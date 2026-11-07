// MinScript type checker (spec §3, §4, §5, §7, §9.5–§9.10, §10).
//
// Bidirectional: every expression is checked against an optional expected type, which drives
// literals, `[]` / `m{}` / `nil`, `_{…}`, closures, and variants inferred from the expected type
// (spec §7.6). Generic calls get fresh inference variables, bound by unification.
//
// The result is a side table: the type of every expression. The AST is not modified.
// See src/types.ts for `unknown` (gradual) and the treatment of borrows.

import type * as A from "./ast.ts"
import type { Diagnostic } from "./diagnostic.ts"
import { loadPrelude, type Prelude } from "./prelude.ts"
import type { Resolution, Sym } from "./resolve.ts"
import * as T from "./types.ts"
import type { Ty } from "./types.ts"
import type { Span } from "./token.ts"

export type CheckResult = {
    /** The type of every checked expression. */
    types: Map<A.Node, Ty>
    /** The type of every local, parameter and global that was checked. */
    symbols: Map<Sym, Ty>
    diagnostics: Diagnostic[]
}

export function checkPackage(files: A.File[], res: Resolution, prelude: Prelude = loadPrelude()): CheckResult {
    return new Checker(files, res, prelude).run()
}

// ---------------------------------------------------------------------------------------------

type TypeInfo = {
    sym: Sym
    kind: "struct" | "union" | "inter" | "alias"
    generics: Sym[]
    decl: A.TypeDecl | A.UnionDecl | A.InterDecl
    fields: Map<string, A.Field>
    variants: Map<string, A.Variant>
    /** inline methods, and methods from every impl block of the type */
    methods: MethodEntry[]
    /** interfaces the type implements (from `type X: A` and `impl A for X`), as written */
    interfaces: A.Type[]
}

type MethodEntry = {
    fun: A.FunDecl
    /** generics in scope besides the method's own: the type's, or the impl block's */
    outer: Sym[]
    /** impl block target (`impl[T] Box[T]`): unified with the receiver to bind `outer` */
    implTarget: A.Type | null
    /** interface the method comes from, for default methods */
    fromInter: Sym | null
}

type Param = { name: string, ty: Ty, variadic: boolean }

/** A function signature with its own generics instantiated. */
type Callable = { params: Param[], ret: Ty, async: boolean, bounds: { v: Ty, bounds: Ty[], span: Span | null }[] }

type FnCtx = {
    ret: Ty                     // declared result (for async functions: the value inside the Promise)
    async: boolean              // `await` allowed
    thisTy: Ty | null
    loops: { breakTy: Ty | null }[]
    isClosure: boolean
}

/** Interfaces every type implements through auto-generated code (spec §9.7). */
const AUTO_INTERFACES: ReadonlySet<string> = new Set(["Stringer", "Clone", "PartialEq", "Hash", "Copy", "PartialOrd"])
/** Prelude type-level forms, evaluated by a later version of the checker. */
const TYPE_LEVEL: ReadonlySet<string> = new Set(["KeyOf", "ElementOf", "IndexOf", "Partial", "Omit", "Pick"])

const OPERATOR_METHODS: Readonly<Record<string, string>> = { "+": "plus", "-": "minus", "*": "times", "/": "divide", "%": "remainder" }

class Checker {
    private readonly files: A.File[]
    private readonly refs: Map<A.Node, Sym>
    private readonly decls: Map<A.Node, Sym>
    private readonly deferred: Set<A.Node>
    private readonly open: Set<A.Node>
    private readonly preludeNames: Map<string, Sym>
    private readonly types = new Map<A.Node, Ty>()
    private readonly diagnostics: Diagnostic[] = []
    private readonly symTypes = new Map<Sym, Ty>()
    private readonly infos = new Map<Sym, TypeInfo>()
    private readonly implsByTarget = new Map<Sym, A.ImplDecl[]>()
    private readonly primMethods = new Map<string, MethodEntry[]>()
    private readonly implicitByOwner = new Map<A.Node, Sym[]>()
    private readonly globalsInProgress = new Set<Sym>()
    private readonly trail: { v: Ty & { k: "var" }, lit: "int" | "float" | null }[] = []
    private readonly inferSites: { v: Ty, node: A.Node, what: string }[] = []
    private nextVar = 0
    private ctx: FnCtx = { ret: T.UNKNOWN, async: false, thisTy: null, loops: [], isClosure: false }
    private selfStack: Ty[] = []

    constructor(files: A.File[], res: Resolution, prelude: Prelude) {
        this.files = files
        this.refs = new Map([...prelude.res.refs, ...res.refs])
        this.decls = new Map([...prelude.res.decls, ...res.decls])
        this.deferred = new Set([...prelude.res.deferred, ...res.deferred])
        this.open = new Set([...prelude.res.open, ...res.open])
        this.preludeNames = prelude.res.pkgScope.names
        for (const sym of [...prelude.res.symbols, ...res.symbols]) {
            if (sym.kind !== "implicit" || sym.scope.closure === null) continue
            const list = this.implicitByOwner.get(sym.scope.closure) ?? []
            if (!list.includes(sym)) list.push(sym)
            this.implicitByOwner.set(sym.scope.closure, list)
        }
        for (const file of [prelude.file, ...files]) {
            for (const item of file.items) if (item.kind === "ImplDecl") this.registerImpl(item)
        }
    }

    run(): CheckResult {
        for (const file of this.files) for (const item of file.items) this.checkItem(item)
        return { types: this.types, symbols: this.symTypes, diagnostics: this.diagnostics }
    }

    // ---- diagnostics and inference variables --------------------------------------------------

    private error(code: string, message: string, at: { span: Span } | Span): void {
        const span = "span" in at ? at.span : at
        this.diagnostics.push({ code, message, span: { ...span }, severity: "error" })
    }

    private fresh(lit: "int" | "float" | null = null): Ty {
        return { k: "var", id: this.nextVar++, ref: null, lit }
    }

    /** Inference variable whose type must be known by the end of the function (else E_CANNOT_INFER_TYPE). */
    private freshAt(node: A.Node, what: string): Ty {
        const v = this.fresh()
        this.inferSites.push({ v, node, what })
        return v
    }

    private bindVar(v: Ty & { k: "var" }, t: Ty): boolean {
        t = T.prune(t)
        if (t === v) return true
        if (t.k === "var") {
            if (v.lit !== null || t.lit !== null) {
                const lit = v.lit === "float" || t.lit === "float" ? "float" : "int"
                this.trail.push({ v: t, lit: t.lit })
                t.lit = lit
            }
            this.trail.push({ v, lit: v.lit })
            v.ref = t
            return true
        }
        if (v.lit !== null) {
            if (t.k === "unknown" || t.k === "never") { /* fine */ }
            else if (v.lit === "int" && !T.isNumeric(t)) return false
            else if (v.lit === "float" && !T.isFloat(t)) return false
        }
        if (T.occurs(v, t)) return false
        this.trail.push({ v, lit: v.lit })
        v.ref = t
        return true
    }

    private undo(mark: number): void {
        while (this.trail.length > mark) {
            const { v, lit } = this.trail.pop()!
            v.ref = null
            v.lit = lit
        }
    }

    /** Assignability with rollback on failure. */
    private tryAssign(from: Ty, to: Ty): boolean {
        const mark = this.trail.length
        if (this.assign(from, to)) return true
        this.undo(mark)
        return false
    }

    /** Reports E_TYPE_MISMATCH unless `from` is assignable to `to`. */
    private expectAssign(node: { span: Span }, from: Ty, to: Ty, what = "expected"): void {
        if (!this.tryAssign(from, to)) {
            this.error("E_TYPE_MISMATCH", `${what} \`${T.show(to)}\`, found \`${T.show(from)}\``, node)
        }
    }

    // ---- assignability (spec §7.2 coercions, §7.4 conversions, §9.5 widening) ----------------

    private assign(from: Ty, to: Ty): boolean {
        from = T.prune(from)
        to = T.prune(to)
        if (from === to) return true
        if (from.k === "unknown" || to.k === "unknown") {
            // gradual: an inference variable meeting `unknown` becomes `unknown` (no "can't infer" error)
            if (from.k === "var" && from.lit === null) this.bindVar(from, T.UNKNOWN)
            if (to.k === "var" && to.lit === null) this.bindVar(to, T.UNKNOWN)
            return true
        }
        if (from.k === "never") return true
        if (from.k === "ref") return this.assign(from.inner, to)
        if (to.k === "ref") return this.assign(from, to.inner)
        if (from.k === "var" && to.k === "named" && this.info(to.sym)?.kind === "inter") {
            // `log.println(1)`: a literal passed as `&Stringer` keeps its own (default) type
            if (from.lit !== null) return true
        }
        if (from.k === "var") return this.bindVar(from, to)
        if (to.k === "var") return this.bindVar(to, from)

        switch (to.k) {
            case "prim":
                if (from.k === "prim") return from.name === to.name || T.widens(from.name, to.name) || (T.isStringy(from) && T.isStringy(to))
                if (from.k === "lit") return this.litFits(from, to)
                if (from.k === "union") return from.members.every((m) => this.assign(m, to))
                return false
            case "lit":
                return from.k === "lit" && from.value === to.value
            case "union":
                if (from.k === "lit") return to.members.some((m) => T.prune(m).k === "lit" && (T.prune(m) as Ty & { k: "lit" }).value === from.value)
                if (from.k === "union") return from.members.every((m) => this.assign(m, to))
                return false
            case "named": {
                const info = this.info(to.sym)
                if (info?.kind === "inter" && !(from.k === "named" && from.sym === to.sym)) return this.implements(from, to)
                if (from.k === "named") {
                    if (from.sym === to.sym) return this.eqArgs(from.args, to.args)
                    // Vec[T] / Array[T, N] → Slice[T]
                    if (to.sym === this.prelude("Slice") && (from.sym === this.prelude("Vec") || from.sym === this.prelude("Array"))) {
                        return this.eqArgs([from.args[0] ?? T.UNKNOWN], [to.args[0] ?? T.UNKNOWN])
                    }
                    return false
                }
                if (from.k === "record" && info?.kind === "struct") return this.recordToStruct(from, to)
                return false
            }
            case "tuple":
                return from.k === "tuple" && from.elems.length === to.elems.length && from.elems.every((e, i) => this.assign(e, to.elems[i]!))
            case "record": {
                if (from.k === "named") {
                    const info = this.info(from.sym)
                    if (info?.kind !== "struct") return false
                    return this.assign(this.structAsRecord(from), to)
                }
                if (from.k !== "record") return false
                for (const f of to.fields) {
                    const g = from.fields.find((x) => x.name === f.name)
                    if (g === undefined) { if (!f.optional) return false; continue }
                    if (!this.assign(g.ty, f.ty)) return false
                }
                return from.fields.every((g) => to.fields.some((f) => f.name === g.name))
            }
            case "fn": {
                if (from.k !== "fn") return false
                if (from.params.length > to.params.length) return false
                for (let i = 0; i < from.params.length; i++) if (!this.assign(to.params[i]!, from.params[i]!)) return false
                if (T.prune(to.ret).k === "prim" && (T.prune(to.ret) as Ty & { k: "prim" }).name === "void") return true
                return this.assign(from.ret, to.ret)
            }
            case "ptr":
                return from.k === "ptr" && this.eqArgs([from.inner], [to.inner])
            case "param":
                return from.k === "param" && from.sym === to.sym
            case "never":
                return false
            case "meta": case "package":
                return false
        }
        return false
    }

    private eqArgs(a: Ty[], b: Ty[]): boolean {
        if (a.length !== b.length) return a.length === 0 || b.length === 0
        return a.every((x, i) => this.assign(x, b[i]!) && this.assign(b[i]!, x))
    }

    private litFits(l: Ty & { k: "lit" }, p: Ty & { k: "prim" }): boolean {
        if (typeof l.value === "string") return T.isStringy(p)
        if (typeof l.value === "boolean") return p.name === "bool"
        return T.isNumeric(p)
    }

    /** Record → named struct (spec §7.4): same field names, missing fields need a default or `T?`. */
    private recordToStruct(from: Ty & { k: "record" }, to: Ty & { k: "named" }): boolean {
        const info = this.info(to.sym)!
        const env = this.envFor(info, to.args)
        for (const [name, field] of info.fields) {
            const g = from.fields.find((f) => f.name === name)
            const fty = T.subst(this.toTy(field.type), env)
            if (g === undefined) {
                if (field.default === null && !this.isOption(fty)) return false
                continue
            }
            if (!this.assign(g.ty, fty)) return false
        }
        return from.fields.every((f) => info.fields.has(f.name))
    }

    private structAsRecord(t: Ty & { k: "named" }): Ty {
        const info = this.info(t.sym)!
        const env = this.envFor(info, t.args)
        const fields = [...info.fields.values()].map((f) => ({ name: f.name, ty: T.subst(this.toTy(f.type), env), optional: false }))
        fields.sort((a, b) => (a.name < b.name ? -1 : 1))
        return { k: "record", fields }
    }

