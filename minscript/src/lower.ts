// Lowering: AST + resolver / checker / ownership results → HIR (src/hir.ts).
//
// Lowering never re-derives a type rule: it reads the checker's decisions (expression types, call
// targets, member targets, inferred variants). Anything it can't lower becomes an `unsupported` node
// (and never a crash), so gaps are visible in `.hir` snapshots.

import type * as A from "./ast.ts"
import type { CallInfo, CallTarget, CheckResult, MemberTarget, Owner, VariantRef } from "./check.ts"
import type * as H from "./hir.ts"
import { loadPrelude, type Prelude } from "./prelude.ts"
import { Scope, type Resolution, type Sym } from "./resolve.ts"
import type { Span } from "./token.ts"
import * as T from "./types.ts"
import type { Ty } from "./types.ts"

export function lowerPackage(files: A.File[], res: Resolution, checked: CheckResult, prelude: Prelude = loadPrelude()): H.Program {
    return new Lowerer(files, res, checked, prelude).run()
}

// ---------------------------------------------------------------------------------------------

type FnCtx = { ret: Ty, retNode: A.Type | null }

const BIG_INTS: ReadonlySet<string> = new Set(["i64", "u64"])

class Lowerer {
    private readonly files: A.File[]
    private readonly refs: Map<A.Node, Sym>
    private readonly decls: Map<A.Node, Sym>
    private readonly captures: Map<A.Node, Sym[]>
    private readonly types: Map<A.Node, Ty>
    private readonly symTypes: Map<Sym, Ty>
    private readonly calls: Map<A.Node, CallInfo>
    private readonly members: Map<A.Node, MemberTarget>
    private readonly variants: Map<A.Node, VariantRef>
    private readonly rets: Map<A.FunDecl, Ty>
    private readonly open: Set<A.Node>
    private readonly deferred: Set<A.Node>
    private readonly implicitByOwner = new Map<A.Node, Sym[]>()
    private readonly funNames = new Map<A.FunDecl, string>()
    private readonly thisSyms: { span: Span, sym: Sym }[] = []
    private readonly tempScope = new Scope("function", null)
    private tempCount = 0
    private ctx: FnCtx = { ret: T.VOID, retNode: null }

    constructor(files: A.File[], res: Resolution, checked: CheckResult, prelude: Prelude) {
        this.files = files
        this.refs = new Map([...prelude.res.refs, ...res.refs])
        this.decls = new Map([...prelude.res.decls, ...res.decls])
        this.captures = res.captures
        this.types = checked.types
        this.symTypes = checked.symbols
        this.calls = checked.calls
        this.members = checked.members
        this.variants = checked.variants
        this.rets = checked.rets
        this.open = res.open
        this.deferred = new Set(res.deferred)
        for (const sym of res.symbols) {
            if (sym.kind !== "implicit" || sym.scope.closure === null) continue
            const list = this.implicitByOwner.get(sym.scope.closure) ?? []
            if (!list.includes(sym)) list.push(sym)
            this.implicitByOwner.set(sym.scope.closure, list)
        }
        for (const [node, sym] of res.refs) if (sym.kind === "this") this.thisSyms.push({ span: node.span, sym })
        this.nameItems(prelude.file, true)
        for (const f of files) this.nameItems(f, false)
    }

    run(): H.Program {
        const program: H.Program = { types: [], funs: [], globals: [] }
        const interfaces = this.collectInterfaces()
        for (const file of this.files) for (const item of file.items) this.lowerItem(item, program, interfaces)
        return program
    }

    // ---- names --------------------------------------------------------------------------------

    private ownerName(owner: Owner): string {
        if (typeof owner === "string") return owner === "auto" ? "auto" : `std.${owner}`
        return owner.std ? `std.${owner.name}` : owner.name
    }

    private nameItems(file: A.File, std: boolean): void {
        const prefix = std ? "std." : ""
        const typeName = (t: A.Type): string => (t.kind === "TName" ? t.path.join(".") : "?")
        for (const item of file.items) {
            switch (item.kind) {
                case "FunDecl": this.funNames.set(item, prefix + item.name); break
                case "ExternDecl": for (const f of item.funs) this.funNames.set(f, prefix + f.name); break
                case "TypeDecl": if (item.body.kind === "StructBody") for (const m of item.body.methods) this.funNames.set(m, `${prefix}${item.name}.${m.name}`); break
                case "UnionDecl": for (const m of item.methods) this.funNames.set(m, `${prefix}${item.name}.${m.name}`); break
                case "InterDecl": for (const m of item.methods ?? []) this.funNames.set(m, `${prefix}${item.name}.${m.name}`); break
                case "ImplDecl": for (const m of item.methods) this.funNames.set(m, `${prefix}${typeName(item.target)}.${m.name}`); break
                default: break
            }
        }
    }

    private funName(decl: A.FunDecl, owner?: Owner): string {
        return this.funNames.get(decl) ?? (owner !== undefined ? `${this.ownerName(owner)}.${decl.name}` : decl.name)
    }

    private typeName(sym: Sym): string {
        return sym.std ? `std.${sym.name}` : sym.name
    }

    /** Interfaces each local type implements (`type X: I` and `impl I for X`), for dynamic dispatch. */
    private collectInterfaces(): Map<Sym, string[]> {
        const out = new Map<Sym, string[]>()
        const add = (target: Sym | undefined, ifaces: A.Type[]) => {
            if (target === undefined) return
            const list = out.get(target) ?? []
            for (const it of ifaces) {
                const s = it.kind === "TName" ? this.refs.get(it) : undefined
                if (s) list.push(this.typeName(s))
            }
            out.set(target, list)
        }
        for (const file of this.files) {
            for (const item of file.items) {
                if (item.kind === "TypeDecl" || item.kind === "UnionDecl") add(this.decls.get(item), item.impls)
                if (item.kind === "ImplDecl" && item.target.kind === "TName") add(this.refs.get(item.target), item.interfaces)
            }
        }
        return out
    }

    // ---- helpers ------------------------------------------------------------------------------

    private ty(e: A.Node): Ty {
        return T.prune(this.types.get(e) ?? T.UNKNOWN)
    }

    private temp(name: string, ty: Ty): H.Local {
        const sym: Sym = { id: -++this.tempCount, name: `$${name}`, kind: "local", mutable: false, decl: null, span: null, scope: this.tempScope }
        return { sym, ty, mutable: false }
    }

    private localOf(sym: Sym): H.Local {
        return { sym, ty: T.prune(this.symTypes.get(sym) ?? T.UNKNOWN), mutable: sym.mutable }
    }

    private ref(l: H.Local, span: Span): H.Expr {
        return { k: "local", ty: l.ty, span, sym: l.sym }
    }

    private unsupported(what: string, at: { span: Span }, ty: Ty = T.UNKNOWN): H.Expr {
        return { k: "unsupported", ty, span: at.span, what }
    }

    private block(stmts: H.Stmt[], value: H.Expr | null): H.Block {
        return { stmts, value }
    }

    private blockExpr(b: H.Block, ty: Ty, span: Span): H.Expr {
        if (b.stmts.length === 0 && b.value !== null) return b.value
        return { k: "block", ty, span, block: b }
    }

    private lit(value: bigint | number | string | boolean | null, ty: Ty, span: Span): H.Expr {
        return { k: "lit", ty, span, value }
    }

    private variant(union: Sym, variant: string, fields: H.Expr[], ty: Ty, span: Span): H.Expr {
        return { k: "variant", ty, span, union: this.typeName(union), variant, fields }
    }

