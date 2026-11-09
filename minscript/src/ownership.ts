// MinScript ownership and borrow checking (spec §9.1–§9.4, §9.6), first version.
//
// Runs after the type checker, per function, walking statements in evaluation order with a state
// of moved bindings. Branches are analysed on copies of the state and merged ("may have been moved");
// loop bodies run twice so a move in one iteration is caught on the next.
//
// Checks:
// - mutability: assigning to, or `&mut`-borrowing, a binding that isn't `var` / `mut` / `&mut`;
// - moves: use after move; moving out of a borrow (needs `.clone()`). Copy values, `string` and
//   handles (`Ref`, `Topic`, `Queue`, `Signal`, `Weak`: cloned implicitly) never move;
// - scoped values (values holding a borrow, §9.3): an owner may not change while a value borrowed
//   from it is still used later; a function may only return borrows of its borrowed parameters;
//   field declarations can't hold borrows; closures holding borrows can't escape (§9.4);
// - async calls with borrowed arguments must be awaited in the same expression (§9.6).
//
// Not yet: poisoning after `recover` (§9.8), partial moves of fields, borrows inside a single
// expression (`v.push(v.len())` is accepted).

import type * as A from "./ast.ts"
import type { CallInfo, CheckResult } from "./check.ts"
import type { Diagnostic } from "./diagnostic.ts"
import type { Resolution, Sym } from "./resolve.ts"
import type { Span } from "./token.ts"
import * as T from "./types.ts"
import type { Ty } from "./types.ts"

export type OwnershipResult = { diagnostics: Diagnostic[] }

export function checkOwnership(files: A.File[], res: Resolution, checked: CheckResult): OwnershipResult {
    return new Ownership(files, res, checked).run()
}

// ---------------------------------------------------------------------------------------------

const HANDLES: ReadonlySet<string> = new Set(["Ref", "Weak", "Topic", "Queue", "Signal"])
const LOCAL_KINDS: ReadonlySet<string> = new Set(["local", "param", "closure-param", "implicit", "this"])

type Moved = { at: A.Node, maybe: boolean }
type State = { dead: boolean, moved: Map<Sym, Moved> }

type Access = "use" | "mut"        // read or borrow / mutate, move or `&mut`
type Event = { sym: Sym, kind: Access, pos: number, node: A.Node }

type Scoped = { sym: Sym, owners: Map<Sym, "shared" | "mut">, defEnd: number, defPos: number }

type FnCtx = {
    /** how each binding is held when it isn't owned: borrowed parameters, `this`, loop items, captures */
    borrowed: Map<Sym, "shared" | "mut">
    retBorrow: boolean          // the function returns a borrow (`-> &str`)
    retNode: A.Type | null
    events: Event[]
    scoped: Scoped[]
    loops: { span: Span, breaks: State[] }[]
    fors: Span[]                // loop bodies, for liveness
    closureLocals: Map<Sym, A.Node>   // locals holding a closure that holds borrows
}

class Ownership {
    private readonly files: A.File[]
    private readonly refs: Map<A.Node, Sym>
    private readonly decls: Map<A.Node, Sym>
    private readonly captures: Map<A.Node, Sym[]>
    private readonly types: Map<A.Node, Ty>
    private readonly symTypes: Map<Sym, Ty>
    private readonly calls: Map<A.Node, CallInfo>
    private readonly diagnostics: Diagnostic[] = []
    private readonly reported = new Set<string>()
    private readonly usesOf = new Map<Sym, A.Node[]>()
    private readonly copyTypes = new Set<Sym>()
    private ctx!: FnCtx

    constructor(files: A.File[], res: Resolution, checked: CheckResult) {
        this.files = files
        this.refs = res.refs
        this.decls = res.decls
        this.captures = res.captures
        this.types = checked.types
        this.symTypes = checked.symbols
        this.calls = checked.calls
        for (const [node, sym] of res.refs) {
            if (node.kind !== "Ident" && node.kind !== "This" && node.kind !== "RecordField") continue
            const list = this.usesOf.get(sym) ?? []
            list.push(node)
            this.usesOf.set(sym, list)
        }
    }

    run(): OwnershipResult {
        for (const file of this.files) this.collectCopy(file)
        for (const file of this.files) for (const item of file.items) this.checkItem(item)
        return { diagnostics: this.diagnostics }
    }

    private error(code: string, message: string, at: { span: Span }): void {
        const key = `${code}@${at.span.start}`
        if (this.reported.has(key)) return
        this.reported.add(key)
        this.diagnostics.push({ code, message, span: { ...at.span }, severity: "error" })
    }

    // ---- type properties ----------------------------------------------------------------------

    /** Types declared `Copy` (`type X: Copy = …` or `impl Copy for X`). */
    private collectCopy(file: A.File): void {
        const isCopyIface = (t: A.Type) => t.kind === "TName" && t.path.join(".") === "Copy"
        for (const item of file.items) {
            if ((item.kind === "TypeDecl" || item.kind === "UnionDecl") && item.impls.some(isCopyIface)) {
                const sym = this.decls.get(item)
                if (sym) this.copyTypes.add(sym)
            }
            if (item.kind === "ImplDecl" && item.interfaces.some(isCopyIface) && item.target.kind === "TName") {
                const sym = this.refs.get(item.target)
                if (sym) this.copyTypes.add(sym)
            }
        }
    }

    /** Copy (spec §9.1): primitives, `string` (immutable, shared), shared borrows, and tuples / records / Options of Copy. */
    private isCopy(t: Ty | undefined): boolean {
        if (t === undefined) return true
        t = T.prune(t)
        switch (t.k) {
            case "prim": case "never": case "unknown": case "var": case "lit": case "union": case "ptr": case "package": case "meta": return true
            case "ref": return !t.mut
            case "tuple": return t.elems.every((e) => this.isCopy(e))
            case "record": return t.fields.every((f) => this.isCopy(f.ty))
            case "fn": case "param": return false
            case "named": {
                if (this.copyTypes.has(t.sym)) return true
                if (t.sym.std && (t.sym.name === "Option" || t.sym.name === "Result" || t.sym.name === "Range")) return t.args.every((a) => this.isCopy(a))
                if (t.sym.std && (t.sym.name === "Ordering" || t.sym.name === "PanicKind")) return true
                return false
            }
        }
    }