    /** Does `t` implement interface `iface`? Unknown and unresolved types are given the benefit of the doubt. */
    private implements(t: Ty, iface: Ty & { k: "named" }): boolean {
        t = T.strip(t)
        if (AUTO_INTERFACES.has(iface.sym.name) && iface.sym.std) return true
        switch (t.k) {
            case "unknown": case "var": case "never": return true
            case "param": {
                const bounds = this.boundsOf(t.sym)
                return bounds.some((b) => b.k === "named" && (b.sym === iface.sym || this.interExtends(b.sym, iface.sym)))
            }
            case "named": {
                if (t.sym === iface.sym || this.interExtends(t.sym, iface.sym)) return true
                const info = this.info(t.sym)
                if (info === undefined) return true
                return info.interfaces.some((it) => {
                    const s = it.kind === "TName" ? this.refs.get(it) : undefined
                    return s !== undefined && (s === iface.sym || this.interExtends(s, iface.sym))
                })
            }
            default: return false
        }
    }

    private interExtends(a: Sym, b: Sym, seen = new Set<Sym>()): boolean {
        if (a === b) return true
        if (seen.has(a)) return false
        seen.add(a)
        const info = this.info(a)
        if (info?.kind !== "inter") return false
        const decl = info.decl as A.InterDecl
        const supers = [...decl.supers, ...(decl.composition ? [decl.composition] : [])]
        const flat = supers.flatMap((s) => (s.kind === "TIntersection" ? s.members : [s]))
        return flat.some((s) => {
            const sym = s.kind === "TName" ? this.refs.get(s) : undefined
            return sym !== undefined && this.interExtends(sym, b, seen)
        })
    }

    // ---- prelude and type information ---------------------------------------------------------

    private prelude(name: string): Sym | undefined {
        return this.preludeNames.get(name)
    }

    private named(name: string, args: Ty[]): Ty {
        const sym = this.prelude(name)
        return sym === undefined ? T.UNKNOWN : { k: "named", sym, args }
    }

    private option(t: Ty): Ty { return this.named("Option", [t]) }
    private isOption(t: Ty): boolean { const s = T.strip(t); return s.k === "named" && s.sym === this.prelude("Option") }
    private isResult(t: Ty): boolean { const s = T.strip(t); return s.k === "named" && s.sym === this.prelude("Result") }
    private isPromise(t: Ty): boolean { const s = T.strip(t); return s.k === "named" && s.sym === this.prelude("Promise") }

    private registerImpl(d: A.ImplDecl): void {
        if (d.target.kind !== "TName") return
        const sym = this.refs.get(d.target)
        if (sym === undefined) return
        if (sym.kind === "builtin-type") {
            const list = this.primMethods.get(sym.name) ?? []
            const outer = d.generics.map((g) => this.decls.get(g)!).filter((s) => s !== undefined)
            for (const m of d.methods) list.push({ fun: m, outer, implTarget: null, fromInter: null })
            this.primMethods.set(sym.name, list)
            return
        }
        const list = this.implsByTarget.get(sym) ?? []
        list.push(d)
        this.implsByTarget.set(sym, list)
    }

    private generics(gs: A.GenericParam[]): Sym[] {
        return gs.map((g) => this.decls.get(g)).filter((s): s is Sym => s !== undefined)
    }

    private info(sym: Sym): TypeInfo | undefined {
        const cached = this.infos.get(sym)
        if (cached !== undefined) return cached
        const decl = sym.decl
        if (decl === null || (decl.kind !== "TypeDecl" && decl.kind !== "UnionDecl" && decl.kind !== "InterDecl")) return undefined
        const generics = this.generics(decl.generics)
        const fields = new Map<string, A.Field>()
        const variants = new Map<string, A.Variant>()
        const methods: MethodEntry[] = []
        const interfaces: A.Type[] = decl.kind === "InterDecl" ? [] : [...decl.impls]
        let kind: TypeInfo["kind"]
        if (decl.kind === "TypeDecl") {
            if (decl.body.kind === "StructBody") {
                kind = "struct"
                for (const f of decl.body.fields) fields.set(f.name, f)
                for (const m of decl.body.methods) methods.push({ fun: m, outer: generics, implTarget: null, fromInter: null })
            } else {
                kind = "alias"
            }
        } else if (decl.kind === "UnionDecl") {
            kind = "union"
            for (const v of decl.variants) variants.set(v.name, v)
            for (const m of decl.methods) methods.push({ fun: m, outer: generics, implTarget: null, fromInter: null })
        } else {
            kind = "inter"
            for (const m of decl.methods ?? []) methods.push({ fun: m, outer: generics, implTarget: null, fromInter: sym })
        }
        const info: TypeInfo = { sym, kind, generics, decl, fields, variants, methods, interfaces }
        this.infos.set(sym, info)
        for (const impl of this.implsByTarget.get(sym) ?? []) {
            const outer = this.generics(impl.generics)
            for (const m of impl.methods) methods.push({ fun: m, outer, implTarget: impl.target, fromInter: null })
            interfaces.push(...impl.interfaces)
        }
        // default methods of implemented interfaces
        for (const it of interfaces) {
            const isym = it.kind === "TName" ? this.refs.get(it) : undefined
            const iinfo = isym ? this.info(isym) : undefined
            if (iinfo === undefined) continue
            for (const m of iinfo.methods) if (m.fun.body !== null) methods.push({ ...m, implTarget: it, outer: iinfo.generics })
        }
        return info
    }

    private envFor(info: TypeInfo, args: Ty[]): Map<Sym, Ty> {
        const env = new Map<Sym, Ty>()
        info.generics.forEach((g, i) => env.set(g, args[i] ?? T.UNKNOWN))
        return env
    }

    private boundsOf(sym: Sym): Ty[] {
        const decl = sym.decl
        if (decl === null || decl.kind !== "GenericParam") return []
        return decl.bounds.map((b) => this.toTy(b))
    }

    // ---- A.Type → Ty --------------------------------------------------------------------------

    private toTy(t: A.Type, depth = 0): Ty {
        switch (t.kind) {
            case "TName": {
                if (t.path[0] === "Self" && t.path.length === 1) return this.selfStack[this.selfStack.length - 1] ?? T.UNKNOWN
                const sym = this.refs.get(t)
                if (sym === undefined || t.path.length > 1 && (sym.kind === "package" || sym.kind === "import")) return T.UNKNOWN
                const args = t.args.map((a) => this.toTy(a, depth))
                switch (sym.kind) {
                    case "builtin-type":
                        if (sym.name === "never") return T.NEVER
                        if (sym.name === "byte") return T.prim("u8")
                        return T.prim(sym.name as T.PrimName)
                    case "generic": return { k: "param", sym }
                    case "type": case "union": case "inter": {
                        if (TYPE_LEVEL.has(sym.name) && sym.std) return T.UNKNOWN
                        const info = this.info(sym)
                        if (info?.kind === "alias" && depth < 20) {
                            const decl = info.decl as A.TypeDecl
                            const saved = this.selfStack
                            return T.subst(this.toTy(decl.body as A.Type, depth + 1), this.envFor(info, args)) ?? saved
                        }
                        return { k: "named", sym, args: this.fillArgs(info, args) }
                    }
                    default: return T.UNKNOWN
                }
            }
            case "TOption": return this.option(this.toTy(t.inner, depth))
            case "TRef": return { k: "ref", mut: t.mut, inner: this.toTy(t.inner, depth) }
            case "TPtr": return { k: "ptr", mut: t.mut, inner: this.toTy(t.inner, depth) }
            case "TTuple": return t.elems.length === 0 ? T.VOID : { k: "tuple", elems: t.elems.map((e) => this.toTy(e, depth)) }
            case "TRecord": {
                const fields = t.fields.map((f) => ({ name: f.name, ty: this.toTy(f.type, depth), optional: false }))
                fields.sort((a, b) => (a.name < b.name ? -1 : 1))
                return { k: "record", fields }
            }
            case "TFn": return { k: "fn", params: t.params.map((p) => this.toTy(p, depth)), ret: this.toTy(t.ret, depth), async: false }
            case "TLiteral": return { k: "lit", value: t.value }
            case "TUnion": return { k: "union", members: t.members.map((m) => this.toTy(m, depth)) }
            case "TTypeOf": {
                const sym = this.refs.get(t)
                return sym?.kind === "global" ? this.globalType(sym) : T.UNKNOWN
            }
            case "TIntersection": case "TError": return T.UNKNOWN
        }
    }

    /** Missing type arguments become fresh variables (`Vec` in `Vec.new()`). */
    private fillArgs(info: TypeInfo | undefined, args: Ty[]): Ty[] {
        if (info === undefined || args.length >= info.generics.length) return args
        return [...args, ...info.generics.slice(args.length).map(() => this.fresh())]
    }

    // ---- signatures ---------------------------------------------------------------------------

    /** The signature of `f` with `env` applied to its outer generics and fresh variables for its own. */
    private callable(f: A.FunDecl, env: Map<Sym, Ty>, selfTy: Ty | null, explicit: Ty[] | null, at: { span: Span } | null): Callable {
        const own = this.generics(f.generics)
        const full = new Map(env)
        if (explicit !== null && explicit.length !== own.length && at !== null) {
            this.error("E_ARG_COUNT", `\`${f.name}\` takes ${own.length} type argument${own.length === 1 ? "" : "s"}, found ${explicit.length}`, at)
        }
        own.forEach((g, i) => full.set(g, explicit?.[i] ?? this.fresh()))
        if (selfTy !== null) this.selfStack.push(selfTy)
        try {
            const params = f.params.map((p) => {
                let ty = T.subst(this.toTy(p.type), full)
                if (p.variadic) ty = { k: "named", sym: this.prelude("Slice")!, args: [ty] }
                return { name: p.name, ty, variadic: p.variadic }
            })
            let ret = f.ret ? T.subst(this.toTy(f.ret), full) : T.VOID
            if (f.async) ret = this.named("Promise", [ret])
            const bounds = own.map((g) => ({ v: full.get(g)!, bounds: this.boundsOf(g).map((b) => T.subst(b, full)), span: at?.span ?? null }))
            return { params, ret, async: f.async, bounds }
        } finally {
            if (selfTy !== null) this.selfStack.pop()
        }
    }

    private fnType(c: Callable): Ty {
        return { k: "fn", params: c.params.map((p) => p.ty), ret: c.ret, async: c.async }
    }

    /** Finds method `name` on `recv` (a value of that type). */
    private findMethod(recv: Ty, name: string, explicit: Ty[] | null, at: { span: Span }): Callable | null {
        const t = T.strip(recv)
        if (t.k === "named") {
            const info = this.info(t.sym)
            if (info !== undefined) {
                for (const m of info.methods) {
                    if (m.fun.name !== name) continue
                    return this.methodCallable(m, info, t, explicit, at)
                }
            }
        }
        if (t.k === "prim" && (t.name === "string" || t.name === "str")) {
            const m = (this.primMethods.get("string") ?? []).find((x) => x.fun.name === name)
            if (m) return this.callable(m.fun, new Map(), t, explicit, at)
        } else if (t.k === "prim") {
            const m = (this.primMethods.get(t.name) ?? []).find((x) => x.fun.name === name)
            if (m) return this.callable(m.fun, new Map(), t, explicit, at)
        }
        if (t.k === "param") {
            for (const b of this.boundsOf(t.sym)) {
                const bs = T.strip(b)
                if (bs.k !== "named") continue
                const info = this.info(bs.sym)
                const m = info?.methods.find((x) => x.fun.name === name)
                if (info && m) return this.callable(m.fun, this.envFor(info, bs.args), t, explicit, at)   // Self = the parameter
            }
        }
        return this.autoMethod(t, name)
    }

    private methodCallable(m: MethodEntry, info: TypeInfo, recv: Ty & { k: "named" }, explicit: Ty[] | null, at: { span: Span }): Callable {
        let env: Map<Sym, Ty>
        if (m.implTarget !== null && m.fromInter === null) {
            // impl[T] Box[T] { … }: bind the impl's generics by unifying its target with the receiver
            env = new Map(m.outer.map((g) => [g, this.fresh()]))
            this.tryAssign(recv, T.subst(this.toTy(m.implTarget), env))
        } else if (m.fromInter !== null && m.fromInter !== info.sym && m.implTarget !== null) {
            // a default method of an implemented interface: bind the interface's generics from `impl I[X] for T`
            const it = this.toTy(m.implTarget)
            env = new Map(m.outer.map((g, i) => [g, it.k === "named" ? it.args[i] ?? T.UNKNOWN : T.UNKNOWN]))
        } else {
            env = this.envFor(info, recv.args)
        }
        return this.callable(m.fun, env, recv, explicit, at)
    }