    private prelude(name: string): Sym | undefined {
        return loadPrelude().res.pkgScope.names.get(name)
    }

    private optionKind(t: Ty): "option" | "result" | null {
        const s = T.strip(t)
        if (s.k !== "named" || !s.sym.std) return null
        if (s.sym.name === "Option") return "option"
        if (s.sym.name === "Result") return "result"
        return null
    }

    private isBig(t: Ty): boolean {
        const s = T.strip(t)
        return s.k === "prim" && BIG_INTS.has(s.name)
    }

    /** Coerces a value to the type it flows into: the only coercion with a runtime effect on JS is int → i64 / u64. */
    private coerce(e: H.Expr, to: Ty | undefined): H.Expr {
        if (to === undefined) return e
        const target = T.strip(to)
        const from = T.strip(e.ty)
        if (this.isBig(target) && T.isInt(from) && !this.isBig(from)) {
            if (e.k === "lit" && typeof e.value === "bigint") return { ...e, ty: target }
            return { k: "widen", ty: target, span: e.span, expr: e }
        }
        // a float given as an interface (`&Stringer`): convert it while its type is known (`2.0`, not `2`)
        if (T.isFloat(from) && target.k === "named" && target.sym.decl?.kind === "InterDecl" && target.sym.name === "Stringer") {
            return { k: "tostr", ty: T.STRING, span: e.span, expr: e }
        }
        if (from.k === "record" && target.k === "named") {
            const decl = target.sym.decl
            if (decl?.kind === "TypeDecl" && decl.body.kind === "StructBody") {
                if (e.k === "record") return this.structFromFields(target.sym, decl.body.fields, e.fields, null, e.span, target)
                // a record value (not a literal): copy its fields into the struct (spec §7.4)
                const tmp = this.temp("rec", e.ty)
                const given = from.fields.map((f) => ({ name: f.name, value: { k: "field", ty: f.ty, span: e.span, object: this.ref(tmp, e.span), name: f.name } as H.Expr }))
                const value = this.structFromFields(target.sym, decl.body.fields, given, null, e.span, target)
                return this.blockExpr(this.block([{ k: "let", local: tmp, value: e }], value), target, e.span)
            }
        }
        return e
    }

    private truthy(e: H.Expr): H.Expr {
        const of = this.optionKind(e.ty)
        if (of === null) return e
        return { k: "truthy", ty: T.BOOL, span: e.span, expr: e, of }
    }

    // ---- items --------------------------------------------------------------------------------

    private fieldDefs(fields: A.Field[]): H.FieldDef[] {
        return fields.map((f) => ({ name: f.name, optional: isOptionType(f.type), ...(isFloatType(f.type) ? { float: true } : {}) }))
    }

    private lowerItem(item: A.Item, p: H.Program, interfaces: Map<Sym, string[]>): void {
        switch (item.kind) {
            case "FunDecl": p.funs.push(this.lowerFun(item)); return
            case "ExternDecl":
                for (const f of item.funs) p.funs.push({ name: this.funName(f), params: f.params.map((x) => this.localOf(this.decls.get(x)!)), self: null, ret: this.retTy(f), async: f.async, body: null, extern: item.abi, span: f.span })
                return
            case "LetDecl": {
                const sym = this.decls.get(item)
                const ty = sym ? T.prune(this.symTypes.get(sym) ?? T.UNKNOWN) : T.UNKNOWN
                this.ctx = { ret: T.UNKNOWN, retNode: null }
                p.globals.push({ name: item.name, ty, value: this.coerce(this.expr(item.value), ty) })
                return
            }
            case "TypeDecl": {
                const sym = this.decls.get(item)
                const ifaces = sym ? interfaces.get(sym) ?? [] : []
                if (item.body.kind === "StructBody") {
                    p.types.push({ kind: "struct", name: item.name, fields: this.fieldDefs(item.body.fields), interfaces: ifaces })
                    for (const m of item.body.methods) p.funs.push(this.lowerFun(m))
                }
                return
            }
            case "UnionDecl": {
                const sym = this.decls.get(item)
                p.types.push({
                    kind: "union", name: item.name, interfaces: sym ? interfaces.get(sym) ?? [] : [],
                    variants: item.variants.map((v) => ({
                        name: v.name,
                        positional: v.fields === null,
                        fields: v.fields ? this.fieldDefs(v.fields) : (v.tuple ?? []).map((t, i) => ({ name: `${i}`, optional: false, ...(isFloatType(t) ? { float: true } : {}) })),
                    })),
                })
                for (const m of item.methods) p.funs.push(this.lowerFun(m))
                return
            }
            case "InterDecl":
                p.types.push({ kind: "inter", name: item.name, methods: (item.methods ?? []).map((m) => m.name) })
                for (const m of item.methods ?? []) if (m.body !== null) p.funs.push(this.lowerFun(m))
                return
            case "ImplDecl":
                for (const m of item.methods) p.funs.push(this.lowerFun(m))
                return
        }
    }

    private retTy(f: A.FunDecl): Ty {
        if (f.ret === null) return T.VOID
        return T.prune(this.rets.get(f) ?? T.UNKNOWN)
    }

    private thisSymIn(body: A.Block): Sym | undefined {
        return this.thisSyms.find((t) => t.span.start >= body.span.start && t.span.end <= body.span.end)?.sym
    }

    private lowerFun(f: A.FunDecl): H.Fun {
        const params = f.params.map((p) => this.localOf(this.decls.get(p)!))
        const thisSym = f.body ? this.thisSymIn(f.body) : undefined
        const self = f.receiver === null ? null : thisSym ? this.localOf(thisSym) : this.temp("this", T.UNKNOWN)
        const ret = this.retTy(f)
        this.ctx = { ret, retNode: f.ret }
        const body = f.body ? this.body(f.body, ret) : null
        return { name: this.funName(f), params, self, ret, async: f.async, body, extern: null, span: f.span }
    }

    /** A function or closure body: the tail value is coerced to the result type. */
    private body(b: A.Block, ret: Ty): H.Block {
        const out = this.stmts(b.stmts)
        if (out.value !== null) out.value = this.coerce(out.value, ret)
        return out
    }

    // ---- statements ---------------------------------------------------------------------------

    private stmts(stmts: A.Stmt[]): H.Block {
        const out: H.Stmt[] = []
        let value: H.Expr | null = null
        stmts.forEach((s, i) => {
            if (s.kind === "ExprStmt") {
                const e = this.expr(s.expr)
                if (i === stmts.length - 1 && !s.semi) value = e
                else out.push({ k: "expr", expr: e })
                return
            }
            this.letStmt(s, out)
        })
        return this.block(out, value)
    }

    private letStmt(s: Extract<A.Stmt, { kind: "Let" }>, out: H.Stmt[]): void {
        const declared = s.pattern.kind === "PBind" ? this.decls.get(s.pattern) : undefined
        const target = declared ? this.symTypes.get(declared) : undefined
        const value = this.coerce(this.expr(s.value), target)
        if (s.else !== null) return this.letElse(s, value, out)
        this.destructure(s.pattern, value, out)
    }

    /** Irrefutable destructuring: one `let` per binding (through a temporary). */
    private destructure(p: A.Pattern, value: H.Expr, out: H.Stmt[]): void {
        switch (p.kind) {
            case "PBind": {
                const sym = this.decls.get(p)
                if (sym) out.push({ k: "let", local: this.localOf(sym), value })
                return
            }
            case "PWild": out.push({ k: "expr", expr: value }); return
            default: {
                const tmp = this.temp("v", value.ty)
                out.push({ k: "let", local: tmp, value })
                for (const [sym, path] of this.paths(p, [])) {
                    let e: H.Expr = this.ref(tmp, p.span)
                    for (const step of path) e = { k: "field", ty: T.UNKNOWN, span: p.span, object: e, name: step }
                    const local = this.localOf(sym)
                    e.ty = local.ty
                    out.push({ k: "let", local, value: e })
                }
            }
        }
    }