    /** Handles are cloned implicitly instead of moved (spec §9.1). */
    private isHandle(t: Ty | undefined): boolean {
        if (t === undefined) return false
        const s = T.strip(t)
        return s.k === "named" && s.sym.std === true && HANDLES.has(s.sym.name)
    }

    /** Does a value of this type hold a borrow (a scoped value, §9.3)? */
    private holdsBorrow(t: Ty | undefined, depth = 0): boolean {
        if (t === undefined || depth > 8) return false
        t = T.prune(t)
        switch (t.k) {
            case "ref": return true
            case "named": return (t.sym.std === true && t.sym.name === "Slice") || t.args.some((a) => this.holdsBorrow(a, depth + 1))
            case "tuple": return t.elems.some((e) => this.holdsBorrow(e, depth + 1))
            case "record": return t.fields.some((f) => this.holdsBorrow(f.ty, depth + 1))
            default: return false
        }
    }

    private typeOf(e: A.Node): Ty | undefined {
        return this.types.get(e)
    }

    // ---- items --------------------------------------------------------------------------------

    private checkItem(item: A.Item): void {
        switch (item.kind) {
            case "FunDecl": return this.checkFun(item)
            case "TypeDecl":
                if (item.body.kind === "StructBody") {
                    for (const f of item.body.fields) this.checkFieldType(f)
                    for (const m of item.body.methods) this.checkFun(m)
                } else if (item.body.kind === "TRecord") {
                    for (const f of item.body.fields) this.checkFieldType(f)
                }
                return
            case "UnionDecl":
                for (const v of item.variants) {
                    for (const f of v.fields ?? []) this.checkFieldType(f)
                    for (const t of v.tuple ?? []) this.checkFieldTypeNode(t, t)
                }
                for (const m of item.methods) this.checkFun(m)
                return
            case "InterDecl": for (const m of item.methods ?? []) this.checkFun(m); return
            case "ImplDecl": for (const m of item.methods) this.checkFun(m); return
            case "LetDecl": case "ExternDecl": return
        }
    }

    /** Field types may not contain borrows (E_BORROW_IN_FIELD, §9.3). */
    private checkFieldType(f: A.Field): void {
        this.checkFieldTypeNode(f.type, f)
    }

    private checkFieldTypeNode(t: A.Type, at: { span: Span }): void {
        const borrow = findBorrowType(t)
        if (borrow !== null) {
            this.error("E_BORROW_IN_FIELD", `a field can't hold a borrow (\`${borrow}\`): store an owned value instead (\`string\` for \`&str\`, \`Vec[T]\` for \`Slice[T]\`)`, at)
        }
    }

    private newCtx(retNode: A.Type | null): FnCtx {
        return {
            borrowed: new Map(), retBorrow: retNode !== null && findBorrowType(retNode) !== null, retNode,
            events: [], scoped: [], loops: [], fors: [], closureLocals: new Map(),
        }
    }

    private checkFun(f: A.FunDecl): void {
        if (f.body === null) return
        const saved = this.ctx
        this.ctx = this.newCtx(f.ret)
        try {
            for (const p of f.params) {
                const sym = this.decls.get(p)
                const t = sym ? T.prune(this.symTypes.get(sym) ?? T.UNKNOWN) : T.UNKNOWN
                if (sym && t.k === "ref") this.ctx.borrowed.set(sym, t.mut ? "mut" : "shared")
            }
            const thisSym = this.findThis(f.body)
            if (thisSym && (f.receiver === "&this" || f.receiver === "&mut this")) this.ctx.borrowed.set(thisSym, f.receiver === "&mut this" ? "mut" : "shared")
            const st: State = { dead: false, moved: new Map() }
            this.body(f.body, st, f.ret)
            this.checkScoped()
        } finally {
            this.ctx = saved
        }
    }

    /** The resolver's `this` symbol used inside a body, if any. */
    private findThis(body: A.Block): Sym | undefined {
        for (const [node, sym] of this.refs) {
            if (sym.kind === "this" && node.span.start >= body.span.start && node.span.end <= body.span.end) return sym
        }
        return undefined
    }

    /** A function or closure body: its last expression is returned. */
    private body(b: A.Block, st: State, ret: A.Type | null): void {
        const stmts = b.stmts
        stmts.forEach((s, i) => {
            const isTail = i === stmts.length - 1 && s.kind === "ExprStmt" && !s.semi
            if (isTail) this.returned(s.expr, st, ret)
            else this.stmt(s, st)
        })
    }

    // ---- state --------------------------------------------------------------------------------

    private clone(st: State): State {
        return { dead: st.dead, moved: new Map(st.moved) }
    }

    /** Joins branch states into `into`: a binding moved on any live branch may have been moved. */
    private merge(into: State, branches: State[]): void {
        const live = branches.filter((b) => !b.dead)
        if (live.length === 0) {
            into.dead = true
            return
        }
        const moved = new Map<Sym, Moved>()
        for (const b of live) {
            for (const [sym, m] of b.moved) {
                const all = live.every((o) => o.moved.has(sym))
                const prev = moved.get(sym)
                moved.set(sym, { at: prev?.at ?? m.at, maybe: !all || m.maybe || (prev?.maybe ?? false) })
            }
        }
        into.dead = false
        into.moved = moved
    }

    // ---- places -------------------------------------------------------------------------------

    /** The binding at the root of a place (`a`, `a.b[0]`, `this.items`), and whether the place is the whole binding. */
    private root(e: A.Expr): { sym: Sym, whole: boolean, node: A.Expr } | null {
        let whole = true
        let cur: A.Expr = e
        for (;;) {
            if (cur.kind === "Paren") { cur = cur.expr; continue }
            if (cur.kind === "Member" || cur.kind === "Index") { whole = false; cur = cur.object; continue }
            if (cur.kind === "Unary" && cur.op === "*") { whole = false; cur = cur.expr; continue }
            break
        }
        if (cur.kind !== "Ident" && cur.kind !== "This") return null
        const sym = this.refs.get(cur)
        if (sym === undefined || !LOCAL_KINDS.has(sym.kind)) return null
        return { sym, whole, node: cur }
    }