    /** Auto-generated methods every type has (spec §9.7). */
    private autoMethod(t: Ty, name: string): Callable | null {
        const sig = (params: Ty[], ret: Ty): Callable => ({ params: params.map((ty, i) => ({ name: `p${i}`, ty, variadic: false })), ret, async: false, bounds: [] })
        switch (name) {
            case "to_str": return sig([], T.STRING)
            case "clone": return sig([], t)
            case "eq": return sig([t], T.BOOL)
            case "hash": return sig([], T.prim("u64"))
            default: return null
        }
    }

    /** Static member of a type: a method without receiver, or a variant. */
    private findStatic(t: Ty, name: string, explicit: Ty[] | null, at: { span: Span }): Callable | Ty | null {
        t = T.prune(t)
        if (t.k !== "named") return null
        const info = this.info(t.sym)
        if (info === undefined) return null
        const variant = info.variants.get(name)
        if (variant !== undefined) return this.variantType(info, t, variant)
        for (const m of info.methods) {
            if (m.fun.name !== name) continue
            // `.[T]` on a static method without generics of its own supplies the type's (`Topic.new.[string]()`)
            if (explicit !== null && m.fun.generics.length === 0) {
                this.eqArgs(t.args, explicit)
                return this.methodCallable(m, info, t, null, at)
            }
            return this.methodCallable(m, info, t, explicit, at)
        }
        return null
    }

    /** A variant as a value: the union itself (unit variant) or its constructor. */
    private variantType(info: TypeInfo, t: Ty & { k: "named" }, v: A.Variant): Ty | Callable {
        const env = this.envFor(info, t.args)
        if (v.tuple !== null) {
            const params = v.tuple.map((p, i) => ({ name: `${i}`, ty: T.subst(this.toTy(p), env), variadic: false }))
            return { params, ret: t, async: false, bounds: [] }
        }
        return t
    }

    private globalType(sym: Sym): Ty {
        const known = this.symTypes.get(sym)
        if (known !== undefined) return known
        const decl = sym.decl
        if (decl === null || decl.kind !== "LetDecl") return T.UNKNOWN
        if (decl.type) {
            const ty = this.toTy(decl.type)
            this.symTypes.set(sym, ty)
            return ty
        }
        if (this.globalsInProgress.has(sym)) return T.UNKNOWN
        this.globalsInProgress.add(sym)
        const saved = this.ctx
        this.ctx = { ret: T.UNKNOWN, async: false, thisTy: null, loops: [], isClosure: false }
        const ty = this.checkExpr(decl.value)
        this.ctx = saved
        this.symTypes.set(sym, ty)
        return ty
    }

    private funType(sym: Sym, explicit: Ty[] | null, at: { span: Span }): { c: Callable } | null {
        const decl = sym.decl
        if (decl === null || decl.kind !== "FunDecl") return null
        return { c: this.callable(decl, new Map(), null, explicit, at) }
    }

    // ---- items --------------------------------------------------------------------------------

    private checkItem(item: A.Item): void {
        switch (item.kind) {
            case "FunDecl": return this.checkFun(item, new Map(), null)
            case "LetDecl": {
                const sym = this.decls.get(item)
                if (sym === undefined) return
                if (item.type) {
                    const ty = this.toTy(item.type)
                    this.symTypes.set(sym, ty)
                    this.withFn({ ret: T.UNKNOWN, async: false, thisTy: null, loops: [], isClosure: false }, () => {
                        this.expectAssign(item.value, this.checkExpr(item.value, ty), ty)
                    })
                } else {
                    this.globalType(sym)
                }
                return
            }
            case "ExternDecl": return
            case "TypeDecl": case "UnionDecl": {
                const sym = this.decls.get(item)
                const info = sym ? this.info(sym) : undefined
                if (sym === undefined || info === undefined) return
                const self: Ty = { k: "named", sym, args: info.generics.map((g) => ({ k: "param", sym: g })) }
                this.selfStack.push(self)
                try {
                    for (const f of info.fields.values()) {
                        if (f.default !== null) {
                            const fty = this.toTy(f.type)
                            this.withFn({ ret: T.UNKNOWN, async: false, thisTy: null, loops: [], isClosure: false }, () => {
                                this.expectAssign(f.default!, this.checkExpr(f.default!, fty), fty)
                            })
                        }
                    }
                    const methods = item.kind === "TypeDecl" ? (item.body.kind === "StructBody" ? item.body.methods : []) : item.methods
                    for (const m of methods) this.checkFun(m, new Map(), self)
                } finally {
                    this.selfStack.pop()
                }
                this.checkInterfaces(info, self, item.impls, item)
                return
            }
            case "InterDecl": {
                const sym = this.decls.get(item)
                if (sym === undefined) return
                const self: Ty = { k: "param", sym }
                this.selfStack.push(self)
                try {
                    for (const m of item.methods ?? []) if (m.body !== null) this.checkFun(m, new Map(), self)
                } finally {
                    this.selfStack.pop()
                }
                return
            }
            case "ImplDecl": {
                const target = this.toTy(item.target)
                this.selfStack.push(target)
                try {
                    for (const m of item.methods) this.checkFun(m, new Map(), target)
                } finally {
                    this.selfStack.pop()
                }
                const tsym = item.target.kind === "TName" ? this.refs.get(item.target) : undefined
                const info = tsym ? this.info(tsym) : undefined
                if (info !== undefined) this.checkInterfaces(info, target, item.interfaces, item)
                return
            }
        }
    }

    /** Every method without a default body must be implemented (E_MISSING_METHOD). */
    private checkInterfaces(info: TypeInfo, _self: Ty, ifaces: A.Type[], at: A.Node): void {
        for (const it of ifaces) {
            const isym = it.kind === "TName" ? this.refs.get(it) : undefined
            const iinfo = isym ? this.info(isym) : undefined
            if (isym === undefined || iinfo === undefined || iinfo.kind !== "inter") continue
            if (isym.std && AUTO_INTERFACES.has(isym.name)) continue
            for (const m of iinfo.methods) {
                if (m.fun.body !== null) continue
                if (!info.methods.some((x) => x.fun.name === m.fun.name && x.fromInter === null)) {
                    this.error("E_MISSING_METHOD", `\`${info.sym.name}\` implements \`${isym.name}\` but doesn't define \`${m.fun.name}\``, at.kind === "ImplDecl" ? it : at)
                }
            }
        }
    }

    private withFn<R>(ctx: FnCtx, fn: () => R): R {
        const saved = this.ctx
        this.ctx = ctx
        try { return fn() } finally { this.ctx = saved }
    }

    private checkFun(f: A.FunDecl, env: Map<Sym, Ty>, selfTy: Ty | null): void {
        if (f.body === null) return
        const own = new Map(env)
        if (selfTy !== null) this.selfStack.push(selfTy)
        try {
            for (const p of f.params) {
                const sym = this.decls.get(p)
                let ty = T.subst(this.toTy(p.type), own)
                if (p.variadic) ty = { k: "named", sym: this.prelude("Slice")!, args: [ty] }
                if (sym) this.symTypes.set(sym, ty)
            }
            const ret = f.ret ? T.subst(this.toTy(f.ret), own) : T.VOID
            const isMain = f.name === "main" && selfTy === null
            const sites = this.inferSites.length
            this.withFn({ ret, async: f.async || isMain, thisTy: f.receiver !== null ? selfTy : null, loops: [], isClosure: false }, () => {
                this.checkBody(f.body!, ret)
            })
            this.finishInference(sites)
        } finally {
            if (selfTy !== null) this.selfStack.pop()
        }
    }

    /** A function or closure body: its value must match the declared result (spec §4.1). */
    private checkBody(body: A.Block, ret: Ty): Ty {
        const isVoid = T.prune(ret).k === "prim" && (T.prune(ret) as Ty & { k: "prim" }).name === "void"
        const value = this.checkStmts(body.stmts, isVoid ? undefined : ret)
        if (isVoid) return value
        const last = body.stmts[body.stmts.length - 1]
        if (value.k === "prim" && value.name === "void" && last?.kind === "ExprStmt" && last.semi && T.prune(this.types.get(last.expr) ?? T.VOID).k !== "never") {
            this.error("E_INVALID_BLOCK_VALUE", `the body must end with a value of type \`${T.show(ret)}\`; the trailing \`;\` discards it`, last)
            return value
        }
        const at: { span: Span } = last?.kind === "ExprStmt" ? last.expr : body
        this.expectAssign(at, value, ret, "the body should produce")
        return value
    }

    /** Defaults numeric literals and reports types that are still unknown (E_CANNOT_INFER_TYPE). */
    private finishInference(from: number): void {
        const reported = new Set<A.Node>()
        for (const site of this.inferSites.splice(from)) {
            for (const v of T.freeVars(site.v)) {
                if (v.lit !== null) continue
                v.ref = T.UNKNOWN
                if (reported.has(site.node)) break         // one diagnostic per literal (`m{}` has keys and values)
                reported.add(site.node)
                this.error("E_CANNOT_INFER_TYPE", `can't infer the type of ${site.what}: add a type annotation, \`as T\`, or \`.[T]\``, site.node)
                break
            }
        }
        // remaining numeric literals default to int / f64 (spec §1.5)
        for (const ty of this.types.values()) {
            for (const v of T.freeVars(ty)) if (v.lit !== null) v.ref = v.lit === "float" ? T.F64 : T.INT
        }
    }

    // ---- statements ---------------------------------------------------------------------------

    /** Checks statements; returns the block's value type (spec §4.1). */
    private checkStmts(stmts: A.Stmt[], expectedLast?: Ty): Ty {
        let value: Ty = T.VOID
        let diverged = false
        stmts.forEach((s, i) => {
            const isLast = i === stmts.length - 1
            if (s.kind === "ExprStmt") {
                const ty = this.checkExpr(s.expr, isLast && !s.semi ? expectedLast : undefined)
                if (T.prune(ty).k === "never") diverged = true
                value = isLast && !s.semi ? ty : T.VOID
                return
            }
            value = T.VOID
            let ty: Ty
            if (s.type !== null) {
                ty = this.toTy(s.type)
                this.expectAssign(s.value, this.checkExpr(s.value, ty), ty)
            } else {
                ty = this.checkExpr(s.value)
            }
            if (s.else !== null) {
                const elseTy = this.checkStmts(s.else.stmts)
                if (T.prune(elseTy).k !== "never" && !this.blockDiverges(s.else)) {
                    this.error("E_LET_ELSE_MUST_DIVERGE", "the `else` block of `let … else` must leave the scope: `return`, `break`, `continue` or `panic(…)`", s.else)
                }
            }
            this.bindPattern(s.pattern, ty)
        })
        return diverged && value.k === "prim" && value.name === "void" ? T.NEVER : value
    }

    private blockDiverges(b: A.Block): boolean {
        return b.stmts.some((s) => s.kind === "ExprStmt" && T.prune(this.types.get(s.expr) ?? T.VOID).k === "never")
    }

    // ---- expressions --------------------------------------------------------------------------

    checkExpr(e: A.Expr, expected?: Ty): Ty {
        const ty = this.exprInner(e, expected)
        this.types.set(e, ty)
        return ty
    }