    /** Each binding of an irrefutable pattern, with its field path (`t(a, r{ b })` → a: ["0"], b: ["1", "b"]). */
    private paths(p: A.Pattern, path: string[]): [Sym, string[]][] {
        switch (p.kind) {
            case "PBind": { const s = this.decls.get(p); return s ? [[s, path]] : [] }
            case "PTuple": return p.elems.flatMap((e, i) => this.paths(e, [...path, `${i}`]))
            case "PStruct": return p.fields.flatMap((f) => {
                if (f.pattern) return this.paths(f.pattern, [...path, f.name])
                const s = this.decls.get(f)
                return s ? [[s, [...path, f.name]] as [Sym, string[]]] : []
            })
            case "PCall": return p.args.flatMap((a, i) => this.paths(a, [...path, `${i}`]))
            default: return []
        }
    }

    /** `let P = e else { … }` → `let $t = match e { P => t(bindings…), _ => else }`, then the bindings. */
    private letElse(s: Extract<A.Stmt, { kind: "Let" }>, value: H.Expr, out: H.Stmt[]): void {
        const binds = this.bindingsOf(s.pattern)
        const pattern = this.pattern(s.pattern, value.ty)
        const elseBlock = this.stmts(s.else!.stmts)
        const elseExpr = this.blockExpr(elseBlock, T.NEVER, s.else!.span)
        if (binds.length === 1) {
            const local = this.localOf(binds[0]!)
            const m: H.Expr = { k: "match", ty: local.ty, span: s.span, subject: value, arms: [
                { pattern, guard: null, body: this.ref(local, s.span) },
                { pattern: { k: "wild" }, guard: null, body: elseExpr },
            ] }
            out.push({ k: "let", local, value: m })
            return
        }
        const tupleTy: Ty = { k: "tuple", elems: binds.map((b) => this.localOf(b).ty) }
        const tmp = this.temp("v", tupleTy)
        const tuple: H.Expr = { k: "tuple", ty: tupleTy, span: s.span, elems: binds.map((b) => this.ref(this.localOf(b), s.span)) }
        out.push({ k: "let", local: tmp, value: { k: "match", ty: tupleTy, span: s.span, subject: value, arms: [
            { pattern, guard: null, body: tuple },
            { pattern: { k: "wild" }, guard: null, body: elseExpr },
        ] } })
        binds.forEach((b, i) => {
            const local = this.localOf(b)
            out.push({ k: "let", local, value: { k: "field", ty: local.ty, span: s.span, object: this.ref(tmp, s.span), name: `${i}` } })
        })
    }

    private bindingsOf(p: A.Pattern): Sym[] {
        const out: Sym[] = []
        const visit = (n: A.Pattern | A.PatField) => {
            if (n.kind === "PBind" || n.kind === "PatField") {
                const s = this.decls.get(n)
                if (s && !out.includes(s)) out.push(s)
            }
            switch (n.kind) {
                case "PCall": n.args.forEach(visit); break
                case "PStruct": n.fields.forEach((f) => (f.pattern ? visit(f.pattern) : visit(f))); break
                case "PTuple": n.elems.forEach(visit); break
                case "POr": if (n.alts[0]) visit(n.alts[0]); break
                default: break
            }
        }
        visit(p)
        return out
    }

    // ---- patterns -----------------------------------------------------------------------------

    private patLit(e: A.Expr): bigint | number | string | boolean | null {
        switch (e.kind) {
            case "Int": return e.value
            case "Float": return e.value
            case "Str": return e.value
            case "Char": return e.value
            case "Bool": return e.value
            case "Nil": return null
            case "Unary": {
                const v = this.patLit(e.expr)
                return typeof v === "bigint" ? -v : typeof v === "number" ? -v : v
            }
            default: return null
        }
    }

    pattern(p: A.Pattern, ty: Ty): H.Pattern {
        const t = T.strip(ty)
        switch (p.kind) {
            case "PWild": case "PError": return { k: "wild" }
            case "PBind": { const s = this.decls.get(p); return s ? { k: "bind", local: this.localOf(s) } : { k: "wild" } }
            case "PLit": {
                if (p.value.kind === "Nil") return { k: "variant", union: "std.Option", variant: "None", fields: [] }
                return { k: "lit", value: this.patLit(p.value) }
            }
            case "PRange": {
                const v = (x: A.Expr | null) => (x === null ? null : this.patLit(x) as bigint | number | string | null)
                return { k: "range", start: v(p.start), end: v(p.end), inclusive: p.op === "..=" }
            }
            case "POr": return { k: "or", alts: p.alts.map((a) => this.pattern(a, ty)) }
            case "PTuple": {
                const n = t.k === "tuple" ? t.elems.length : p.elems.length
                const elems = p.elems.map((e, i) => this.pattern(e, t.k === "tuple" ? t.elems[i] ?? T.UNKNOWN : T.UNKNOWN))
                while (elems.length < n) elems.push({ k: "wild" })
                return { k: "tuple", elems }
            }
            case "PPath": case "PCall": case "PStruct": {
                const v = this.variants.get(p)
                if (v !== undefined) return this.variantPattern(p, v, t)
                // no checker info (the value's type is unknown): name the variant directly
                const sym = this.refs.get(p)
                if (sym?.kind === "variant" && sym.owner) return this.variantPattern(p, { union: sym.owner, variant: sym.name }, t)
                if (p.path !== null && p.path.length === 1 && (p.kind === "PCall" || p.kind === "PPath") && (sym === undefined || sym.kind === "union")) {
                    const fields = p.kind === "PCall" ? p.args.map((a) => this.pattern(a, T.UNKNOWN)) : []
                    return { k: "variant", union: "?", variant: p.path[0]!, fields }
                }
                if (p.path !== null && p.path.length >= 2 && (p.kind === "PCall" || p.kind === "PPath")) {
                    const fields = p.kind === "PCall" ? p.args.map((a) => this.pattern(a, T.UNKNOWN)) : []
                    return { k: "variant", union: p.path.slice(0, -1).join("."), variant: p.path[p.path.length - 1]!, fields }
                }
                if (p.kind === "PStruct") {
                    return { k: "fields", fields: p.fields.map((f) => {
                        if (f.pattern) return { name: f.name, pattern: this.pattern(f.pattern, T.UNKNOWN) }
                        const s = this.decls.get(f)
                        return { name: f.name, pattern: s ? { k: "bind", local: this.localOf(s) } as H.Pattern : { k: "wild" } as H.Pattern }
                    }) }
                }
                return { k: "wild" }
            }
        }
    }

    private variantPattern(p: A.Pattern & { kind: "PPath" | "PCall" | "PStruct" }, v: VariantRef, t: Ty): H.Pattern {
        const decl = v.union.decl
        const vdecl = decl?.kind === "UnionDecl" ? decl.variants.find((x) => x.name === v.variant) : undefined
        const union = this.typeName(v.union)
        if (p.kind === "PPath") return { k: "variant", union, variant: v.variant, fields: [] }
        if (p.kind === "PCall") {
            const n = vdecl?.tuple?.length ?? p.args.length
            const fields = p.args.map((a) => this.pattern(a, T.UNKNOWN))
            while (fields.length < n) fields.push({ k: "wild" })
            void t
            return { k: "variant", union, variant: v.variant, fields }
        }
        const names = vdecl?.fields?.map((f) => f.name) ?? p.fields.map((f) => f.name)
        const fields = names.map((name): H.Pattern => {
            const f = p.fields.find((x) => x.name === name)
            if (f === undefined) return { k: "wild" }
            if (f.pattern) return this.pattern(f.pattern, T.UNKNOWN)
            const s = this.decls.get(f)
            return s ? { k: "bind", local: this.localOf(s) } : { k: "wild" }
        })
        return { k: "variant", union, variant: v.variant, fields }
    }