    private isPlace(e: A.Expr): boolean {
        if (e.kind === "Paren") return this.isPlace(e.expr)
        if (e.kind === "Ident" || e.kind === "This") return this.root(e) !== null
        if (e.kind === "Member" || e.kind === "Index") return this.root(e) !== null
        return false
    }

    /** Is the binding held as a borrow here (borrowed param, `&this`, loop item, implicit capture)? */
    private heldBy(sym: Sym): "owned" | "shared" | "mut" {
        const b = this.ctx.borrowed.get(sym)
        if (b !== undefined) return b
        const t = T.prune(this.symTypes.get(sym) ?? T.UNKNOWN)
        if (t.k === "ref") return t.mut ? "mut" : "shared"
        return "owned"
    }

    private event(sym: Sym, kind: Access, node: A.Node): void {
        this.ctx.events.push({ sym, kind, pos: node.span.start, node })
    }

    /** A use of a binding: it must not have been moved. */
    private touch(sym: Sym, node: A.Node, st: State, kind: Access): void {
        const m = st.moved.get(sym)
        if (m !== undefined && !st.dead) {
            const where = `${m.at.span.line}:${m.at.span.col}`
            const name = sym.name === "it1" ? "it" : sym.name
            this.error("E_USE_AFTER_MOVE", m.maybe
                ? `\`${name}\` may have been moved (at ${where}) on some path to here: clone it before the move, or restructure`
                : `\`${name}\` was moved at ${where} and can't be used after that: clone it before the move (\`.clone()\`), or borrow it`, node)
        }
        this.event(sym, kind, node)
    }

    /** Reads every binding used inside a place expression (and the index expressions). */
    private readPlace(e: A.Expr, st: State, kind: Access): void {
        switch (e.kind) {
            case "Paren": return this.readPlace(e.expr, st, kind)
            case "Member": return this.readPlace(e.object, st, kind)
            case "Index": this.readPlace(e.object, st, kind); this.expr(e.index, st); return
            case "Unary": return this.readPlace(e.expr, st, kind)
            case "Ident": case "This": {
                const sym = this.refs.get(e)
                if (sym && LOCAL_KINDS.has(sym.kind)) this.touch(sym, e, st, kind)
                return
            }
            default: this.expr(e, st)
        }
    }

    /** Can this place be written (assignment or `&mut`)? */
    private checkWritable(target: A.Expr, code: "E_ASSIGN_IMMUTABLE" | "E_MUT_BORROW_IMMUTABLE"): void {
        const r = this.root(target)
        if (r === null) return
        if (target.kind === "Unary" && target.op === "*") return      // raw pointer writes (unsafe)
        this.checkWritableSym(r, target, code)
    }