    private exprInner(e: A.Expr, exp?: Ty): Ty {
        switch (e.kind) {
            case "Ident": return this.checkIdent(e, exp)
            case "This": return this.ctx.thisTy ?? T.UNKNOWN
            case "Int": return this.checkInt(e, exp)
            case "Float": {
                const x = exp ? T.strip(exp) : null
                if (x && T.isFloat(x)) return x
                return this.fresh("float")
            }
            case "Str": {
                const x = exp ? T.strip(exp) : null
                if (x && (x.k === "lit" || x.k === "union")) {
                    const lit: Ty = { k: "lit", value: e.value }
                    if (this.tryAssign(lit, x)) return x
                }
                return T.STRING
            }
            case "Char": return T.CHAR
            case "Bool": return T.BOOL
            case "Nil": {
                const x = exp ? T.strip(exp) : null
                if (x && this.isOption(x)) return x
                return this.option(this.freshAt(e, "`nil`"))
            }
            case "Template":
                for (const p of e.parts) if (typeof p !== "string") this.checkExpr(p)
                return T.STRING
            case "Paren": return this.checkExpr(e.expr, exp)
            case "Vec": return this.checkVec(e, exp)
            case "Array": {
                const x = exp ? T.strip(exp) : null
                const elem = x?.k === "named" && x.sym === this.prelude("Array") ? x.args[0]! : this.freshAt(e, "the array's elements")
                this.checkElems(e.elems, elem, "Array")
                return this.named("Array", [elem, { k: "lit", value: BigInt(e.elems.length) }])
            }
            case "Tuple": {
                const x = exp ? T.strip(exp) : null
                const elems = e.elems.map((el, i) => this.checkExpr(el.kind === "Spread" ? el.expr : el, x?.k === "tuple" ? x.elems[i] : undefined))
                return elems.length === 0 ? T.VOID : { k: "tuple", elems }
            }
            case "Set": {
                const x = exp ? T.strip(exp) : null
                const elem = x?.k === "named" && x.sym === this.prelude("Set") ? x.args[0]! : this.freshAt(e, "the set's elements")
                this.checkElems(e.elems, elem, "Set")
                return this.named("Set", [elem])
            }
            case "Map": return this.checkMap(e, exp)
            case "Record": return this.checkRecord(e, exp)
            case "Inferred": return this.checkInferred(e, exp)
            case "StructLit": return this.checkStructLit(e, exp)
            case "Closure": return this.checkClosure(e, exp)
            case "Unary": return this.checkUnary(e, exp)
            case "Await": {
                if (!this.ctx.async) this.error("E_AWAIT_OUTSIDE_ASYNC", "`await` is only allowed in an `async fun` (or `main`)", e)
                const t = this.checkExpr(e.expr)
                return this.awaited(t, e.expr)
            }
            case "Binary": return this.checkBinary(e, exp)
            case "Assign": return this.checkAssign(e)
            case "Range": {
                let elem: Ty = this.fresh("int")
                if (e.start) elem = this.checkExpr(e.start, elem)
                if (e.end) this.expectAssign(e.end, this.checkExpr(e.end, elem), elem)
                return this.named("Range", [elem])
            }
            case "As": return this.checkAs(e)
            case "Or": return this.checkOr(e)
            case "Member": case "OptMember": return this.checkMember(e, exp)
            case "Call": return this.checkCall(e, exp)
            case "Index": return this.checkIndex(e)
            case "GenericApply": return this.checkGenericValue(e)
            case "Try": return this.checkTry(e)
            case "If": return this.checkIf(e, exp)
            case "Match": return this.checkMatch(e, exp)
            case "Select": return this.checkSelect(e, exp)
            case "For": return this.checkFor(e)
            case "Block": return this.checkStmts(e.stmts, exp)
            case "Unsafe": return this.checkStmts(e.body.stmts, exp)
            case "Recover": {
                const x = exp ? T.strip(exp) : null
                const inner = x !== null && this.isResult(x) ? (x as Ty & { k: "named" }).args[0] : undefined
                const v = this.checkStmts(e.body.stmts, inner)
                return this.named("Result", [T.prune(v).k === "never" ? (inner ?? T.VOID) : v, this.named("Panic", [])])
            }
            case "Return": {
                if (e.value !== null) {
                    const want = this.ctx.ret
                    this.expectAssign(e.value, this.checkExpr(e.value, want), want, "the function returns")
                } else if (!this.isVoid(this.ctx.ret) && T.prune(this.ctx.ret).k !== "unknown" && T.prune(this.ctx.ret).k !== "var") {
                    this.error("E_TYPE_MISMATCH", `\`return\` needs a value of type \`${T.show(this.ctx.ret)}\``, e)
                } else if (T.prune(this.ctx.ret).k === "var") {
                    this.tryAssign(T.VOID, this.ctx.ret)
                }
                return T.NEVER
            }
            case "Break": {
                const loop = this.ctx.loops[this.ctx.loops.length - 1]
                if (e.value !== null) {
                    const ty = this.checkExpr(e.value, loop?.breakTy ?? undefined)
                    if (loop !== undefined) {
                        if (loop.breakTy === null) loop.breakTy = ty
                        else this.expectAssign(e.value, ty, loop.breakTy)
                    }
                }
                return T.NEVER
            }
            case "Continue": return T.NEVER
            case "Error": return T.UNKNOWN
        }
    }

    private isVoid(t: Ty): boolean {
        t = T.prune(t)
        return t.k === "prim" && t.name === "void"
    }

    private checkInt(e: Extract<A.Expr, { kind: "Int" }>, exp?: Ty): Ty {
        const x = exp ? T.strip(exp) : null
        if (x && x.k === "prim" && T.isNumeric(x)) {
            this.checkIntRange(e, e.value, x.name)
            return x
        }
        if (x && (x.k === "lit" || x.k === "union")) {
            const lit: Ty = { k: "lit", value: e.value }
            if (this.tryAssign(lit, x)) return x
        }
        return this.fresh("int")
    }

    private checkIntRange(node: { span: Span }, value: bigint, name: string, negated = false): void {
        const range = T.INT_RANGE[name]
        if (range === undefined) return
        const v = negated ? -value : value
        if (v < range[0] || v > range[1]) this.error("E_INT_OUT_OF_RANGE", `\`${v}\` doesn't fit in \`${name}\` (${range[0]} to ${range[1]})`, node)
    }

    private checkElems(elems: (A.Expr | A.Spread)[], elem: Ty, kind: string): void {
        for (const el of elems) {
            if (el.kind === "Spread") {
                const t = this.checkExpr(el.expr)
                const s = T.strip(t)
                if (s.k === "named" && s.args.length > 0) this.expectAssign(el.expr, s.args[0]!, elem)
                else if (s.k !== "unknown") this.error("E_TYPE_MISMATCH", `\`...\` in a ${kind} literal needs a collection, found \`${T.show(t)}\``, el.expr)
                continue
            }
            this.expectAssign(el, this.checkExpr(el, elem), elem)
        }
    }

    private checkVec(e: Extract<A.Expr, { kind: "Vec" }>, exp?: Ty): Ty {
        const x = exp ? T.strip(exp) : null
        let elem: Ty
        if (x?.k === "unknown") elem = this.fresh()
        else if (x?.k === "named" && (x.sym === this.prelude("Vec") || x.sym === this.prelude("Slice"))) elem = x.args[0] ?? this.fresh()
        else elem = this.freshAt(e, "the elements of `[]`")
        this.checkElems(e.elems, elem, "Vec")
        return this.named("Vec", [elem])
    }

    private checkMap(e: Extract<A.Expr, { kind: "Map" }>, exp?: Ty): Ty {
        const x = exp ? T.strip(exp) : null
        const ok = x?.k === "named" && x.sym === this.prelude("Map")
        const loose = x?.k === "unknown"
        const key = ok ? x.args[0]! : loose ? this.fresh() : this.freshAt(e, "the keys of `m{}`")
        const val = ok ? x.args[1]! : loose ? this.fresh() : this.freshAt(e, "the values of `m{}`")
        for (const en of e.entries) {
            if (en.kind === "Spread") { this.checkExpr(en.expr, this.named("Map", [key, val])); continue }
            this.expectAssign(en.key, this.checkExpr(en.key, key), key)
            this.expectAssign(en.value, this.checkExpr(en.value, val), val)
        }
        return this.named("Map", [key, val])
    }

    // ---- names --------------------------------------------------------------------------------

    private checkIdent(e: Extract<A.Expr, { kind: "Ident" }>, exp?: Ty): Ty {
        const sym = this.refs.get(e)
        if (sym === undefined) {
            if (this.deferred.has(e) && !this.open.has(e)) return this.inferVariantValue(e, e.name, exp)
            return T.UNKNOWN
        }
        return this.symValue(sym, e, exp)
    }

    private symValue(sym: Sym, at: A.Node, exp?: Ty): Ty {
        switch (sym.kind) {
            case "local": case "param": case "closure-param": case "implicit":
                return this.symTypes.get(sym) ?? T.UNKNOWN
            case "this": return this.ctx.thisTy ?? T.UNKNOWN
            case "fun": case "extern-fun": {
                const f = this.funType(sym, null, at)
                return f ? this.fnType(f.c) : T.UNKNOWN
            }
            case "global": return this.globalType(sym)
            case "type": case "union": case "inter": {
                const info = this.info(sym)
                return { k: "meta", ty: { k: "named", sym, args: this.fillArgs(info, []) } }
            }
            case "builtin-type": return { k: "meta", ty: sym.name === "never" ? T.NEVER : T.prim(sym.name as T.PrimName) }
            case "generic": return { k: "meta", ty: { k: "param", sym } }
            case "variant": {
                const owner = sym.owner
                const info = owner ? this.info(owner) : undefined
                const decl = sym.decl
                if (owner === undefined || info === undefined || decl === null || decl.kind !== "Variant") return T.UNKNOWN
                const x = exp ? T.strip(exp) : null
                const t: Ty & { k: "named" } = x?.k === "named" && x.sym === owner ? x : { k: "named", sym: owner, args: info.generics.map(() => this.fresh()) }
                const v = this.variantType(info, t, decl)
                return isCallable(v) ? this.fnType(v) : v
            }
            case "package": case "import": return { k: "package", name: sym.name }
            case "prelude-type": case "prelude-value": return T.UNKNOWN
        }
    }

    /**
     * A bare uppercase name the resolver couldn't bind: a variant of the expected union (spec §7.6).
     * Returns the variant's value (unit) or constructor (payload); E_CANNOT_INFER_VARIANT otherwise.
     */
    private inferVariantValue(at: A.Node, name: string, exp?: Ty): Ty {
        if (exp !== undefined && T.strip(exp).k === "unknown") return T.UNKNOWN
        const found = this.expectedVariant(name, exp)
        if (found === null) {
            this.error("E_CANNOT_INFER_VARIANT", `unknown name \`${name}\`: no variant \`${name}\` in the expected type${exp ? ` \`${T.show(exp)}\`` : ""}; qualify it (\`Type.${name}\`)`, at)
            return T.UNKNOWN
        }
        const v = this.variantType(found.info, found.t, found.v)
        return isCallable(v) ? this.fnType(v) : v
    }

    private expectedVariant(name: string, exp?: Ty): { info: TypeInfo, t: Ty & { k: "named" }, v: A.Variant } | null {
        if (exp === undefined) return null
        const x = T.strip(exp)
        if (x.k !== "named") return null
        const info = this.info(x.sym)
        const v = info?.variants.get(name)
        if (info === undefined || v === undefined) return null
        return { info, t: x, v }
    }

    // ---- operators ----------------------------------------------------------------------------

    private checkTruthy(e: A.Expr, t: Ty): void {
        const s = T.strip(t)
        if (s.k === "unknown" || s.k === "var" || s.k === "never") return
        if (s.k === "prim" && s.name === "bool") return
        if (this.isOption(s) || this.isResult(s)) return
        this.error("E_NOT_TRUTHY", `a condition must be \`bool\`, an Option or a Result, found \`${T.show(t)}\`${T.isNumeric(s) ? ": compare explicitly, e.g. `n != 0`" : T.isStringy(s) ? ": use `!s.is_empty()`" : ""}`, e)
    }

    private checkUnary(e: Extract<A.Expr, { kind: "Unary" }>, exp?: Ty): Ty {
        switch (e.op) {
            case "-": {
                if (e.expr.kind === "Int" && exp !== undefined && T.isNumeric(T.strip(exp))) {
                    const x = T.strip(exp) as Ty & { k: "prim" }
                    this.checkIntRange(e, e.expr.value, x.name, true)
                    this.types.set(e.expr, x)
                    return x
                }
                const t = this.checkExpr(e.expr, exp)
                const s = T.strip(t)
                if (s.k === "var" || s.k === "unknown" || T.isNumeric(s)) return t
                if (s.k === "named" && this.findMethod(s, "neg", null, e)) return t
                this.error("E_INVALID_OPERANDS", `\`-\` needs a number, found \`${T.show(t)}\``, e)
                return T.UNKNOWN
            }
            case "!": {
                const t = this.checkExpr(e.expr)
                if (T.isInt(T.strip(t))) return t       // bitwise not
                this.checkTruthy(e.expr, t)
                return T.BOOL
            }
            case "&": case "&mut": {
                const x = exp ? T.prune(exp) : null
                const t = this.checkExpr(e.expr, x?.k === "ref" ? x.inner : undefined)
                return { k: "ref", mut: e.op === "&mut", inner: t }
            }
            case "*": {
                const t = T.prune(this.checkExpr(e.expr))
                if (t.k === "ptr" || t.k === "ref") return t.inner
                if (t.k !== "unknown" && t.k !== "var") this.error("E_INVALID_OPERANDS", `\`*\` dereferences a pointer, found \`${T.show(t)}\``, e)
                return T.UNKNOWN
            }
        }
    }

