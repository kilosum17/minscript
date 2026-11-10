// Lowering: typed AST → HIR (spec §0.3 step 5; the HIR is described in src/hir.ts).
//
// Lowering reads the decisions the resolver and the checker recorded (what each name binds to,
// each expression's type, what each call, member, operator, index and loop resolved to, which
// variant each inferred name is). It never re-derives a type rule: if it needs a fact, the checker
// records it.
//
// The whole program is lowered at once (the prelude, then each package in dependency order), so
// every call can name its callee.

import type * as A from "./ast.ts";
import type { CallTarget, CheckResult } from "./check.ts";
import type * as H from "./hir.ts";
import type { Resolution, ResolveFile, Sym } from "./resolve.ts";
import * as T from "./types.ts";
import type { Ty } from "./types.ts";

export interface LowerPackage {
    name: string;
    files: ResolveFile[];
    res: Resolution;
    checked: CheckResult;
    std: boolean;
}

/** Lowers every package (the prelude first) into one HIR program. */
export function lowerProgram(packages: LowerPackage[]): H.Program {
    return new Lowerer(packages).run();
}

const qualify = (pkg: string, name: string) => (pkg === "main" ? name : `${pkg}.${name}`);

let nextTemp = 1;

class Lowerer {
    readonly packages: LowerPackage[];
    readonly out: H.Program = { types: [], funs: [], globals: [] };
    // merged side tables of every package
    readonly refs = new Map<object, Sym>();
    readonly decls = new Map<object, Sym>();
    readonly types = new Map<object, Ty>();
    readonly calls = new Map<A.Call, CheckResult["calls"] extends Map<A.Call, infer V> ? V : never>();
    readonly members = new Map<A.Member, CheckResult["members"] extends Map<A.Member, infer V> ? V : never>();
    readonly variants = new Map<object, { union: Sym; variant: string }>();
    readonly ops = new Map<object, CallTarget>();
    readonly symTypes = new Map<Sym, Ty>();
    readonly rets = new Map<A.FnDecl, Ty>();
    readonly declTypes = new Map<A.Type, Ty>();
    readonly captures = new Map<A.Closure, Sym[]>();
    readonly implicit = new Map<object, Map<string, Sym>>();
    readonly thisOf = new Map<object, Sym>();
    // names
    readonly fnNames = new Map<A.FnDecl, string>();
    readonly typeNames = new Map<Sym, string>();
    readonly typeDecls = new Map<Sym, A.TypeDecl | A.UnionDecl | A.InterDecl>();
    readonly globalNames = new Map<Sym, string>();
    /** methods declared in an interface */
    readonly interMethods = new Set<A.FnDecl>();
    // the current function
    pkg!: LowerPackage;
    file = "";
    locals = new Map<Sym, H.Local>();
    selfLocal: H.Local | null = null;

    constructor(packages: LowerPackage[]) {
        this.packages = packages;
        for (const p of packages) {
            const { res, checked } = p;
            for (const [k, v] of res.refs) this.refs.set(k, v);
            for (const [k, v] of res.decls) this.decls.set(k, v);
            for (const [k, v] of res.captures) this.captures.set(k, v);
            for (const s of res.symbols) {
                if (s.kind === "implicit" && s.decl) {
                    const m = this.implicit.get(s.decl) ?? new Map<string, Sym>();
                    m.set(s.name, s);
                    this.implicit.set(s.decl, m);
                }
                if (s.kind === "this" && s.decl) this.thisOf.set(s.decl, s);
            }
            for (const [k, v] of checked.types) this.types.set(k, v);
            for (const [k, v] of checked.calls) this.calls.set(k, v);
            for (const [k, v] of checked.members) this.members.set(k, v);
            for (const [k, v] of checked.variants) this.variants.set(k, v);
            for (const [k, v] of checked.ops) this.ops.set(k, v);
            for (const [k, v] of checked.symTypes) this.symTypes.set(k, v);
            for (const [k, v] of checked.rets) this.rets.set(k, v);
            for (const [k, v] of checked.declTypes) this.declTypes.set(k, v);
        }
        for (const p of packages) for (const f of p.files) for (const item of f.ast.items) this.name(item, p.name);
        for (const p of packages) for (const f of p.files) for (const item of f.ast.items) if (item.kind === "ImplDecl") this.nameImpl(item);
    }

    /** Mangled names: `pkg.fn`, `pkg.Type`, `pkg.Type.method` (the main package unprefixed). */
    name(item: A.Item, pkg: string): void {
        switch (item.kind) {
            case "Fn":
                this.fnNames.set(item, qualify(pkg, item.name));
                return;
            case "TypeDecl": case "UnionDecl": case "InterDecl": {
                const sym = this.decls.get(item);
                const name = qualify(pkg, item.name);
                if (sym) {
                    this.typeNames.set(sym, name);
                    this.typeDecls.set(sym, item);
                }
                const members = item.kind === "InterDecl" ? item.methods ?? [] : item.members ?? [];
                for (const m of members) if (m.kind === "Fn") this.fnNames.set(m, `${name}.${m.name}`);
                if (item.kind === "InterDecl") for (const m of item.methods ?? []) this.interMethods.add(m);
                return;
            }
            case "LetDecl": case "VarDecl": {
                const sym = this.decls.get(item);
                if (sym) this.globalNames.set(sym, qualify(pkg, item.name));
                return;
            }
            case "ExternDecl":
                for (const f of item.fns) this.fnNames.set(f, f.name);
                return;
            case "ImplDecl":
                return;
        }
    }

    nameImpl(item: A.ImplDecl): void {
        const owner = item.target.kind === "TName" ? this.refs.get(item.target) : undefined;
        const base = owner ? this.typeNames.get(owner) ?? `prelude.${owner.name}` : "?";
        for (const m of item.methods) this.fnNames.set(m, `${base}.${m.name}`);
    }

    run(): H.Program {
        for (const p of this.packages) {
            this.pkg = p;
            for (const f of p.files) {
                this.file = f.path;
                for (const item of f.ast.items) this.item(item);
            }
        }
        return this.out;
    }

    // ---- helpers ------------------------------------------------------------------------------

    ty(node: object): Ty {
        return T.ground(this.types.get(node) ?? T.UNKNOWN);
    }

    symTy(s: Sym): Ty {
        return T.ground(this.symTypes.get(s) ?? T.UNKNOWN);
    }

    sp(n: { span: A.Span }): H.Span {
        return { start: n.span.start, end: n.span.end };
    }

    local(s: Sym, mutable = s.mutable, shared = false): H.Local {
        let l = this.locals.get(s);
        if (!l) {
            l = { sym: s, name: s.name, ty: this.symTy(s), mutable, shared };
            if (this.isUniqueTy(l.ty)) l.unique = true;
            this.locals.set(s, l);
        }
        return l;
    }

    /** A type declared `Unique` (§9.2); a struct with a Unique field is Unique too. */
    isUniqueTy(t: Ty, seen = new Set<Sym>()): boolean {
        const p = T.prune(t);
        if (p.k !== "named" || seen.has(p.sym)) return false;
        seen.add(p.sym);
        const d = this.typeDecls.get(p.sym);
        if (!d || d.kind === "InterDecl") return false;
        if (d.impls.some((i) => i.kind === "TName" && this.refs.get(i)?.pkg === "prelude" && this.refs.get(i)?.name === "Unique")) return true;
        if (d.kind === "TypeDecl") {
            for (const m of d.members ?? []) if (m.kind === "Field" && m.type.kind === "TName" && this.refs.get(m.type) && this.isUniqueTy({ k: "named", sym: this.refs.get(m.type)!, args: [] }, seen)) return true;
        }
        return false;
    }