    private checkWritableSym(r: { sym: Sym, whole: boolean }, target: { span: Span }, code: "E_ASSIGN_IMMUTABLE" | "E_MUT_BORROW_IMMUTABLE"): void {
        const held = this.heldBy(r.sym)
        const name = r.sym.kind === "this" ? "this" : r.sym.name
        const what = code === "E_ASSIGN_IMMUTABLE" ? "assign to" : "borrow mutably"
        if (held === "mut") return
        if (held === "shared") {
            const capture = r.sym.kind !== "this" && this.isImplicitCapture(r.sym)
            const hint = r.sym.kind === "this" ? "declare the method with `&mut this`"
                : capture ? `the closure borrows \`${name}\` read-only: capture it with \`#[&mut ${name}]\``
                : `\`${name}\` is a shared borrow: take \`&mut\` instead`
            this.error(code, `can't ${what} ${r.whole ? `\`${name}\`` : `a part of \`${name}\``}: ${hint}`, target)
            return
        }
        if (r.sym.mutable) return
        const hint = r.sym.kind === "this" ? "the method takes `this` by value: declare it with `mut this`"
            : r.sym.kind === "param" ? `declare the parameter as \`mut ${name}\``
            : `declare it with \`var\` (or \`:==\`)`
        this.error(code, `can't ${what} ${r.whole ? `\`${name}\`` : `a part of \`${name}\``}, which isn't mutable: ${hint}`, target)
    }

    private isImplicitCapture(sym: Sym): boolean {
        return this.ctx.borrowed.get(sym) === "shared" && sym.kind !== "param" && sym.kind !== "this"
    }

    // ---- moves --------------------------------------------------------------------------------

    /**
     * `e` is consumed by an owner (a binding, an owned parameter, a field, the result):
     * a non-Copy place is moved, and a place held through a borrow can't be moved out of.
     */
    private consume(e: A.Expr, st: State, ownedTarget = true, typedOwned = false): void {
        if (e.kind === "Paren") return this.consume(e.expr, st, ownedTarget, typedOwned)
        // (escaping closures are checked where they escape: returns, fields, owned `(T) -> U` parameters)
        const r = this.root(e)
        if (r === null || !this.isPlace(e)) return this.expr(e, st)
        const ty = this.typeOf(e)
        this.readPlace(e, st, "use")
        // a `&T` given where an owned `T` is required (an owned parameter, the result, a field):
        // the referenced value would have to move out of the borrow
        const pt = T.prune(ty ?? T.UNKNOWN)
        if (typedOwned && pt.k === "ref" && !this.isCopy(pt.inner) && !this.isHandle(pt.inner)) {
            const name = r.sym.kind === "this" ? "this" : r.sym.name
            this.error("E_MOVE_OUT_OF_BORROW", `\`${name}\` is a borrow (\`${T.show(pt)}\`), but an owned \`${T.show(pt.inner)}\` is needed here: use \`.clone()\``, e)
            return
        }
        if (this.isCopy(ty) || this.isHandle(ty)) return
        const held = this.heldBy(r.sym)
        if (held !== "owned") {
            if (!ownedTarget) return
            const name = r.sym.kind === "this" ? "this" : r.sym.name
            this.error("E_MOVE_OUT_OF_BORROW", `can't move ${r.whole ? `\`${name}\`` : `out of \`${name}\``} here: it is borrowed${r.sym.kind === "this" ? " (`&this`)" : ""}, so the value isn't ours to give away; use \`.clone()\``, e)
            return
        }
        if (!ownedTarget || !r.whole) return        // partial moves are not tracked yet
        st.moved.set(r.sym, { at: e, maybe: false })
        this.event(r.sym, "mut", e)
    }

    /** A value returned from the function (or closure): moved out, or checked as a returned borrow. */
    private returned(e: A.Expr, st: State, ret: A.Type | null): void {
        if (ret !== null && findBorrowType(ret) !== null) {
            this.checkReturnedBorrow(e)
            this.expr(e, st)
            return
        }
        const fnRet = ret !== null && (ret.kind === "TFn")
        if (fnRet) this.checkEscapeOf(e)
        this.consume(e, st, ret !== null, ret !== null)
    }

    // ---- statements ---------------------------------------------------------------------------

    private stmt(s: A.Stmt, st: State): void {
        if (s.kind === "ExprStmt") {
            this.expr(s.expr, st)
            return
        }
        const annotatedBorrow = s.type !== null && findBorrowType(s.type) !== null
        this.consume(s.value, st, !annotatedBorrow, s.type !== null && !annotatedBorrow)
        if (s.else !== null) {
            const branch = this.clone(st)
            this.block(s.else, branch)
            // the else block diverges, so its state doesn't flow on
        }
        this.freshBindings(s.pattern, st)
        // a binding that holds a borrow is a scoped value: remember what it borrows from
        if (s.pattern.kind === "PBind") {
            const sym = this.decls.get(s.pattern)
            if (sym === undefined) return
            const ty = this.symTypes.get(sym)
            const closure = this.closureOf(s.value)
            if (closure !== null && this.closureHoldsBorrow(closure)) this.ctx.closureLocals.set(sym, closure)
            if (this.holdsBorrow(ty) || T.prune(ty ?? T.UNKNOWN).k === "fn") {
                const owners = this.ownersOf(s.value)
                owners.delete(sym)
                if (owners.size > 0) this.ctx.scoped.push({ sym, owners, defEnd: s.span.end, defPos: s.span.start })
            }
        }
    }

    private closureOf(e: A.Expr): A.Node | null {
        if (e.kind === "Paren") return this.closureOf(e.expr)
        if (e.kind === "Closure") return e
        if (e.kind === "Ident") {
            const sym = this.refs.get(e)
            return sym ? this.ctx.closureLocals.get(sym) ?? null : null
        }
        return null
    }

    /** New bindings start out valid (a `let` in a loop body is fresh on every iteration). */
    private freshBindings(p: A.Pattern, st: State): void {
        const visit = (n: A.Pattern | A.PatField): void => {
            const sym = this.decls.get(n)
            if (sym) st.moved.delete(sym)
            switch (n.kind) {
                case "PCall": n.args.forEach(visit); break
                case "PStruct": n.fields.forEach((f) => { visit(f); if (f.pattern) visit(f.pattern) }); break
                case "PTuple": n.elems.forEach(visit); break
                case "POr": n.alts.forEach(visit); break
                default: break
            }
        }
        visit(p)
    }

    /** Bindings of a pattern matched against a borrowed place are borrowed too. */
    private borrowPattern(p: A.Pattern, mode: "shared" | "mut"): void {
        const visit = (n: A.Pattern | A.PatField): void => {
            const sym = this.decls.get(n)
            if (sym) this.ctx.borrowed.set(sym, mode)
            switch (n.kind) {
                case "PCall": n.args.forEach(visit); break
                case "PStruct": n.fields.forEach((f) => { visit(f); if (f.pattern) visit(f.pattern) }); break
                case "PTuple": n.elems.forEach(visit); break
                case "POr": n.alts.forEach(visit); break
                default: break
            }
        }
        visit(p)
    }

    private block(b: A.Block, st: State): void {
        for (const s of b.stmts) this.stmt(s, st)
    }

    // ---- expressions --------------------------------------------------------------------------

    private expr(e: A.Expr, st: State, awaited = false): void {
        switch (e.kind) {
            case "Ident": case "This": {
                const sym = this.refs.get(e)
                if (sym && LOCAL_KINDS.has(sym.kind)) this.touch(sym, e, st, "use")
                return
            }
            case "Int": case "Float": case "Str": case "Char": case "Bool": case "Nil": case "Error": return
            case "Template": for (const p of e.parts) if (typeof p !== "string") this.expr(p, st); return
            case "Paren": return this.expr(e.expr, st, awaited)
            case "Vec": case "Array": case "Tuple": case "Set":
                for (const el of e.elems) this.element(el.kind === "Spread" ? el.expr : el, st)
                return
            case "Map":
                for (const en of e.entries) {
                    if (en.kind === "Spread") this.expr(en.expr, st)
                    else { this.element(en.key, st); this.element(en.value, st) }
                }
                return
            case "Record": case "Inferred": case "StructLit":
                if (e.kind === "StructLit") this.expr(e.type, st)
                for (const f of e.fields) {
                    if (f.kind === "Spread") { this.expr(f.expr, st); continue }
                    if (f.value !== null) this.element(f.value, st, e.kind === "StructLit")
                    else this.shorthandField(f, st)
                }
                return
            case "Closure": return this.closure(e, st)
            case "Unary":
                if (e.op === "&mut") {
                    this.checkWritable(e.expr, "E_MUT_BORROW_IMMUTABLE")
                    return this.readPlace(e.expr, st, "mut")
                }
                if (e.op === "&") return this.readPlace(e.expr, st, "use")
                return this.expr(e.expr, st)
            case "Await": return this.awaitExpr(e.expr, st)
            case "Binary": {
                this.expr(e.left, st)
                if (e.op === "&&" || e.op === "||" || e.op === "??") {
                    const right = this.clone(st)
                    if (e.op === "??") this.consume(e.right, right)
                    else this.expr(e.right, right)
                    this.merge(st, [this.clone(st), right])
                    return
                }
                this.expr(e.right, st)
                return
            }
            case "Assign": return this.assign(e, st)
            case "Range": if (e.start) this.expr(e.start, st); if (e.end) this.expr(e.end, st); return
            case "As": return this.expr(e.expr, st)
            case "Or": {
                this.consume(e.expr, st)
                const branch = this.clone(st)
                this.consume(e.rhs, branch)            // the right side is returned (or breaks): it diverges
                return
            }
            case "Member": case "OptMember": return this.expr(e.object, st)
            case "Index": this.expr(e.object, st); this.expr(e.index, st); return
            case "GenericApply": return this.expr(e.target, st)
            case "Try": return this.consume(e.expr, st)
            case "Call": return this.call(e, st, awaited)
            case "If": return this.ifExpr(e, st)
            case "Match": return this.matchExpr(e, st)
            case "Select": return this.selectExpr(e, st)
            case "For": return this.forExpr(e, st)
            case "Block": { this.block(e, st); return }
            case "Unsafe": { this.block(e.body, st); return }
            case "Recover": {
                const before = this.clone(st)
                this.block(e.body, st)
                this.merge(st, [before, this.clone(st)])     // the block may panic part-way
                return
            }
            case "Return":
                if (e.value !== null) this.returned(e.value, st, this.ctx.retNode)
                st.dead = true
                return
            case "Break": {
                if (e.value !== null) this.consume(e.value, st)
                const loop = this.ctx.loops[this.ctx.loops.length - 1]
                if (loop) loop.breaks.push(this.clone(st))
                st.dead = true
                return
            }
            case "Continue": st.dead = true; return
        }
    }

    /** An element of a literal (Vec, struct field, …): owned by the literal. */
    private element(e: A.Expr, st: State, typedOwned = false): void {
        this.checkEscapeOf(e)
        this.consume(e, st, true, typedOwned)
    }

    private shorthandField(f: A.RecordField, st: State): void {
        const sym = this.refs.get(f)
        if (sym === undefined || !LOCAL_KINDS.has(sym.kind)) return
        this.touch(sym, f, st, "use")
        const ty = this.symTypes.get(sym)
        if (this.ctx.closureLocals.has(sym)) this.checkEscape(f, this.ctx.closureLocals.get(sym)!)
        if (this.isCopy(ty) || this.isHandle(ty)) return
        if (this.heldBy(sym) !== "owned") {
            this.error("E_MOVE_OUT_OF_BORROW", `can't move \`${sym.name}\` into this literal: it is borrowed; use \`${f.key}: ${f.key}.clone()\``, f)
            return
        }
        st.moved.set(sym, { at: f, maybe: false })
        this.event(sym, "mut", f)
    }

    private awaitExpr(e: A.Expr, st: State): void {
        if (e.kind === "Call" || (e.kind === "Paren" && e.expr.kind === "Call")) return this.expr(e, st, true)
        this.consume(e, st)        // awaiting a stored Promise consumes it
    }

    private assign(e: Extract<A.Expr, { kind: "Assign" }>, st: State): void {
        this.checkWritable(e.target, "E_ASSIGN_IMMUTABLE")
        if (e.op === "=") {
            this.consume(e.value, st)
            this.checkEscapeOf(e.value)
            const r = this.root(e.target)
            if (r !== null && r.whole) {
                st.moved.delete(r.sym)             // re-initialized
                this.event(r.sym, "mut", e.target)
                return
            }
            this.readPlace(e.target, st, "mut")
            return
        }
        this.expr(e.value, st)
        this.readPlace(e.target, st, "mut")
    }

    private call(e: Extract<A.Expr, { kind: "Call" }>, st: State, awaited: boolean): void {
        const info = this.calls.get(e)
        const callee = e.callee.kind === "GenericApply" ? e.callee.target : e.callee
        const recvExpr = (callee.kind === "Member" || callee.kind === "OptMember") && info?.receiver != null ? callee.object : null

        // the receiver
        if (recvExpr !== null && info !== undefined) {
            switch (info.receiver) {
                case "this": case "mut this": this.consume(recvExpr, st); break
                case "&mut this":
                    if (this.isPlace(recvExpr) && !this.isHandle(this.typeOf(recvExpr))) {
                        this.checkWritable(recvExpr, "E_MUT_BORROW_IMMUTABLE")
                        this.readPlace(recvExpr, st, "mut")
                    } else {
                        this.expr(recvExpr, st)
                    }
                    break
                default: this.expr(recvExpr, st)
            }
        } else {
            this.expr(e.callee, st)
        }

        // the arguments
        e.args.forEach((a, i) => {
            const arg = a.kind === "Spread" ? a.expr : a
            const p = info?.args[i]
            if (p === undefined) { this.expr(arg, st); return }
            const pt = T.prune(p)
            if (pt.k === "ref") {
                if (pt.mut && this.isPlace(arg)) {
                    this.checkWritable(arg, "E_MUT_BORROW_IMMUTABLE")
                    this.readPlace(arg, st, "mut")
                } else {
                    this.expr(arg, st)
                }
                return
            }
            if (pt.k === "fn") this.checkEscapeOf(arg)
            if (pt.k === "unknown" || pt.k === "var") { this.expr(arg, st); return }
            this.consume(arg, st, true, pt.k !== "param")
        })

        if (info?.async && !awaited) this.checkSpawn(e, info, recvExpr)
        if (T.prune(this.typeOf(e) ?? T.UNKNOWN).k === "never") st.dead = true
    }

    /** An async call that isn't awaited right away runs as a task: it can't hold borrows (§9.6). */
    private checkSpawn(e: Extract<A.Expr, { kind: "Call" }>, info: CallInfo, recv: A.Expr | null): void {
        const borrowedPlace = (x: A.Expr) => this.isPlace(x) && !this.isHandle(this.typeOf(x)) && !this.isCopy(this.typeOf(x))
        if (recv !== null && (info.receiver === "&this" || info.receiver === "&mut this") && borrowedPlace(recv)) {
            this.error("E_BORROW_ACROSS_SPAWN", "this async call borrows its receiver, so it must be awaited in the same expression (`await x.f()`); or call it on an owned value / a handle", e)
            return
        }
        e.args.forEach((a, i) => {
            const p = T.prune(info.args[i] ?? T.UNKNOWN)
            const arg = a.kind === "Spread" ? a.expr : a
            if (p.k === "ref" && borrowedPlace(arg)) {
                this.error("E_BORROW_ACROSS_SPAWN", "this async call borrows an argument, so it must be awaited in the same expression (`await f(x)`); or pass an owned value or a handle (`Ref`)", arg)
            }
        })
    }

    private ifExpr(e: Extract<A.Expr, { kind: "If" }>, st: State): void {
        if (e.cond.kind === "LetCond") {
            this.expr(e.cond.value, st)
            this.matchedBy(e.cond.value, e.cond.pattern)
        } else {
            this.expr(e.cond, st)
        }
        const thenSt = this.clone(st)
        if (e.cond.kind === "LetCond") this.freshBindings(e.cond.pattern, thenSt)
        this.block(e.then, thenSt)
        const elseSt = this.clone(st)
        if (e.else !== null) {
            if (e.else.kind === "Block") this.block(e.else, elseSt)
            else this.expr(e.else, elseSt)
        }
        this.merge(st, [thenSt, elseSt])
    }

    /** Bindings of a pattern matched against a borrowed place borrow from it. */
    private matchedBy(subject: A.Expr, p: A.Pattern): void {
        const r = this.root(subject)
        if (r === null || !this.isPlace(subject)) return
        const held = this.heldBy(r.sym)
        if (held !== "owned") this.borrowPattern(p, held)
    }

    private matchExpr(e: Extract<A.Expr, { kind: "Match" }>, st: State): void {
        if (e.subject) this.expr(e.subject, st)
        const branches: State[] = []
        for (const arm of e.arms) {
            const b = this.clone(st)
            if (arm.pattern) {
                if (e.subject) this.matchedBy(e.subject, arm.pattern)
                this.freshBindings(arm.pattern, b)
            }
            if (arm.test) this.expr(arm.test, b)
            if (arm.guard) this.expr(arm.guard, b)
            this.consumeOrExpr(arm.body, b)
            branches.push(b)
        }
        if (branches.length > 0) this.merge(st, branches)
    }

    private consumeOrExpr(e: A.Expr, st: State): void {
        if (this.isPlace(e)) this.consume(e, st)
        else this.expr(e, st)
    }

    private selectExpr(e: Extract<A.Expr, { kind: "Select" }>, st: State): void {
        for (const arm of e.arms) this.expr(arm.expr, st, true)       // every arm waits: awaited
        const branches: State[] = []
        for (const arm of e.arms) {
            const b = this.clone(st)
            if (arm.pattern) this.freshBindings(arm.pattern, b)
            this.consumeOrExpr(arm.body, b)
            branches.push(b)
        }
        if (e.else !== null) {
            const b = this.clone(st)
            this.expr(e.else, b)
            branches.push(b)
        }
        if (branches.length > 0) this.merge(st, branches)
    }

    private forExpr(e: Extract<A.Expr, { kind: "For" }>, st: State): void {
        if (e.expr !== null) {
            if (e.form === "in" && !e.await) this.expr(e.expr, st)
            else if (e.form === "in" && e.await) this.readPlace(e.expr, st, "mut")
            else this.expr(e.expr, st)
        }
        // `for x in items` borrows each item (iter(), spec §10.2); `for await` and ranges yield owned values
        if (e.form === "in" && !e.await && e.pattern !== null) {
            const t = T.strip(this.typeOf(e.expr!) ?? T.UNKNOWN)
            const borrowsItems = t.k === "named" && t.sym.std === true && ["Vec", "Array", "Slice", "Set", "Map"].includes(t.sym.name)
            if (borrowsItems) this.borrowPattern(e.pattern, "shared")
        }
        if (e.form === "let" && e.pattern !== null && e.expr !== null) this.matchedBy(e.expr, e.pattern)

        this.ctx.fors.push(e.body.span)
        const loop = { span: e.body.span, breaks: [] as State[] }
        this.ctx.loops.push(loop)
        try {
            // run the body twice: a move in one iteration is a use-after-move in the next
            const first = this.clone(st)
            this.declarePatterns(e, first)
            this.block(e.body, first)
            const again = this.clone(st)
            this.merge(again, [this.clone(st), first])
            this.declarePatterns(e, again)
            this.block(e.body, again)
            if (e.form === "infinite") this.merge(st, loop.breaks.length > 0 ? loop.breaks : [{ dead: true, moved: new Map() }])
            else this.merge(st, [this.clone(st), first, again, ...loop.breaks])
        } finally {
            this.ctx.loops.pop()
        }
    }

    private declarePatterns(e: Extract<A.Expr, { kind: "For" }>, st: State): void {
        if (e.pattern) this.freshBindings(e.pattern, st)
        if (e.pattern2) this.freshBindings(e.pattern2, st)
    }

    // ---- closures (§9.4) ----------------------------------------------------------------------

    private closureHoldsBorrow(c: A.Node): boolean {
        return this.borrowedCaptures(c).length > 0
    }

    /** Captures held as borrows: the implicit ones (except handles) and `#[&mut x]`. */
    private borrowedCaptures(c: A.Node): { sym: Sym, mode: "shared" | "mut" }[] {
        if (c.kind !== "Closure") return []
        const explicit = new Map<Sym, A.Capture["mode"]>()
        for (const cap of c.captures ?? []) {
            const sym = this.refs.get(cap)
            if (sym) explicit.set(sym, cap.mode)
        }
        const out: { sym: Sym, mode: "shared" | "mut" }[] = []
        for (const sym of this.captures.get(c) ?? []) {
            const mode = explicit.get(sym)
            if (mode === "move") continue
            if (mode === "mut") { out.push({ sym, mode: "mut" }); continue }
            if (this.isHandle(this.symTypes.get(sym))) continue       // handles are cloned into the closure
            out.push({ sym, mode: "shared" })
        }
        return out
    }

    private checkEscapeOf(e: A.Expr): void {
        const c = this.closureOf(e)
        if (c !== null) this.checkEscape(e, c)
    }

    /** A closure holding borrows can't be returned, stored, or passed as an owned function (§9.4). */
    private checkEscape(at: { span: Span }, c: A.Node): void {
        const borrowed = this.borrowedCaptures(c)
        if (borrowed.length === 0) return
        const names = borrowed.map((b) => b.sym.kind === "this" ? "this" : b.sym.name)
        const fix = borrowed.filter((b) => b.mode === "shared").map((b) => b.sym.name)
        this.error("E_CLOSURE_ESCAPES_BORROW", `this closure borrows ${names.map((n) => `\`${n}\``).join(", ")}, so it can't outlive this scope (returned, stored, or passed as an owned \`(T) -> U\`)${fix.length ? `: capture by value with \`#[${fix.join(", ")}]\`` : ""}`, at)
    }