    // ---- expressions --------------------------------------------------------------------------

    expr(e: A.Expr): H.Expr {
        const ty = this.ty(e)
        const span = e.span
        switch (e.kind) {
            case "Ident": return this.ident(e, ty)
            case "This": {
                const sym = this.refs.get(e)
                return sym ? { k: "local", ty, span, sym } : this.unsupported("`this` without a receiver", e, ty)
            }
            case "Int": return this.lit(e.value, ty, span)
            case "Float": return this.lit(e.value, ty, span)
            case "Str": return this.lit(e.value, ty, span)
            case "Char": return { k: "char", ty, span, value: e.value }
            case "Bool": return this.lit(e.value, ty, span)
            case "Nil": return { k: "variant", ty, span, union: "std.Option", variant: "None", fields: [] }
            case "Template": return {
                k: "concat", ty: T.STRING, span,
                parts: e.parts.filter((p) => p !== "").map((p) => (typeof p === "string" ? this.lit(p, T.STRING, span) : this.toStr(this.expr(p)))),
            }
            case "Paren": return this.expr(e.expr)
            case "Vec": return { k: "vec", ty, span, elems: e.elems.map((x) => this.elem(x, elemTy(ty))) }
            case "Array": return { k: "array", ty, span, elems: e.elems.map((x) => this.elem(x, elemTy(ty))) }
            case "Set": return { k: "set", ty, span, elems: e.elems.map((x) => this.elem(x, elemTy(ty))) }
            case "Tuple":
                if (e.elems.length === 0) return this.lit(null, T.VOID, span)
                return { k: "tuple", ty, span, elems: e.elems.map((x) => this.expr(x.kind === "Spread" ? x.expr : x)) }
            case "Map": return {
                k: "map", ty, span,
                entries: e.entries.map((en) => (en.kind === "Spread" ? { k: "spread", expr: this.expr(en.expr) } as H.Spread : { key: this.expr(en.key), value: this.expr(en.value) })),
            }
            case "Record": return this.record(e.fields, ty, span)
            case "Inferred": {
                const t = T.strip(ty)
                if (t.k === "named" && t.sym.decl?.kind === "TypeDecl" && t.sym.decl.body.kind === "StructBody") {
                    return this.structFromFields(t.sym, t.sym.decl.body.fields, this.givenFields(e.fields), this.spreadOf(e.fields), span, ty)
                }
                return this.record(e.fields, ty, span)
            }
            case "StructLit": return this.structLit(e, ty)
            case "Closure": return this.closure(e, ty)
            case "Unary": return this.unary(e, ty)
            case "Await": return { k: "await", ty, span, expr: this.expr(e.expr) }
            case "Binary": return this.binary(e, ty)
            case "Assign": return this.assign(e)
            case "Range": return { k: "range", ty, span, start: e.start ? this.expr(e.start) : null, end: e.end ? this.expr(e.end) : null, inclusive: e.op === "..=" }
            case "As": {
                const inner = this.expr(e.expr)
                const from = T.strip(inner.ty), to = T.strip(ty)
                const numeric = (x: Ty) => T.isNumeric(x) || x.k === "ptr" || (x.k === "prim" && x.name === "char")
                if (numeric(from) && numeric(to) && !(from.k === "prim" && to.k === "prim" && from.name === to.name)) return { k: "cast", ty, span, expr: inner, to: ty }
                return this.coerce({ ...inner, ty: inner.ty.k === "var" ? ty : inner.ty }, ty)
            }
            case "Or": return this.orExpr(e, ty)
            case "Member": return this.member(e, ty)
            case "OptMember": return this.optMember(e, ty)
            case "Call": return this.call(e, ty)
            case "Index": {
                const ot = T.strip(this.ty(e.object))
                const map = ot.k === "named" && ot.sym.std === true && ot.sym.name === "Map"
                return { k: "index", ty, span, object: this.expr(e.object), index: this.expr(e.index), map }
            }
            case "GenericApply": return this.expr(e.target)
            case "Try": return this.tryExpr(e, ty)
            case "If": return this.ifExpr(e, ty)
            case "Match": return this.matchExpr(e, ty)
            case "Select": return {
                k: "select", ty, span,
                arms: e.arms.map((a) => {
                    const wait = this.expr(a.expr)
                    return { wait, pattern: a.pattern ? this.pattern(a.pattern, awaitedTy(wait.ty)) : { k: "wild" } as H.Pattern, body: this.expr(a.body) }
                }),
                else: e.else ? this.expr(e.else) : null,
            }
            case "For": return this.forExpr(e, ty)
            case "Block": return this.blockExpr(this.stmts(e.stmts), ty, span)
            case "Unsafe": return this.blockExpr(this.stmts(e.body.stmts), ty, span)
            case "Recover": return { k: "recover", ty, span, body: this.stmts(e.body.stmts) }
            case "Return": return { k: "return", ty: T.NEVER, span, value: e.value ? this.coerce(this.expr(e.value), this.ctx.ret) : null }
            case "Break": return { k: "break", ty: T.NEVER, span, label: e.label, value: e.value ? this.expr(e.value) : null }
            case "Continue": return { k: "continue", ty: T.NEVER, span, label: e.label }
            case "Error": return this.unsupported("a syntax error", e, ty)
        }
    }

    private toStr(e: H.Expr): H.Expr {
        if (T.isStringy(T.strip(e.ty))) return e
        return { k: "tostr", ty: T.STRING, span: e.span, expr: e }
    }

    private elem(x: A.Expr | A.Spread, ty: Ty | undefined): H.Expr | H.Spread {
        if (x.kind === "Spread") return { k: "spread", expr: this.expr(x.expr) }
        return this.coerce(this.expr(x), ty)
    }

    private ident(e: Extract<A.Expr, { kind: "Ident" }>, ty: Ty): H.Expr {
        const span = e.span
        const v = this.variants.get(e)
        if (v !== undefined) return this.variantValue(v, ty, span)
        const sym = this.refs.get(e)
        // names from a glob import, or variants of a package type that isn't loaded yet (`Text` for
        // `ws.Message`): their packages have no signatures, so they stay symbolic
        if (sym === undefined && (this.open.has(e) || this.deferred.has(e))) return { k: "extern", ty, span, path: e.name, args: null }
        if (sym === undefined) return this.unsupported(`unresolved name \`${e.name}\``, e, ty)
        switch (sym.kind) {
            case "local": case "param": case "closure-param": case "implicit": case "this":
                return { k: "local", ty, span, sym }
            case "fun": case "extern-fun": {
                const decl = sym.decl
                return decl?.kind === "FunDecl" ? { k: "fn", ty, span, name: this.funName(decl) } : this.unsupported("function", e, ty)
            }
            case "global": return { k: "global", ty, span, name: sym.std ? `std.${sym.name}` : sym.name }
            case "package": case "import": return { k: "extern", ty, span, path: sym.detail ?? sym.name, args: null }
            default: return this.unsupported(`\`${e.name}\` used as a value`, e, ty)
        }
    }