    /** A compiler temporary. */
    temp(ty: Ty, hint = "t"): H.Local {
        const id = nextTemp++;
        const sym: Sym = {
            id: -id, name: `$${hint}${id}`, kind: "local", mutable: false, decl: null, file: this.file, start: 0, pkg: this.pkg.name,
            pub: false, used: true, home: null,
        };
        const l: H.Local = { sym, name: sym.name, ty, mutable: false, shared: false };
        this.locals.set(sym, l);
        return l;
    }

    readLocal(l: H.Local, at: H.Span): H.Expr {
        return { k: "read", ty: l.ty, span: at, place: { root: { k: "local", local: l.sym, name: l.name }, segs: [] } };
    }

    unit(at: H.Span): H.Expr {
        return { k: "lit", ty: T.VOID, span: at, value: null };
    }

    isPrelude(t: Ty, name: string): boolean {
        const p = T.prune(t);
        return p.k === "named" && p.sym.pkg === "prelude" && p.sym.name === name;
    }

    typeName(t: Ty): string {
        const p = T.prune(t);
        if (p.k === "named") return this.typeNames.get(p.sym) ?? p.sym.name;
        return T.show(p);
    }

    // ---- items --------------------------------------------------------------------------------

    item(item: A.Item): void {
        switch (item.kind) {
            case "Fn":
                return this.fn(item, null, []);
            case "TypeDecl": case "UnionDecl": case "InterDecl": {
                const sym = this.decls.get(item);
                const self: Ty = sym ? { k: "named", sym, args: [] } : T.UNKNOWN;
                const outer = item.generics.map((g) => this.decls.get(g)).filter((s): s is Sym => !!s);
                this.typeDef(item, sym);
                const members = item.kind === "InterDecl" ? item.methods ?? [] : item.members ?? [];
                for (const m of members) if (m.kind === "Fn") this.fn(m, self, outer);
                return;
            }
            case "ImplDecl": {
                const outer = item.generics.map((g) => this.decls.get(g)).filter((s): s is Sym => !!s);
                for (const m of item.methods) this.fn(m, T.UNKNOWN, outer);
                return;
            }
            case "LetDecl": case "VarDecl": {
                const sym = this.decls.get(item);
                if (!sym) return;
                this.locals = new Map();
                this.out.globals.push({
                    name: this.globalNames.get(sym) ?? item.name, sym, ty: this.symTy(sym), value: this.expr(item.value), mutable: item.kind === "VarDecl",
                });
                return;
            }
            case "ExternDecl":
                for (const f of item.fns) this.fn(f, null, [], item.abi);
                return;
        }
    }

    typeDef(item: A.TypeDecl | A.UnionDecl | A.InterDecl, sym: Sym | undefined): void {
        const name = sym ? this.typeNames.get(sym) ?? item.name : item.name;
        const marks = (impls: A.Type[], n: string) => impls.some((i) => i.kind === "TName" && this.refs.get(i)?.pkg === "prelude" && this.refs.get(i)?.name === n);
        if (item.kind === "TypeDecl") {
            if (item.alias) return;
            const fields = (item.members ?? []).filter((m): m is A.Field => m.kind === "Field").map((f) => ({ name: f.name, mode: f.mode, ty: this.fieldTy(f) }));
            this.out.types.push({ kind: "struct", name, sym: sym ?? null, fields, identity: marks(item.impls, "Identity"), unique: marks(item.impls, "Unique") });
        } else if (item.kind === "UnionDecl") {
            const variants = item.members.filter((m): m is A.Variant => m.kind === "Variant").map((v) => ({
                name: v.name, fields: v.fields ? v.fields.map((f) => f.name) : (v.tuple ?? []).map((_, i) => String(i)), positional: !v.fields,
                tys: v.fields ? v.fields.map((f) => this.fieldTy(f)) : (v.tuple ?? []).map((t) => this.declTy(t)),
            }));
            this.out.types.push({ kind: "union", name, variants });
        } else {
            this.out.types.push({ kind: "inter", name, methods: (item.methods ?? []).map((m) => m.name) });
        }
    }

    /** A field's declared type, from its default's or a constructor's recorded type, else by name. */
    declTy(t: A.Type): Ty {
        return this.declTypes.has(t) ? T.ground(this.declTypes.get(t)!) : T.UNKNOWN;
    }

    fieldTy(f: A.Field): Ty {
        const known = this.declTy(f.type);
        if (known !== T.UNKNOWN) return known;
        if (f.type.kind === "TName" && f.type.args.length === 0) {
            const s = this.refs.get(f.type);
            if (s && (s.kind === "type" || s.kind === "union")) return { k: "named", sym: s, args: [] };
        }
        if (f.type.kind === "TName") {
            const s = this.refs.get(f.type);
            if (s && (s.kind === "type" || s.kind === "union")) return { k: "named", sym: s, args: f.type.args.map(() => T.UNKNOWN) };
        }
        return T.UNKNOWN;
    }

    fn(fn: A.FnDecl, _self: Ty | null, outer: Sym[], abi: string | null = null): void {
        this.locals = new Map();
        this.selfLocal = null;
        const params = fn.params.map((p) => {
            const sym = this.decls.get(p);
            return sym ? this.local(sym, p.star) : this.temp(T.UNKNOWN, p.name);
        });
        const thisSym = this.thisOf.get(fn);
        if (fn.receiver && thisSym) this.selfLocal = this.local(thisSym, fn.receiver === "*this");
        const own = fn.generics.map((g) => this.decls.get(g)).filter((s): s is Sym => !!s);
        const builtin = fn.body !== null && isBuiltinBody(fn.body);
        const f: H.Fun = {
            name: this.fnNames.get(fn) ?? fn.name,
            params,
            modes: fn.params.map((p) => (p.star ? "write" : "read")),
            self: this.selfLocal,
            selfMode: fn.receiver === null ? null : fn.receiver === "*this" ? "write" : "read",
            ret: T.ground(this.rets.get(fn) ?? T.UNKNOWN),
            retMode: fn.retStar ? "write" : "read",
            effectsAttr: effectsAttr(fn),
            async: fn.isAsync,
            body: fn.body && !builtin ? this.body(fn.body) : null,
            builtin,
            extern: abi,
            generics: [...outer, ...own],
            witnesses: { js: [], native: [] },
            file: this.file,
            span: this.sp(fn),
        };
        this.out.funs.push(f);
    }

    // ---- blocks and statements ----------------------------------------------------------------

    body(b: A.Block): H.Block {
        return this.stmts(b.stmts);
    }

    stmts(list: A.Stmt[]): H.Block {
        const out: H.Stmt[] = [];
        let value: H.Expr | null = null;
        list.forEach((s, i) => {
            const last = i === list.length - 1;
            if (s.kind === "ExprStmt" && last && !s.semi) {
                value = this.expr(s.expr);
                return;
            }
            out.push(this.stmt(s));
        });
        return { stmts: out, value };
    }

    stmt(s: A.Stmt): H.Stmt {
        switch (s.kind) {
            case "LetStmt": {
                const value = this.expr(s.value);
                return { k: "let", pattern: this.pattern(s.pattern, value.ty), value, else: s.else ? this.body(s.else) : null };
            }
            case "VarStmt": {
                const sym = this.decls.get(s);
                const value = this.expr(s.value);
                const local = sym ? this.local(sym, true, s.shared) : this.temp(value.ty);
                return { k: "let", pattern: { k: "bind", local }, value, else: null };
            }
            case "ShortDecl": {
                const sym = this.decls.get(s);
                const value = this.expr(s.value);
                const local = sym ? this.local(sym, s.mutable) : this.temp(value.ty);
                return { k: "let", pattern: { k: "bind", local }, value, else: null };
            }
            case "ExprStmt":
                return { k: "expr", expr: this.expr(s.expr) };
        }
    }