    private checkBinary(e: Extract<A.Expr, { kind: "Binary" }>, exp?: Ty): Ty {
        const op = e.op
        if (op === "&&" || op === "||") {
            this.checkTruthy(e.left, this.checkExpr(e.left))
            this.checkTruthy(e.right, this.checkExpr(e.right))
            return T.BOOL
        }
        if (op === "??") return this.checkNullish(e, exp)

        const l = this.checkExpr(e.left, (op === "+" || op === "-" || op === "*" || op === "/" || op === "%") ? exp : undefined)
        const r = this.checkExpr(e.right, l)
        const ls = T.strip(l), rs = T.strip(r)
        if (ls.k === "unknown" || rs.k === "unknown") return ["==", "!=", "<", "<=", ">", ">="].includes(op) ? T.BOOL : T.UNKNOWN

        if (["==", "!=", "<", "<=", ">", ">="].includes(op)) {
            if (!this.tryAssign(r, l) && !this.tryAssign(l, r)) {
                this.error("E_TYPE_MISMATCH", `can't compare \`${T.show(l)}\` with \`${T.show(r)}\``, e)
            }
            return T.BOOL
        }

        const numericish = (t: Ty) => T.isNumeric(t) || (t.k === "var" && t.lit !== null)
        if (op === "+" && T.isStringy(ls) && T.isStringy(rs)) return T.STRING
        if (["+", "-", "*", "/", "%"].includes(op) && numericish(ls) && numericish(rs)) return this.numericResult(e, l, r)
        if (["&", "|", "^", "<<", ">>"].includes(op)) {
            const intish = (t: Ty) => T.isInt(t) || (t.k === "var" && t.lit === "int")
            if (intish(ls) && intish(rs)) return op === "<<" || op === ">>" ? l : this.numericResult(e, l, r)
            this.error("E_INVALID_OPERANDS", `\`${op}\` needs integers, found \`${T.show(l)}\` and \`${T.show(r)}\``, e)
            return T.UNKNOWN
        }
        // operator interfaces (Plus, Minus, …)
        const method = OPERATOR_METHODS[op]
        if (method !== undefined && ls.k !== "var") {
            const c = this.findMethod(ls, method, null, e)
            if (c !== null && c.params.length === 1) {
                this.expectAssign(e.right, r, c.params[0]!.ty)
                return c.ret
            }
        }
        if ((ls.k === "var" && ls.lit === null) || (rs.k === "var" && rs.lit === null)) return T.UNKNOWN
        this.error("E_INVALID_OPERANDS", `\`${op}\` can't be applied to \`${T.show(l)}\` and \`${T.show(r)}\``, e)
        return T.UNKNOWN
    }

    /** Arithmetic on numbers: same type, or the wider one when one side widens losslessly (spec §9.5). */
    private numericResult(e: A.Expr, l: Ty, r: Ty): Ty {
        if (this.tryAssign(r, l)) return l
        if (this.tryAssign(l, r)) return r
        this.error("E_TYPE_MISMATCH", `mismatched number types \`${T.show(l)}\` and \`${T.show(r)}\`: convert one with \`as\``, e)
        return l
    }

    private optionalInner(t: Ty): { inner: Ty, payload: Ty | null } | null {
        const s = T.strip(t)
        if (s.k !== "named") return null
        if (s.sym === this.prelude("Option")) return { inner: s.args[0] ?? T.UNKNOWN, payload: null }
        if (s.sym === this.prelude("Result")) return { inner: s.args[0] ?? T.UNKNOWN, payload: s.args[1] ?? T.UNKNOWN }
        return null
    }

    private checkNullish(e: Extract<A.Expr, { kind: "Binary" }>, exp?: Ty): Ty {
        const l = this.checkExpr(e.left, exp ? this.option(exp) : undefined)
        const ls = T.strip(l)
        if (ls.k === "unknown" || ls.k === "var") { this.checkExpr(e.right, exp); return exp ?? T.UNKNOWN }
        const o = this.optionalInner(l)
        if (o === null) {
            this.error("E_TYPE_MISMATCH", `\`??\` needs an Option or a Result on its left, found \`${T.show(l)}\``, e.left)
            this.checkExpr(e.right)
            return T.UNKNOWN
        }
        const r = this.checkExpr(e.right, o.inner)
        if (this.tryAssign(r, o.inner)) return o.inner
        if (this.tryAssign(r, this.option(o.inner))) return this.option(o.inner)
        this.error("E_TYPE_MISMATCH", `the fallback of \`??\` should be \`${T.show(o.inner)}\`, found \`${T.show(r)}\``, e.right)
        return o.inner
    }

    private checkAssign(e: Extract<A.Expr, { kind: "Assign" }>): Ty {
        const target = this.checkExpr(e.target)
        if (e.op === "??=") {
            const o = this.optionalInner(target)
            if (o === null && T.strip(target).k !== "unknown") {
                this.error("E_TYPE_MISMATCH", `\`??=\` needs an Option on its left, found \`${T.show(target)}\``, e.target)
            }
            const want = o?.inner ?? T.UNKNOWN
            this.expectAssign(e.value, this.checkExpr(e.value, want), want)
            return T.VOID
        }
        const value = this.checkExpr(e.value, target)
        if (e.op === "=") {
            this.expectAssign(e.value, value, target)
        } else {
            const op = e.op.slice(0, -1)
            const ts = T.strip(target), vs = T.strip(value)
            if (op === "+" && T.isStringy(ts)) this.expectAssign(e.value, value, T.STRING)
            else if (T.isNumeric(ts) || ts.k === "var") this.expectAssign(e.value, value, target)
            else if (ts.k !== "unknown" && vs.k !== "unknown") {
                const method = OPERATOR_METHODS[op]
                const c = method ? this.findMethod(ts, `${method}_assign`, null, e) ?? this.findMethod(ts, method, null, e) : null
                if (c === null) this.error("E_INVALID_OPERANDS", `\`${e.op}\` can't be applied to \`${T.show(target)}\``, e)
            }
        }
        return T.VOID
    }

    private checkAs(e: Extract<A.Expr, { kind: "As" }>): Ty {
        const t = this.toTy(e.type)
        const v = this.checkExpr(e.expr, t)
        if (this.tryAssign(v, t)) return t                       // a type annotation (spec §3.3)
        const vs = T.strip(v), ts = T.strip(t)
        const castable = (a: Ty) => T.isNumeric(a) || a.k === "ptr" || (a.k === "prim" && a.name === "char")
        if (castable(vs) && castable(ts)) return t                // a cast
        this.error("E_INVALID_CAST", `\`${T.show(v)}\` can't be used as \`${T.show(t)}\`: \`as\` annotates a matching type or casts between numbers / pointers`, e)
        return t
    }

    private checkOr(e: Extract<A.Expr, { kind: "Or" }>): Ty {
        const l = this.checkExpr(e.expr)
        const o = this.optionalInner(l)
        if (o === null && T.strip(l).k !== "unknown" && T.strip(l).k !== "var") {
            this.error("E_TYPE_MISMATCH", `\`or\` needs an Option or a Result on its left, found \`${T.show(l)}\``, e.expr)
        }
        // the payload (`it`, or the named binding) is the error of a Result
        const payload = o?.payload ?? T.UNKNOWN
        const named = this.decls.get(e)
        if (named !== undefined) this.symTypes.set(named, payload)
        for (const sym of this.implicitByOwner.get(e) ?? []) this.symTypes.set(sym, payload)
        const rhs = this.checkExpr(e.rhs, this.ctx.ret)
        if (T.prune(rhs).k !== "never") this.expectAssign(e.rhs, rhs, this.ctx.ret, "`or` returns its right side from the function, which returns")
        return o?.inner ?? T.UNKNOWN
    }

    private checkTry(e: Extract<A.Expr, { kind: "Try" }>): Ty {
        const t = this.checkExpr(e.expr)
        const o = this.optionalInner(t)
        if (o === null) {
            if (T.strip(t).k !== "unknown" && T.strip(t).k !== "var") {
                this.error("E_INVALID_TRY", `\`?\` needs an Option or a Result, found \`${T.show(t)}\``, e)
            }
            return T.UNKNOWN
        }
        const ret = T.strip(this.ctx.ret)
        if (ret.k === "unknown" || ret.k === "var") return o.inner
        if (o.payload === null && !this.isOption(ret)) {
            this.error("E_INVALID_TRY", `\`?\` on an Option returns \`None\`, so the function must return an Option (it returns \`${T.show(this.ctx.ret)}\`)`, e)
        } else if (o.payload !== null) {
            if (!this.isResult(ret)) {
                this.error("E_INVALID_TRY", `\`?\` on a Result returns the error, so the function must return a Result (it returns \`${T.show(this.ctx.ret)}\`)`, e)
            } else {
                const err = (ret as Ty & { k: "named" }).args[1] ?? T.UNKNOWN
                if (!this.tryAssign(o.payload, err)) {
                    this.error("E_INVALID_TRY", `\`?\` would return an error of type \`${T.show(o.payload)}\`, but the function's errors are \`${T.show(err)}\``, e)
                }
            }
        }
        return o.inner
    }

    private awaited(t: Ty, at: A.Node): Ty {
        const s = T.strip(t)
        if (s.k === "named" && s.sym === this.prelude("Promise")) return s.args[0] ?? T.UNKNOWN
        if (s.k !== "unknown" && s.k !== "var" && s.k !== "never") this.error("E_TYPE_MISMATCH", `\`await\` needs a Promise, found \`${T.show(t)}\``, at)
        return T.UNKNOWN
    }

    private checkIndex(e: Extract<A.Expr, { kind: "Index" }>): Ty {
        const t = this.checkExpr(e.object)
        const s = T.strip(t)
        if (s.k === "named") {
            if (s.sym === this.prelude("Vec") || s.sym === this.prelude("Array") || s.sym === this.prelude("Slice")) {
                this.expectAssign(e.index, this.checkExpr(e.index, T.INT), T.INT, "an index is")
                return s.args[0] ?? T.UNKNOWN
            }
            if (s.sym === this.prelude("Map")) {
                const k = s.args[0] ?? T.UNKNOWN
                this.expectAssign(e.index, this.checkExpr(e.index, k), k, "the map's keys are")
                return s.args[1] ?? T.UNKNOWN
            }
            const c = this.findMethod(s, "index", null, e)
            if (c !== null && c.params.length === 1) {
                this.expectAssign(e.index, this.checkExpr(e.index, c.params[0]!.ty), c.params[0]!.ty)
                return T.strip(c.ret)
            }
        }
        this.checkExpr(e.index)
        if (s.k === "unknown" || s.k === "var") return T.UNKNOWN
        const hint = T.isStringy(s) ? ": strings aren't integer-indexable, use `.bytes()`, `.chars()` or `.substring(a, b)`" : ""
        this.error("E_NOT_INDEXABLE", `\`${T.show(t)}\` can't be indexed${hint}`, e)
        return T.UNKNOWN
    }

    // ---- members and calls --------------------------------------------------------------------

    private checkMember(e: Extract<A.Expr, { kind: "Member" | "OptMember" }>, exp?: Ty): Ty {
        const obj = this.checkExpr(e.object)
        if (e.kind === "OptMember") {
            const o = this.optionalInner(obj)
            if (o === null) {
                const s = T.strip(obj)
                if (s.k !== "unknown" && s.k !== "var") this.error("E_TYPE_MISMATCH", `\`?.\` needs an Option or a Result, found \`${T.show(obj)}\`; use \`.\``, e)
                return T.UNKNOWN
            }
            const inner = this.memberOf(e, o.inner, e.name, exp)
            return this.isOption(inner) ? inner : this.option(inner)
        }
        return this.memberOf(e, obj, e.name, exp)
    }

    private memberOf(e: A.Expr, objTy: Ty, name: string | number, _exp?: Ty): Ty {
        const t = T.strip(objTy)
        switch (t.k) {
            case "unknown": case "var": case "package": case "never": return T.UNKNOWN
            case "meta": {
                if (typeof name !== "string") break
                const st = this.findStatic(t.ty, name, null, e)
                if (st === null) {
                    const target = T.prune(t.ty)
                    if (target.k !== "named") return T.UNKNOWN
                    this.error("E_UNKNOWN_MEMBER", `\`${T.show(target)}\` has no variant or static method \`${name}\``, e)
                    return T.UNKNOWN
                }
                return isCallable(st) ? this.fnType(st) : st
            }
            case "tuple":
                if (typeof name === "number") {
                    const el = t.elems[name]
                    if (el !== undefined) return el
                    this.error("E_UNKNOWN_FIELD", `the tuple has ${t.elems.length} elements, so \`.${name}\` doesn't exist`, e)
                    return T.UNKNOWN
                }
                break
            case "record": {
                const f = t.fields.find((x) => x.name === name)
                if (f !== undefined) return f.ty
                break
            }
            case "named": {
                const info = this.info(t.sym)
                const field = info?.fields.get(String(name))
                if (info !== undefined && field !== undefined) return T.subst(this.toTy(field.type), this.envFor(info, t.args))
                if (typeof name === "string") {
                    const m = this.findMethod(t, name, null, e)
                    if (m !== null) return this.fnType(m)
                }
                if (info === undefined) return T.UNKNOWN
                break
            }
            case "param": {
                if (typeof name === "string") {
                    const m = this.findMethod(t, name, null, e)
                    if (m !== null) return this.fnType(m)
                }
                break
            }
            default:
                if (typeof name === "string") {
                    const m = this.findMethod(t, name, null, e)
                    if (m !== null) return this.fnType(m)
                }
        }
        this.error("E_UNKNOWN_FIELD", `\`${T.show(objTy)}\` has no field or method \`${String(name)}\``, e)
        return T.UNKNOWN
    }