    /** A variant used as a value: the value itself (unit variant), or its constructor. */
    private variantValue(v: VariantRef, ty: Ty, span: Span): H.Expr {
        const decl = v.union.decl
        const vdecl = decl?.kind === "UnionDecl" ? decl.variants.find((x) => x.name === v.variant) : undefined
        if (vdecl !== undefined && (vdecl.tuple !== null || vdecl.fields !== null)) {
            return { k: "fn", ty, span, name: `${this.typeName(v.union)}.${v.variant}` }
        }
        return this.variant(v.union, v.variant, [], ty, span)
    }

    private record(fields: (A.RecordField | A.Spread)[], ty: Ty, span: Span): H.Expr {
        const spread = this.spreadOf(fields)
        const given = this.givenFields(fields)
        if (spread === null) return { k: "record", ty, span, fields: given }
        // `r{ ...base, a: 1 }`: copy the base's fields, then override
        const base = this.expr(spread)
        const tmp = this.temp("base", base.ty)
        const bt = T.strip(base.ty)
        const names = bt.k === "record" ? bt.fields.map((f) => f.name) : []
        const all = [...names.filter((n) => !given.some((g) => g.name === n)).map((name) => ({ name, value: { k: "field", ty: T.UNKNOWN, span, object: this.ref(tmp, span), name } as H.Expr })), ...given]
        return this.blockExpr(this.block([{ k: "let", local: tmp, value: base }], { k: "record", ty, span, fields: all }), ty, span)
    }

    private givenFields(fields: (A.RecordField | A.Spread)[]): { name: string, value: H.Expr }[] {
        const out: { name: string, value: H.Expr }[] = []
        for (const f of fields) {
            if (f.kind === "Spread") continue
            if (f.value !== null) { out.push({ name: f.key, value: this.expr(f.value) }); continue }
            const sym = this.refs.get(f)
            out.push({ name: f.key, value: sym ? { k: "local", ty: this.localOf(sym).ty, span: f.span, sym } : this.unsupported(`field \`${f.key}\``, f) })
        }
        return out
    }

    private spreadOf(fields: (A.RecordField | A.Spread)[]): A.Expr | null {
        const s = fields.find((f): f is A.Spread => f.kind === "Spread")
        return s ? s.expr : null
    }

    /** A struct value with every field: given, from the spread base, the default, or `None` for `T?`. */
    private structFromFields(sym: Sym, decl: A.Field[], given: { name: string, value: H.Expr }[], spread: A.Expr | null, span: Span, ty: Ty): H.Expr {
        const stmts: H.Stmt[] = []
        let base: H.Local | null = null
        if (spread !== null) {
            const b = this.expr(spread)
            base = this.temp("base", b.ty)
            stmts.push({ k: "let", local: base, value: b })
        }
        const fields = decl.map((f) => {
            const g = given.find((x) => x.name === f.name)
            if (g) return { name: f.name, value: g.value }
            if (base) return { name: f.name, value: { k: "field", ty: T.UNKNOWN, span, object: this.ref(base, span), name: f.name } as H.Expr }
            if (f.default !== null) return { name: f.name, value: this.expr(f.default) }
            if (isOptionType(f.type)) return { name: f.name, value: { k: "variant", ty: T.UNKNOWN, span, union: "std.Option", variant: "None", fields: [] } as H.Expr }
            return { name: f.name, value: this.unsupported(`missing field \`${f.name}\``, { span }) }
        })
        const value: H.Expr = { k: "struct", ty, span, type: this.typeName(sym), fields }
        return stmts.length === 0 ? value : this.blockExpr(this.block(stmts, value), ty, span)
    }

    private structLit(e: Extract<A.Expr, { kind: "StructLit" }>, ty: Ty): H.Expr {
        const v = this.variants.get(e)
        if (v !== undefined) {
            const decl = v.union.decl
            const vdecl = decl?.kind === "UnionDecl" ? decl.variants.find((x) => x.name === v.variant) : undefined
            const given = this.givenFields(e.fields)
            const fields = (vdecl?.fields ?? []).map((f) => given.find((g) => g.name === f.name)?.value
                ?? (f.default ? this.expr(f.default) : isOptionType(f.type) ? { k: "variant", ty: T.UNKNOWN, span: e.span, union: "std.Option", variant: "None", fields: [] } as H.Expr : this.unsupported(`missing field \`${f.name}\``, e)))
            return this.variant(v.union, v.variant, fields, ty, e.span)
        }
        const t = T.strip(ty)
        if (t.k === "named" && t.sym.decl?.kind === "TypeDecl" && t.sym.decl.body.kind === "StructBody") {
            return this.structFromFields(t.sym, t.sym.decl.body.fields, this.givenFields(e.fields), this.spreadOf(e.fields), e.span, ty)
        }
        // a type from a package that isn't loaded yet (`models.User { … }`)
        return this.record(e.fields, ty, e.span)
    }

    private closure(e: Extract<A.Expr, { kind: "Closure" }>, ty: Ty): H.Expr {
        let params: H.Local[]
        if (e.params !== null) {
            params = e.params.map((p) => this.localOf(this.decls.get(p)!))
        } else {
            const implicit = (this.implicitByOwner.get(e) ?? []).filter((s, i, all) => all.indexOf(s) === i)
            const n = Math.max(0, ...implicit.map((s) => Number(s.name.slice(2) || "1")))
            params = []
            for (let i = 1; i <= n; i++) {
                const s = implicit.find((x) => Number(x.name.slice(2) || "1") === i)
                const ft = T.strip(ty)
                params.push(s ? this.localOf(s) : this.temp(`it${i}`, ft.k === "fn" ? ft.params[i - 1] ?? T.UNKNOWN : T.UNKNOWN))
            }
        }
        const explicit = new Map<Sym, A.Capture["mode"]>()
        for (const c of e.captures ?? []) { const s = this.refs.get(c); if (s) explicit.set(s, c.mode) }
        const captures = (this.captures.get(e) ?? []).map((sym) => ({ sym, mode: explicit.get(sym) ?? "ref" as const }))
        const ft = T.strip(ty)
        const ret = ft.k === "fn" ? T.prune(ft.ret) : T.UNKNOWN
        const saved = this.ctx
        this.ctx = { ret, retNode: e.ret }
        try {
            return { k: "closure", ty, span: e.span, params, captures, body: this.body(e.body, ret) }
        } finally {
            this.ctx = saved
        }
    }

    private unary(e: Extract<A.Expr, { kind: "Unary" }>, ty: Ty): H.Expr {
        const inner = this.expr(e.expr)
        switch (e.op) {
            case "-":
                if (inner.k === "lit" && (typeof inner.value === "bigint" || typeof inner.value === "number")) return { ...inner, value: -inner.value, ty, span: e.span }
                return { k: "unary", ty, span: e.span, op: "neg", expr: inner }
            case "!":
                if (T.isInt(T.strip(inner.ty))) return { k: "unary", ty, span: e.span, op: "bitnot", expr: inner }
                return { k: "unary", ty: T.BOOL, span: e.span, op: "not", expr: this.truthy(inner) }
            case "&": case "&mut": return inner          // borrows have no runtime form here
            case "*": return { k: "unary", ty, span: e.span, op: "deref", expr: inner }
        }
    }