    // ---- places -------------------------------------------------------------------------------

    /** The place an expression denotes, when it is one: a local / global and a path into it. */
    place(e: A.Expr): H.Place | null {
        switch (e.kind) {
            case "Paren":
                return this.place(e.expr);
            case "This":
                return this.selfLocal ? { root: { k: "local", local: this.selfLocal.sym, name: "this" }, segs: [] } : null;
            case "Ident": {
                const s = this.refs.get(e);
                if (!s) return null;
                if (s.kind === "local" || s.kind === "param" || s.kind === "closure-param" || s.kind === "implicit" || s.kind === "this") {
                    const l = this.local(s);
                    return { root: { k: "local", local: s, name: l.name }, segs: [] };
                }
                if (s.kind === "global") return { root: { k: "global", name: this.globalNames.get(s) ?? s.name, sym: s }, segs: [] };
                return null;
            }
            case "Member": {
                const m = this.members.get(e);
                if (e.optional) return null;
                if (m && m.kind !== "field" && m.kind !== "tuple") return null;
                if (!m && this.isPackageMember(e)) return null;
                const base = this.placeOrValue(e.target);
                if (m?.kind === "tuple") return { root: base.root, segs: [...base.segs, { k: "tuple", index: m.index }] };
                return { root: base.root, segs: [...base.segs, { k: "field", name: e.name, mode: this.fieldMode(e.target, e.name) }] };
            }
            case "Index": {
                if (this.ops.has(e)) return null;
                const base = this.placeOrValue(e.target);
                const key = e.index.kind === "Int" ? String(e.index.value) : e.index.kind === "Str" ? JSON.stringify(e.index.value) : null;
                const map = this.isPrelude(this.ty(e.target), "Map") || this.isPrelude(this.ty(e.target), "PMap");
                return { root: base.root, segs: [...base.segs, { k: "elem", index: this.expr(e.index), key, map }] };
            }
            default:
                return null;
        }
    }

    placeOrValue(e: A.Expr): H.Place {
        return this.place(e) ?? { root: { k: "value", expr: this.expr(e) }, segs: [] };
    }

    fieldMode(target: A.Expr, name: string): "shared" | "once" | null {
        const t = T.prune(this.ty(target));
        if (t.k !== "named") return null;
        const d = this.typeDecls.get(t.sym);
        if (!d || d.kind !== "TypeDecl") return null;
        const f = (d.members ?? []).find((m): m is A.Field => m.kind === "Field" && m.name === name);
        return f?.mode ?? null;
    }

    isPackageMember(e: A.Member): boolean {
        return T.prune(this.types.get(e.target) ?? T.UNKNOWN).k === "package";
    }

    /** A dotted path for a member of a package that isn't loaded: `json.parse`. */
    externPath(e: A.Expr): string {
        if (e.kind === "Ident") return e.name;
        if (e.kind === "Member") return `${this.externPath(e.target)}.${e.name}`;
        if (e.kind === "GenericApply") return this.externPath(e.target);
        return "?";
    }

    // ---- expressions --------------------------------------------------------------------------

    expr(e: A.Expr): H.Expr {
        const ty = this.ty(e);
        const span = this.sp(e);
        switch (e.kind) {
            case "Ident":
                return this.ident(e, ty, span);
            case "This":
                return this.selfLocal ? this.readLocal(this.selfLocal, span) : { k: "unsupported", ty, span, what: "this" };
            case "SelfExpr":
                return { k: "unsupported", ty, span, what: "Self as a value" };
            case "Int":
                return { k: "lit", ty, span, value: T.isFloat(ty) ? Number(e.value) : e.value };
            case "Float":
                return { k: "lit", ty, span, value: e.value };
            case "Str":
                return { k: "lit", ty, span, value: e.value };
            case "Char":
                return { k: "char", ty, span, value: e.value };
            case "Byte":
                return { k: "lit", ty, span, value: e.value };
            case "Bool":
                return { k: "lit", ty, span, value: e.value };
            case "Nil":
                return { k: "variant", ty, span, union: "prelude.Option", variant: "None", fields: [] };
            case "Template": {
                const parts: H.Expr[] = [];
                e.parts.forEach((p, i) => {
                    if (p !== "") parts.push({ k: "lit", ty: T.STR, span, value: p });
                    const x = e.exprs[i];
                    if (x) {
                        const v = this.expr(x);
                        parts.push(T.prune(v.ty).k === "prim" && (T.prune(v.ty) as { name: string }).name === "str" ? v : { k: "tostr", ty: T.STR, span: v.span, expr: v });
                    }
                });
                return { k: "concat", ty: T.STR, span, parts };
            }
            case "Vec": case "Array": case "Set": {
                const elems = e.elems.map((el): H.Expr | H.Spread => (el.spread ? { k: "spread", expr: this.expr(el.value) } : this.expr(el.value)));
                return { k: e.kind === "Vec" ? "vec" : e.kind === "Array" ? "array" : "set", ty, span, elems };
            }
            case "Tuple":
                return e.elems.length === 0 ? this.unit(span) : { k: "tuple", ty, span, elems: e.elems.map((el) => this.expr(el.value)) };
            case "Map":
                return {
                    k: "map", ty, span,
                    entries: e.entries.map((en) => (en.kind === "Spread" ? { k: "spread" as const, expr: this.expr(en.value) } : { key: this.expr(en.key), value: this.expr(en.value) })),
                };
            case "Record":
                return this.record(e.items, ty, span);
            case "Inferred": {
                const t = T.prune(ty);
                if (t.k === "named") return this.structLit(t, e.items, span, ty);
                return this.record(e.items, ty, span);
            }
            case "Struct":
                return this.structExpr(e, ty, span);
            case "Closure":
                return this.closure(e, ty, span);
            case "Paren":
                return this.expr(e.expr);
            case "Unary":
                return this.unary(e, ty, span);
            case "Await":
                return { k: "await", ty, span, expr: this.expr(e.operand) };
            case "Binary":
                return this.binary(e, ty, span);
            case "Assign":
                return this.assign(e, span);
            case "Range":
                return { k: "range", ty, span, start: e.start ? this.expr(e.start) : null, end: e.end ? this.expr(e.end) : null, inclusive: e.inclusive };
            case "As": {
                const inner = this.expr(e.expr);
                const from = T.prune(inner.ty);
                const to = T.prune(ty);
                const numeric = (t: Ty) => T.isNumeric(t) || (t.k === "prim" && (t.name === "char" || t.name === "bool"));
                if (numeric(from) && numeric(to) && T.show(from) !== T.show(to)) return { k: "cast", ty, span, expr: inner, to: ty };
                return { ...inner, ty: T.isOpen(inner.ty) ? ty : inner.ty };
            }
            case "Or":
                return this.orExpr(e, ty, span);
            case "Call":
                return this.call(e, ty, span);
            case "Index": {
                const op = this.ops.get(e);
                if (op) return this.methodCall(op, "index", this.argOf(e.target, false), [{ mode: "read", expr: this.expr(e.index) }], ty, span);
                return this.read(e, ty, span);
            }
            case "Member":
                return this.member(e, ty, span);
            case "GenericApply":
                return this.expr(e.target);
            case "Try":
                return this.tryExpr(e, ty, span);
            case "If":
                return this.ifExpr(e, ty, span);
            case "Match":
                return this.match(e, ty, span);
            case "Select":
                return {
                    k: "select", ty, span,
                    arms: e.arms.map((a) => {
                        const wait = this.expr(a.expr);
                        const inner = this.isPrelude(wait.ty, "Promise") ? (T.prune(wait.ty) as { args: Ty[] }).args[0]! : T.UNKNOWN;
                        return { wait, pattern: a.pattern ? this.pattern(a.pattern, inner) : { k: "wild" as const }, body: this.expr(a.body) };
                    }),
                    else: e.else ? this.expr(e.else) : null,
                };
            case "Lock":
                return { k: "lock", ty, span, places: e.places.map((p) => this.placeOrValue(p)), body: this.body(e.body) };
            case "For":
                return this.forExpr(e, ty, span);
            case "Block":
                return { k: "block", ty, span, block: this.body(e) };
            case "Unsafe":
                return { k: "block", ty, span, block: this.body(e.body) };
            case "Recover":
                return { k: "recover", ty, span, body: this.body(e.body) };
            case "Return":
                return { k: "return", ty: T.NEVER, span, value: e.value ? this.expr(e.value) : null };
            case "Break":
                return { k: "break", ty: T.NEVER, span, label: e.label, value: e.value ? this.expr(e.value) : null };
            case "Continue":
                return { k: "continue", ty: T.NEVER, span, label: e.label };
            case "Error":
                return { k: "unsupported", ty, span, what: "a syntax error" };
        }
    }