    private closure(c: Extract<A.Expr, { kind: "Closure" }>, st: State): void {
        // creating the closure: by-value captures move in, `&mut` captures need a mutable binding
        for (const cap of c.captures ?? []) {
            const sym = this.refs.get(cap)
            if (sym === undefined) continue
            if (cap.mode === "move") {
                this.touch(sym, cap, st, "use")
                const ty = this.symTypes.get(sym)
                if (!this.isCopy(ty) && !this.isHandle(ty)) {
                    if (this.heldBy(sym) !== "owned") this.error("E_MOVE_OUT_OF_BORROW", `can't move \`${sym.name}\` into the closure: it is borrowed; capture a clone`, cap)
                    else { st.moved.set(sym, { at: cap, maybe: false }); this.event(sym, "mut", cap) }
                }
            } else if (cap.mode === "mut") {
                this.touch(sym, cap, st, "mut")
                this.checkWritableSym({ sym, whole: true }, cap, "E_MUT_BORROW_IMMUTABLE")
            } else {
                this.touch(sym, cap, st, "use")
            }
        }
        const explicit = new Set((c.captures ?? []).map((cap) => this.refs.get(cap)).filter((s): s is Sym => s !== undefined))
        for (const sym of this.captures.get(c) ?? []) {
            if (explicit.has(sym)) continue
            const m = st.moved.get(sym)
            if (m !== undefined) this.touch(sym, c, st, "use")
            else this.event(sym, "use", c)
        }

        // the body runs later: its own analysis, with the captures held as borrows (or owned)
        const saved = this.ctx
        const inner = this.newCtx(c.ret)
        inner.borrowed = new Map(saved.borrowed)
        inner.closureLocals = new Map(saved.closureLocals)
        for (const b of this.borrowedCaptures(c)) inner.borrowed.set(b.sym, b.mode)
        for (const cap of c.captures ?? []) {
            const sym = this.refs.get(cap)
            if (sym && cap.mode === "move") inner.borrowed.delete(sym)
        }
        this.ctx = inner
        try {
            const bodySt: State = { dead: false, moved: new Map() }
            this.body(c.body, bodySt, c.ret)
            this.checkScoped()
        } finally {
            this.ctx = saved
        }
    }