    private checkGenericValue(e: Extract<A.Expr, { kind: "GenericApply" }>): Ty {
        const args = e.args.map((a) => this.toTy(a))
        const target = e.target
        if (target.kind === "Ident") {
            const sym = this.refs.get(target)
            if (sym?.kind === "fun" || sym?.kind === "extern-fun") {
                const f = this.funType(sym, args, e)
                this.types.set(target, f ? this.fnType(f.c) : T.UNKNOWN)
                return f ? this.fnType(f.c) : T.UNKNOWN
            }
        }
        const t = this.checkExpr(target)
        const s = T.prune(t)
        if (s.k === "meta") {
            const inner = T.prune(s.ty)
            if (inner.k === "named") {
                this.eqArgs(inner.args, args)
                return { k: "meta", ty: inner }
            }
        }
        return T.UNKNOWN
    }

    /** Resolves what is being called: a function, method, constructor or closure. */
    private callee(e: Extract<A.Expr, { kind: "Call" }>, exp?: Ty): { c: Callable | null, ty: Ty, viaOpt: boolean } {
        let callee = e.callee
        let explicit: Ty[] | null = null
        if (callee.kind === "GenericApply") {
            explicit = callee.args.map((a) => this.toTy(a))
            callee = callee.target
        }

        // method call / static call: x.f(…), T.f(…), x?.f(…)
        if ((callee.kind === "Member" || callee.kind === "OptMember") && typeof callee.name === "string") {
            const obj = this.checkExpr(callee.object)
            let recv = obj
            const viaOpt = callee.kind === "OptMember"
            if (viaOpt) {
                const o = this.optionalInner(obj)
                recv = o?.inner ?? T.UNKNOWN
            }
            const s = T.prune(recv)
            if (s.k === "meta") {
                const st = this.findStatic(s.ty, callee.name, explicit, callee)
                if (st === null) {
                    const target = T.prune(s.ty)
                    if (target.k === "named") this.error("E_UNKNOWN_MEMBER", `\`${T.show(target)}\` has no static method or variant \`${callee.name}\``, callee)
                    return { c: null, ty: T.UNKNOWN, viaOpt }
                }
                if (!(isCallable(st))) {
                    this.error("E_NOT_CALLABLE", `\`${callee.name}\` has no payload; write it without \`(…)\``, e)
                    return { c: null, ty: T.UNKNOWN, viaOpt }
                }
                return { c: st, ty: this.fnType(st), viaOpt }
            }
            const st = T.strip(recv)
            if (st.k === "unknown" || st.k === "var" || st.k === "package" || st.k === "never") return { c: null, ty: T.UNKNOWN, viaOpt }
            const m = this.findMethod(st, callee.name, explicit, callee)
            if (m !== null) return { c: m, ty: this.fnType(m), viaOpt }
            // a field holding a function
            const ft = this.memberOf(callee, st, callee.name)
            return { c: null, ty: ft, viaOpt }
        }

        if (callee.kind === "Ident") {
            const sym = this.refs.get(callee)
            if (sym === undefined && this.deferred.has(callee)) {
                if (this.open.has(callee) || (exp !== undefined && T.strip(exp).k === "unknown")) return { c: null, ty: T.UNKNOWN, viaOpt: false }
                // Text("hi") with an expected union (spec §7.6)
                const found = this.expectedVariant(callee.name, exp)
                if (found === null) {
                    this.error("E_CANNOT_INFER_VARIANT", `unknown name \`${callee.name}\`: no variant \`${callee.name}\` in the expected type${exp ? ` \`${T.show(exp)}\`` : ""}; qualify it (\`Type.${callee.name}\`)`, callee)
                    return { c: null, ty: T.UNKNOWN, viaOpt: false }
                }
                const v = this.variantType(found.info, found.t, found.v)
                return { c: isCallable(v) ? v : null, ty: isCallable(v) ? this.fnType(v) : v, viaOpt: false }
            }
            if (sym?.kind === "fun" || sym?.kind === "extern-fun") {
                const f = this.funType(sym, explicit, callee)
                if (f) {
                    this.types.set(callee, this.fnType(f.c))
                    return { c: f.c, ty: this.fnType(f.c), viaOpt: false }
                }
            }
            if (sym?.kind === "variant") {
                const t = this.symValue(sym, callee, exp)
                this.types.set(callee, t)
                const owner = sym.owner!
                const info = this.info(owner)!
                const x = exp ? T.strip(exp) : null
                const recv: Ty & { k: "named" } = x?.k === "named" && x.sym === owner ? x : { k: "named", sym: owner, args: info.generics.map(() => this.fresh()) }
                const v = this.variantType(info, recv, sym.decl as A.Variant)
                if (isCallable(v)) return { c: v, ty: this.fnType(v), viaOpt: false }
                this.error("E_NOT_CALLABLE", `\`${sym.name}\` has no payload; write it without \`(…)\``, e)
                return { c: null, ty: T.UNKNOWN, viaOpt: false }
            }
            if (sym !== undefined && (sym.kind === "type" || sym.kind === "union")) {
                // `Signal(0)`, `Ref(x)`: calling a type calls its static `new`
                const meta = this.symValue(sym, callee) as Ty & { k: "meta" }
                this.types.set(callee, meta)
                const st = this.findStatic(meta.ty, "new", explicit, callee)
                if (st !== null && isCallable(st)) return { c: st, ty: this.fnType(st), viaOpt: false }
                this.error("E_NOT_CALLABLE", `\`${sym.name}\` is a type without a static \`new\`; build it with \`${sym.name} { … }\``, e)
                return { c: null, ty: T.UNKNOWN, viaOpt: false }
            }
        }

        const t = this.checkExpr(callee)
        return { c: null, ty: t, viaOpt: false }
    }

    private checkCall(e: Extract<A.Expr, { kind: "Call" }>, exp?: Ty): Ty {
        const { c, ty, viaOpt } = this.callee(e, exp)
        let callable = c
        if (callable === null) {
            const s = T.strip(ty)
            if (s.k === "fn") {
                callable = { params: s.params.map((p, i) => ({ name: `${i}`, ty: p, variadic: false })), ret: s.ret, async: s.async, bounds: [] }
            } else {
                if (s.k !== "unknown" && s.k !== "var" && s.k !== "package" && s.k !== "never") {
                    this.error("E_NOT_CALLABLE", `\`${T.show(ty)}\` can't be called`, e.callee)
                }
                for (const a of e.args) this.checkExpr(a.kind === "Spread" ? a.expr : a, T.UNKNOWN)
                return T.UNKNOWN
            }
        }
        if (exp !== undefined) this.tryAssign(callable.ret, exp)    // let the expected result guide inference
        this.applyArgs(e, callable)
        for (const b of callable.bounds) {
            for (const bound of b.bounds) {
                const v = T.prune(b.v)
                const bs = T.strip(bound)
                if (v.k === "var" || bs.k !== "named") continue
                if (!this.implements(v, bs)) this.error("E_BOUND_NOT_SATISFIED", `\`${T.show(v)}\` doesn't implement \`${T.show(bound)}\``, e)
            }
        }
        return viaOpt ? (this.isOption(callable.ret) ? callable.ret : this.option(callable.ret)) : callable.ret
    }

    private applyArgs(e: Extract<A.Expr, { kind: "Call" }>, c: Callable): void {
        const params = c.params
        const variadic = params.length > 0 && params[params.length - 1]!.variadic
        const fixed = variadic ? params.length - 1 : params.length
        const args = e.args
        // missing trailing `void` arguments may be left out: `Ok()`, `resolver.resolve()` (spec §7.1)
        const omittable = (p: Param) => {
            const t = T.prune(p.ty)
            if (t.k === "var" && t.lit === null) return this.tryAssign(T.VOID, t)
            return this.isVoid(t) || t.k === "unknown"
        }
        const required = params.slice(0, fixed).filter((p, i) => (i >= args.length ? !omittable(p) : true)).length
        if (args.length < Math.min(required, fixed) || (!variadic && args.length > fixed)) {
            this.error("E_ARG_COUNT", `expected ${variadic ? "at least " : ""}${required === fixed ? fixed : `${required}–${fixed}`} argument${fixed === 1 ? "" : "s"}, found ${args.length}`, e)
        }
        // closures last, so the other arguments can bind generics first (`map(items, #{ … })`)
        const order = args.map((a, i) => i).sort((a, b) => Number(args[a]!.kind === "Closure") - Number(args[b]!.kind === "Closure"))
        for (const i of order) {
            const a = args[i]!
            const p = i < fixed ? params[i] : variadic ? params[params.length - 1] : undefined
            if (p === undefined) { this.checkExpr(a.kind === "Spread" ? a.expr : a); continue }
            let want = p.ty
            if (p.variadic) {
                const s = T.strip(want)
                const elem = s.k === "named" ? s.args[0] ?? T.UNKNOWN : T.UNKNOWN
                if (a.kind === "Spread") { this.checkExpr(a.expr, want); continue }
                want = elem
            }
            if (a.kind === "Spread") {
                this.error("E_TYPE_MISMATCH", "`...` spreads only into a variadic parameter (`...name: T`)", a)
                this.checkExpr(a.expr)
                continue
            }
            const t = this.checkExpr(a, want)
            this.expectAssign(a, t, want)
        }
    }

    // ---- literals with fields -----------------------------------------------------------------

    private checkRecord(e: Extract<A.Expr, { kind: "Record" }>, exp?: Ty): Ty {
        const x = exp ? T.strip(exp) : null
        const hint = (name: string): Ty | undefined => {
            if (x?.k === "record") return x.fields.find((f) => f.name === name)?.ty
            if (x?.k === "named") {
                const info = this.info(x.sym)
                const f = info?.fields.get(name)
                return info && f ? T.subst(this.toTy(f.type), this.envFor(info, x.args)) : undefined
            }
            return undefined
        }
        const fields: T.RecordField[] = []
        for (const f of e.fields) {
            if (f.kind === "Spread") {
                const st = T.strip(this.checkExpr(f.expr))
                const src = st.k === "named" && this.info(st.sym)?.kind === "struct" ? this.structAsRecord(st) : st
                if (src.k === "record") for (const g of src.fields) if (!fields.some((h) => h.name === g.name)) fields.push(g)
                continue
            }
            const ty = this.fieldValue(f, hint(f.key))
            const i = fields.findIndex((h) => h.name === f.key)
            if (i >= 0) fields.splice(i, 1)
            fields.push({ name: f.key, ty, optional: false })
        }
        fields.sort((a, b) => (a.name < b.name ? -1 : 1))
        return { k: "record", fields }
    }

    private fieldValue(f: A.RecordField, want: Ty | undefined): Ty {
        if (f.value !== null) return this.checkExpr(f.value, want)
        const sym = this.refs.get(f)               // shorthand: `r{ name }`
        return sym ? this.symValue(sym, f) : T.UNKNOWN
    }

    private checkInferred(e: Extract<A.Expr, { kind: "Inferred" }>, exp?: Ty): Ty {
        const x = exp ? T.strip(exp) : null
        if (x === null || x.k === "var") {
            this.error("E_CANNOT_INFER_STRUCT_TYPE", "`_{ … }` takes its type from the context, and there is none here: name the type (`Config { … }`) or annotate it", e)
            for (const f of e.fields) if (f.kind === "Spread") this.checkExpr(f.expr); else if (f.value) this.checkExpr(f.value)
            return T.UNKNOWN
        }
        if (x.k === "unknown") {
            for (const f of e.fields) if (f.kind === "Spread") this.checkExpr(f.expr); else this.fieldValue(f, undefined)
            return T.UNKNOWN
        }
        if (x.k === "record") return this.checkRecord({ ...e, kind: "Record" }, x)
        if (x.k === "named" && this.info(x.sym)?.kind === "struct") {
            this.checkStructFields(e, x, e.fields)
            return x
        }
        this.error("E_CANNOT_INFER_STRUCT_TYPE", `\`_{ … }\` builds a struct or record, but \`${T.show(x)}\` is expected`, e)
        return T.UNKNOWN
    }