    read(e: A.Expr, ty: Ty, span: H.Span): H.Expr {
        const p = this.place(e);
        if (p) return { k: "read", ty, span, place: p };
        return this.expr(e);
    }

    ident(e: A.Ident, ty: Ty, span: H.Span): H.Expr {
        const ref = this.variants.get(e);
        const s = this.refs.get(e);
        if (ref && (!s || s.kind === "variant" || T.prune(ty).k === "named" || T.prune(ty).k === "fn")) return this.variantValue(ref, ty, span);
        if (!s) return { k: "extern", ty, span, path: e.name, args: null };
        switch (s.kind) {
            case "local": case "param": case "closure-param": case "implicit": case "this": case "global":
                return this.read(e, ty, span);
            case "fn": case "extern-fn":
                return { k: "fnref", ty, span, name: s.decl ? this.fnNames.get(s.decl as A.FnDecl) ?? s.name : s.name };
            case "variant":
                return this.variantValue({ union: s.owner!, variant: s.name }, ty, span);
            default:
                return { k: "extern", ty, span, path: e.name, args: null };
        }
    }

    /** A variant used as a value: the value itself, or its constructor (a function). */
    variantValue(ref: { union: Sym; variant: string }, ty: Ty, span: H.Span): H.Expr {
        const union = this.typeNames.get(ref.union) ?? ref.union.name;
        if (T.prune(ty).k === "fn") return { k: "fnref", ty, span, name: `${union}.${ref.variant}` };
        return { k: "variant", ty, span, union, variant: ref.variant, fields: [] };
    }

    member(e: A.Member, ty: Ty, span: H.Span): H.Expr {
        const m = this.members.get(e);
        if (e.optional) return this.optionalMember(e, ty, span);
        switch (m?.kind) {
            case "field": case "tuple":
                return this.read(e, ty, span);
            case "static":
                return { k: "fnref", ty, span, name: this.fnNames.get(m.decl) ?? e.name };
            case "variant":
                return this.variantValue(m.ref, ty, span);
            case "item": {
                const s = m.sym;
                if (s.kind === "fn" || s.kind === "extern-fn") return { k: "fnref", ty, span, name: this.fnNames.get(s.decl as A.FnDecl) ?? s.name };
                if (s.kind === "global") return { k: "read", ty, span, place: { root: { k: "global", name: this.globalNames.get(s) ?? s.name, sym: s }, segs: [] } };
                if (s.kind === "variant") return this.variantValue({ union: s.owner!, variant: s.name }, ty, span);
                return { k: "unsupported", ty, span, what: `the ${s.kind} ${s.name} as a value` };
            }
            case "method":
                return this.methodValue(e, ty, span);
        }
        const v = this.variants.get(e);
        if (v) return this.variantValue(v, ty, span);
        if (this.isPackageMember(e)) return { k: "extern", ty, span, path: this.externPath(e), args: null };
        // an unknown receiver: a dynamic field read
        return this.read(e, ty, span);
    }

    /** `x.f` used as a value (not called): a closure that calls it. */
    methodValue(e: A.Member, ty: Ty, span: H.Span): H.Expr {
        const fnTy = T.prune(ty);
        const params = fnTy.k === "fn" ? fnTy.params.map((p, i) => this.temp(p.ty, `a${i}`)) : [];
        const recv = this.temp(this.ty(e.target), "recv");
        const call: H.Expr = {
            k: "call", ty: fnTy.k === "fn" ? fnTy.ret : T.UNKNOWN, span, callee: { k: "dyn", method: e.name },
            recv: { mode: "read", expr: this.readLocal(recv, span) }, args: params.map((p) => ({ mode: "read" as const, expr: this.readLocal(p, span) })),
            witnessArgs: [], async: fnTy.k === "fn" && fnTy.async,
        };
        return {
            k: "block", ty, span,
            block: {
                stmts: [{ k: "let", pattern: { k: "bind", local: recv }, value: this.expr(e.target), else: null }],
                value: { k: "closure", ty, span, params, modes: params.map(() => "read"), captures: [{ sym: recv.sym, name: recv.name, mode: "read" }], body: { stmts: [], value: call } },
            },
        };
    }

    /** `a?.b`: `match a { ok(v) => Some(v.b), fail => None }` (no double Option). */
    optionalMember(e: A.Member, ty: Ty, span: H.Span): H.Expr {
        const target = this.expr(e.target);
        const inner = this.isPrelude(target.ty, "Option") ? (T.prune(target.ty) as { args: Ty[] }).args[0]! : T.UNKNOWN;
        const v = this.temp(inner, "v");
        const fieldTy = this.isPrelude(ty, "Option") ? (T.prune(ty) as { args: Ty[] }).args[0]! : ty;
        const m = this.members.get(e);
        const place: H.Place = { root: { k: "local", local: v.sym, name: v.name }, segs: m?.kind === "tuple" ? [{ k: "tuple", index: m.index }] : [{ k: "field", name: e.name, mode: null }] };
        const read: H.Expr = { k: "read", ty: fieldTy, span, place };
        const wrapped: H.Expr = this.isPrelude(fieldTy, "Option") ? read : { k: "variant", ty, span, union: "prelude.Option", variant: "Some", fields: [read] };
        return {
            k: "match", ty, span, subject: target,
            arms: [
                { pattern: { k: "ok", value: { k: "bind", local: v } }, guard: null, body: wrapped },
                { pattern: { k: "fail", payload: { k: "wild" } }, guard: null, body: { k: "variant", ty, span, union: "prelude.Option", variant: "None", fields: [] } },
            ],
        };
    }