    private binary(e: Extract<A.Expr, { kind: "Binary" }>, ty: Ty): H.Expr {
        const span = e.span
        if (e.op === "&&" || e.op === "||") {
            return { k: e.op === "&&" ? "and" : "or", ty: T.BOOL, span, left: this.truthy(this.expr(e.left)), right: this.truthy(this.expr(e.right)) }
        }
        if (e.op === "??") return this.nullish(e, ty)
        let left = this.expr(e.left)
        let right = this.expr(e.right)
        const ls = T.strip(left.ty), rs = T.strip(right.ty)
        if (e.op === "+" && T.isStringy(ls) && T.isStringy(rs)) return { k: "concat", ty: T.STRING, span, parts: [left, right] }
        // mixed widths: widen the narrower side (spec §9.5)
        if (T.isNumeric(ls) && T.isNumeric(rs)) {
            left = this.coerce(left, right.ty)
            right = this.coerce(right, left.ty)
        }
        // operator interfaces on user types: `a + b` → `T.plus(a, b)`
        const method = { "+": "plus", "-": "minus", "*": "times", "/": "divide", "%": "remainder" }[e.op]
        if (method && ls.k === "named" && !ls.sym.std) {
            return { k: "call", ty, span, fn: `${this.typeName(ls.sym)}.${method}`, args: [left, right] }
        }
        return { k: "binary", ty, span, op: e.op, left, right }
    }

    /** `a ?? b` → `match a { Some(v) => v, None => b }` (b is evaluated only when needed). */
    private nullish(e: Extract<A.Expr, { kind: "Binary" }>, ty: Ty): H.Expr {
        const span = e.span
        const left = this.expr(e.left)
        const right = this.coerce(this.expr(e.right), ty)
        const inner = innerTy(left.ty)
        const v = this.temp("v", inner)
        const keepsOption = this.optionKind(ty) === "option" && this.optionKind(inner) !== "option"
        const someBody: H.Expr = keepsOption ? this.variant(this.prelude("Option")!, "Some", [this.ref(v, span)], ty, span) : this.ref(v, span)
        return { k: "match", ty, span, subject: left, arms: [
            { pattern: { k: "ok", value: { k: "bind", local: v } }, guard: null, body: someBody },
            { pattern: { k: "wild" }, guard: null, body: right },
        ] }
    }

    private assign(e: Extract<A.Expr, { kind: "Assign" }>): H.Expr {
        const target = this.expr(e.target)
        const value = this.coerce(this.expr(e.value), target.ty)
        if (e.op === "??=") {
            // `x ??= v` → `if !x { x = Some(v) }`
            const some = this.variant(this.prelude("Option")!, "Some", [value], target.ty, e.span)
            const set: H.Expr = { k: "assign", ty: T.VOID, span: e.span, target, op: "=", value: some }
            return { k: "if", ty: T.VOID, span: e.span, cond: { k: "unary", ty: T.BOOL, span: e.span, op: "not", expr: this.truthy(target) }, then: this.block([], set), else: null }
        }
        const ts = T.strip(target.ty)
        if (e.op === "+=" && T.isStringy(ts)) {
            return { k: "assign", ty: T.VOID, span: e.span, target, op: "=", value: { k: "concat", ty: T.STRING, span: e.span, parts: [target, value] } }
        }
        return { k: "assign", ty: T.VOID, span: e.span, target, op: e.op, value }
    }

    /** `e or rhs` → `match e { Some(v) / Ok(v) => v, None / Err(it) => return rhs }`. */
    private orExpr(e: Extract<A.Expr, { kind: "Or" }>, ty: Ty): H.Expr {
        const span = e.span
        const subject = this.expr(e.expr)
        const v = this.temp("v", ty)
        const named = this.decls.get(e)
        const implicit = this.implicitByOwner.get(e)?.[0]
        const payloadSym = named ?? implicit
        const rhs = this.expr(e.rhs)
        const fallback: H.Expr = T.prune(rhs.ty).k === "never" ? rhs : { k: "return", ty: T.NEVER, span: e.rhs.span, value: this.coerce(rhs, this.ctx.ret) }
        return { k: "match", ty, span, subject, arms: [
            { pattern: { k: "ok", value: { k: "bind", local: v } }, guard: null, body: this.ref(v, span) },
            { pattern: { k: "fail", payload: payloadSym ? { k: "bind", local: this.localOf(payloadSym) } : { k: "wild" } }, guard: null, body: fallback },
        ] }
    }

    /**
     * `e?` → `match e { ok(v) => v, fail => return e }`: the failed value (`None` / `Err(x)`) is
     * returned as it is, which is right for an Option and a Result alike.
     */
    private tryExpr(e: Extract<A.Expr, { kind: "Try" }>, ty: Ty): H.Expr {
        const span = e.span
        const subject = this.expr(e.expr)
        const t = this.temp("t", subject.ty)
        const v = this.temp("v", ty)
        const m: H.Expr = { k: "match", ty, span, subject: this.ref(t, span), arms: [
            { pattern: { k: "ok", value: { k: "bind", local: v } }, guard: null, body: this.ref(v, span) },
            { pattern: { k: "wild" }, guard: null, body: { k: "return", ty: T.NEVER, span, value: { ...this.ref(t, span), ty: this.ctx.ret } } },
        ] }
        return this.blockExpr(this.block([{ k: "let", local: t, value: subject }], m), ty, span)
    }

    private member(e: Extract<A.Expr, { kind: "Member" }>, ty: Ty): H.Expr {
        const span = e.span
        const name = String(e.name)
        const target = this.members.get(e)
        const path = this.externPath(e)
        if (path !== null) return { k: "extern", ty, span, path, args: null }
        switch (target?.kind) {
            case "variant": return this.variantValue({ union: target.union, variant: target.variant }, ty, span)
            case "static": return { k: "fn", ty, span, name: this.funName(target.decl, target.owner) }
            case "method": return this.unsupported(`the method \`${name}\` used as a value (wrap it in a closure)`, e, ty)
            case "tuple": return { k: "field", ty, span, object: this.expr(e.object), name: `${target.index}` }
            default: return { k: "field", ty, span, object: this.expr(e.object), name }
        }
    }

    /** `json.parse`, `ws.Message.Close`: a path into a std package without signatures. */
    private externPath(e: A.Expr): string | null {
        if (e.kind === "Ident") {
            const sym = this.refs.get(e)
            if (sym === undefined && (this.open.has(e) || (this.deferred.has(e) && !this.variants.has(e)))) return e.name
            return sym && (sym.kind === "package" || sym.kind === "import") ? (sym.detail ?? sym.name) : null
        }
        if (e.kind === "Member" && typeof e.name === "string") {
            const base = this.externPath(e.object)
            return base === null ? null : `${base}.${e.name}`
        }
        return null
    }

    /** `x?.f` → `match x { Some(o) => Some(o.f), None => None }` (no double Option). */
    private optMember(e: Extract<A.Expr, { kind: "OptMember" }>, ty: Ty): H.Expr {
        const span = e.span
        const subject = this.expr(e.object)
        const o = this.temp("o", innerTy(subject.ty))
        const inner = this.ref(o, span)
        const access: H.Expr = typeof e.name === "number"
            ? { k: "field", ty: T.UNKNOWN, span, object: inner, name: `${e.name}` }
            : { k: "field", ty: innerTy(ty), span, object: inner, name: e.name }
        return this.someOrNone(subject, o, access, ty, span)
    }

    private someOrNone(subject: H.Expr, o: H.Local, value: H.Expr, ty: Ty, span: Span): H.Expr {
        const option = this.prelude("Option")!
        const wrapped = this.optionKind(value.ty) === "option" ? value : this.variant(option, "Some", [value], ty, span)
        return { k: "match", ty, span, subject, arms: [
            { pattern: { k: "ok", value: { k: "bind", local: o } }, guard: null, body: wrapped },
            { pattern: { k: "wild" }, guard: null, body: this.variant(option, "None", [], ty, span) },
        ] }
    }