    // ---- scoped values (§9.3) -----------------------------------------------------------------

    /**
     * The bindings a value may borrow from, by its shape: places it reads (`x`, `x.f`, `x[i]` → x),
     * receivers of `&this` methods, arguments passed by reference, and the captures of closures.
     * Arithmetic, templates and owned arguments produce owned values, so they borrow nothing.
     */
    private ownersOf(e: A.Expr): Map<Sym, "shared" | "mut"> {
        const out = new Map<Sym, "shared" | "mut">()
        const add = (sym: Sym, mode: "shared" | "mut") => {
            if (out.get(sym) !== "mut") out.set(sym, mode)
            for (const s of this.ctx.scoped) {
                if (s.sym === sym) for (const [o, m] of s.owners) if (out.get(o) !== "mut") out.set(o, m)
            }
        }
        const visit = (n: A.Expr): void => {
            switch (n.kind) {
                case "Ident": case "This": {
                    const sym = this.refs.get(n)
                    if (sym === undefined || !LOCAL_KINDS.has(sym.kind)) return
                    if (this.isHandle(this.symTypes.get(sym))) return
                    add(sym, "shared")
                    return
                }
                case "Member": case "OptMember": return visit(n.object)
                case "Index": return visit(n.object)
                case "Paren": case "Try": case "As": return visit(n.expr)
                case "Binary": if (n.op === "??") { visit(n.left); visit(n.right) } return
                case "Or": return visit(n.expr)
                case "Vec": case "Array": case "Tuple": case "Set":
                    for (const x of n.elems) visit(x.kind === "Spread" ? x.expr : x)
                    return
                case "If": case "Match": case "Block": case "Unsafe": case "Recover":
                    return forEachChildExpr(n, visit)
                case "Await": case "Template": case "Range": case "Int": case "Float": case "Str": case "Char": case "Bool": case "Nil":
                case "Record": case "Inferred": case "StructLit": case "Map":
                    return
                case "Closure":
                    for (const b of this.borrowedCaptures(n)) add(b.sym, b.mode)
                    return
                case "Unary":
                    if (n.op === "&mut") { const r = this.root(n.expr); if (r) add(r.sym, "mut"); return }
                    return visit(n.expr)
                case "Call": {
                    const info = this.calls.get(n)
                    const callee = n.callee.kind === "GenericApply" ? n.callee.target : n.callee
                    if ((callee.kind === "Member" || callee.kind === "OptMember") && info?.receiver === "&mut this") {
                        const r = this.root(callee.object)
                        if (r) add(r.sym, "mut")
                    } else if ((callee.kind === "Member" || callee.kind === "OptMember") && (info?.receiver === "this" || info?.receiver === "mut this")) {
                        // the receiver is consumed: the result borrows nothing from it
                    } else if (callee.kind === "Member" || callee.kind === "OptMember") {
                        visit(callee.object)
                        // a borrow returned by a handle's method (`r.get()`: `&T`) borrows from that handle
                        const r = this.root(callee.object)
                        if (r && this.isHandle(this.symTypes.get(r.sym)) && T.prune(this.typeOf(n) ?? T.UNKNOWN).k === "ref") add(r.sym, "shared")
                    }
                    n.args.forEach((a, i) => {
                        const p = T.prune(info?.args[i] ?? T.UNKNOWN)
                        if (p.k === "ref" || p.k === "unknown") visit(a.kind === "Spread" ? a.expr : a)   // owned arguments are moved, not borrowed
                    })
                    return
                }
                default:
                    return
            }
        }
        visit(e)
        return out
    }