    record(items: A.RecItem[], ty: Ty, span: H.Span): H.Expr {
        const fields: { name: string; value: H.Expr }[] = [];
        for (const it of items) {
            if (it.kind === "Spread") {
                const base = this.expr(it.value);
                const bt = T.prune(base.ty);
                const names = bt.k === "record" ? bt.fields.map((f) => f.name) : bt.k === "named" ? this.structFields(bt.sym).map((f) => f.name) : [];
                const tmp = this.temp(base.ty, "base");
                const read = (n: string): H.Expr => ({ k: "read", ty: T.UNKNOWN, span, place: { root: { k: "local", local: tmp.sym, name: tmp.name }, segs: [{ k: "field", name: n, mode: null }] } });
                for (const n of names) if (!fields.some((f) => f.name === n)) fields.push({ name: n, value: { k: "block", ty: T.UNKNOWN, span, block: { stmts: [{ k: "let", pattern: { k: "bind", local: tmp }, value: base, else: null }], value: read(n) } } });
                continue;
            }
            const value = this.recValue(it);
            const i = fields.findIndex((f) => f.name === it.name);
            if (i >= 0) fields.splice(i, 1);
            fields.push({ name: it.name, value });
        }
        fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return { k: "record", ty, span, fields };
    }

    recValue(it: A.RecItem & { kind: "Field" }): H.Expr {
        if (it.value) return this.expr(it.value);
        const s = this.refs.get(it);
        const ident: A.Ident = { kind: "Ident", span: it.span, name: it.name };
        if (s) this.refs.set(ident, s);
        return this.read(ident, s ? this.symTy(s) : T.UNKNOWN, this.sp(it));
    }

    structFields(sym: Sym): A.Field[] {
        const d = this.typeDecls.get(sym);
        return d?.kind === "TypeDecl" ? (d.members ?? []).filter((m): m is A.Field => m.kind === "Field") : [];
    }

    structExpr(e: A.StructLit, ty: Ty, span: H.Span): H.Expr {
        const ref = this.variants.get(e);
        if (ref) {
            const d = this.typeDecls.get(ref.union);
            const variant = d?.kind === "UnionDecl" ? d.members.find((m): m is A.Variant => m.kind === "Variant" && m.name === ref.variant) : undefined;
            const fields = this.fieldValues(variant?.fields ?? [], e.items, span);
            return { k: "variant", ty, span, union: this.typeNames.get(ref.union) ?? ref.union.name, variant: ref.variant, fields: fields.map((f) => f.value) };
        }
        const t = T.prune(ty);
        if (t.k === "named") return this.structLit(t, e.items, span, ty);
        return this.record(e.items, ty, span);
    }

    structLit(t: Ty & { k: "named" }, items: A.RecItem[], span: H.Span, ty: Ty): H.Expr {
        return { k: "struct", ty, span, type: this.typeNames.get(t.sym) ?? t.sym.name, fields: this.fieldValues(this.structFields(t.sym), items, span) };
    }

    /** Every declared field, in order: given, from a spread, its default, or `None`. */
    fieldValues(decl: A.Field[], items: A.RecItem[], span: H.Span): { name: string; value: H.Expr }[] {
        const given = new Map<string, H.Expr>();
        let spread: H.Local | null = null;
        const pre: H.Stmt[] = [];
        for (const it of items) {
            if (it.kind === "Spread") {
                const base = this.expr(it.value);
                spread = this.temp(base.ty, "base");
                pre.push({ k: "let", pattern: { k: "bind", local: spread }, value: base, else: null });
            } else {
                given.set(it.name, this.recValue(it));
            }
        }
        const out = decl.map((f) => {
            const g = given.get(f.name);
            if (g) return { name: f.name, value: g };
            if (spread) return { name: f.name, value: { k: "read", ty: T.UNKNOWN, span, place: { root: { k: "local", local: spread.sym, name: spread.name }, segs: [{ k: "field", name: f.name, mode: f.mode }] } } as H.Expr };
            if (f.default) return { name: f.name, value: this.expr(f.default) };
            return { name: f.name, value: { k: "variant", ty: T.UNKNOWN, span, union: "prelude.Option", variant: "None", fields: [] } as H.Expr };
        });
        if (pre.length > 0 && out[0]) out[0] = { name: out[0].name, value: { k: "block", ty: out[0].value.ty, span, block: { stmts: pre, value: out[0].value } } };
        return out;
    }

    closure(c: A.Closure, ty: Ty, span: H.Span): H.Expr {
        const fnTy = T.prune(ty);
        const n = fnTy.k === "fn" ? fnTy.params.length : 0;
        const params: H.Local[] = [];
        if (c.params) {
            for (const p of c.params) {
                const s = this.decls.get(p);
                params.push(s ? this.local(s, p.isVar) : this.temp(T.UNKNOWN, "p"));
            }
        } else {
            const implicit = this.implicit.get(c) ?? new Map<string, Sym>();
            for (let i = 0; i < n; i++) {
                const s = implicit.get(i === 0 ? "it" : `it${i + 1}`);
                params.push(s ? this.local(s) : this.temp(fnTy.k === "fn" ? fnTy.params[i]!.ty : T.UNKNOWN, "p"));
            }
        }
        while (params.length < n) params.push(this.temp(fnTy.k === "fn" ? fnTy.params[params.length]!.ty : T.UNKNOWN, "p"));
        const modes = params.map((_, i): "read" | "write" => (fnTy.k === "fn" && fnTy.params[i]?.star ? "write" : "read"));
        const body = this.stmts(c.body);
        const captured = this.captures.get(c) ?? [];
        const written = new Set<Sym>();
        walkBlock(body, (x) => {
            if (x.k === "assign" && x.place.root.k === "local") written.add(x.place.root.local);
            if (x.k === "call" || x.k === "callvalue") {
                for (const a of [...(x.k === "call" && x.recv ? [x.recv] : []), ...x.args]) if (a.mode === "write" && a.place.root.k === "local") written.add(a.place.root.local);
            }
        });
        const captures = captured.map((s) => ({ sym: s, name: s.name, mode: written.has(s) ? ("write" as const) : ("read" as const) }));
        return { k: "closure", ty, span, params, modes, captures, body };
    }

    unary(e: A.Unary, ty: Ty, span: H.Span): H.Expr {
        if (e.op === "-") {
            if (e.operand.kind === "Int") return { k: "lit", ty, span, value: T.isFloat(ty) ? -Number(e.operand.value) : -e.operand.value };
            const op = this.ops.get(e);
            if (op) return this.methodCall(op, "negate", this.argOf(e.operand, false), [], ty, span);
            return { k: "unary", ty, span, op: "neg", expr: this.expr(e.operand) };
        }
        const inner = this.expr(e.operand);
        if (T.isInt(inner.ty)) return { k: "unary", ty, span, op: "bitnot", expr: inner };
        return { k: "unary", ty: T.BOOL, span, op: "not", expr: this.truthy(inner) };
    }

    /** A condition: Option / Result become an explicit test (§4.7). */
    truthy(x: H.Expr): H.Expr {
        if (this.isPrelude(x.ty, "Option")) return { k: "truthy", ty: T.BOOL, span: x.span, expr: x, of: "option" };
        if (this.isPrelude(x.ty, "Result")) return { k: "truthy", ty: T.BOOL, span: x.span, expr: x, of: "result" };
        return x;
    }

    binary(e: A.Binary, ty: Ty, span: H.Span): H.Expr {
        if (e.op === "&&" || e.op === "||") {
            return { k: e.op === "&&" ? "and" : "or", ty: T.BOOL, span, left: this.truthy(this.expr(e.left)), right: this.truthy(this.expr(e.right)) };
        }
        if (e.op === "??") return this.nullish(e, ty, span);
        const op = this.ops.get(e);
        if (op) {
            const method = { "+": "plus", "-": "minus", "*": "times", "/": "divide", "%": "remainder" }[e.op] ?? e.op;
            return this.methodCall(op, method, this.argOf(e.left, false), [{ mode: "read", expr: this.expr(e.right) }], ty, span);
        }
        return { k: "binary", ty, span, op: e.op, left: this.expr(e.left), right: this.expr(e.right) };
    }