    // ---- calls --------------------------------------------------------------------------------

    private call(e: Extract<A.Expr, { kind: "Call" }>, ty: Ty): H.Expr {
        const span = e.span
        const info = this.calls.get(e)
        const callee = e.callee.kind === "GenericApply" ? e.callee.target : e.callee
        const target: CallTarget = info?.target ?? { kind: "unknown" }
        const args = (decl: A.FunDecl | null) => this.args(e, info, decl)

        // calls through `?.`: `x?.f()` → match x { Some(o) => Some(o.f()), None => None }
        if (callee.kind === "OptMember" && (target.kind === "method" || target.kind === "unknown")) {
            const subject = this.expr(callee.object)
            const o = this.temp("o", innerTy(subject.ty))
            const recv = this.ref(o, span)
            const inner = this.methodCall(target, recv, typeof callee.name === "string" ? callee.name : String(callee.name), args(target.kind === "method" ? target.decl : null), innerTy(ty), span)
            return this.someOrNone(subject, o, inner, ty, span)
        }

        switch (target.kind) {
            case "fun": return { k: "call", ty, span, fn: this.funName(target.decl), args: args(target.decl) }
            case "static": return { k: "call", ty, span, fn: this.funName(target.decl, target.owner), args: args(target.decl) }
            case "variant": {
                const a = args(null)
                const decl = target.union.decl
                const vdecl = decl?.kind === "UnionDecl" ? decl.variants.find((x) => x.name === target.variant) : undefined
                while (a.length < (vdecl?.tuple?.length ?? 0)) a.push(this.lit(null, T.VOID, span))     // `Ok()` → Ok(t())
                return this.variant(target.union, target.variant, a, ty, span)
            }
            case "method": {
                if (callee.kind !== "Member") return this.unsupported("method call", e, ty)
                return this.methodCall(target, this.expr(callee.object), String(callee.name), args(target.decl), ty, span)
            }
            case "value": return { k: "callvalue", ty, span, callee: this.expr(callee), args: args(null) }
            case "unknown": {
                const path = this.externPath(callee)
                if (path !== null) {
                    // `json.parse.[User](s)`: the runtime needs the type to build a `User`
                    const typeArgs = e.callee.kind === "GenericApply"
                        ? e.callee.args.map((a) => { const s = a.kind === "TName" ? this.refs.get(a) : undefined; return s ? this.typeName(s) : "?" })
                        : undefined
                    return { k: "extern", ty, span, path, args: args(null), ...(typeArgs ? { typeArgs } : {}) }
                }
                if (callee.kind === "Member" && typeof callee.name === "string") {
                    return { k: "dyncall", ty, span, recv: this.expr(callee.object), method: callee.name, args: args(null) }
                }
                return { k: "callvalue", ty, span, callee: this.expr(callee), args: args(null) }
            }
        }
    }

    private methodCall(target: CallTarget, recv: H.Expr, name: string, args: H.Expr[], ty: Ty, span: Span): H.Expr {
        if (target.kind !== "method" || target.dyn || target.decl === null) return { k: "dyncall", ty, span, recv, method: target.kind === "method" && target.auto ? target.auto : name, args }
        return { k: "call", ty, span, fn: this.funName(target.decl, target.owner), args: [recv, ...args] }
    }

    /** Arguments coerced to their parameters; variadic arguments packed into a slice; missing `void` arguments filled. */
    private args(e: Extract<A.Expr, { kind: "Call" }>, info: CallInfo | undefined, decl: A.FunDecl | null): H.Expr[] {
        const params = decl?.params ?? []
        const variadicAt = params.findIndex((p) => p.variadic)
        const out: H.Expr[] = []
        const packed: (H.Expr | H.Spread)[] = []
        let spreadOnly: H.Expr | null = null
        e.args.forEach((a, i) => {
            const want = info?.args[i]
            if (variadicAt >= 0 && i >= variadicAt) {
                if (a.kind === "Spread") {
                    const s = this.expr(a.expr)
                    if (e.args.length - 1 === variadicAt) spreadOnly = s
                    else packed.push({ k: "spread", expr: s })
                } else {
                    packed.push(this.coerce(this.expr(a), want))
                }
                return
            }
            out.push(this.coerce(this.expr(a.kind === "Spread" ? a.expr : a), want))
        })
        if (variadicAt >= 0) {
            out.push(spreadOnly ?? { k: "vec", ty: T.UNKNOWN, span: e.span, elems: packed })
        } else {
            for (let i = out.length; i < params.length; i++) out.push(this.lit(null, T.VOID, e.span))   // omitted `void` arguments
        }
        return out
    }

    // ---- control flow -------------------------------------------------------------------------

    private ifExpr(e: Extract<A.Expr, { kind: "If" }>, ty: Ty): H.Expr {
        const span = e.span
        const then = this.stmts(e.then.stmts)
        const elseBlock: H.Block | null = e.else === null ? null
            : e.else.kind === "Block" ? this.stmts(e.else.stmts)
            : this.block([], this.expr(e.else))
        if (e.cond.kind === "LetCond") {
            const subject = this.expr(e.cond.value)
            return { k: "match", ty, span, subject, arms: [
                { pattern: this.pattern(e.cond.pattern, subject.ty), guard: null, body: this.blockExpr(then, ty, e.then.span) },
                { pattern: { k: "wild" }, guard: null, body: elseBlock ? this.blockExpr(elseBlock, ty, span) : this.lit(null, T.VOID, span) },
            ] }
        }
        return { k: "if", ty, span, cond: this.truthy(this.expr(e.cond)), then, else: elseBlock }
    }

    private matchExpr(e: Extract<A.Expr, { kind: "Match" }>, ty: Ty): H.Expr {
        const span = e.span
        if (e.subject === null) {
            // `match { c1 => a, c2 => b, _ => d }` → if c1 { a } else if c2 { b } else { d }
            let result: H.Expr | null = null
            for (const arm of [...e.arms].reverse()) {
                const body = this.expr(arm.body)
                if (arm.test === null) { result = body; continue }
                result = { k: "if", ty, span: arm.span, cond: this.truthy(this.expr(arm.test)), then: this.block([], body), else: result ? this.block([], result) : null }
            }
            return result ?? this.lit(null, T.VOID, span)
        }
        const subject = this.expr(e.subject)
        return {
            k: "match", ty, span, subject,
            arms: e.arms.map((a) => ({
                pattern: a.pattern ? this.pattern(a.pattern, subject.ty) : { k: "wild" },
                guard: a.guard ? this.truthy(this.expr(a.guard)) : null,
                body: this.expr(a.body),
            })),
        }
    }

    private forExpr(e: Extract<A.Expr, { kind: "For" }>, ty: Ty): H.Expr {
        const span = e.span
        const label = e.label
        const body = () => this.stmts(e.body.stmts)
        const brk: H.Expr = { k: "break", ty: T.NEVER, span, label: null, value: null }
        const loop = (b: H.Block, step: H.Block | null = null): H.Expr => ({ k: "loop", ty, span, label, body: b, step })
        const guardBreak = (cond: H.Expr): H.Stmt => ({
            k: "expr", expr: { k: "if", ty: T.VOID, span, cond: { k: "unary", ty: T.BOOL, span, op: "not", expr: cond }, then: this.block([], brk), else: null },
        })

        switch (e.form) {
            case "infinite": return loop(body())
            case "cond": {
                const b = body()
                return loop(this.block([guardBreak(this.truthy(this.expr(e.expr!))), ...b.stmts], b.value))
            }
            case "let": {
                // for let P = e { … } → loop { match e { P => { … }, _ => break } }
                const subject = this.expr(e.expr!)
                const b = body()
                const m: H.Expr = { k: "match", ty: T.VOID, span, subject, arms: [
                    { pattern: this.pattern(e.pattern!, subject.ty), guard: null, body: this.blockExpr(b, T.VOID, e.body.span) },
                    { pattern: { k: "wild" }, guard: null, body: brk },
                ] }
                return loop(this.block([{ k: "expr", expr: m }], null))
            }
            case "in": return this.forIn(e, ty, loop, guardBreak, brk)
        }
    }