    private checkStructLit(e: Extract<A.Expr, { kind: "StructLit" }>, exp?: Ty): Ty {
        let tyExpr = e.type
        let explicit: Ty[] | null = null
        if (tyExpr.kind === "GenericApply") {
            explicit = tyExpr.args.map((a) => this.toTy(a))
            tyExpr = tyExpr.target
        }
        // a struct-like variant: `Payment.Card { … }`, or `Card { … }` with an expected union (spec §7.6)
        let variant: { info: TypeInfo, t: Ty & { k: "named" }, v: A.Variant } | null = null
        if (tyExpr.kind === "Ident" && this.refs.get(tyExpr) === undefined && this.deferred.has(tyExpr)) {
            variant = this.expectedVariant(tyExpr.name, exp)
            if (variant === null && (this.open.has(tyExpr) || (exp !== undefined && T.strip(exp).k === "unknown"))) {
                this.checkFieldsLoosely(e.fields)
                return T.UNKNOWN
            }
            if (variant === null) {
                this.error("E_CANNOT_INFER_VARIANT", `unknown type or variant \`${tyExpr.name}\``, tyExpr)
                this.checkFieldsLoosely(e.fields)
                return T.UNKNOWN
            }
        } else if (tyExpr.kind === "Member" && typeof tyExpr.name === "string") {
            const obj = T.prune(this.checkExpr(tyExpr.object))
            if (obj.k === "meta" && T.prune(obj.ty).k === "named") {
                const t = T.prune(obj.ty) as Ty & { k: "named" }
                const info = this.info(t.sym)
                const v = info?.variants.get(tyExpr.name)
                if (info && v) {
                    const x = exp ? T.strip(exp) : null
                    variant = { info, t: x?.k === "named" && x.sym === t.sym ? x : t, v }
                }
            }
            if (variant === null) {
                this.checkFieldsLoosely(e.fields)
                return T.UNKNOWN            // `models.User { … }`: a package's type, not loaded yet
            }
        }
        if (variant !== null) {
            if (variant.v.fields === null) {
                this.error("E_TYPE_MISMATCH", `variant \`${variant.v.name}\` has no fields`, e)
                return variant.t
            }
            this.checkFieldList(e, variant.v.fields, this.envFor(variant.info, variant.t.args), e.fields, variant.t)
            return variant.t
        }
        const meta = T.prune(this.checkExpr(tyExpr))
        if (meta.k !== "meta") {
            if (meta.k !== "unknown") this.error("E_NOT_A_TYPE", `\`${T.show(meta)}\` is not a struct type`, tyExpr)
            this.checkFieldsLoosely(e.fields)
            return T.UNKNOWN
        }
        const t = T.prune(meta.ty)
        if (t.k !== "named" || this.info(t.sym)?.kind !== "struct") {
            if (t.k === "named") this.error("E_TYPE_MISMATCH", `\`${T.show(t)}\` is not a struct, so it can't be built with \`{ … }\``, tyExpr)
            this.checkFieldsLoosely(e.fields)
            return T.UNKNOWN
        }
        if (explicit !== null) this.eqArgs(t.args, explicit)
        const x = exp ? T.strip(exp) : null
        if (x?.k === "named" && x.sym === t.sym) this.eqArgs(t.args, x.args)
        this.checkStructFields(e, t, e.fields)
        return t
    }

    private checkFieldsLoosely(fields: (A.RecordField | A.Spread)[]): void {
        for (const f of fields) if (f.kind === "Spread") this.checkExpr(f.expr, T.UNKNOWN); else this.fieldValue(f, T.UNKNOWN)
    }

    private checkStructFields(e: A.Expr, t: Ty & { k: "named" }, fields: (A.RecordField | A.Spread)[]): void {
        const info = this.info(t.sym)!
        this.checkFieldList(e, [...info.fields.values()], this.envFor(info, t.args), fields, t)
    }