    /** `a ?? b`: `match a { ok(v) => v, fail => b }`. */
    nullish(e: A.Binary, ty: Ty, span: H.Span): H.Expr {
        const subject = this.expr(e.left);
        const v = this.temp(ty, "v");
        return {
            k: "match", ty, span, subject,
            arms: [
                { pattern: { k: "ok", value: { k: "bind", local: v } }, guard: null, body: this.readLocal(v, span) },
                { pattern: { k: "fail", payload: { k: "wild" } }, guard: null, body: this.expr(e.right) },
            ],
        };
    }

    assign(e: A.Assign, span: H.Span): H.Expr {
        const place = this.place(e.target) ?? { root: { k: "value", expr: this.expr(e.target) }, segs: [] };
        const op = this.ops.get(e);
        if (op && e.op !== "=" && e.op !== "??=") {
            const method = { "+=": "plus", "-=": "minus", "*=": "times", "/=": "divide", "%=": "remainder" }[e.op] ?? e.op;
            const targetTy = this.ty(e.target);
            const value = this.methodCall(op, method, { mode: "read", expr: { k: "read", ty: targetTy, span, place } }, [{ mode: "read", expr: this.expr(e.value) }], targetTy, span);
            return { k: "assign", ty: T.VOID, span, place, op: "=", value };
        }
        return { k: "assign", ty: T.VOID, span, place, op: e.op, value: this.expr(e.value) };
    }

    /** `x or rhs`: `match x { ok(v) => v, fail(p) => return rhs }` (§4.6). */
    orExpr(e: A.Or, ty: Ty, span: H.Span): H.Expr {
        const subject = this.expr(e.expr);
        const v = this.temp(ty, "v");
        let payload: H.Pattern = { k: "wild" };
        const named = e.name !== null ? this.decls.get(e) : this.implicit.get(e)?.get("it");
        if (named) payload = { k: "bind", local: this.local(named) };
        const rhs = this.expr(e.rhs);
        const body: H.Expr = T.prune(rhs.ty).k === "never" ? rhs : { k: "return", ty: T.NEVER, span: rhs.span, value: rhs };
        return {
            k: "match", ty, span, subject,
            arms: [
                { pattern: { k: "ok", value: { k: "bind", local: v } }, guard: null, body: this.readLocal(v, span) },
                { pattern: { k: "fail", payload }, guard: null, body },
            ],
        };
    }

    /** `x?`: `match x { ok(v) => v, fail(e) => return Err(e) / None }`. */
    tryExpr(e: A.Try, ty: Ty, span: H.Span): H.Expr {
        const subject = this.expr(e.expr);
        const v = this.temp(ty, "v");
        const isResult = this.isPrelude(subject.ty, "Result");
        const err = this.temp(isResult ? (T.prune(subject.ty) as { args: Ty[] }).args[1]! : T.UNKNOWN, "err");
        const ret: H.Expr = isResult
            ? { k: "variant", ty: T.UNKNOWN, span, union: "prelude.Result", variant: "Err", fields: [this.readLocal(err, span)] }
            : { k: "variant", ty: T.UNKNOWN, span, union: "prelude.Option", variant: "None", fields: [] };
        return {
            k: "match", ty, span, subject,
            arms: [
                { pattern: { k: "ok", value: { k: "bind", local: v } }, guard: null, body: this.readLocal(v, span) },
                { pattern: { k: "fail", payload: isResult ? { k: "bind", local: err } : { k: "wild" } }, guard: null, body: { k: "return", ty: T.NEVER, span, value: ret } },
            ],
        };
    }

    ifExpr(e: A.If, ty: Ty, span: H.Span): H.Expr {
        const els = e.else ? (e.else.kind === "If" ? { stmts: [], value: this.ifExpr(e.else, ty, this.sp(e.else)) } : this.body(e.else)) : null;
        if (e.pattern) {
            const subject = this.expr(e.cond);
            const pattern = this.pattern(e.pattern, subject.ty);
            const then = this.body(e.then);
            return {
                k: "match", ty, span, subject,
                arms: [
                    { pattern, guard: null, body: { k: "block", ty, span, block: then } },
                    { pattern: { k: "wild" }, guard: null, body: els ? { k: "block", ty, span, block: els } : this.unit(span) },
                ],
            };
        }
        return { k: "if", ty, span, cond: this.truthy(this.expr(e.cond)), then: this.body(e.then), else: els };
    }

    match(e: A.Match, ty: Ty, span: H.Span): H.Expr {
        if (!e.subject) {
            // a subject-less match is an `if` chain
            let result: H.Expr = { k: "unsupported", ty, span, what: "no arm matched" };
            for (const arm of [...e.arms].reverse()) {
                const body = this.expr(arm.body);
                if (arm.pattern) {
                    result = body;
                    continue;
                }
                result = { k: "if", ty, span, cond: this.truthy(this.expr(arm.cond!)), then: { stmts: [], value: body }, else: { stmts: [], value: result } };
            }
            return result;
        }
        const subject = this.expr(e.subject);
        return {
            k: "match", ty, span, subject,
            arms: e.arms.map((a) => ({
                pattern: a.pattern ? this.pattern(a.pattern, subject.ty) : { k: "wild" as const },
                guard: a.guard ? this.truthy(this.expr(a.guard)) : null,
                body: this.expr(a.body),
            })),
        };
    }

    forExpr(e: A.For, ty: Ty, span: H.Span): H.Expr {
        const label = e.label;
        switch (e.form) {
            case "infinite":
                return { k: "loop", ty, span, label, body: this.body(e.body) };
            case "cond": {
                const cond = this.truthy(this.expr(e.expr!));
                const exit: H.Expr = {
                    k: "if", ty: T.VOID, span, cond: { k: "unary", ty: T.BOOL, span, op: "not", expr: cond },
                    then: { stmts: [{ k: "expr", expr: { k: "break", ty: T.NEVER, span, label, value: null } }], value: null }, else: null,
                };
                const body = this.body(e.body);
                return { k: "loop", ty, span, label, body: { stmts: [{ k: "expr", expr: exit }, ...body.stmts, ...(body.value ? [{ k: "expr" as const, expr: body.value }] : [])], value: null } };
            }
            case "let": {
                const subject = this.expr(e.expr!);
                const pattern = this.pattern(e.pattern!, subject.ty);
                const m: H.Expr = {
                    k: "match", ty: T.VOID, span, subject,
                    arms: [
                        { pattern, guard: null, body: { k: "block", ty: T.VOID, span, block: this.body(e.body) } },
                        { pattern: { k: "wild" }, guard: null, body: { k: "break", ty: T.NEVER, span, label, value: null } },
                    ],
                };
                return { k: "loop", ty, span, label, body: { stmts: [{ k: "expr", expr: m }], value: null } };
            }
            case "in": {
                const iterable = this.expr(e.expr!);
                const it = T.prune(iterable.ty);
                const isNamed = (n: string) => this.isPrelude(it, n);
                const of: "vec" | "map" | "range" | "iter" | "async" = e.isAwait
                    ? "async"
                    : ["Vec", "Array", "Slice", "Set", "PVec"].some(isNamed) ? "vec" : isNamed("Map") || isNamed("PMap") ? "map" : isNamed("Range") ? "range" : "iter";
                const itemTy = of === "map" ? (it as { args: Ty[] }).args[0]! : it.k === "named" ? it.args[0] ?? T.UNKNOWN : T.UNKNOWN;
                const secondTy = of === "map" ? (it as { args: Ty[] }).args[1]! : T.INT;
                const item = this.pattern(e.pattern!, this.patternTy(e.pattern!) ?? itemTy);
                const second = e.pattern2 ? this.pattern(e.pattern2, this.patternTy(e.pattern2) ?? secondTy) : null;
                return { k: "foreach", ty, span, label, item, second, iterable, of, body: this.body(e.body) };
            }
        }
    }