    private forIn(e: Extract<A.Expr, { kind: "For" }>, ty: Ty, loop: (b: H.Block, step?: H.Block | null) => H.Expr, guardBreak: (c: H.Expr) => H.Stmt, brk: H.Expr): H.Expr {
        const span = e.span
        const iterable = this.expr(e.expr!)
        const it = T.strip(iterable.ty)
        const bindItem = (value: H.Expr, out: H.Stmt[]) => this.destructure(e.pattern!, value, out)
        const std = (name: string) => it.k === "named" && it.sym.std === true && it.sym.name === name

        // for await x in s → loop { match await s.next() { Some(x) => { … }, None => break } }
        if (e.await) {
            const call: H.Expr = it.k === "named" && it.sym.std === true
                ? { k: "call", ty: T.UNKNOWN, span, fn: `std.${it.sym.name}.next`, args: [iterable] }
                : { k: "dyncall", ty: T.UNKNOWN, span, recv: iterable, method: "next", args: [] }
            const next: H.Expr = { k: "await", ty: T.UNKNOWN, span, expr: call }
            const v = this.temp("item", T.UNKNOWN)
            const stmts: H.Stmt[] = []
            bindItem(this.ref(v, span), stmts)
            const b = this.stmts(e.body.stmts)
            const m: H.Expr = { k: "match", ty: T.VOID, span, subject: next, arms: [
                { pattern: { k: "variant", union: "std.Option", variant: "Some", fields: [{ k: "bind", local: v }] }, guard: null, body: this.blockExpr(this.block([...stmts, ...b.stmts], b.value), T.VOID, e.body.span) },
                { pattern: { k: "wild" }, guard: null, body: brk },
            ] }
            return loop(this.block([{ k: "expr", expr: m }], null))
        }

        // ranges and indexable collections: a counter with a `step` (so `continue` advances it)
        const counter = (start: H.Expr, intTy: Ty, cond: (i: H.Expr) => H.Expr, item: (i: H.Expr) => H.Expr | null, pre: H.Stmt[]): H.Expr => {
            const i = { ...this.temp("i", intTy), mutable: true }
            const iRef = this.ref(i, span)
            const stmts: H.Stmt[] = [guardBreak(cond(iRef))]
            const value = item(iRef)
            if (value !== null) bindItem(value, stmts)
            if (e.pattern2) this.destructure(e.pattern2, iRef, stmts)
            const b = this.stmts(e.body.stmts)
            const one = this.isBig(intTy) ? 1n : 1
            const step = this.block([{ k: "expr", expr: { k: "assign", ty: T.VOID, span, target: iRef, op: "+=", value: this.lit(one, intTy, span) } }], null)
            const l = loop(this.block([...stmts, ...b.stmts], b.value), step)
            return { k: "block", ty, span, block: this.block([...pre, { k: "let", local: i, value: start }], l) }
        }

        if (iterable.k === "range" && iterable.start !== null) {
            const intTy = T.prune(iterable.start.ty)
            const end = iterable.end
            const endTmp = end ? this.temp("end", end.ty) : null
            const pre: H.Stmt[] = endTmp && end ? [{ k: "let", local: endTmp, value: end }] : []
            const cmp = iterable.inclusive ? "<=" : "<"
            return counter(iterable.start, intTy,
                (i) => (endTmp ? { k: "binary", ty: T.BOOL, span, op: cmp, left: i, right: this.ref(endTmp, span) } : this.lit(true, T.BOOL, span)),
                (i) => i, pre)
        }
        if (std("Vec") || std("Array") || std("Slice")) {
            const coll = this.temp("items", iterable.ty)
            const len: H.Expr = { k: "call", ty: T.INT, span, fn: `std.${(it as Ty & { k: "named" }).sym.name}.len`, args: [this.ref(coll, span)] }
            return counter(this.lit(0, T.INT, span), T.INT,
                (i) => ({ k: "binary", ty: T.BOOL, span, op: "<", left: i, right: len }),
                (i) => ({ k: "index", ty: elemTy(iterable.ty) ?? T.UNKNOWN, span, object: this.ref(coll, span), index: i, map: false }),
                [{ k: "let", local: coll, value: iterable }])
        }

        // everything else: the iterator protocol (`iter()` unless it is already an iterator)
        const iterExpr: H.Expr = std("Iterator") || this.hasNext(it) ? iterable
            : it.k === "named" && it.sym.std === true ? { k: "call", ty: T.UNKNOWN, span, fn: `std.${it.sym.name}.iter`, args: [iterable] }
            : { k: "dyncall", ty: T.UNKNOWN, span, recv: iterable, method: "iter", args: [] }
        const iter = this.temp("iter", iterExpr.ty)
        const v = this.temp("item", T.UNKNOWN)
        const stmts: H.Stmt[] = []
        if (std("Map") && e.pattern2) {
            this.destructure(e.pattern!, { k: "field", ty: T.UNKNOWN, span, object: this.ref(v, span), name: "0" }, stmts)
            this.destructure(e.pattern2, { k: "field", ty: T.UNKNOWN, span, object: this.ref(v, span), name: "1" }, stmts)
        } else {
            bindItem(this.ref(v, span), stmts)
        }
        const b = this.stmts(e.body.stmts)
        const next: H.Expr = { k: "dyncall", ty: T.UNKNOWN, span, recv: this.ref(iter, span), method: "next", args: [] }
        const m: H.Expr = { k: "match", ty: T.VOID, span, subject: next, arms: [
            { pattern: { k: "variant", union: "std.Option", variant: "Some", fields: [{ k: "bind", local: v }] }, guard: null, body: this.blockExpr(this.block([...stmts, ...b.stmts], b.value), T.VOID, e.body.span) },
            { pattern: { k: "wild" }, guard: null, body: brk },
        ] }
        return { k: "block", ty, span, block: this.block([{ k: "let", local: iter, value: iterExpr }], loop(this.block([{ k: "expr", expr: m }], null))) }
    }

    private hasNext(t: Ty): boolean {
        if (t.k !== "named") return false
        const decl = t.sym.decl
        if (decl?.kind === "TypeDecl" && decl.body.kind === "StructBody") return decl.body.methods.some((m) => m.name === "next")
        return false
    }
}

// ---------------------------------------------------------------------------------------------

function isFloatType(t: A.Type): boolean {
    return t.kind === "TName" && t.path.length === 1 && (t.path[0] === "f64" || t.path[0] === "f32")
}

function isOptionType(t: A.Type): boolean {
    return t.kind === "TOption" || (t.kind === "TName" && t.path.length === 1 && t.path[0] === "Option")
}

function elemTy(t: Ty): Ty | undefined {
    const s = T.strip(t)
    return s.k === "named" ? s.args[0] : undefined
}

function innerTy(t: Ty): Ty {
    const s = T.strip(t)
    return s.k === "named" ? s.args[0] ?? T.UNKNOWN : T.UNKNOWN
}

function awaitedTy(t: Ty): Ty {
    return innerTy(t)
}