    /** A function returning a borrow may only return borrows of its borrowed parameters / receiver. */
    private checkReturnedBorrow(e: A.Expr): void {
        const owners = this.ownersOf(e)
        for (const [sym] of owners) {
            if (this.heldBy(sym) !== "owned") continue
            if (this.holdsBorrow(this.symTypes.get(sym))) continue          // a scoped local: its own owners are listed too
            const name = sym.kind === "this" ? "this" : sym.name
            const what = sym.kind === "param" ? `the parameter \`${name}\`, which is owned (it is dropped when the function returns)` : `\`${name}\`, which is local to the function`
            this.error("E_RETURN_LOCAL_BORROW", `this returns a borrow of ${what}: return an owned value (\`.to_str()\`, \`.to_vec()\`, \`.clone()\`) or take the parameter as \`&T\``, e)
            return
        }
    }

    /**
     * An owner can't change while a value borrowed from it is still used later
     * (and nothing may touch an owner that is borrowed mutably).
     */
    private checkScoped(): void {
        for (const s of this.ctx.scoped) {
            const uses = (this.usesOf.get(s.sym) ?? []).filter((u) => u.span.start > s.defEnd)
            if (uses.length === 0) continue
            let end = Math.max(...uses.map((u) => u.span.end))
            // used inside a loop declared outside it: live until the end of the loop
            for (const f of this.ctx.fors) {
                if (s.defPos >= f.start && s.defPos <= f.end) continue
                if (uses.some((u) => u.span.start >= f.start && u.span.end <= f.end)) end = Math.max(end, f.end)
            }
            for (const ev of this.ctx.events) {
                if (ev.pos <= s.defEnd || ev.pos >= end) continue
                const mode = s.owners.get(ev.sym)
                if (mode === undefined) continue
                if (mode === "shared" && ev.kind !== "mut") continue
                const lastUse = uses.reduce((a, b) => (b.span.start > a.span.start ? b : a))
                const name = ev.sym.kind === "this" ? "this" : ev.sym.name
                const verb = mode === "mut" ? "used" : "changed"
                this.error("E_BORROW_CONFLICT", `\`${name}\` is ${verb} here while \`${s.sym.name}\` (which borrows ${mode === "mut" ? "it mutably" : "from it"}) is still used at ${lastUse.span.line}:${lastUse.span.col}`, ev.node)
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------

/** The first borrow inside a type annotation (`&T`, `Slice[T]`), as text, or null. */
function findBorrowType(t: A.Type): string | null {
    switch (t.kind) {
        case "TRef": return "&" + (t.mut ? "mut " : "") + typeText(t.inner)
        case "TName":
            if (t.path.length === 1 && t.path[0] === "Slice") return typeText(t)
            for (const a of t.args) { const b = findBorrowType(a); if (b) return b }
            return null
        case "TOption": case "TPtr": return t.kind === "TPtr" ? null : findBorrowType(t.inner)
        case "TTuple": for (const e of t.elems) { const b = findBorrowType(e); if (b) return b } return null
        case "TRecord": for (const f of t.fields) { const b = findBorrowType(f.type); if (b) return b } return null
        case "TUnion": case "TIntersection": return null
        default: return null
    }
}

function typeText(t: A.Type): string {
    switch (t.kind) {
        case "TName": return t.path.join(".") + (t.args.length ? `[${t.args.map(typeText).join(", ")}]` : "")
        case "TRef": return "&" + (t.mut ? "mut " : "") + typeText(t.inner)
        case "TOption": return typeText(t.inner) + "?"
        default: return "…"
    }
}

/** Calls `fn` on each direct sub-expression of `e` (used by `ownersOf`). */
function forEachChildExpr(e: A.Expr, fn: (x: A.Expr) => void): void {
    const visitBlock = (b: A.Block) => b.stmts.forEach((s) => (s.kind === "ExprStmt" ? fn(s.expr) : fn(s.value)))
    switch (e.kind) {
        case "Paren": case "Await": case "Try": case "As": return fn(e.expr)
        case "Member": case "OptMember": return fn(e.object)
        case "Index": fn(e.object); fn(e.index); return
        case "GenericApply": return fn(e.target)
        case "Binary": fn(e.left); fn(e.right); return
        case "Or": fn(e.expr); return
        case "Range": if (e.start) fn(e.start); if (e.end) fn(e.end); return
        case "Template": for (const p of e.parts) if (typeof p !== "string") fn(p); return
        case "Vec": case "Array": case "Tuple": case "Set": for (const x of e.elems) fn(x.kind === "Spread" ? x.expr : x); return
        case "Map": for (const x of e.entries) { if (x.kind === "Spread") fn(x.expr); else { fn(x.key); fn(x.value) } } return
        case "Record": case "Inferred": case "StructLit":
            for (const f of e.fields) { if (f.kind === "Spread") fn(f.expr); else if (f.value) fn(f.value) }
            return
        case "If":
            if (e.cond.kind !== "LetCond") fn(e.cond)
            visitBlock(e.then)
            if (e.else) { if (e.else.kind === "Block") visitBlock(e.else); else fn(e.else) }
            return
        case "Match": for (const a of e.arms) fn(a.body); return
        case "Block": return visitBlock(e)
        case "Unsafe": case "Recover": return visitBlock(e.body)
        default: return
    }
}