    patternTy(p: A.Pattern): Ty | undefined {
        if (p.kind === "PBind") {
            const s = this.decls.get(p);
            return s ? this.symTy(s) : undefined;
        }
        return undefined;
    }

    // ---- calls --------------------------------------------------------------------------------

    /** An argument: a place when the parameter (or receiver) is written (`*T`, `*this`). */
    argOf(e: A.Expr, write: boolean): H.Arg {
        if (write) {
            const p = this.place(e);
            if (p) return { mode: "write", place: p, ty: this.ty(e) };
        }
        return { mode: "read", expr: this.expr(e) };
    }

    methodCall(target: CallTarget, method: string, recv: H.Arg, args: H.Arg[], ty: Ty, span: H.Span): H.Expr {
        const decl = target.kind === "method" || target.kind === "static" || target.kind === "fn" ? target.decl : null;
        const rt = T.prune(recv.mode === "read" ? recv.expr.ty : recv.ty);
        const abstractRecv = rt.k === "param" || rt.k === "unknown" || (rt.k === "named" && this.typeDecls.get(rt.sym)?.kind === "InterDecl");
        const viaInter = decl !== null && this.interMethods.has(decl) && (abstractRecv || decl.body === null);
        const callee: H.Callee = decl && !viaInter ? { k: "fn", name: this.fnNames.get(decl) ?? method } : { k: "dyn", method };
        return { k: "call", ty, span, callee, recv, args, witnessArgs: [], async: decl?.isAsync ?? false };
    }

    call(e: A.Call, ty: Ty, span: H.Span): H.Expr {
        const info = this.calls.get(e);
        const target = info?.target ?? { kind: "unknown" as const };
        let callee = e.callee;
        while (callee.kind === "GenericApply" || callee.kind === "Paren") callee = callee.kind === "Paren" ? callee.expr : callee.target;
        const decl = target.kind === "fn" || target.kind === "static" ? target.decl : target.kind === "method" ? target.decl : null;
        const witnessArgs = (info?.env ?? []).map(([s, t]): [Sym, Ty] => [s, T.ground(t)]);
        const async = info?.async ?? false;
        switch (target.kind) {
            case "fn": case "static": {
                // `T.default()`: a static of a generic parameter, through its witness (§15.4)
                const owner = callee.kind === "Member" ? T.prune(this.ty(callee.target)) : null;
                const param = owner?.k === "meta" ? T.prune(owner.ty) : null;
                const fnCallee: H.Callee = param?.k === "param" && callee.kind === "Member"
                    ? { k: "witness", param: param.sym, method: callee.name }
                    : { k: "fn", name: this.fnNames.get(target.decl) ?? target.decl.name };
                return { k: "call", ty, span, callee: fnCallee, recv: null, args: this.args(e.args, info?.params ?? [], target.decl), witnessArgs, async };
            }
            case "method": {
                const recvExpr = callee.kind === "Member" ? callee.target : null;
                const recv = recvExpr ? this.argOf(recvExpr, decl?.receiver === "*this") : null;
                const c: H.Callee = target.decl ? { k: "fn", name: this.fnNames.get(target.decl) ?? target.decl.name } : target.auto ? { k: "auto", method: target.auto } : { k: "dyn", method: callee.kind === "Member" ? callee.name : "?" };
                // an interface method dispatches on the receiver unless a concrete type supplies it
                // through the interface's default body (§13.2)
                const rt = recvExpr ? T.prune(this.ty(recvExpr)) : T.UNKNOWN;
                const abstractRecv = rt.k === "param" || rt.k === "unknown" || (rt.k === "named" && this.typeDecls.get(rt.sym)?.kind === "InterDecl");
                const viaInter = target.decl !== null && this.interMethods.has(target.decl) && (abstractRecv || target.decl.body === null);
                const dynCallee: H.Callee = (target.dyn || viaInter) && callee.kind === "Member" ? { k: "dyn", method: callee.name } : c;
                return { k: "call", ty, span, callee: dynCallee, recv, args: this.args(e.args, info?.params ?? [], target.decl), witnessArgs, async };
            }
            case "variant": {
                const union = target.ref.union ? this.typeNames.get(target.ref.union) ?? target.ref.union.name : "?";
                return { k: "variant", ty, span, union, variant: target.ref.variant, fields: e.args.map((a) => this.expr(a.value)) };
            }
            case "value":
                return { k: "callvalue", ty, span, fn: this.expr(callee), args: this.args(e.args, info?.params ?? [], null) };
            case "unknown":
                if (callee.kind === "Member" && this.isPackageMember(callee)) return { k: "extern", ty, span, path: this.externPath(callee), args: e.args.map((a) => this.expr(a.value)) };
                if (callee.kind === "Ident" && !this.refs.get(callee)) return { k: "extern", ty, span, path: callee.name, args: e.args.map((a) => this.expr(a.value)) };
                if (callee.kind === "Member") {
                    return { k: "call", ty, span, callee: { k: "dyn", method: callee.name }, recv: { mode: "read", expr: this.expr(callee.target) }, args: e.args.map((a) => ({ mode: "read" as const, expr: this.expr(a.value) })), witnessArgs: [], async: false };
                }
                return { k: "callvalue", ty, span, fn: this.expr(callee), args: e.args.map((a) => ({ mode: "read" as const, expr: this.expr(a.value) })) };
        }
    }

    /** Arguments with their modes; variadic ones packed into a Vec; missing `void` ones filled. */
    args(args: A.Elem[], params: { ty: Ty; star: boolean }[], decl: A.FnDecl | null): H.Arg[] {
        const variadicAt = decl ? decl.params.findIndex((p) => p.variadic) : -1;
        const out: H.Arg[] = [];
        const fixed = variadicAt >= 0 ? variadicAt : params.length;
        for (let i = 0; i < Math.min(args.length, fixed); i++) out.push(this.argOf(args[i]!.value, params[i]?.star ?? false));
        if (variadicAt >= 0) {
            const rest = args.slice(variadicAt);
            const vecTy = T.ground(params[variadicAt]?.ty ?? T.UNKNOWN);
            if (rest.length === 1 && rest[0]!.spread) out.push({ mode: "read", expr: this.expr(rest[0]!.value) });
            else {
                const at = rest[0] ? this.sp(rest[0].value) : { start: 0, end: 0 };
                out.push({ mode: "read", expr: { k: "vec", ty: vecTy, span: at, elems: rest.map((a): H.Expr | H.Spread => (a.spread ? { k: "spread", expr: this.expr(a.value) } : this.expr(a.value))) } });
            }
        } else {
            for (let i = fixed; i < args.length; i++) out.push({ mode: "read", expr: this.expr(args[i]!.value) });
            for (let i = args.length; i < fixed; i++) out.push({ mode: "read", expr: this.unit({ start: 0, end: 0 }) });
        }
        return out;
    }

    // ---- patterns -----------------------------------------------------------------------------