    /** Fields of a struct literal: known names, required fields present (or spread), types match. */
    private checkFieldList(e: A.Expr, decl: A.Field[], env: Map<Sym, Ty>, given: (A.RecordField | A.Spread)[], self: Ty): void {
        let spread = false
        const seen = new Set<string>()
        for (const f of given) {
            if (f.kind === "Spread") {
                spread = true
                this.expectAssign(f.expr, this.checkExpr(f.expr, self), self, "`...` here spreads a")
                continue
            }
            const df = decl.find((d) => d.name === f.key)
            if (df === undefined) {
                this.error("E_UNKNOWN_FIELD", `\`${T.show(self)}\` has no field \`${f.key}\``, f)
                this.fieldValue(f, undefined)
                continue
            }
            seen.add(f.key)
            const want = T.subst(this.toTy(df.type), env)
            this.expectAssign(f.value ?? f, this.fieldValue(f, want), want)
        }
        if (spread) return
        const missing = decl.filter((d) => !seen.has(d.name) && d.default === null && !this.isOption(this.toTy(d.type)))
        if (missing.length > 0) {
            this.error("E_MISSING_FIELD", `missing field${missing.length > 1 ? "s" : ""} ${missing.map((m) => `\`${m.name}\``).join(", ")} in \`${T.show(self)}\``, e)
        }
    }

    // ---- closures -----------------------------------------------------------------------------

    private checkClosure(e: Extract<A.Expr, { kind: "Closure" }>, exp?: Ty): Ty {
        const x = exp ? T.strip(exp) : null
        const want = x?.k === "fn" ? x : null
        const loose = x?.k === "unknown"        // passed to something without a signature yet
        const params: Ty[] = []
        if (e.params !== null) {
            e.params.forEach((p, i) => {
                const ty = p.type ? this.toTy(p.type) : want?.params[i] ?? (loose ? T.UNKNOWN : this.freshAt(p, `closure parameter \`${p.name}\``))
                if (p.type && want?.params[i]) this.expectAssign(p, want.params[i]!, ty, "the closure parameter is")
                const sym = this.decls.get(p)
                if (sym) this.symTypes.set(sym, ty)
                params.push(ty)
            })
        } else {
            // implicit `it`, `it2` …: as many parameters as the highest one used
            const implicit = this.implicitByOwner.get(e) ?? []
            const n = Math.max(0, ...implicit.map((s) => Number(s.name.slice(2) || "1")))
            for (let i = 0; i < n; i++) params.push(want?.params[i] ?? (loose ? T.UNKNOWN : this.freshAt(e, `\`it${i === 0 ? "" : i + 1}\``)))
            for (const s of implicit) this.symTypes.set(s, params[Number(s.name.slice(2) || "1") - 1] ?? T.UNKNOWN)
        }
        const ret = e.ret ? this.toTy(e.ret) : want?.ret ?? (loose ? T.UNKNOWN : this.fresh())
        const ctx: FnCtx = { ret, async: false, thisTy: this.ctx.thisTy, loops: [], isClosure: true }
        this.withFn(ctx, () => {
            const value = this.checkStmts(e.body.stmts, this.isVoid(ret) ? undefined : ret)
            if (this.isVoid(ret)) return
            if (T.prune(value).k !== "never") this.expectAssign(e.body.stmts[e.body.stmts.length - 1] ?? e, value, ret, "the closure should produce")
        })
        return { k: "fn", params, ret, async: false }
    }

    // ---- control flow -------------------------------------------------------------------------

    /** The type of two branches together (if / match). */
    private join(at: { span: Span }, a: Ty | null, b: Ty, exp?: Ty): Ty {
        if (a === null) return b
        if (T.prune(a).k === "never") return b
        if (T.prune(b).k === "never") return a
        if (exp !== undefined && !this.isVoid(exp)) return exp
        if (this.tryAssign(b, a)) return a
        if (this.tryAssign(a, b)) return b
        this.error("E_TYPE_MISMATCH", `the branches have different types: \`${T.show(a)}\` and \`${T.show(b)}\``, at)
        return a
    }

    private checkIf(e: Extract<A.Expr, { kind: "If" }>, exp?: Ty): Ty {
        if (e.cond.kind === "LetCond") {
            const v = this.checkExpr(e.cond.value)
            this.bindPattern(e.cond.pattern, v)
        } else {
            this.checkTruthy(e.cond, this.checkExpr(e.cond, T.BOOL))
        }
        const branchExp = e.else !== null ? exp : undefined
        const thenTy = this.checkStmts(e.then.stmts, branchExp)
        if (e.else === null) return T.VOID
        const elseTy = e.else.kind === "Block" ? this.checkStmts(e.else.stmts, branchExp) : this.checkExpr(e.else, branchExp)
        if (exp !== undefined && !this.isVoid(exp)) {
            if (T.prune(thenTy).k !== "never") this.expectAssign(lastValueNode(e.then), thenTy, exp)
            if (T.prune(elseTy).k !== "never") this.expectAssign(e.else.kind === "Block" ? lastValueNode(e.else) : e.else, elseTy, exp)
            return T.prune(thenTy).k === "never" && T.prune(elseTy).k === "never" ? T.NEVER : exp
        }
        if (this.isVoid(thenTy) || this.isVoid(elseTy)) return T.prune(thenTy).k === "never" ? elseTy : T.prune(elseTy).k === "never" ? thenTy : T.VOID
        return this.join(e, thenTy, elseTy)
    }

    private checkMatch(e: Extract<A.Expr, { kind: "Match" }>, exp?: Ty): Ty {
        const subject = e.subject ? this.checkExpr(e.subject) : null
        let result: Ty | null = null
        for (const arm of e.arms) {
            if (arm.pattern !== null && subject !== null) this.bindPattern(arm.pattern, subject)
            if (arm.test !== null) this.checkTruthy(arm.test, this.checkExpr(arm.test, T.BOOL))
            if (arm.guard !== null) this.checkTruthy(arm.guard, this.checkExpr(arm.guard, T.BOOL))
            const ty = this.checkExpr(arm.body, exp)
            if (exp !== undefined && !this.isVoid(exp) && T.prune(ty).k !== "never") this.expectAssign(arm.body, ty, exp)
            else result = this.joinArm(arm.body, result, ty)
        }
        this.checkExhaustive(e, subject)
        if (exp !== undefined && !this.isVoid(exp)) return exp
        return result ?? T.NEVER
    }

    private joinArm(at: { span: Span }, a: Ty | null, b: Ty): Ty {
        if (a !== null && (this.isVoid(a) || this.isVoid(b)) && T.prune(a).k !== "never" && T.prune(b).k !== "never") return T.VOID
        return this.join(at, a, b)
    }

    private checkSelect(e: Extract<A.Expr, { kind: "Select" }>, exp?: Ty): Ty {
        if (!this.ctx.async) this.error("E_AWAIT_OUTSIDE_ASYNC", "`select` waits, so it is only allowed in an `async fun` (or `main`)", e)
        let result: Ty | null = null
        for (const arm of e.arms) {
            const t = this.checkExpr(arm.expr)
            const s = T.strip(t)
            let value: Ty = T.UNKNOWN
            if (s.k === "named" && s.sym === this.prelude("Promise")) value = s.args[0] ?? T.UNKNOWN
            else if (s.k !== "unknown" && s.k !== "var") this.error("E_SELECT_ARM_NOT_PROMISE", `a \`select\` arm waits on a Promise, found \`${T.show(t)}\``, arm.expr)
            if (arm.pattern !== null) this.bindPattern(arm.pattern, value)
            result = this.joinArm(arm.body, result, this.checkExpr(arm.body, exp))
        }
        if (e.else !== null) result = this.joinArm(e.else, result, this.checkExpr(e.else, exp))
        return result ?? T.VOID
    }

    /** The element type of `for x in e` (spec §5.3, §10.2). */
    private elementOf(t: Ty, at: A.Node, isAwait: boolean): { item: Ty, second: Ty | null } {
        const s = T.strip(t)
        if (s.k === "unknown" || s.k === "var") return { item: T.UNKNOWN, second: null }
        if (isAwait) {
            const next = this.findMethod(s, "next", null, { span: at.span })
            if (next !== null) {
                const r = this.awaited(next.ret, at)
                const o = this.optionalInner(r)
                if (o !== null) return { item: o.inner, second: null }
            }
            if (s.k === "named") return { item: T.UNKNOWN, second: null }
            this.error("E_NOT_ITERABLE", `\`for await\` needs an AsyncIterator (a value with \`async fun next() -> T?\`), found \`${T.show(t)}\``, at)
            return { item: T.UNKNOWN, second: null }
        }
        if (s.k === "named") {
            const n = s.sym.name
            if (s.sym.std && (n === "Vec" || n === "Array" || n === "Slice" || n === "Set")) return { item: s.args[0] ?? T.UNKNOWN, second: T.INT }
            if (s.sym.std && n === "Map") return { item: s.args[0] ?? T.UNKNOWN, second: s.args[1] ?? T.UNKNOWN }
            if (s.sym.std && n === "Range") return { item: s.args[0] ?? T.UNKNOWN, second: null }
            const next = this.findMethod(s, "next", null, { span: at.span })
            if (next !== null) {
                const o = this.optionalInner(next.ret)
                if (o !== null) return { item: o.inner, second: T.INT }
            }
            const iter = this.findMethod(s, "iter", null, { span: at.span })
            if (iter !== null) return this.elementOf(iter.ret, at, false)
        }
        if (T.isStringy(s)) {
            this.error("E_NOT_ITERABLE", "a string isn't iterable directly: use `.chars()`, `.bytes()` or `.lines()`", at)
            return { item: T.UNKNOWN, second: null }
        }
        this.error("E_NOT_ITERABLE", `\`${T.show(t)}\` can't be iterated with \`for … in\``, at)
        return { item: T.UNKNOWN, second: null }
    }

    private checkFor(e: Extract<A.Expr, { kind: "For" }>): Ty {
        if (e.await && !this.ctx.async) this.error("E_AWAIT_OUTSIDE_ASYNC", "`for await` is only allowed in an `async fun` (or `main`)", e)
        switch (e.form) {
            case "cond": this.checkTruthy(e.expr!, this.checkExpr(e.expr!, T.BOOL)); break
            case "let": this.bindPattern(e.pattern!, this.checkExpr(e.expr!)); break
            case "in": {
                const it = this.checkExpr(e.expr!)
                const { item, second } = this.elementOf(it, e.expr!, e.await)
                this.bindPattern(e.pattern!, item)
                if (e.pattern2) {
                    if (second === null) this.error("E_TYPE_MISMATCH", `\`${T.show(it)}\` yields one value per step, so there is no second binding`, e.pattern2)
                    this.bindPattern(e.pattern2, second ?? T.UNKNOWN)
                }
                break
            }
            case "infinite": break
        }
        const loop = { breakTy: null as Ty | null }
        this.ctx.loops.push(loop)
        try {
            this.checkStmts(e.body.stmts)
        } finally {
            this.ctx.loops.pop()
        }
        if (e.form === "infinite") return loop.breakTy ?? (this.containsBreak(e.body) ? T.VOID : T.NEVER)
        return T.VOID
    }

    private containsBreak(b: A.Block): boolean {
        let found = false
        const visit = (n: unknown): void => {
            if (found || n === null || typeof n !== "object") return
            const node = n as { kind?: string }
            if (node.kind === "Break") { found = true; return }
            if (node.kind === "For" || node.kind === "Closure") return
            for (const v of Object.values(n)) if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === "object" && "kind" in v) visit(v)
        }
        for (const s of b.stmts) visit(s)
        return found
    }

    // ---- patterns (spec §6) -------------------------------------------------------------------

    private bindPattern(p: A.Pattern, ty: Ty): void {
        const t = T.strip(ty)
        switch (p.kind) {
            case "PWild": case "PError": return
            case "PBind": {
                const sym = this.decls.get(p)
                if (sym) this.symTypes.set(sym, ty)
                return
            }
            case "PLit": {
                const lt = this.checkExpr(p.value, t.k === "unknown" ? undefined : t)
                if (!this.tryAssign(lt, t) && !this.tryAssign(t, lt)) this.error("E_TYPE_MISMATCH", `this pattern is \`${T.show(lt)}\`, but the value is \`${T.show(ty)}\``, p)
                return
            }
            case "PRange":
                for (const v of [p.start, p.end]) {
                    if (v === null) continue
                    const lt = this.checkExpr(v, t.k === "unknown" ? undefined : t)
                    if (!this.tryAssign(lt, t)) this.error("E_TYPE_MISMATCH", `this range is \`${T.show(lt)}\`, but the value is \`${T.show(ty)}\``, p)
                }
                return
            case "PTuple": {
                if (t.k === "unknown" || t.k === "var") { for (const el of p.elems) this.bindPattern(el, T.UNKNOWN); return }
                if (t.k !== "tuple" || (p.rest ? t.elems.length < p.elems.length : t.elems.length !== p.elems.length)) {
                    this.error("E_TYPE_MISMATCH", `this pattern is a tuple of ${p.elems.length}${p.rest ? " or more" : ""}, but the value is \`${T.show(ty)}\``, p)
                    for (const el of p.elems) this.bindPattern(el, T.UNKNOWN)
                    return
                }
                p.elems.forEach((el, i) => this.bindPattern(el, t.elems[i]!))
                return
            }
            case "POr": for (const a of p.alts) this.bindPattern(a, ty); return
            case "PPath": case "PCall": case "PStruct": return this.bindConstructor(p, ty)
        }
    }

    /** The variant (or struct) a constructor pattern names, given the value's type. */
    private patternVariant(p: A.Pattern & { kind: "PPath" | "PCall" | "PStruct" }, ty: Ty): { info: TypeInfo, t: Ty & { k: "named" }, v: A.Variant | null } | null | "unknown" {
        const t = T.strip(ty)
        const path = p.path
        if (path === null) return "unknown"
        const sym = this.refs.get(p)
        const fromValue = (name: string) => {
            if (t.k !== "named") return null
            const info = this.info(t.sym)
            const v = info?.variants.get(name)
            return info && v ? { info, t, v } : null
        }
        if (sym === undefined) {
            if (t.k === "unknown" || t.k === "var") return "unknown"
            return path.length === 1 ? fromValue(path[0]!) : "unknown"
        }
        if (sym.kind === "variant") {
            if (t.k === "unknown" || t.k === "var") return "unknown"
            if (t.k !== "named" || t.sym !== sym.owner) return null
            return fromValue(sym.name)
        }
        if (sym.kind === "union" && path.length === 2) {
            if (t.k === "unknown" || t.k === "var") return "unknown"
            if (t.k !== "named" || t.sym !== sym) return null
            return fromValue(path[1]!)
        }
        if (sym.kind === "type" && path.length === 1) {
            if (t.k === "unknown" || t.k === "var") return "unknown"
            if (t.k !== "named" || t.sym !== sym) return null
            return { info: this.info(sym)!, t, v: null }
        }
        return "unknown"
    }

    private bindConstructor(p: A.Pattern & { kind: "PPath" | "PCall" | "PStruct" }, ty: Ty): void {
        const found = this.patternVariant(p, ty)
        const bindAllUnknown = () => {
            if (p.kind === "PCall") for (const a of p.args) this.bindPattern(a, T.UNKNOWN)
            if (p.kind === "PStruct") for (const f of p.fields) {
                if (f.pattern) this.bindPattern(f.pattern, T.UNKNOWN)
                else { const s = this.decls.get(f); if (s) this.symTypes.set(s, T.UNKNOWN) }
            }
        }
        if (found === "unknown") {
            if (p.kind === "PStruct" && p.path === null) return this.bindRecordPattern(p, ty)
            return bindAllUnknown()
        }
        if (found === null) {
            const name = p.path?.join(".") ?? "r{…}"
            const t = T.strip(ty)
            if (t.k === "named" && p.path?.length === 1 && !this.refs.get(p)) {
                this.error("E_UNKNOWN_VARIANT", `\`${T.show(ty)}\` has no variant \`${name}\``, p)
            } else {
                this.error("E_TYPE_MISMATCH", `the pattern \`${name}\` doesn't match a value of type \`${T.show(ty)}\``, p)
            }
            return bindAllUnknown()
        }
        const env = this.envFor(found.info, found.t.args)
        if (found.v === null) {
            // a struct pattern on a named struct: `User { id, .. }`
            if (p.kind === "PStruct") this.bindFieldPatterns(p, [...found.info.fields.values()], env, found.t)
            return
        }
        const v = found.v
        if (p.kind === "PCall") {
            const payload = (v.tuple ?? []).map((x) => T.subst(this.toTy(x), env))
            if (v.tuple === null || (p.rest ? payload.length < p.args.length : payload.length !== p.args.length)) {
                this.error("E_TYPE_MISMATCH", `variant \`${v.name}\` has ${v.tuple === null ? (v.fields ? "named fields" : "no payload") : `${payload.length} field${payload.length === 1 ? "" : "s"}`}, but the pattern gives ${p.args.length}`, p)
                return bindAllUnknown()
            }
            p.args.forEach((a, i) => this.bindPattern(a, payload[i]!))
        } else if (p.kind === "PStruct") {
            if (v.fields === null) {
                this.error("E_TYPE_MISMATCH", `variant \`${v.name}\` has no named fields`, p)
                return bindAllUnknown()
            }
            this.bindFieldPatterns(p, v.fields, env, found.t)
        } else if (v.tuple !== null || v.fields !== null) {
            this.error("E_TYPE_MISMATCH", `variant \`${v.name}\` has a payload: match it with \`${v.name}(…)\`${v.fields ? ` or \`${v.name} { … }\`` : ""}`, p)
        }
    }

    private bindFieldPatterns(p: A.Pattern & { kind: "PStruct" }, fields: A.Field[], env: Map<Sym, Ty>, self: Ty): void {
        for (const f of p.fields) {
            const df = fields.find((d) => d.name === f.name)
            const fty = df ? T.subst(this.toTy(df.type), env) : T.UNKNOWN
            if (df === undefined) this.error("E_UNKNOWN_FIELD", `\`${T.show(self)}\` has no field \`${f.name}\``, f)
            if (f.pattern) this.bindPattern(f.pattern, fty)
            else { const s = this.decls.get(f); if (s) this.symTypes.set(s, fty) }
        }
    }

    private bindRecordPattern(p: A.Pattern & { kind: "PStruct" }, ty: Ty): void {
        const t = T.strip(ty)
        const rec = t.k === "named" && this.info(t.sym)?.kind === "struct" ? this.structAsRecord(t) : t
        for (const f of p.fields) {
            let fty: Ty = T.UNKNOWN
            if (rec.k === "record") {
                const g = rec.fields.find((x) => x.name === f.name)
                if (g) fty = g.ty
                else this.error("E_UNKNOWN_FIELD", `\`${T.show(ty)}\` has no field \`${f.name}\``, f)
            }
            if (f.pattern) this.bindPattern(f.pattern, fty)
            else { const s = this.decls.get(f); if (s) this.symTypes.set(s, fty) }
        }
    }

    // ---- exhaustiveness (simple: top-level variants, bool, literal unions) ---------------------

    private checkExhaustive(e: Extract<A.Expr, { kind: "Match" }>, subject: Ty | null): void {
        const irrefutable = (p: A.Pattern): boolean => {
            switch (p.kind) {
                case "PWild": case "PBind": case "PError": return true
                case "PTuple": return p.elems.every(irrefutable)
                case "POr": return p.alts.some(irrefutable)
                default: return false
            }
        }
        const arms = e.arms.filter((a) => a.guard === null)
        if (subject === null) {
            if (!arms.some((a) => a.pattern !== null && irrefutable(a.pattern))) {
                this.error("E_NON_EXHAUSTIVE_MATCH", "a `match` without a subject needs a final `_ =>` arm", e)
            }
            return
        }
        const pats = arms.map((a) => a.pattern!).flatMap((p) => (p.kind === "POr" ? p.alts : [p]))
        if (pats.some(irrefutable)) return
        const t = T.strip(subject)
        if (t.k === "unknown" || t.k === "var" || t.k === "never") return
        let missing: string[] = []
        if (t.k === "named" && this.info(t.sym)?.kind === "union") {
            const info = this.info(t.sym)!
            const covered = new Set<string>()
            for (const p of pats) {
                if (p.kind !== "PPath" && p.kind !== "PCall" && p.kind !== "PStruct") continue
                const f = this.patternVariant(p, t)
                if (f === null || f === "unknown" || f.v === null) continue
                const full = p.kind === "PPath" || (p.kind === "PCall" && p.args.every(irrefutable)) || (p.kind === "PStruct" && p.fields.every((x) => x.pattern === null || irrefutable(x.pattern)))
                if (full) covered.add(f.v.name)
            }
            missing = [...info.variants.keys()].filter((v) => !covered.has(v))
        } else if (t.k === "prim" && t.name === "bool") {
            const vals = new Set(pats.filter((p) => p.kind === "PLit" && p.value.kind === "Bool").map((p) => ((p as { value: { value: boolean } }).value.value)))
            missing = [true, false].filter((b) => !vals.has(b)).map(String)
        } else if (t.k === "union") {
            const vals = new Set(pats.filter((p) => p.kind === "PLit").map((p) => {
                const v = (p as A.Pattern & { kind: "PLit" }).value
                return v.kind === "Str" ? v.value : v.kind === "Int" ? String(v.value) : v.kind === "Bool" ? String(v.value) : "?"
            }))
            missing = t.members.map((m) => T.prune(m)).filter((m): m is Ty & { k: "lit" } => m.k === "lit").map((m) => String(m.value)).filter((v) => !vals.has(v))
        } else {
            missing = ["_"]
        }
        if (missing.length === 0) return
        const list = missing[0] === "_" ? "add a `_ =>` arm" : `missing ${missing.map((m) => `\`${m}\``).join(", ")}`
        this.error("E_NON_EXHAUSTIVE_MATCH", `this \`match\` on \`${T.show(subject)}\` doesn't cover every case: ${list}`, e)
    }
}

function isCallable(x: Callable | Ty): x is Callable {
    return "bounds" in x
}

function lastValueNode(b: A.Block): { span: Span } {
    const last = b.stmts[b.stmts.length - 1]
    return last?.kind === "ExprStmt" ? last.expr : b
}