    pattern(p: A.Pattern, ty: Ty): H.Pattern {
        switch (p.kind) {
            case "PWild": case "PError":
                return { k: "wild" };
            case "PBind": {
                const s = this.decls.get(p);
                return s ? { k: "bind", local: this.local(s, p.isVar) } : { k: "wild" };
            }
            case "PLit":
                return { k: "lit", value: litValue(p.value) };
            case "PRange":
                return { k: "range", start: litValue(p.start) ?? 0, end: litValue(p.end) ?? 0, inclusive: p.inclusive } as H.Pattern;
            case "POr":
                return { k: "or", alts: p.alts.map((a) => this.pattern(a, ty)) };
            case "PTuple": {
                const t = T.prune(ty);
                const tys = t.k === "tuple" ? t.elems : [];
                const elems = p.elems.map((el, i) => this.pattern(el, tys[i] ?? T.UNKNOWN));
                while (p.rest && elems.length < tys.length) elems.push({ k: "wild" });
                return { k: "tuple", elems };
            }
            case "PRecord":
                return { k: "fields", fields: p.fields.map((f) => ({ name: f.name, pattern: this.fieldPattern(f) })) };
            case "PCtor":
                return this.ctorPattern(p, ty);
        }
    }

    fieldPattern(f: A.FieldPat): H.Pattern {
        if (f.pattern) return this.pattern(f.pattern, T.UNKNOWN);
        const s = this.decls.get(f);
        return s ? { k: "bind", local: this.local(s, f.isVar) } : { k: "wild" };
    }

    ctorPattern(p: A.PCtor, ty: Ty): H.Pattern {
        const ref = this.variants.get(p);
        if (!ref) {
            const s = this.refs.get(p);
            if (s?.kind === "type" && p.fields) return { k: "fields", fields: p.fields.map((f) => ({ name: f.name, pattern: this.fieldPattern(f) })) };
            const args = [...(p.args ?? []).map((a) => this.pattern(a, T.UNKNOWN)), ...(p.fields ?? []).map((f) => this.fieldPattern(f))];
            const name = p.path[p.path.length - 1]!;
            if (name === "Some" || name === "Ok") return { k: "ok", value: args[0] ?? { k: "wild" } };
            if (name === "None") return { k: "fail", payload: { k: "wild" } };
            if (name === "Err") return { k: "fail", payload: args[0] ?? { k: "wild" } };
            return { k: "variant", union: "?", variant: name, fields: args };
        }
        const union = ref.union;
        if (union.pkg === "prelude" && (union.name === "Option" || union.name === "Result")) {
            const inner = (p.args ?? [])[0];
            const payload = inner ? this.pattern(inner, T.UNKNOWN) : ({ k: "wild" } as H.Pattern);
            if (ref.variant === "Some" || ref.variant === "Ok") return { k: "ok", value: payload };
            return { k: "fail", payload };
        }
        const d = this.typeDecls.get(union);
        const variant = d?.kind === "UnionDecl" ? d.members.find((m): m is A.Variant => m.kind === "Variant" && m.name === ref.variant) : undefined;
        let fields: H.Pattern[];
        if (variant?.fields) {
            fields = variant.fields.map((f) => {
                const fp = p.fields?.find((x) => x.name === f.name);
                return fp ? this.fieldPattern(fp) : { k: "wild" as const };
            });
        } else {
            fields = (p.args ?? []).map((a) => this.pattern(a, T.UNKNOWN));
            while (fields.length < (variant?.tuple?.length ?? 0)) fields.push({ k: "wild" });
        }
        void ty;
        return { k: "variant", union: this.typeNames.get(union) ?? union.name, variant: ref.variant, fields };
    }
}

// ---- helpers -------------------------------------------------------------------------------------

function effectsAttr(fn: A.FnDecl): H.Fun["effectsAttr"] {
    const a = fn.attrs.find((x) => x.name === "effects");
    if (!a) return null;
    const get = (n: string) => a.args.find((x) => x.name === n)?.paths ?? [];
    return { keeps: get("keeps"), consumes: get("consumes"), returnsView: get("returns_view") };
}

function isBuiltinBody(b: A.Block): boolean {
    if (b.stmts.length !== 1) return false;
    const s = b.stmts[0]!;
    return s.kind === "ExprStmt" && s.expr.kind === "Call" && s.expr.callee.kind === "Ident" && s.expr.callee.name === "_builtin";
}

function litValue(e: A.Expr): bigint | number | string | boolean | null {
    switch (e.kind) {
        case "Int": case "Float": case "Str": case "Char": case "Bool": case "Byte":
            return e.value;
        case "Unary":
            if (e.operand.kind === "Int") return -e.operand.value;
            if (e.operand.kind === "Float") return -e.operand.value;
            return null;
        default:
            return null;
    }
}

/** Visits every expression of a block, depth first. */
export function walkBlock(b: H.Block, f: (e: H.Expr) => void): void {
    for (const s of b.stmts) {
        if (s.k === "let") {
            walkExpr(s.value, f);
            if (s.else) walkBlock(s.else, f);
        } else walkExpr(s.expr, f);
    }
    if (b.value) walkExpr(b.value, f);
}

export function walkPlace(p: H.Place, f: (e: H.Expr) => void): void {
    if (p.root.k === "value") walkExpr(p.root.expr, f);
    for (const s of p.segs) if (s.k === "elem") walkExpr(s.index, f);
}

function walkArg(a: H.Arg, f: (e: H.Expr) => void): void {
    if (a.mode === "read") walkExpr(a.expr, f);
    else walkPlace(a.place, f);
}

export function walkExpr(e: H.Expr, f: (e: H.Expr) => void): void {
    f(e);
    const sub = (x: H.Expr | H.Spread | null) => {
        if (!x) return;
        if (x.k === "spread") walkExpr(x.expr, f);
        else walkExpr(x, f);
    };
    switch (e.k) {
        case "read": return walkPlace(e.place, f);
        case "assign": walkPlace(e.place, f); return sub(e.value);
        case "call": if (e.recv) walkArg(e.recv, f); e.args.forEach((a) => walkArg(a, f)); return;
        case "callvalue": sub(e.fn); e.args.forEach((a) => walkArg(a, f)); return;
        case "extern": e.args?.forEach(sub); return;
        case "struct": case "record": e.fields.forEach((x) => sub(x.value)); return;
        case "variant": e.fields.forEach(sub); return;
        case "tuple": e.elems.forEach(sub); return;
        case "vec": case "array": case "set": e.elems.forEach(sub); return;
        case "map": e.entries.forEach((en) => ("k" in en ? sub(en) : (sub(en.key), sub(en.value)))); return;
        case "range": sub(e.start); sub(e.end); return;
        case "unary": case "tostr": case "cast": case "await": case "truthy": return sub(e.expr);
        case "binary": case "and": case "or": sub(e.left); sub(e.right); return;
        case "concat": e.parts.forEach(sub); return;
        case "if": sub(e.cond); walkBlock(e.then, f); if (e.else) walkBlock(e.else, f); return;
        case "match": sub(e.subject); e.arms.forEach((a) => (sub(a.guard), sub(a.body))); return;
        case "loop": return walkBlock(e.body, f);
        case "foreach": sub(e.iterable); return walkBlock(e.body, f);
        case "break": case "return": return sub(e.value);
        case "block": return walkBlock(e.block, f);
        case "closure": return walkBlock(e.body, f);
        case "select": e.arms.forEach((a) => (sub(a.wait), sub(a.body))); return sub(e.else);
        case "recover": return walkBlock(e.body, f);
        case "lock": e.places.forEach((p) => walkPlace(p, f)); return walkBlock(e.body, f);
        default: return;
    }
}
