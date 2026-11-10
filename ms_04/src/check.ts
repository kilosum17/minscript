// The type checker (spec §13.5, with the typing rules of §3–§12).
//
// Bidirectional: every expression is checked against an optional expected type, which drives
// literals, `[]` / `m{}` / `nil`, `_{…}`, closure parameters (and their modes) and variants named
// without their type (§7.7). Generic calls get fresh inference variables, bound by unification.
// The expected type is only a hint: mismatches are reported by the caller that knows the rule.
//
// Gradual: anything that can't be known (a package that isn't loaded, an earlier error) is
// `unknown`, which is compatible with everything and never produces a diagnostic. The checker
// reports a mismatch only between two types it fully knows.
//
// The AST is not modified: results are side tables keyed by node (the type of every expression,
// of every symbol, what each call and member refers to, which variant each inferred name is).

import type * as A from "./ast.ts";
import { diag, type Diagnostic } from "./diagnostic.ts";
import type { LoadedPackage, Program } from "./loader.ts";
import type { Resolution, ResolveFile, Sym } from "./resolve.ts";
import * as T from "./types.ts";
import type { FnParam, Ty, Var } from "./types.ts";

// ---- results -----------------------------------------------------------------------------------

export type VariantRef = { union: Sym; variant: string };

export type CallTarget =
    | { kind: "fn"; decl: A.FnDecl }
    | { kind: "method"; decl: A.FnDecl | null; auto: string | null; dyn: boolean }
    | { kind: "static"; decl: A.FnDecl }
    | { kind: "variant"; ref: VariantRef }
    | { kind: "value" }
    | { kind: "unknown" };

export type MemberTarget =
    | { kind: "field" }
    | { kind: "tuple"; index: number }
    | { kind: "method"; decl: A.FnDecl | null }
    | { kind: "static"; decl: A.FnDecl }
    | { kind: "variant"; ref: VariantRef }
    | { kind: "item"; sym: Sym }
    | { kind: "unknown" };

export interface CallInfo {
    target: CallTarget;
    /** the parameter each argument is passed to: its type and mode */
    params: FnParam[];
    async: boolean;
    /** the callee's own generics, as instantiated */
    typeArgs: Ty[];
    /** every generic in scope of the callee (the type's or impl's, then its own), as instantiated */
    env: [Sym, Ty][];
}

export interface CheckResult {
    pkg: string;
    /** the type of every checked expression */
    types: Map<A.Expr, Ty>;
    /** the type of every local, parameter and global that was checked */
    symTypes: Map<Sym, Ty>;
    calls: Map<A.Call, CallInfo>;
    members: Map<A.Member, MemberTarget>;
    /** the variant each inferred name, constructor pattern or variant literal refers to */
    variants: Map<object, VariantRef>;
    /**
     * Methods an expression calls without writing a call: an operator (`a + b` → `plus`, also in
     * `+=`), an index (`x[i]` → `index`), a `for` loop's iteration (`next` / `iter`), a unary `-`.
     */
    ops: Map<object, CallTarget>;
    /** the declared result of each function and method (for `async fn`: the value, not the Promise) */
    rets: Map<A.FnDecl, Ty>;
    /** the declared type of each field and variant payload (generic parameters unsubstituted) */
    declTypes: Map<A.Type, Ty>;
    /** lint findings the checker is placed to see (L_SHADOWED_VARIANT); reported by the lint stage */
    lints: Diagnostic[];
    diagnostics: Diagnostic[];
}

// ---- the world: what every package of a program declares ---------------------------------------

type InfoKind = "struct" | "union" | "inter" | "alias";

interface MethodEntry {
    fn: A.FnDecl;
    /** generics in scope besides the method's own: the type's, or the impl block's */
    outer: Sym[];
    /** `impl[T] Vec[T]`: unified with the receiver to bind `outer` */
    implTarget: A.Type | null;
    /** bounds of the impl block's generics (`impl[T: Stringer] Vec[T]`) */
    implGenerics: A.GenericParam[];
    /** a default method of this interface (type), with the interface's arguments as implemented */
    fromInter: A.Type | null;
}

interface TypeInfo {
    sym: Sym;
    kind: InfoKind;
    decl: A.TypeDecl | A.UnionDecl | A.InterDecl;
    generics: Sym[];
    /** generic parameters declared `: Unique` (§9.2) */
    uniqueOk: Set<Sym>;
    fields: Map<string, A.Field>;
    variants: Map<string, A.Variant>;
    methods: MethodEntry[];
    /** interfaces it implements: `type X: A`, `impl A for X` */
    interfaces: A.Type[];
    file: string;
    std: boolean;
}

/** Interfaces every type implements through generated code (§13.2). */
const AUTO_INTERFACES: ReadonlySet<string> = new Set(["Stringer", "PartialEq", "Hash", "Copy", "Default"]);
const NUMBER_INTERFACES: ReadonlySet<string> = new Set([
    "Plus", "Minus", "Times", "Divide", "Remainder", "PlusAssign", "MinusAssign", "TimesAssign", "DivideAssign", "RemainderAssign", "PartialOrd",
]);
const OPERATOR_METHODS: Readonly<Record<string, string>> = { "+": "plus", "-": "minus", "*": "times", "/": "divide", "%": "remainder" };
/** generated methods (§13.2, §12.1) */
const AUTO_METHODS = new Set(["to_str", "eq", "hash", "clone", "same_fields"]);

class World {
    readonly refs = new Map<object, Sym>();
    readonly decls = new Map<object, Sym>();
    readonly deferred = new Set<object>();
    readonly infos = new Map<Sym, TypeInfo>();
    readonly primMethods = new Map<string, MethodEntry[]>();
    readonly implicit = new Map<object, Map<string, Sym>>();
    readonly symTypes = new Map<Sym, Ty>();
    readonly prelude = new Map<string, Sym>();
    /** item → its file */
    readonly fileOf = new Map<object, string>();
    readonly testFiles = new Set<string>();
    readonly openFiles = new Set<string>();
    /** each method's receiver symbol */
    readonly thisOf = new Map<object, Sym>();

    add(files: ResolveFile[], res: Resolution, std: boolean): void {
        for (const f of res.openFiles) this.openFiles.add(f);
        for (const [k, v] of res.refs) this.refs.set(k, v);
        for (const [k, v] of res.decls) this.decls.set(k, v);
        for (const d of res.deferred) this.deferred.add(d);
        for (const s of res.symbols) {
            if (s.kind === "this" && s.decl) this.thisOf.set(s.decl, s);
            if (s.kind !== "implicit" || !s.decl) continue;
            const m = this.implicit.get(s.decl) ?? new Map<string, Sym>();
            m.set(s.name, s);
            this.implicit.set(s.decl, m);
        }
        if (res.pkg === "prelude") for (const [n, s] of res.exports) this.prelude.set(n, s);
        for (const f of files) {
            if (f.path.endsWith("_test.ms")) this.testFiles.add(f.path);
            for (const item of f.ast.items) {
                this.fileOf.set(item, f.path);
                if (item.kind === "TypeDecl" || item.kind === "UnionDecl" || item.kind === "InterDecl") this.register(item, f.path, std);
            }
        }
        for (const f of files) for (const item of f.ast.items) if (item.kind === "ImplDecl") this.registerImpl(item);
    }

    register(d: A.TypeDecl | A.UnionDecl | A.InterDecl, file: string, std: boolean): void {
        const sym = this.decls.get(d);
        if (!sym) return;
        const kind: InfoKind = d.kind === "UnionDecl" ? "union" : d.kind === "InterDecl" ? "inter" : d.alias ? "alias" : "struct";
        const generics = d.generics.map((g) => this.decls.get(g)).filter((s): s is Sym => s !== undefined);
        const uniqueOk = new Set<Sym>();
        d.generics.forEach((g) => {
            const s = this.decls.get(g);
            if (s && g.bounds.some((b) => b.kind === "TName" && b.path[0] === "Unique")) uniqueOk.add(s);
        });
        const info: TypeInfo = {
            sym, kind, decl: d, generics, uniqueOk, fields: new Map(), variants: new Map(), methods: [], interfaces: [], file, std,
        };
        if (d.kind === "TypeDecl") {
            info.interfaces.push(...d.impls);
            for (const m of d.members ?? []) {
                if (m.kind === "Field") info.fields.set(m.name, m);
                else info.methods.push({ fn: m, outer: generics, implTarget: null, implGenerics: [], fromInter: null });
            }
        } else if (d.kind === "UnionDecl") {
            info.interfaces.push(...d.impls);
            for (const m of d.members) {
                if (m.kind === "Variant") info.variants.set(m.name, m);
                else info.methods.push({ fn: m, outer: generics, implTarget: null, implGenerics: [], fromInter: null });
            }
        } else {
            for (const m of d.methods ?? []) info.methods.push({ fn: m, outer: generics, implTarget: null, implGenerics: [], fromInter: null });
        }
        this.infos.set(sym, info);
    }

    registerImpl(d: A.ImplDecl): void {
        if (d.target.kind !== "TName") return;
        const target = this.refs.get(d.target);
        if (!target) return;
        const outer = d.generics.map((g) => this.decls.get(g)).filter((s): s is Sym => s !== undefined);
        const entries = d.methods.map((fn): MethodEntry => ({ fn, outer, implTarget: d.generics.length > 0 ? d.target : null, implGenerics: d.generics, fromInter: null }));
        if (target.kind === "builtin-type") {
            this.primMethods.set(target.name, [...(this.primMethods.get(target.name) ?? []), ...entries]);
            return;
        }
        const info = this.infos.get(target);
        if (!info) return;
        info.methods.push(...entries);
        info.interfaces.push(...d.inters);
    }
}

// ---- programs ----------------------------------------------------------------------------------

/** Checks every package of a program, in dependency order, the prelude first. */
export function checkProgram(program: Program, preludeFile: ResolveFile): { prelude: CheckResult; packages: Map<LoadedPackage, CheckResult>; diagnostics: Diagnostic[] } {
    const world = new World();
    world.add([preludeFile], program.prelude, true);
    const prelude = new Checker(world, [preludeFile], program.prelude, true).run();
    const packages = new Map<LoadedPackage, CheckResult>();
    const diagnostics: Diagnostic[] = [];
    for (const p of program.packages) {
        const std = p.dir.includes("/std/");
        world.add(p.files, p.res, std);
        const r = new Checker(world, p.files, p.res, std).run();
        packages.set(p, r);
        diagnostics.push(...r.diagnostics);
    }
    return { prelude, packages, diagnostics };
}

/** Checks one package on its own (with the prelude): what `ms check file.ms` does for a single file. */
export function checkPackage(files: ResolveFile[], res: Resolution, prelude: { res: Resolution; file: ResolveFile }): CheckResult {
    const world = new World();
    world.add([prelude.file], prelude.res, true);
    new Checker(world, [prelude.file], prelude.res, true).run();
    world.add(files, res, false);
    return new Checker(world, files, res, false).run();
}

// ---- the checker -------------------------------------------------------------------------------

interface Loop {
    label: string | null;
    infinite: boolean;
    breakTy: Ty | null;
    broke: boolean;
}

interface FnCtx {
    /** declared result (for async functions: the value inside the Promise) */
    ret: Ty;
    async: boolean;
    selfTy: Ty | null;
    loops: Loop[];
}

interface Param {
    name: string;
    ty: Ty;
    star: boolean;
    variadic: boolean;
}

/** A function as called: its own generics instantiated. */
interface Callable {
    params: Param[];
    ret: Ty;
    async: boolean;
    own: { sym: Sym; v: Var; bounds: A.Type[]; uniqueOk: boolean }[];
    target: CallTarget;
    /** the instantiation of the outer generics, for bounds of an impl block */
    env: Map<Sym, Ty>;
    /** generics need `.[T]` when they can't be inferred */
    generic: boolean;
}

class Checker {
    readonly w: World;
    readonly files: ResolveFile[];
    readonly res: Resolution;
    readonly std: boolean;
    readonly out: CheckResult;
    file = "";
    ctx: FnCtx = { ret: T.UNKNOWN, async: false, selfTy: null, loops: [] };
    selfStack: Ty[] = [];
    trail: { v: Var; ref: Ty | null; lit: Var["lit"] }[] = [];
    inferSites: { v: Ty; at: { span: A.Span }; code: string; what: string }[] = [];
    nextVar = 0;
    globalsBusy = new Set<Sym>();
    aliasBusy = new Set<Sym>();

    constructor(w: World, files: ResolveFile[], res: Resolution, std: boolean) {
        this.w = w;
        this.files = files;
        this.res = res;
        this.std = std;
        this.out = {
            pkg: res.pkg, types: new Map(), symTypes: w.symTypes, calls: new Map(), members: new Map(), variants: new Map(), ops: new Map(), rets: new Map(), declTypes: new Map(), lints: [], diagnostics: [],
        };
    }

    run(): CheckResult {
        for (const f of this.files) {
            this.file = f.path;
            for (const item of f.ast.items) this.declChecks(item, f);
        }
        for (const f of this.files) {
            this.file = f.path;
            for (const item of f.ast.items) this.item(item);
        }
        for (const [e, t] of this.out.types) this.out.types.set(e, T.zonk(t));
        return this.out;
    }

    // ---- diagnostics and inference ------------------------------------------------------------

    error(code: string, message: string, at: { span: A.Span }, fix?: string): void {
        const d = diag(code, message, at.span.start, at.span.end, fix);
        d.file = this.file;
        if (this.out.diagnostics.some((x) => x.start === d.start && x.code === d.code && x.file === d.file)) return;
        this.out.diagnostics.push(d);
    }

    fresh(lit: Var["lit"] = null): Var {
        return { k: "var", id: this.nextVar++, ref: null, lit };
    }

    freshAt(at: { span: A.Span }, what: string, code = "E_CANNOT_INFER_TYPE"): Var {
        const v = this.fresh();
        this.inferSites.push({ v, at, code, what });
        return v;
    }

    bind(v: Var, t: Ty): boolean {
        t = T.prune(t);
        if (t === v) return true;
        if (t.k === "var") {
            if (v.lit !== null && t.lit !== v.lit) {
                const lit = v.lit === "float" || t.lit === "float" ? "float" : "int";
                this.trail.push({ v: t, ref: t.ref, lit: t.lit });
                t.lit = lit;
            }
            this.trail.push({ v, ref: v.ref, lit: v.lit });
            v.ref = t;
            return true;
        }
        if (v.lit === "int" && !(t.k === "unknown" || T.isNumeric(t) || (t.k === "lit" && typeof t.value === "bigint") || t.k === "never")) return false;
        if (v.lit === "float" && !(t.k === "unknown" || T.isFloat(t) || t.k === "never")) return false;
        if (T.occurs(v, t)) return false;
        this.trail.push({ v, ref: v.ref, lit: v.lit });
        v.ref = t;
        return true;
    }

    /** Runs `f`; if it returns false, undoes every variable it bound. */
    attempt(f: () => boolean): boolean {
        const mark = this.trail.length;
        if (f()) return true;
        while (this.trail.length > mark) {
            const e = this.trail.pop()!;
            e.v.ref = e.ref;
            e.v.lit = e.lit;
        }
        return false;
    }

    /** Whether a value of type `from` may be used where `to` is expected (binding variables). */
    assignable(from: Ty, to: Ty): boolean {
        return this.attempt(() => this.flows(from, to, false));
    }

    equal(a: Ty, b: Ty): boolean {
        return this.attempt(() => this.flows(a, b, true));
    }

    flows(a: Ty, b: Ty, exact: boolean): boolean {
        a = T.prune(a);
        b = T.prune(b);
        if (a === b) return true;
        if (a.k === "unknown" || b.k === "unknown") {
            if (a.k === "var") this.bind(a, T.UNKNOWN);
            if (b.k === "var") this.bind(b, T.UNKNOWN);
            return true;
        }
        if (a.k === "never" && !exact) return true;
        if (a.k === "var" && b.k === "var") return this.bind(a, b);
        if (a.k === "var" && a.lit !== null && b.k === "named" && this.w.infos.get(b.sym)?.kind === "inter") {
            // a number literal where an interface is expected: it will default to int / f64
            return this.implementsSym(a.lit === "int" ? T.INT : T.F64, b.sym);
        }
        if (a.k === "var") {
            // a literal flowing into a union of literals, or a wider number: take the expected type
            return this.bind(a, b) || (!exact && a.lit === "int" && T.isFloat(b) && this.bind(a, b));
        }
        if (b.k === "var") {
            if (b.lit !== null && a.k === "lit") return this.bind(b, typeof a.value === "bigint" ? T.INT : T.UNKNOWN);
            return this.bind(b, a.k === "lit" && typeof a.value === "string" ? T.STR : a.k === "lit" && typeof a.value === "boolean" ? T.BOOL : a);
        }
        switch (b.k) {
            case "prim":
                if (a.k === "prim") return a.name === b.name || (!exact && T.widens(a.name, b.name));
                if (a.k === "lit") return litBase(a) === b.name || (typeof a.value === "bigint" && T.isNumeric(b));
                if (a.k === "union" && !exact) return a.members.every((m) => this.flows(m, b, false));
                return false;
            case "lit":
                return a.k === "lit" && a.value === b.value;
            case "union":
                if (a.k === "lit") return b.members.some((m) => m.k === "lit" && m.value === a.value);
                if (a.k === "union") return a.members.every((m) => this.flows(m, b, exact));
                return false;
            case "named":
                return this.flowsNamed(a, b, exact);
            case "param":
                return a.k === "param" && a.sym === b.sym;
            case "tuple":
                return a.k === "tuple" && a.elems.length === b.elems.length && a.elems.every((e, i) => this.flows(e, b.elems[i]!, exact));
            case "record":
                if (a.k === "record") {
                    return a.fields.length === b.fields.length && a.fields.every((f, i) => f.name === b.fields[i]!.name && this.flows(f.ty, b.fields[i]!.ty, exact));
                }
                if (a.k === "named" && !exact) return this.structToRecord(a, b);
                return false;
            case "fn":
                if (a.k !== "fn" || a.params.length !== b.params.length) return false;
                return a.params.every((p, i) => this.flows(b.params[i]!.ty, p.ty, true)) && this.flows(a.ret, b.ret, exact);
            case "meta":
                return a.k === "meta" && this.flows(a.ty, b.ty, true);
            case "package":
                return a.k === "package" && a.sym === b.sym;
            case "never":
                return a.k === "never";
        }
        return false;
    }

    flowsNamed(a: Ty, b: Ty & { k: "named" }, exact: boolean): boolean {
        if (a.k === "named" && a.sym === b.sym) {
            return a.args.length === b.args.length && a.args.every((x, i) => this.flows(x, b.args[i]!, true));
        }
        if (exact) return false;
        const binfo = this.w.infos.get(b.sym);
        // Vec / Array → Slice (§7.2)
        if (b.sym === this.w.prelude.get("Slice") && a.k === "named" && (a.sym === this.w.prelude.get("Vec") || a.sym === this.w.prelude.get("Array"))) {
            return this.flows(a.args[0] ?? T.UNKNOWN, b.args[0] ?? T.UNKNOWN, true);
        }
        if (binfo?.kind === "inter") return this.implementsTy(a, b);
        if (a.k === "record" && binfo?.kind === "struct") return this.recordToStruct(a, b);
        return false;
    }

    /** record → named struct: same field names; fields left out must have a default or be optional (§7.5). */
    recordToStruct(a: Ty & { k: "record" }, b: Ty & { k: "named" }): boolean {
        const info = this.w.infos.get(b.sym)!;
        const env = this.typeEnv(info, b.args);
        for (const f of a.fields) {
            const field = info.fields.get(f.name);
            if (!field || !this.flows(f.ty, this.fieldType(field, env), false)) return false;
        }
        for (const [name, field] of info.fields) {
            if (a.fields.some((f) => f.name === name)) continue;
            if (!field.default && !this.isOptional(this.fieldType(field, env))) return false;
        }
        return true;
    }

    structToRecord(a: Ty & { k: "named" }, b: Ty & { k: "record" }): boolean {
        const info = this.w.infos.get(a.sym);
        if (!info || info.kind !== "struct" || info.fields.size !== b.fields.length) return false;
        const env = this.typeEnv(info, a.args);
        return b.fields.every((f) => {
            const field = info.fields.get(f.name);
            return field !== undefined && this.flows(this.fieldType(field, env), f.ty, true);
        });
    }

    // ---- type construction --------------------------------------------------------------------

    preludeNamed(name: string, args: Ty[]): Ty {
        const sym = this.w.prelude.get(name);
        return sym ? { k: "named", sym, args } : T.UNKNOWN;
    }

    option(t: Ty): Ty {
        return this.preludeNamed("Option", [t]);
    }

    isNamed(t: Ty, name: string): boolean {
        const p = T.prune(t);
        return p.k === "named" && p.sym === this.w.prelude.get(name);
    }

    /** An interface type: expecting it constrains nothing to be equal (it is a supertype). */
    isInterface(t: Ty): boolean {
        const p = T.prune(t);
        return p.k === "named" && this.w.infos.get(p.sym)?.kind === "inter";
    }

    isOptional(t: Ty): boolean {
        return this.isNamed(t, "Option");
    }

    typeEnv(info: TypeInfo, args: Ty[]): Map<Sym, Ty> {
        const env = new Map<Sym, Ty>();
        info.generics.forEach((g, i) => env.set(g, args[i] ?? T.UNKNOWN));
        return env;
    }

    /** The type a field holds: `once` fields read as `T?` (§12.2). */
    fieldType(f: A.Field, env: Map<Sym, Ty>): Ty {
        const t = T.subst(this.ty(f.type), env);
        return f.mode === "once" ? this.option(t) : t;
    }

    /** A written type → Ty. `check`: report generic-argument problems (annotations, not signatures). */
    ty(t: A.Type, check = false): Ty {
        switch (t.kind) {
            case "TName":
                return this.namedTy(t, check);
            case "TOptional":
                return this.option(this.ty(t.inner, check));
            case "TTuple":
                return t.elems.length === 0 ? T.VOID : { k: "tuple", elems: t.elems.map((e) => this.ty(e, check)) };
            case "TRecord":
                return record(t.fields.map((f) => ({ name: f.name, ty: this.ty(f.type, check), optional: false })));
            case "TFn":
                return { k: "fn", params: t.params.map((p) => ({ star: p.star, ty: this.ty(p.type, check) })), ret: this.ty(t.ret, check), async: false };
            case "TUnion":
                return { k: "union", members: t.alts.map((a) => this.ty(a, check)) };
            case "TInter":
                return t.parts.length > 0 ? this.ty(t.parts[0]!, check) : T.UNKNOWN;
            case "TTypeOf": {
                const s = this.w.refs.get(t);
                return s ? this.zonkLater(this.symType(s, t)) : T.UNKNOWN;
            }
            case "TLit":
                return { k: "lit", value: t.value };
            case "TError":
                return T.UNKNOWN;
        }
    }

    zonkLater(t: Ty): Ty {
        return T.prune(t);
    }

    namedTy(t: A.NamedType, check: boolean): Ty {
        if (t.path[0] === "Self" && t.path.length === 1) return this.selfStack[this.selfStack.length - 1] ?? T.UNKNOWN;
        const sym = this.w.refs.get(t);
        if (!sym || this.w.deferred.has(t)) return T.UNKNOWN;
        const args = t.args.map((a) => this.ty(a, check));
        switch (sym.kind) {
            case "builtin-type":
                if (sym.name === "never") return T.NEVER;
                if (sym.name === "byte") return T.U8;
                return (T.INT_TYPES as readonly string[]).includes(sym.name) || ["f32", "f64", "bool", "char", "str", "void"].includes(sym.name)
                    ? T.prim(sym.name as T.PrimName)
                    : T.UNKNOWN; // type-level forms (KeyOf…) are evaluated later
            case "generic":
                return { k: "param", sym };
            case "type": case "union": case "inter": {
                const info = this.w.infos.get(sym);
                if (!info) return T.UNKNOWN;
                const full = info.generics.map((_, i) => args[i] ?? (check ? T.UNKNOWN : T.UNKNOWN));
                if (check && t.args.length > 0 && t.args.length !== info.generics.length && !(sym.name === "Array")) {
                    this.error("E_ARG_COUNT", `\`${sym.name}\` takes ${info.generics.length} type argument(s), not ${t.args.length}`, t);
                }
                if (check) this.uniqueArgs(info, full, t);
                if (info.kind === "alias") return this.expandAlias(info, full);
                return { k: "named", sym, args: full };
            }
            default:
                return T.UNKNOWN;
        }
    }

    expandAlias(info: TypeInfo, args: Ty[]): Ty {
        const decl = info.decl as A.TypeDecl;
        if (!decl.alias || this.aliasBusy.has(info.sym)) return T.UNKNOWN;
        this.aliasBusy.add(info.sym);
        try {
            return T.subst(this.ty(decl.alias), this.typeEnv(info, args));
        } finally {
            this.aliasBusy.delete(info.sym);
        }
    }

    /** E_UNIQUE_TYPE_ARG (§9.2): a Unique type for a parameter without `: Unique`. */
    uniqueArgs(info: TypeInfo, args: Ty[], at: { span: A.Span }): void {
        info.generics.forEach((g, i) => {
            const a = args[i];
            if (a && !info.uniqueOk.has(g) && this.isUnique(a)) {
                this.error("E_UNIQUE_TYPE_ARG", `\`${T.show(a)}\` is Unique, and \`${info.sym.name}\`'s \`${g.name}\` doesn't admit Unique types`, at, `${g.name}: Unique`);
            }
        });
    }

    isUnique(t: Ty, seen = new Set<Sym>()): boolean {
        t = T.prune(t);
        if (t.k === "param") {
            const decl = t.sym.decl as A.GenericParam | null;
            return !!decl?.bounds?.some((b) => b.kind === "TName" && b.path[0] === "Unique");
        }
        if (t.k !== "named" || seen.has(t.sym)) return false;
        seen.add(t.sym);
        const info = this.w.infos.get(t.sym);
        if (!info) return false;
        if (info.interfaces.some((i) => i.kind === "TName" && this.w.refs.get(i) === this.w.prelude.get("Unique"))) return true;
        if (info.kind === "struct") {
            const env = this.typeEnv(info, t.args);
            for (const f of info.fields.values()) if (this.isUnique(this.fieldType(f, env), seen)) return true;
        }
        return false;
    }

    isIdentity(t: Ty): boolean {
        const p = T.prune(t);
        if (p.k !== "named") return false;
        const info = this.w.infos.get(p.sym);
        return !!info?.interfaces.some((i) => i.kind === "TName" && this.w.refs.get(i) === this.w.prelude.get("Identity"));
    }

    /** The type a type declaration denotes inside its own body: `Pair[A, B]`. */
    selfType(info: TypeInfo): Ty {
        return { k: "named", sym: info.sym, args: info.generics.map((g) => ({ k: "param", sym: g }) as Ty) };
    }

    // ---- symbols ------------------------------------------------------------------------------

    /** The type of a symbol used as a value. */
    symType(s: Sym, at: { span: A.Span }, expected?: Ty): Ty {
        switch (s.kind) {
            case "local": case "param": case "closure-param": case "implicit": case "this":
                return this.w.symTypes.get(s) ?? (s.kind === "param" ? this.paramDeclType(s) : T.UNKNOWN);
            case "fn": case "extern-fn":
                return s.decl ? this.fnValue(s.decl as A.FnDecl) : T.UNKNOWN;
            case "global":
                return this.globalType(s);
            case "type": case "union": case "inter": {
                const info = this.w.infos.get(s);
                if (!info) return T.UNKNOWN;
                const args = info.generics.map(() => this.fresh() as Ty);
                return { k: "meta", ty: info.kind === "alias" ? this.expandAlias(info, args) : { k: "named", sym: s, args } };
            }
            case "generic":
                return { k: "meta", ty: { k: "param", sym: s } };
            case "builtin-type": {
                const name = s.name === "byte" ? "u8" : s.name;
                return (T.INT_TYPES as readonly string[]).includes(name) || ["f32", "f64", "bool", "char", "str"].includes(name)
                    ? { k: "meta", ty: T.prim(name as T.PrimName) }
                    : s.kind === "builtin-type" && s.target === undefined ? T.UNKNOWN : T.UNKNOWN;
            }
            case "variant":
                return this.variantValue(s, at, expected);
            case "package":
                return { k: "package", sym: s };
            default:
                return T.UNKNOWN;
        }
    }

    paramDeclType(s: Sym): Ty {
        const p = s.decl as A.Param | null;
        if (!p || !("type" in p)) return T.UNKNOWN;
        const t = this.ty(p.type);
        return p.variadic ? this.preludeNamed("Slice", [t]) : t;
    }

    globalType(s: Sym): Ty {
        const known = this.w.symTypes.get(s);
        if (known) return known;
        const d = s.decl as A.LetDecl | A.VarDecl | null;
        if (!d) return T.UNKNOWN;
        if (d.type) {
            const t = this.ty(d.type);
            this.w.symTypes.set(s, t);
            return t;
        }
        if (this.globalsBusy.has(s) || !this.files.some((f) => f.ast.items.includes(d))) return T.UNKNOWN;
        // a global used before its own item was checked: check its initializer now
        this.globalsBusy.add(s);
        const saved = [this.ctx, this.file] as const;
        this.ctx = { ret: T.UNKNOWN, async: false, selfTy: null, loops: [] };
        this.file = this.w.fileOf.get(d) ?? this.file;
        const t = T.zonk(this.check(d.value));
        [this.ctx, this.file] = saved;
        this.globalsBusy.delete(s);
        this.w.symTypes.set(s, t);
        return t;
    }

    /** The signature of a function declaration, generics not instantiated. */
    sig(fn: A.FnDecl, self: Ty | null): { params: Param[]; ret: Ty; async: boolean; generics: Sym[] } {
        if (self) this.selfStack.push(self);
        try {
            const params = fn.params.map((p): Param => {
                const t = this.ty(p.type);
                return { name: p.name, ty: p.variadic ? this.preludeNamed("Slice", [t]) : t, star: p.star, variadic: p.variadic };
            });
            const ret = fn.ret ? this.ty(fn.ret) : T.VOID;
            const generics = fn.generics.map((g) => this.w.decls.get(g)).filter((s): s is Sym => s !== undefined);
            return { params, ret, async: fn.isAsync, generics };
        } finally {
            if (self) this.selfStack.pop();
        }
    }

    /** A function's callable form, with its own generics (and `outer` ones) instantiated. */
    callable(fn: A.FnDecl, self: Ty | null, target: CallTarget, env = new Map<Sym, Ty>()): Callable {
        const s = this.sig(fn, self);
        const own = fn.generics.map((g, i) => ({
            sym: s.generics[i]!,
            v: this.fresh(),
            bounds: g.bounds,
            uniqueOk: g.bounds.some((b) => b.kind === "TName" && b.path[0] === "Unique"),
        })).filter((o) => o.sym !== undefined);
        const full = new Map(env);
        for (const o of own) full.set(o.sym, o.v);
        const params = s.params.map((p) => ({ ...p, ty: T.subst(p.ty, full) }));
        return { params, ret: T.subst(s.ret, full), async: s.async, own, target, env: full, generic: own.length > 0 };
    }

    fnValue(fn: A.FnDecl): Ty {
        const c = this.callable(fn, null, { kind: "fn", decl: fn });
        return { k: "fn", params: c.params.map((p) => ({ ty: p.ty, star: p.star })), ret: this.asyncRet(c), async: c.async };
    }

    asyncRet(c: { async: boolean; ret: Ty }): Ty {
        return c.async ? this.preludeNamed("Promise", [c.ret]) : c.ret;
    }

    // ---- variants -----------------------------------------------------------------------------

    variantOf(s: Sym): { info: TypeInfo; variant: A.Variant } | null {
        const owner = s.owner;
        const info = owner ? this.w.infos.get(owner) : undefined;
        const variant = info?.variants.get(s.name);
        return info && variant ? { info, variant } : null;
    }

    /** A variant used as a value: the union value, or its constructor. */
    variantValue(s: Sym, at: { span: A.Span }, expected?: Ty): Ty {
        const v = this.variantOf(s);
        if (!v) return T.UNKNOWN;
        return this.constructorOf(v.info, v.variant, at, expected);
    }

    constructorOf(info: TypeInfo, variant: A.Variant, at: { span: A.Span }, expected?: Ty): Ty {
        const args = info.generics.map(() => this.fresh() as Ty);
        const union: Ty = { k: "named", sym: info.sym, args };
        this.out.variants.set(at, { union: info.sym, variant: variant.name });
        if (variant.tuple) {
            const env = this.typeEnv(info, args);
            const params = variant.tuple.map((t) => ({ ty: T.subst(this.ty(t), env), star: false }));
            return { k: "fn", params, ret: union, async: false };
        }
        if (expected) this.assignable(union, expected);
        return union;
    }

    /** `Punct(p)` where `TokenKind` is expected and `Punct` is also a type: the variant wins (§7.7). */
    expectedVariant(name: string, at: { span: A.Span }, expected: Ty | undefined, s: Sym | undefined): Ty | null {
        if (!s || !isUpperName(name) || s.kind === "local" || s.kind === "param" || s.kind === "variant") return null;
        const exp = expected ? T.prune(expected) : undefined;
        if (exp?.k !== "named") return null;
        const info = this.w.infos.get(exp.sym);
        const variant = info?.variants.get(name);
        if (!info || !variant) return null;
        const ctor = this.constructorOf(info, variant, at);
        this.assignable(ctor.k === "fn" ? ctor.ret : ctor, exp);
        // a type of the same name is never ambiguous (a type isn't a value); a function or global is
        if ((s.kind === "fn" || s.kind === "global") && s.pkg === this.out.pkg) {
            this.out.lints.push({
                ...diag("L_SHADOWED_VARIANT", `\`${name}\` is the variant \`${T.show(exp)}.${name}\` here, not the ${s.kind === "fn" ? "function" : "global"} \`${name}\` of this package (§7.7)`, at.span.start, at.span.end, `${s.pkg}.${name} for the ${s.kind === "fn" ? "function" : "global"}, or rename it`),
                file: this.file,
            });
        }
        return ctor;
    }

    /** A bare name not declared anywhere (`Text`, `Cash`): a variant of the expected union (§7.7). */
    inferVariant(name: string, at: { span: A.Span }, expected: Ty | undefined, asCallee: boolean): Ty | null {
        const exp = expected ? T.prune(expected) : undefined;
        let target = exp;
        if (exp && asCallee && exp.k !== "named") target = undefined;
        if (target && target.k === "named") {
            const info = this.w.infos.get(target.sym);
            const variant = info?.variants.get(name);
            if (info && variant) {
                const ctor = this.constructorOf(info, variant, at);
                const ret = ctor.k === "fn" ? ctor.ret : ctor;
                this.assignable(ret, target);
                return ctor;
            }
            if (info?.kind === "union") {
                this.error("E_UNKNOWN_VARIANT", `union \`${info.sym.name}\` has no variant \`${name}\``, at);
                return T.UNKNOWN;
            }
        }
        if (this.w.openFiles.has(this.file)) return null;
        if (exp === undefined) {
            this.error("E_CANNOT_INFER_VARIANT", `\`${name}\` isn't declared, and no union type is expected here`, at, `Union.${name}`);
            return T.UNKNOWN;
        }
        if (!T.isOpen(exp) && exp.k !== "named") {
            this.error("E_CANNOT_INFER_VARIANT", `\`${name}\` isn't declared, and \`${T.show(exp)}\` is not a union`, at, `Union.${name}`);
            return T.UNKNOWN;
        }
        return null;
    }

    // ---- interfaces ---------------------------------------------------------------------------

    /** Whether `t` implements the interface type `inter` (§8.5, §13.2); lenient when unsure. */
    implementsTy(t: Ty, inter: Ty & { k: "named" }): boolean {
        return this.implementsSym(t, inter.sym);
    }

    implementsSym(t: Ty, inter: Sym): boolean {
        t = T.prune(t);
        const name = inter.pkg === "prelude" ? inter.name : "";
        switch (t.k) {
            case "unknown": case "var": case "never":
                return true;
            case "prim":
                if (AUTO_INTERFACES.has(name)) return true;
                if (NUMBER_INTERFACES.has(name)) return T.isNumeric(t) || (t.name === "str" && (name === "Plus" || name === "PlusAssign" || name === "PartialOrd")) || (t.name === "char" && name === "PartialOrd");
                return false;
            case "lit": case "union": case "tuple": case "record":
                return AUTO_INTERFACES.has(name) || (name === "PartialOrd" && t.k !== "tuple" && t.k !== "record");
            case "param": {
                const decl = t.sym.decl as A.GenericParam | null;
                if (AUTO_INTERFACES.has(name) && name !== "Default") return true;
                return !!decl?.bounds?.some((b) => this.boundIncludes(b, inter));
            }
            case "named": {
                if (t.sym === inter) return true;
                const info = this.w.infos.get(t.sym);
                if (!info) return true;
                if (AUTO_INTERFACES.has(name)) return true;
                return info.interfaces.some((i) => this.boundIncludes(i, inter));
            }
            case "fn":
                return name === "Copy";
            default:
                return true;
        }
    }

    /** Whether an interface type (as written) is `inter` or extends it. */
    boundIncludes(b: A.Type, inter: Sym, seen = new Set<Sym>()): boolean {
        if (b.kind === "TInter") return b.parts.some((p) => this.boundIncludes(p, inter, seen));
        if (b.kind !== "TName") return false;
        const s = this.w.refs.get(b);
        if (!s) return true;
        if (s === inter) return true;
        if (seen.has(s)) return false;
        seen.add(s);
        const info = this.w.infos.get(s);
        const d = info?.decl as A.InterDecl | undefined;
        if (!d || d.kind !== "InterDecl") return false;
        return d.supers.some((x) => this.boundIncludes(x, inter, seen)) || (d.alias !== null && this.boundIncludes(d.alias, inter, seen));
    }

    /** E_BOUND_NOT_SATISFIED: each bound of a generic, for its inferred argument. */
    checkBounds(own: Callable["own"], at: { span: A.Span }): void {
        for (const o of own) {
            const arg = T.prune(o.v);
            if (T.isOpen(arg)) continue;
            if (!o.uniqueOk && this.isUnique(arg)) {
                this.error("E_UNIQUE_TYPE_ARG", `\`${T.show(arg)}\` is Unique, and \`${o.sym.name}\` doesn't admit Unique types`, at, `${o.sym.name}: Unique`);
            }
            for (const b of o.bounds) {
                for (const part of b.kind === "TInter" ? b.parts : [b]) {
                    const s = part.kind === "TName" ? this.w.refs.get(part) : undefined;
                    if (!s || s.kind !== "inter" || s.name === "Unique") continue;
                    if (!this.implementsSym(arg, s)) {
                        this.error("E_BOUND_NOT_SATISFIED", `\`${T.show(arg)}\` doesn't implement \`${s.name}\`, which \`${o.sym.name}\` requires`, at);
                    }
                }
            }
        }
    }

    // ---- members ------------------------------------------------------------------------------

    /** The methods a type has: its own and its impls', then default methods of its interfaces. */
    methodsOf(t: Ty): { entries: MethodEntry[]; info: TypeInfo | null } {
        t = T.prune(t);
        if (t.k === "prim") return { entries: this.w.primMethods.get(t.name) ?? [], info: null };
        if (t.k === "lit") return this.methodsOf(T.prim(litBase(t) as T.PrimName));
        if (t.k === "union") return this.methodsOf(t.members[0] ?? T.UNKNOWN);
        if (t.k !== "named") return { entries: [], info: null };
        const info = this.w.infos.get(t.sym) ?? null;
        if (!info) return { entries: [], info: null };
        const entries = [...info.methods];
        for (const i of info.interfaces) {
            for (const [, m] of this.interMethodEntries(i)) entries.push(m);
        }
        return { entries, info };
    }

    /** Methods an interface type brings (with bodies or not), each with the interface instance. */
    interMethodEntries(i: A.Type, seen = new Set<Sym>()): Map<string, MethodEntry> {
        const out = new Map<string, MethodEntry>();
        for (const part of i.kind === "TInter" ? i.parts : [i]) {
            const s = part.kind === "TName" ? this.w.refs.get(part) : undefined;
            const info = s ? this.w.infos.get(s) : undefined;
            if (!s || !info || info.kind !== "inter" || seen.has(s)) continue;
            seen.add(s);
            const d = info.decl as A.InterDecl;
            for (const m of d.methods ?? []) if (!out.has(m.name)) out.set(m.name, { fn: m, outer: info.generics, implTarget: null, implGenerics: [], fromInter: part });
            for (const sup of [...d.supers, ...(d.alias ? [d.alias] : [])]) {
                for (const [k, v] of this.interMethodEntries(sup, seen)) if (!out.has(k)) out.set(k, v);
            }
        }
        return out;
    }

    /** A method of `recv` named `name`, ready to call; null if it has none (or unknown). */
    method(recv: Ty, name: string, at: { span: A.Span }): Callable | "unknown" | null {
        const r = T.prune(recv);
        if (r.k === "unknown" || r.k === "var" || r.k === "never") return "unknown";
        if (r.k === "param") return this.paramMethod(r, name, at);
        const { entries, info } = this.methodsOf(r);
        const candidates = entries.filter((e) => e.fn.name === name && e.fn.receiver !== null);
        for (const e of candidates) {
            const c = this.instantiateMethod(e, r, info, at);
            if (c) {
                if (info?.kind === "inter" && (e.fn.generics.length > 0 || (e.fn.ret?.kind === "TName" && e.fn.ret.path[0] === "Self"))) {
                    this.error("E_NOT_DYN_SAFE", `\`${name}\` can't be called on an interface value: it is generic or returns \`Self\``, at);
                }
                return c;
            }
        }
        if (AUTO_METHODS.has(name)) return this.autoMethod(r, name);
        if (name === "weak" && this.isIdentity(r)) {
            // `x.weak()` on an identity value (§12.4)
            return { params: [], ret: this.preludeNamed("Weak", [r]), async: false, own: [], target: { kind: "method", decl: null, auto: "weak", dyn: false }, env: new Map(), generic: false };
        }
        return null;
    }

    instantiateMethod(e: MethodEntry, recv: Ty, info: TypeInfo | null, at: { span: A.Span }): Callable | null {
        const env = new Map<Sym, Ty>();
        if (e.implTarget) {
            for (const g of e.outer) env.set(g, this.fresh());
            const target = T.subst(this.ty(e.implTarget), env);
            if (!this.equal(target, recv)) return null;
            for (const g of e.implGenerics) {
                const s = this.w.decls.get(g);
                const arg = s ? T.prune(env.get(s) ?? T.UNKNOWN) : T.UNKNOWN;
                for (const b of g.bounds) {
                    const bs = b.kind === "TName" ? this.w.refs.get(b) : undefined;
                    if (bs && bs.kind === "inter" && bs.name !== "Unique" && !this.implementsSym(arg, bs)) return null;
                }
            }
        } else if (e.fromInter) {
            // a default method of an interface: its generics are the arguments it is implemented with
            const it = this.ty(e.fromInter);
            const isym = e.fromInter.kind === "TName" ? this.w.refs.get(e.fromInter) : undefined;
            const iinfo = isym ? this.w.infos.get(isym) : undefined;
            if (it.k === "named" && iinfo) iinfo.generics.forEach((g, i) => env.set(g, it.args[i] ?? this.fresh()));
        } else if (info && recv.k === "named") {
            info.generics.forEach((g, i) => env.set(g, recv.args[i] ?? T.UNKNOWN));
        }
        void at;
        return this.callable(e.fn, recv, { kind: "method", decl: e.fn, auto: null, dyn: info?.kind === "inter" }, env);
    }

    paramMethod(p: Ty & { k: "param" }, name: string, at: { span: A.Span }): Callable | "unknown" | null {
        const decl = p.sym.decl as A.GenericParam | null;
        for (const b of decl?.bounds ?? []) {
            for (const [, e] of this.interMethodEntries(b)) {
                if (e.fn.name !== name || e.fn.receiver === null) continue;
                const it = this.ty(e.fromInter!);
                const env = new Map<Sym, Ty>();
                const s = e.fromInter!.kind === "TName" ? this.w.refs.get(e.fromInter!) : undefined;
                const info = s ? this.w.infos.get(s) : undefined;
                if (it.k === "named" && info) info.generics.forEach((g, i) => env.set(g, it.args[i] ?? this.fresh()));
                return this.callable(e.fn, p, { kind: "method", decl: e.fn, auto: null, dyn: false }, env);
            }
        }
        if (AUTO_METHODS.has(name)) return this.autoMethod(p, name);
        void at;
        return null;
    }

    autoMethod(recv: Ty, name: string): Callable {
        const target: CallTarget = { kind: "method", decl: null, auto: name, dyn: false };
        const base = { async: false, own: [], target, env: new Map(), generic: false };
        switch (name) {
            case "to_str": return { ...base, params: [], ret: T.STR };
            case "eq": case "same_fields": return { ...base, params: [{ name: "o", ty: recv, star: false, variadic: false }], ret: T.BOOL };
            case "hash": return { ...base, params: [], ret: T.U64 };
            default: return { ...base, params: [], ret: recv };
        }
    }

    /** A static member of a type: a static method or a variant. */
    staticMember(t: Ty, name: string, at: { span: A.Span }): { callable?: Callable; value?: Ty } | null {
        const p = T.prune(t);
        if (p.k === "param") {
            for (const b of (p.sym.decl as A.GenericParam | null)?.bounds ?? []) {
                const e = this.interMethodEntries(b).get(name);
                if (e && e.fn.receiver === null) return { callable: this.callable(e.fn, p, { kind: "static", decl: e.fn }) };
            }
            return null;
        }
        if (p.k !== "named") return p.k === "prim" ? this.primStatic(p, name) : { value: T.UNKNOWN };
        const info = this.w.infos.get(p.sym);
        if (!info) return { value: T.UNKNOWN };
        const variant = info.variants.get(name);
        if (variant) {
            const ctor = this.constructorOf(info, variant, at);
            const ret = ctor.k === "fn" ? ctor.ret : ctor;
            this.equal(ret, p);
            return { value: ctor };
        }
        for (const e of this.methodsOf(p).entries) {
            if (e.fn.name !== name || e.fn.receiver !== null) continue;
            return { callable: this.callable(e.fn, p, { kind: "static", decl: e.fn }, this.typeEnv(info, p.args)) };
        }
        if (name === "default") return { callable: { params: [], ret: p, async: false, own: [], target: { kind: "unknown" }, env: new Map(), generic: false } };
        return null;
    }

    primStatic(p: Ty, name: string): { callable?: Callable; value?: Ty } | null {
        const e = (this.w.primMethods.get((p as { name: string }).name) ?? []).find((m) => m.fn.name === name && m.fn.receiver === null);
        if (e) return { callable: this.callable(e.fn, p, { kind: "static", decl: e.fn }) };
        return { value: T.UNKNOWN };
    }

    /** `x.name` on a value: a field, a tuple index, or a method used as a value. */
    field(recv: Ty, name: string, at: A.Member): Ty {
        const r = T.prune(recv);
        if (r.k === "unknown" || r.k === "var" || r.k === "never") return T.UNKNOWN;
        if (r.k === "tuple") {
            const i = Number(name);
            if (Number.isInteger(i) && i < r.elems.length) {
                this.out.members.set(at, { kind: "tuple", index: i });
                return r.elems[i]!;
            }
        }
        if (r.k === "record") {
            const f = r.fields.find((x) => x.name === name);
            if (f) {
                this.out.members.set(at, { kind: "field" });
                return f.ty;
            }
        }
        if (r.k === "named") {
            const info = this.w.infos.get(r.sym);
            if (!info) return T.UNKNOWN;
            const f = info.fields.get(name);
            if (f) {
                this.out.members.set(at, { kind: "field" });
                return this.fieldType(f, this.typeEnv(info, r.args));
            }
        }
        const m = this.method(r, name, at);
        if (m === "unknown") return T.UNKNOWN;
        if (m) {
            this.out.members.set(at, { kind: "method", decl: m.target.kind === "method" ? m.target.decl : null });
            return { k: "fn", params: m.params.map((p) => ({ ty: p.ty, star: p.star })), ret: this.asyncRet(m), async: m.async };
        }
        this.error("E_UNKNOWN_FIELD", `\`${T.show(r)}\` has no field or method \`${name}\``, at);
        return T.UNKNOWN;
    }

    // ---- items --------------------------------------------------------------------------------

    /** Checks that need only declarations: interfaces implemented, `once`, attributes, tests (§18.3). */
    declChecks(item: A.Item, f: ResolveFile): void {
        for (const a of item.attrs) this.attributeCheck(a);
        if (item.kind === "Fn" && f.path.endsWith("_test.ms") && item.name.startsWith("test_")) {
            if (item.params.length > 0 || item.receiver || item.generics.length > 0 || (item.ret && !(item.ret.kind === "TName" && item.ret.path[0] === "void"))) {
                this.error("E_TEST_SIGNATURE", `a test takes no parameters, returns nothing and isn't generic`, item);
            }
        }
        if (item.kind === "TypeDecl" || item.kind === "UnionDecl") {
            for (const m of item.members ?? []) {
                if (m.kind === "Fn") for (const a of m.attrs) this.attributeCheck(a);
                if (m.kind === "Field" && m.mode === "once") {
                    const sym = this.w.decls.get(item);
                    if (sym && !this.isIdentity({ k: "named", sym, args: [] })) {
                        this.error("E_ONCE_OUTSIDE_IDENTITY", `\`once\` fields are allowed only on identity types`, m, `type ${item.name}: Identity`);
                    }
                }
            }
            const sym = this.w.decls.get(item);
            const info = sym ? this.w.infos.get(sym) : undefined;
            if (info) this.interfaceChecks(info, item.impls, item);
        }
        if (item.kind === "ImplDecl") {
            for (const m of item.methods) for (const a of m.attrs) this.attributeCheck(a);
            const target = item.target.kind === "TName" ? this.w.refs.get(item.target) : undefined;
            const info = target ? this.w.infos.get(target) : undefined;
            if (info && item.inters.length > 0) this.interfaceChecks(info, item.inters, item);
        }
    }

    attributeCheck(a: A.Attribute): void {
        if (a.name !== "effects") this.error("E_UNKNOWN_ATTRIBUTE", `unknown attribute \`#[${a.name}]\``, a);
        else if (!this.std) this.error("E_ATTRIBUTE_NOT_ALLOWED", "`#[effects]` may only be used in std", a);
    }

    /** E_UNIQUE_IMPL and E_MISSING_METHOD for the interfaces a declaration says a type implements. */
    interfaceChecks(info: TypeInfo, inters: A.Type[], at: { span: A.Span }): void {
        const have = new Set(info.methods.map((m) => m.fn.name));
        for (const i of inters) {
            const s = i.kind === "TName" ? this.w.refs.get(i) : undefined;
            if (s === this.w.prelude.get("Unique") && !this.std) {
                this.error("E_UNIQUE_IMPL", "only std and `extern` code may implement `Unique`", at);
            }
            for (const [name, e] of this.interMethodEntries(i)) {
                if (e.fn.body || have.has(name) || AUTO_METHODS.has(name) || name === "default") continue;
                this.error("E_MISSING_METHOD", `\`${info.sym.name}\` implements \`${T.show(this.ty(i))}\` but has no method \`${name}\``, at);
            }
        }
    }

    item(item: A.Item): void {
        switch (item.kind) {
            case "Fn":
                return this.fnBody(item, null);
            case "TypeDecl": case "UnionDecl": {
                const sym = this.w.decls.get(item);
                const info = sym ? this.w.infos.get(sym) : undefined;
                if (!info) return;
                this.selfStack.push(this.selfType(info));
                if (item.kind === "TypeDecl") {
                    if (item.alias) this.ty(item.alias, true);
                    for (const m of item.members ?? []) {
                        if (m.kind === "Field") this.fieldDecl(m);
                        else this.fnBody(m, this.selfType(info));
                    }
                } else {
                    for (const m of item.members) {
                        if (m.kind === "Variant") {
                            for (const t of m.tuple ?? []) this.out.declTypes.set(t, this.ty(t, true));
                            for (const f of m.fields ?? []) this.fieldDecl(f);
                        } else {
                            this.fnBody(m, this.selfType(info));
                        }
                    }
                }
                this.selfStack.pop();
                return;
            }
            case "InterDecl": {
                const sym = this.w.decls.get(item);
                const info = sym ? this.w.infos.get(sym) : undefined;
                const self: Ty = info ? this.selfType(info) : T.UNKNOWN;
                this.selfStack.push(self);
                for (const m of item.methods ?? []) this.fnBody(m, self);
                this.selfStack.pop();
                return;
            }
            case "ImplDecl": {
                const target = this.ty(item.target, true);
                this.selfStack.push(target);
                for (const m of item.methods) this.fnBody(m, target);
                this.selfStack.pop();
                return;
            }
            case "LetDecl": case "VarDecl": {
                const sym = this.w.decls.get(item);
                const declared = item.type ? this.ty(item.type, true) : undefined;
                this.withFn({ ret: T.UNKNOWN, async: false, selfTy: null, loops: [] }, () => {
                    const t = declared ? this.expect(item.value, declared) : this.check(item.value);
                    if (sym && !this.w.symTypes.has(sym)) this.w.symTypes.set(sym, declared ?? t);
                });
                if (sym && !declared) this.w.symTypes.set(sym, T.zonk(this.w.symTypes.get(sym) ?? T.UNKNOWN));
                return;
            }
            case "ExternDecl":
                for (const f of item.fns) this.fnBody(f, null);
                return;
        }
    }

    fieldDecl(f: A.Field): void {
        const t = this.ty(f.type, true);
        this.out.declTypes.set(f.type, t);
        if (f.default) this.withFn({ ret: T.UNKNOWN, async: false, selfTy: null, loops: [] }, () => this.expect(f.default!, t));
    }

    withFn(ctx: FnCtx, f: () => void): void {
        const saved = this.ctx;
        const sites = this.inferSites;
        this.ctx = ctx;
        this.inferSites = [];
        try {
            f();
        } finally {
            this.reportInference();
            this.ctx = saved;
            this.inferSites = sites;
        }
    }

    /** At the end of a function: types that are still unknown (§13.5). */
    reportInference(): void {
        for (const site of this.inferSites) {
            const t = T.prune(site.v);
            if (t.k === "var" && t.lit === null) {
                const fix = site.code === "E_CANNOT_INFER_GENERIC" ? "add `.[T]`" : "annotate it, or use `as T`";
                this.error(site.code, `can't infer the type of ${site.what}`, site.at, fix);
                this.bind(t, T.UNKNOWN);
            }
        }
    }

    fnBody(fn: A.FnDecl, self: Ty | null): void {
        if (self) this.selfStack.push(self);
        const s = this.sig(fn, self);
        this.out.rets.set(fn, s.ret);
        const thisSym = this.w.thisOf.get(fn);
        if (thisSym && self) this.w.symTypes.set(thisSym, self);
        if (!fn.body) {
            fn.params.forEach((p, i) => {
                const sym = this.w.decls.get(p);
                if (sym) this.w.symTypes.set(sym, s.params[i]!.ty);
            });
            if (self) this.selfStack.pop();
            return;
        }
        for (const p of fn.params) this.ty(p.type, true);
        if (fn.ret) this.ty(fn.ret, true);
        const isMain = fn.name === "main" && this.res.pkg === "main" && self === null;
        this.withFn({ ret: s.ret, async: fn.isAsync || isMain, selfTy: self, loops: [] }, () => {
            fn.params.forEach((p, i) => {
                const sym = this.w.decls.get(p);
                if (sym) this.w.symTypes.set(sym, s.params[i]!.ty);
            });
            this.body(fn.body!, s.ret, fn);
        });
        if (self) this.selfStack.pop();
    }

    /** A function or closure body against its declared result. */
    body(b: A.Block, ret: Ty, at: { span: A.Span }): Ty {
        const voidRet = T.prune(ret).k === "prim" && (T.prune(ret) as { name: string }).name === "void";
        const last = b.stmts[b.stmts.length - 1];
        const t = this.stmts(b.stmts, voidRet ? undefined : ret, voidRet);
        if (voidRet || T.prune(t).k === "never") return t;
        if (last?.kind === "ExprStmt" && last.semi && T.prune(t).k !== "never") {
            this.error("E_INVALID_BLOCK_VALUE", "the `;` discards the value this function returns", last, "remove the `;`");
            return t;
        }
        if (!this.assignable(t, ret)) {
            const at2 = last?.kind === "ExprStmt" ? last.expr : last ?? at;
            if (T.prune(t).k === "prim" && (T.prune(t) as { name: string }).name === "void") {
                this.error("E_INVALID_BLOCK_VALUE", `this body ends without a value, but returns \`${T.show(ret)}\``, at2);
            } else {
                this.mismatch(t, ret, at2);
            }
        }
        return t;
    }

    mismatch(actual: Ty, expected: Ty, at: { span: A.Span }): void {
        this.error("E_TYPE_MISMATCH", `expected \`${T.show(expected)}\`, found \`${T.show(actual)}\``, at);
    }

    // ---- statements ---------------------------------------------------------------------------

    /** A statement list; the value is its last expression (no `;`), `never` if a statement diverges. */
    stmts(list: A.Stmt[], expected: Ty | undefined, discard: boolean): Ty {
        let result: Ty = T.VOID;
        let diverges = false;
        list.forEach((s, i) => {
            const last = i === list.length - 1;
            if (s.kind === "ExprStmt") {
                const isValue = last && !s.semi && !discard;
                const t = isValue ? this.check(s.expr, expected) : this.check(s.expr, undefined, true);
                if (T.prune(t).k === "never") diverges = true;
                if (isValue) result = t;
                return;
            }
            this.stmt(s);
        });
        return diverges ? T.NEVER : result;
    }

    stmt(s: A.Stmt): void {
        switch (s.kind) {
            case "LetStmt": {
                const declared = s.type ? this.ty(s.type, true) : undefined;
                const t = declared ? this.expect(s.value, declared) : this.check(s.value);
                if (s.else) {
                    const e = this.block(s.else, undefined);
                    if (!T.isOpen(e)) this.error("E_LET_ELSE_MUST_DIVERGE", "the `else` of `let … else` must not finish: end it with `return`, `break`, `continue` or a panic", s.else);
                }
                this.pattern(s.pattern, declared ?? t);
                return;
            }
            case "VarStmt": {
                const declared = s.type ? this.ty(s.type, true) : undefined;
                const t = declared ? this.expect(s.value, declared) : this.check(s.value);
                const sym = this.w.decls.get(s);
                if (sym) this.w.symTypes.set(sym, declared ?? widenLit(t));
                return;
            }
            case "ShortDecl": {
                const t = this.check(s.value);
                const sym = this.w.decls.get(s);
                if (sym) this.w.symTypes.set(sym, widenLit(t));
                return;
            }
            case "ExprStmt":
                this.check(s.expr, undefined, true);
                return;
        }
    }

    block(b: A.Block, expected: Ty | undefined, discard = false): Ty {
        const t = this.stmts(b.stmts, expected, discard);
        this.out.types.set(b, t);
        return t;
    }

    // ---- expressions --------------------------------------------------------------------------

    /** Checks `e` against `expected` and reports a mismatch. Returns the type the value has there. */
    expect(e: A.Expr, expected: Ty): Ty {
        const t = this.check(e, expected);
        if (!this.assignable(t, expected)) {
            const p = T.prune(t);
            if (e.kind === "Binary" && e.op === "||" && !T.isOpen(expected) && !(T.prune(expected).k === "prim" && (T.prune(expected) as { name: string }).name === "bool")) {
                this.error("E_USE_NULLISH", "`||` gives a `bool`: use `??` for a fallback value", e, "??");
            } else if (p.k === "prim" && p.name === "void" && e.kind === "Block") {
                this.error("E_INVALID_BLOCK_VALUE", `this block has no value, but \`${T.show(expected)}\` is expected`, e);
            } else {
                this.mismatch(t, expected, e);
            }
            return expected;
        }
        return T.prune(t).k === "never" ? t : expected;
    }

    check(e: A.Expr, expected?: Ty, discard = false): Ty {
        const t = this.expr(e, expected, discard);
        this.out.types.set(e, t);
        return t;
    }

    expr(e: A.Expr, expected: Ty | undefined, discard: boolean): Ty {
        switch (e.kind) {
            case "Ident":
                return this.ident(e, expected, false);
            case "This":
                return this.ctx.selfTy ?? T.UNKNOWN;
            case "SelfExpr":
                return { k: "meta", ty: this.selfStack[this.selfStack.length - 1] ?? T.UNKNOWN };
            case "Int":
                return this.intLit(e.value, e, expected);
            case "Float": {
                const exp = expected ? T.prune(expected) : undefined;
                return exp && T.isFloat(exp) ? exp : this.fresh("float");
            }
            case "Str": {
                const exp = expected ? T.prune(expected) : undefined;
                if (exp && (exp.k === "union" || exp.k === "lit")) return { k: "lit", value: e.value };
                return T.STR;
            }
            case "Template":
                for (const x of e.exprs) this.check(x);
                return T.STR;
            case "Char":
                return T.CHAR;
            case "Byte":
                return T.U8;
            case "Bool": {
                const exp = expected ? T.prune(expected) : undefined;
                return exp && (exp.k === "union" || exp.k === "lit") ? { k: "lit", value: e.value } : T.BOOL;
            }
            case "Nil": {
                const exp = expected ? T.prune(expected) : undefined;
                if (exp && this.isOptional(exp)) return exp;
                if (exp?.k === "unknown") return this.option(T.UNKNOWN);
                return this.option(this.freshAt(e, "`nil`"));
            }
            case "Vec": case "Array": case "Set":
                return this.collection(e, expected);
            case "Tuple":
                return this.tuple(e, expected);
            case "Map":
                return this.mapLit(e, expected);
            case "Record":
                return this.recordLit(e.items, e, expected);
            case "Inferred":
                return this.inferredLit(e, expected);
            case "Struct":
                return this.structLit(e, expected);
            case "Closure":
                return this.closure(e, expected);
            case "Paren":
                return this.check(e.expr, expected, discard);
            case "Unary":
                return this.unary(e, expected);
            case "Await":
                return this.awaitExpr(e, expected);
            case "Binary":
                return this.binary(e, expected);
            case "Assign":
                return this.assign(e);
            case "Range":
                return this.range(e);
            case "As":
                return this.asExpr(e);
            case "Or":
                return this.orExpr(e, expected);
            case "Call":
                return this.call(e, expected);
            case "Index":
                return this.index(e);
            case "Member":
                return this.member(e, expected);
            case "GenericApply": {
                const t = this.check(e.target);
                const args = e.args.map((a) => this.ty(a, true));
                const p = T.prune(t);
                if (p.k === "meta" && T.prune(p.ty).k === "named") {
                    const n = T.prune(p.ty) as Ty & { k: "named" };
                    n.args.forEach((a, i) => args[i] && this.equal(a, args[i]!));
                    return p;
                }
                return T.UNKNOWN;
            }
            case "Try":
                return this.tryExpr(e);
            case "If":
                return this.ifExpr(e, expected, discard);
            case "Match":
                return this.match(e, expected, discard);
            case "Select":
                return this.select(e, expected, discard);
            case "Lock":
                for (const p of e.places) {
                    this.check(p);
                    if (!this.isSharedPlace(p)) this.error("E_LOCK_NOT_SHARED", "`lock` takes a `shared` binding or field (§10.1)", p);
                }
                return this.block(e.body, expected, discard);
            case "For":
                return this.forExpr(e);
            case "Block":
                return this.block(e, expected, discard);
            case "Unsafe":
                return this.block(e.body, expected, discard);
            case "Recover": {
                const inner = expected && this.isNamed(expected, "Result") ? (T.prune(expected) as { args: Ty[] }).args[0] : undefined;
                const t = this.block(e.body, inner, false);
                return this.preludeNamed("Result", [T.prune(t).k === "never" ? this.fresh() : t, this.preludeNamed("Panic", [])]);
            }
            case "Return":
                if (e.value) {
                    if (T.prune(this.ctx.ret).k === "prim" && (T.prune(this.ctx.ret) as { name: string }).name === "void") {
                        const t = this.check(e.value);
                        if (!T.isOpen(t) && !(T.prune(t).k === "prim" && (T.prune(t) as { name: string }).name === "void")) this.mismatch(t, T.VOID, e.value);
                    } else {
                        this.expect(e.value, this.ctx.ret);
                    }
                } else if (!this.assignable(T.VOID, this.ctx.ret)) {
                    this.error("E_TYPE_MISMATCH", `\`return\` needs a value of type \`${T.show(this.ctx.ret)}\``, e);
                }
                return T.NEVER;
            case "Break": {
                if (this.ctx.loops.length === 0) this.error("E_BREAK_OUTSIDE_LOOP", "`break` is only allowed inside a loop", e);
                const loop = this.loopFor(e.label);
                if (loop) {
                    loop.broke = true;
                    if (e.value) {
                        if (loop.breakTy) this.expect(e.value, loop.breakTy);
                        else {
                            this.check(e.value);
                            this.error("E_BREAK_VALUE", "only an infinite `for { … }` loop has a value; `break` here takes none", e.value);
                        }
                    }
                }
                return T.NEVER;
            }
            case "Continue":
                if (this.ctx.loops.length === 0) this.error("E_BREAK_OUTSIDE_LOOP", "`continue` is only allowed inside a loop", e);
                return T.NEVER;
            case "Error":
                return T.UNKNOWN;
        }
    }

    loopFor(label: string | null): Loop | undefined {
        const loops = this.ctx.loops;
        if (label === null) return loops[loops.length - 1];
        for (let i = loops.length - 1; i >= 0; i--) if (loops[i]!.label === label) return loops[i];
        return undefined;
    }

    ident(e: A.Ident, expected: Ty | undefined, asCallee: boolean): Ty {
        const s = this.w.refs.get(e);
        // a variant of the expected union comes before ordinary name resolution (§7.7)
        const preferred = this.expectedVariant(e.name, e, expected, s);
        if (preferred) return preferred;
        if (!s) {
            if (this.w.deferred.has(e) && isUpperName(e.name)) {
                return this.inferVariant(e.name, e, expected, asCallee) ?? T.UNKNOWN;
            }
            return T.UNKNOWN;
        }
        if (s.kind === "variant") {
            const v = this.variantOf(s);
            if (v) {
                const ctor = this.constructorOf(v.info, v.variant, e);
                const ret = ctor.k === "fn" ? ctor.ret : ctor;
                if (expected) this.assignable(ret, expected);
                return ctor;
            }
        }
        return this.symType(s, e, expected);
    }

    intLit(value: bigint, at: { span: A.Span }, expected: Ty | undefined): Ty {
        const exp = expected ? T.prune(expected) : undefined;
        if (exp && T.isInt(exp)) {
            const range = T.INT_RANGE[(exp as { name: string }).name];
            if (range && (value < range[0] || value > range[1])) {
                this.error("E_INT_OUT_OF_RANGE", `${value} doesn't fit in \`${T.show(exp)}\``, at);
            }
            return exp;
        }
        if (exp && T.isFloat(exp)) return exp;
        if (exp && (exp.k === "union" || exp.k === "lit")) return { k: "lit", value };
        return this.fresh("int");
    }

    collection(e: A.VecLit | A.ArrayLit | A.SetLit, expected: Ty | undefined): Ty {
        const name = e.kind === "Vec" ? "Vec" : e.kind === "Array" ? "Array" : "Set";
        const exp = expected ? T.prune(expected) : undefined;
        if (exp?.k === "unknown") {
            for (const el of e.elems) this.check(el.value, T.UNKNOWN);
            return T.UNKNOWN;
        }
        let elem: Ty | undefined = exp && this.isNamed(exp, name) ? nargs(exp)[0] : exp && name === "Vec" && this.isNamed(exp, "Slice") ? nargs(exp)[0] : undefined;
        for (const el of e.elems) {
            if (el.spread) {
                const t = this.check(el.value);
                const p = T.prune(t);
                if (p.k === "named" && p.args[0]) elem ? this.equal(p.args[0], elem) : (elem = p.args[0]);
                continue;
            }
            if (elem) this.expect(el.value, elem);
            else elem = widenLit(this.check(el.value));
        }
        elem ??= this.freshAt(e, `this empty ${name === "Vec" ? "`[]`" : "literal"}`);
        if (name === "Array") return this.preludeNamed("Array", [elem, { k: "lit", value: BigInt(e.elems.length) }]);
        return this.preludeNamed(name, [elem]);
    }

    tuple(e: A.TupleLit, expected: Ty | undefined): Ty {
        if (e.elems.length === 0) return T.VOID;
        const exp = expected ? T.prune(expected) : undefined;
        const elems = e.elems.map((el, i) => {
            const want = exp?.k === "tuple" ? exp.elems[i] : undefined;
            return want ? this.expect(el.value, want) : widenLit(this.check(el.value));
        });
        return { k: "tuple", elems };
    }

    mapLit(e: A.MapLit, expected: Ty | undefined): Ty {
        const exp = expected ? T.prune(expected) : undefined;
        if (exp?.k === "unknown") {
            for (const en of e.entries) {
                if (en.kind === "Entry") this.check(en.key, T.UNKNOWN);
                this.check(en.value, T.UNKNOWN);
            }
            return T.UNKNOWN;
        }
        let key: Ty | undefined = exp && (this.isNamed(exp, "Map") || this.isNamed(exp, "PMap")) ? nargs(exp)[0] : undefined;
        let val: Ty | undefined = exp && (this.isNamed(exp, "Map") || this.isNamed(exp, "PMap")) ? nargs(exp)[1] : undefined;
        for (const en of e.entries) {
            if (en.kind === "Spread") {
                this.check(en.value);
                continue;
            }
            if (key) this.expect(en.key, key);
            else key = widenLit(this.check(en.key));
            if (val) this.expect(en.value, val);
            else val = widenLit(this.check(en.value));
        }
        key ??= this.freshAt(e, "this empty `m{}`");
        val ??= this.fresh();
        return this.preludeNamed("Map", [key, val]);
    }

    recordLit(items: A.RecItem[], at: { span: A.Span }, expected: Ty | undefined): Ty {
        const exp = expected ? T.prune(expected) : undefined;
        const fields: T.RecordField[] = [];
        for (const it of items) {
            if (it.kind === "Spread") {
                const t = T.prune(this.check(it.value));
                if (t.k === "record") for (const f of t.fields) if (!fields.some((x) => x.name === f.name)) fields.push(f);
                if (t.k === "named") {
                    const info = this.w.infos.get(t.sym);
                    for (const [n, f] of info?.fields ?? []) if (!fields.some((x) => x.name === n)) fields.push({ name: n, ty: this.fieldType(f, this.typeEnv(info!, t.args)), optional: false });
                }
                continue;
            }
            const want = exp?.k === "record" ? exp.fields.find((f) => f.name === it.name)?.ty : undefined;
            const t = this.recItemValue(it, want);
            const i = fields.findIndex((f) => f.name === it.name);
            if (i >= 0) fields.splice(i, 1);
            fields.push({ name: it.name, ty: widenLit(t), optional: false });
        }
        void at;
        return record(fields);
    }

    recItemValue(it: A.RecItem & { kind: "Field" }, want: Ty | undefined): Ty {
        if (it.value) return want ? this.expect(it.value, want) : this.check(it.value);
        const s = this.w.refs.get(it);
        const t = s ? this.symType(s, it) : T.UNKNOWN;
        if (want && !this.assignable(t, want)) this.mismatch(t, want, it);
        return want ?? t;
    }

    inferredLit(e: A.InferredLit, expected: Ty | undefined): Ty {
        const exp = expected ? T.prune(expected) : undefined;
        if (exp === undefined) {
            this.error("E_CANNOT_INFER_STRUCT_TYPE", "`_{…}` needs an expected type", e, "write the type name");
            for (const it of e.items) if (it.kind === "Spread" || it.value) this.check(it.value!);
            return T.UNKNOWN;
        }
        if (exp.k === "named") {
            const info = this.w.infos.get(exp.sym);
            if (info?.kind === "struct") return this.structFields(info, exp.args, e.items, e, exp);
        }
        if (exp.k === "record") return this.recordLit(e.items, e, exp);
        for (const it of e.items) if (it.kind === "Spread" || it.value) this.check(it.value!);
        return T.UNKNOWN;
    }

    structLit(e: A.StructLit, expected: Ty | undefined): Ty {
        // the type: a struct, or a struct-like variant (`Card { … }`, `Payment.Card { … }`)
        let typeExpr = e.type;
        let explicit: Ty[] = [];
        if (typeExpr.kind === "GenericApply") {
            explicit = typeExpr.args.map((a) => this.ty(a, true));
            typeExpr = typeExpr.target;
        }
        let variant: { info: TypeInfo; variant: A.Variant } | null = null;
        let info: TypeInfo | undefined;
        if (typeExpr.kind === "Ident") {
            const s = this.w.refs.get(typeExpr);
            // a variant of the expected union comes before ordinary name resolution (§7.7):
            // `Range { … }` with an `ExprKind` expected is the variant, not prelude's Range
            const exp = expected ? T.prune(expected) : undefined;
            const expInfo = exp?.k === "named" ? this.w.infos.get(exp.sym) : undefined;
            const expVariant = expInfo?.kind === "union" ? expInfo.variants.get(typeExpr.name) : undefined;
            if (s?.kind !== "variant" && expInfo && expVariant?.fields) variant = { info: expInfo, variant: expVariant };
            else if (s?.kind === "variant") variant = this.variantOf(s);
            else if (s && (s.kind === "type" || s.kind === "union")) info = this.w.infos.get(s);
            else if (!s && this.w.deferred.has(typeExpr)) {
                const exp = expected ? T.prune(expected) : undefined;
                const uinfo = exp?.k === "named" ? this.w.infos.get(exp.sym) : undefined;
                const v = uinfo?.variants.get(typeExpr.name);
                if (uinfo && v) variant = { info: uinfo, variant: v };
                else {
                    this.inferVariant(typeExpr.name, typeExpr, expected, false);
                    this.items(e.items);
                    return T.UNKNOWN;
                }
            }
        } else if (typeExpr.kind === "Member") {
            const target = T.prune(this.check(typeExpr.target));
            const s = this.w.refs.get(typeExpr);
            if (s && (s.kind === "type" || s.kind === "union")) info = this.w.infos.get(s);
            else if (target.k === "meta" && T.prune(target.ty).k === "named") {
                const u = this.w.infos.get((T.prune(target.ty) as { sym: Sym }).sym);
                const v = u?.variants.get(typeExpr.name);
                if (u && v) variant = { info: u, variant: v };
            }
        }
        if (variant) {
            const args = variant.info.generics.map(() => this.fresh() as Ty);
            const union: Ty = { k: "named", sym: variant.info.sym, args };
            if (expected) this.assignable(union, expected);
            this.out.variants.set(e, { union: variant.info.sym, variant: variant.variant.name });
            const fields = new Map((variant.variant.fields ?? []).map((f) => [f.name, f] as const));
            this.fieldItems(fields, this.typeEnv(variant.info, args), e.items, e, `variant \`${variant.variant.name}\``);
            return union;
        }
        if (info?.kind === "struct") {
            const args = info.generics.map((_, i) => explicit[i] ?? (this.fresh() as Ty));
            return this.structFields(info, args, e.items, e, expected);
        }
        this.items(e.items);
        return T.UNKNOWN;
    }

    items(items: A.RecItem[]): void {
        for (const it of items) {
            if (it.kind === "Spread") this.check(it.value);
            else if (it.value) this.check(it.value);
        }
    }

    structFields(info: TypeInfo, args: Ty[], items: A.RecItem[], at: { span: A.Span }, expected: Ty | undefined): Ty {
        const t: Ty = { k: "named", sym: info.sym, args };
        if (expected) this.assignable(t, expected);
        this.fieldItems(info.fields, this.typeEnv(info, args), items, at, `\`${info.sym.name}\``);
        return t;
    }

    fieldItems(fields: Map<string, A.Field>, env: Map<Sym, Ty>, items: A.RecItem[], at: { span: A.Span }, what: string): void {
        const given = new Set<string>();
        let spread = false;
        for (const it of items) {
            if (it.kind === "Spread") {
                spread = true;
                this.check(it.value);
                continue;
            }
            given.add(it.name);
            const f = fields.get(it.name);
            if (!f) {
                this.error("E_UNKNOWN_FIELD", `${what} has no field \`${it.name}\``, it);
                if (it.value) this.check(it.value);
                continue;
            }
            const want = T.subst(this.ty(f.type), env);
            this.recItemValue(it, want);
        }
        if (spread) return;
        for (const [name, f] of fields) {
            if (given.has(name) || f.default || f.mode === "once" || this.isOptional(this.ty(f.type))) continue;
            this.error("E_MISSING_FIELD", `${what} needs field \`${name}\``, at);
        }
    }

    closure(c: A.Closure, expected: Ty | undefined): Ty {
        const exp = expected ? T.prune(expected) : undefined;
        const expFn = exp?.k === "fn" ? exp : undefined;
        const params: FnParam[] = [];
        if (c.params) {
            c.params.forEach((p, i) => {
                const want = expFn?.params[i];
                const ty = p.type ? this.ty(p.type, true) : want?.ty ?? this.fresh();
                if (p.type && want) this.equal(ty, want.ty);
                const sym = this.w.decls.get(p);
                if (sym) this.w.symTypes.set(sym, ty);
                params.push({ ty, star: p.star || (want?.star ?? false) });
            });
        } else {
            // `it`, `it2`…: as many parameters as the highest one used, at least what is expected
            const implicit = this.w.implicit.get(c) ?? new Map<string, Sym>();
            let n = 0;
            for (const name of implicit.keys()) n = Math.max(n, name === "it" ? 1 : Number(name.slice(2)));
            for (let i = 0; i < n; i++) {
                const want = expFn?.params[i];
                params.push({ ty: want?.ty ?? this.fresh(), star: want?.star ?? false });
            }
            for (const [name, sym] of implicit) this.w.symTypes.set(sym, params[name === "it" ? 0 : Number(name.slice(2)) - 1]!.ty);
            // a closure may take fewer parameters than its type supplies (§4.4)
            if (expFn) for (let i = n; i < expFn.params.length; i++) params.push(expFn.params[i]!);
        }
        if (expFn && c.params) for (let i = c.params.length; i < expFn.params.length; i++) params.push(expFn.params[i]!);
        const ret = c.ret ? this.ty(c.ret, true) : expFn?.ret ?? this.fresh();
        const saved = this.ctx;
        this.ctx = { ret, async: saved.async, selfTy: saved.selfTy, loops: [] };
        const block: A.Block = { kind: "Block", span: c.span, stmts: c.body };
        this.body(block, ret, c);
        this.ctx = saved;
        return { k: "fn", params, ret, async: false };
    }

    unary(e: A.Unary, expected: Ty | undefined): Ty {
        if (e.op === "-" && e.operand.kind === "Int") return this.intLit(-e.operand.value, e, expected);
        const t = this.check(e.operand, e.op === "-" ? expected : undefined);
        const p = T.prune(t);
        if (e.op === "-") {
            if (T.isOpen(p) || T.isNumeric(p) || p.k === "var") return t;
            if (p.k === "named" && this.method(p, "negate", e)) return t;
            this.error("E_INVALID_OPERANDS", `\`-\` needs a number, not \`${T.show(p)}\``, e);
            return T.UNKNOWN;
        }
        if (T.isInt(p) || (p.k === "var" && p.lit === "int")) return t; // bitwise not
        this.truthy(t, e.operand);
        return T.BOOL;
    }

    /** Conditions and `&&` / `||` / `!` operands: bool, Option or Result (§4.7). */
    truthy(t: Ty, at: { span: A.Span }): void {
        const p = T.prune(t);
        if (T.isOpen(p) || p.k === "var") return;
        if (p.k === "prim" && p.name === "bool") return;
        if (p.k === "lit" && typeof p.value === "boolean") return;
        if (this.isNamed(p, "Option") || this.isNamed(p, "Result")) return;
        this.error("E_NOT_TRUTHY", `a condition must be \`bool\`, an Option or a Result, not \`${T.show(p)}\``, at);
    }

    awaitExpr(e: A.Await, expected: Ty | undefined): Ty {
        if (!this.ctx.async) this.error("E_AWAIT_OUTSIDE_ASYNC", "`await` is only allowed in an `async fn` or in `main`", e);
        const t = this.check(e.operand, expected ? this.preludeNamed("Promise", [expected]) : undefined);
        const p = T.prune(t);
        if (this.isNamed(p, "Promise")) return nargs(p)[0] ?? T.UNKNOWN;
        return T.isOpen(p) ? T.UNKNOWN : p;
    }

    binary(e: A.Binary, expected: Ty | undefined): Ty {
        const op = e.op;
        if (op === "&&" || op === "||") {
            this.truthy(this.check(e.left), e.left);
            this.truthy(this.check(e.right), e.right);
            return T.BOOL;
        }
        if (op === "??") {
            const l = T.prune(this.check(e.left, expected ? this.option(expected) : undefined));
            const inner = this.isNamed(l, "Option") || this.isNamed(l, "Result") ? nargs(l)[0]! : undefined;
            if (!inner) {
                if (!T.isOpen(l)) this.error("E_INVALID_OPERANDS", `\`??\` needs an Option or a Result on its left, not \`${T.show(l)}\``, e.left);
                this.check(e.right, expected);
                return T.UNKNOWN;
            }
            const r = this.check(e.right, inner);
            if (this.assignable(r, inner)) return inner;
            const opt = this.option(inner);
            if (this.assignable(r, opt)) return opt;
            this.mismatch(r, inner, e.right);
            return inner;
        }
        const l = this.check(e.left, isArith(op) ? expected : undefined);
        if (op === "==" || op === "!=") {
            const r = this.check(e.right, l);
            if (!this.assignable(r, l) && !this.assignable(l, r)) {
                this.error("E_INVALID_OPERANDS", `\`${T.show(l)}\` and \`${T.show(r)}\` can't be compared`, e);
            }
            return T.BOOL;
        }
        const r = this.check(e.right, l);
        const pl = T.prune(l);
        const pr = T.prune(r);
        if (op === "<" || op === "<=" || op === ">" || op === ">=") {
            if (T.isOpen(pl) || T.isOpen(pr)) return T.BOOL;
            if (this.numberPair(pl, pr) || (this.comparable(pl) && (this.equal(pl, pr) || this.assignable(pr, pl) || this.assignable(pl, pr)))) return T.BOOL;
            this.error("E_INVALID_OPERANDS", `\`${T.show(pl)}\` and \`${T.show(pr)}\` can't be ordered with \`${op}\``, e);
            return T.BOOL;
        }
        if (T.isOpen(pl) && !(pl.k === "var" && pl.lit)) return T.prune(pl).k === "never" ? T.NEVER : T.isOpen(pr) ? T.UNKNOWN : pr;
        if (T.isOpen(pr) && !(pr.k === "var" && pr.lit)) return pl;
        if (op in OPERATOR_METHODS) {
            const n = this.numberPair(pl, pr);
            if (n) return n;
            if (op === "+" && this.stringy(pl) && this.stringy(pr)) return T.STR;
            if (pl.k === "named" || pl.k === "param") {
                const m = this.method(pl, OPERATOR_METHODS[op]!, e);
                if (m && m !== "unknown") {
                    this.out.ops.set(e, m.target);
                    const p0 = m.params[0];
                    if (p0 && !this.assignable(pr, p0.ty)) this.mismatch(pr, p0.ty, e.right);
                    return m.ret;
                }
                if (m === "unknown") return T.UNKNOWN;
            }
            this.error("E_INVALID_OPERANDS", `\`${op}\` can't combine \`${T.show(pl)}\` and \`${T.show(pr)}\``, e);
            return T.UNKNOWN;
        }
        // bitwise
        const intish = (t: Ty) => T.isInt(t) || (t.k === "var" && t.lit === "int");
        if (intish(pl) && intish(pr) && this.equal(pl, pr)) return pl;
        const n = this.numberPair(pl, pr);
        if (n && T.isInt(T.prune(n))) return n;
        this.error("E_INVALID_OPERANDS", `\`${op}\` needs integers, not \`${T.show(pl)}\` and \`${T.show(pr)}\``, e);
        return T.UNKNOWN;
    }

    stringy(t: Ty): boolean {
        const p = T.prune(t);
        return (p.k === "prim" && (p.name === "str" || p.name === "char")) || (p.k === "lit" && typeof p.value === "string") || p.k === "union";
    }

    comparable(t: Ty): boolean {
        const p = T.prune(t);
        if (p.k === "prim") return p.name !== "void";
        if (p.k === "lit" || p.k === "union") return true;
        if (p.k === "named" || p.k === "param") {
            const ord = this.w.prelude.get("PartialOrd");
            return !ord || this.implementsSym(p, ord);
        }
        return false;
    }

    /** Two numbers: the same type, or one widens to the other (§13.1). */
    numberPair(a: Ty, b: Ty): Ty | null {
        const pa = T.prune(a);
        const pb = T.prune(b);
        const num = (t: Ty) => T.isNumeric(t) || (t.k === "var" && t.lit !== null);
        if (!num(pa) || !num(pb)) return null;
        if (this.equal(pa, pb)) return pa;
        if (pa.k === "prim" && pb.k === "prim") {
            if (T.widens(pa.name, pb.name)) return pb;
            if (T.widens(pb.name, pa.name)) return pa;
        }
        return null;
    }

    assign(e: A.Assign): Ty {
        let target = this.check(e.target);
        if (e.target.kind === "Member") {
            this.identityFieldWrite(e.target);
            // a `once` field reads as `T?` and is written as `T` (§12.2)
            if (this.onceField(e.target)) target = nargs(target)[0] ?? T.UNKNOWN;
        }
        if (e.op === "=") {
            this.expect(e.value, target);
            return T.VOID;
        }
        if (e.op === "??=") {
            const p = T.prune(target);
            if (this.isNamed(p, "Option")) {
                const v = this.check(e.value, nargs(p)[0]);
                if (!this.assignable(v, nargs(p)[0]!) && !this.assignable(v, p)) this.mismatch(v, nargs(p)[0]!, e.value);
            } else {
                this.check(e.value);
                if (!T.isOpen(p)) this.error("E_INVALID_OPERANDS", `\`??=\` needs an Option on its left, not \`${T.show(p)}\``, e.target);
            }
            return T.VOID;
        }
        const op = e.op.slice(0, -1);
        const fake: A.Binary = { kind: "Binary", span: e.span, op, left: e.target, right: e.value };
        const r = this.binaryWithLeft(fake, target);
        const op2 = this.out.ops.get(fake);
        if (op2) this.out.ops.set(e, op2);
        if (!T.isOpen(r) && !this.assignable(r, target)) this.mismatch(r, target, e);
        return T.VOID;
    }

    binaryWithLeft(e: A.Binary, left: Ty): Ty {
        const saved = this.out.types.get(e.left);
        const t = this.binary(e, undefined);
        if (saved) this.out.types.set(e.left, saved);
        void left;
        return t;
    }

    onceField(m: A.Member): boolean {
        const recv = T.prune(this.out.types.get(m.target) ?? T.UNKNOWN);
        return recv.k === "named" && this.w.infos.get(recv.sym)?.fields.get(m.name)?.mode === "once";
    }

    /** E_ASSIGN_IDENTITY_FIELD: plain fields of identity values never change (§12.1). */
    identityFieldWrite(m: A.Member): void {
        const recv = T.prune(this.out.types.get(m.target) ?? T.UNKNOWN);
        if (recv.k !== "named" || !this.isIdentity(recv)) return;
        const f = this.w.infos.get(recv.sym)?.fields.get(m.name);
        if (f && f.mode === null) {
            this.error("E_ASSIGN_IDENTITY_FIELD", `\`${m.name}\` of an identity value can't change after construction`, m, `build a new value: ${recv.sym.name} { ...old, ${m.name}: … }`);
        }
    }

    range(e: A.Range): Ty {
        let elem: Ty | undefined;
        if (e.start) elem = this.check(e.start);
        if (e.end) elem = elem ? this.expect(e.end, elem) : this.check(e.end);
        return this.preludeNamed("Range", [elem ? widenLit(elem) : T.INT]);
    }

    asExpr(e: A.As): Ty {
        const target = this.ty(e.type, true);
        if (e.expr.kind === "Int" || (e.expr.kind === "Unary" && e.expr.operand.kind === "Int")) {
            const value = e.expr.kind === "Int" ? e.expr.value : -(e.expr as { operand: A.IntLit }).operand.value;
            const p = T.prune(target);
            const range = p.k === "prim" ? T.INT_RANGE[p.name] : undefined;
            this.out.types.set(e.expr, range && (value < range[0] || value > range[1]) ? T.INT : target);
            return target;
        }
        const t = this.check(e.expr, target);
        if (this.assignable(t, target)) return target;
        const pt = T.prune(t);
        const pg = T.prune(target);
        const num = (x: Ty) => T.isNumeric(x) || (x.k === "prim" && (x.name === "char" || x.name === "bool")) || (x.k === "var" && x.lit !== null);
        if (num(pt) && num(pg)) return target;
        if (T.isOpen(pt) || T.isOpen(pg)) return target;
        this.error("E_INVALID_CAST", `\`${T.show(pt)}\` can't be used as \`${T.show(pg)}\`: it is neither its type nor a number cast`, e);
        return target;
    }

    orExpr(e: A.Or, expected: Ty | undefined): Ty {
        const t = T.prune(this.check(e.expr, expected ? this.option(expected) : undefined));
        let inner: Ty = T.UNKNOWN;
        let payload: Ty = T.UNKNOWN;
        if (this.isNamed(t, "Option")) {
            inner = nargs(t)[0]!;
            payload = T.VOID;
        } else if (this.isNamed(t, "Result")) {
            inner = nargs(t)[0]!;
            payload = nargs(t)[1]!;
        } else if (!T.isOpen(t)) {
            this.error("E_INVALID_OPERANDS", `\`or\` needs an Option or a Result on its left, not \`${T.show(t)}\``, e.expr);
        }
        // the payload: `or e => …` or `it`
        if (e.name !== null) {
            const sym = this.w.decls.get(e);
            if (sym) this.w.symTypes.set(sym, payload);
        } else {
            for (const sym of this.w.implicit.get(e)?.values() ?? []) this.w.symTypes.set(sym, payload);
        }
        // the right side is returned from the function (§4.6)
        const r = this.check(e.rhs, this.ctx.ret);
        if (T.prune(r).k !== "never" && !this.assignable(r, this.ctx.ret)) this.mismatch(r, this.ctx.ret, e.rhs);
        return inner;
    }

    tryExpr(e: A.Try): Ty {
        const t = T.prune(this.check(e.expr));
        if (T.isOpen(t)) return T.UNKNOWN;
        const ret = T.prune(this.ctx.ret);
        if (this.isNamed(t, "Option")) {
            if (!T.isOpen(ret) && !this.isNamed(ret, "Option")) this.error("E_INVALID_TRY", `\`?\` on an Option needs the function to return an Option, not \`${T.show(ret)}\``, e);
            return nargs(t)[0]!;
        }
        if (this.isNamed(t, "Result")) {
            if (!T.isOpen(ret)) {
                if (!this.isNamed(ret, "Result")) this.error("E_INVALID_TRY", `\`?\` on a Result needs the function to return a Result, not \`${T.show(ret)}\``, e);
                else if (!this.assignable(nargs(t)[1]!, nargs(ret)[1]!)) this.error("E_INVALID_TRY", `\`?\` can't return error \`${T.show(nargs(t)[1]!)}\` from a function whose error is \`${T.show(nargs(ret)[1]!)}\``, e, ".map_err(#{ … })");
            }
            return nargs(t)[0]!;
        }
        this.error("E_INVALID_TRY", `\`?\` needs an Option or a Result, not \`${T.show(t)}\``, e);
        return T.UNKNOWN;
    }

    index(e: A.Index): Ty {
        const t = T.prune(this.check(e.target));
        if (T.isOpen(t)) {
            this.check(e.index);
            return T.UNKNOWN;
        }
        if (this.isNamed(t, "Vec") || this.isNamed(t, "Array") || this.isNamed(t, "Slice") || this.isNamed(t, "PVec")) {
            this.expect(e.index, T.INT);
            return nargs(t)[0]!;
        }
        if (this.isNamed(t, "Map") || this.isNamed(t, "PMap")) {
            this.expect(e.index, nargs(t)[0]!);
            return nargs(t)[1]!;
        }
        if (t.k === "named") {
            const m = this.method(t, "index", e);
            if (m && m !== "unknown") {
                this.out.ops.set(e, m.target);
                if (m.params[0]) this.expect(e.index, m.params[0].ty);
                return m.ret;
            }
        }
        this.check(e.index);
        const hint = t.k === "prim" && t.name === "str" ? ": use `.bytes()`, `.chars()` or `.substring()`" : t.k === "tuple" ? ": use `.0`, `.1`…" : "";
        this.error("E_NOT_INDEXABLE", `\`${T.show(t)}\` can't be indexed${hint}`, e);
        return T.UNKNOWN;
    }

    member(e: A.Member, expected: Ty | undefined): Ty {
        // an item of a loaded package
        const item = this.w.refs.get(e);
        if (item) {
            this.check(e.target);
            this.out.members.set(e, { kind: "item", sym: item });
            if (item.kind === "variant") {
                const v = this.variantOf(item);
                if (v) return this.constructorOf(v.info, v.variant, e, expected);
            }
            return this.symType(item, e, expected);
        }
        const t = T.prune(this.check(e.target));
        if (t.k === "package") return T.UNKNOWN;
        if (t.k === "meta") {
            const s = this.staticMember(t.ty, e.name, e);
            if (!s) {
                const inner = T.prune(t.ty);
                if (inner.k === "named" || inner.k === "param") this.error("E_UNKNOWN_MEMBER", `\`${T.show(inner)}\` has no variant or static method \`${e.name}\``, e);
                return T.UNKNOWN;
            }
            if (s.callable) {
                this.out.members.set(e, { kind: "static", decl: (s.callable.target as { decl: A.FnDecl }).decl });
                return { k: "fn", params: s.callable.params.map((p) => ({ ty: p.ty, star: p.star })), ret: this.asyncRet(s.callable), async: s.callable.async };
            }
            const v = s.value ?? T.UNKNOWN;
            const ref = this.out.variants.get(e);
            if (ref) this.out.members.set(e, { kind: "variant", ref });
            if (expected && v.k !== "fn") this.assignable(v, expected);
            return v;
        }
        if (e.optional) {
            if (this.isNamed(t, "Option")) {
                const inner = this.fieldOnValue(nargs(t)[0]!, e);
                return this.isOptional(inner) ? inner : this.option(inner);
            }
            if (!T.isOpen(t)) this.error("E_INVALID_OPERANDS", `\`?.\` needs an Option, not \`${T.show(t)}\``, e);
            return T.UNKNOWN;
        }
        return this.fieldOnValue(t, e);
    }

    fieldOnValue(t: Ty, e: A.Member): Ty {
        return this.field(t, e.name, e);
    }

    // ---- calls --------------------------------------------------------------------------------

    call(e: A.Call, expected: Ty | undefined): Ty {
        const c = this.callee(e.callee, expected);
        if (c === "unknown") {
            // nothing is known about the parameters: arguments are checked against `unknown`
            for (const a of e.args) this.check(a.value, T.UNKNOWN);
            this.out.calls.set(e, { target: { kind: "unknown" }, params: [], async: false, typeArgs: [], env: [] });
            return T.UNKNOWN;
        }
        if ("notCallable" in c) {
            for (const a of e.args) this.check(a.value);
            this.error("E_NOT_CALLABLE", `\`${T.show(c.notCallable)}\` is not a function`, e.callee);
            return T.UNKNOWN;
        }
        // the expected result guides inference before the arguments (`let v: Vec[u8] = Vec.new()`)
        const ret = this.asyncRet(c);
        if (expected && c.generic && !this.isInterface(expected)) this.assignable(ret, expected);
        this.args(c, e);
        this.checkBounds(c.own, e);
        if (c.generic) {
            for (const o of c.own) if (T.freeVars(c.ret).has(o.v)) this.inferSites.push({ v: o.v, at: e, code: "E_CANNOT_INFER_GENERIC", what: `\`${o.sym.name}\` in this call` });
        }
        this.out.calls.set(e, {
            target: c.target, params: c.params.map((p) => ({ ty: p.ty, star: p.star })), async: c.async, typeArgs: c.own.map((o) => o.v), env: [...c.env],
        });
        return ret;
    }

    /** What a call calls. */
    callee(callee: A.Expr, expected: Ty | undefined): Callable | "unknown" | { notCallable: Ty } {
        // explicit generics: `f.[T](x)`, `Vec.new.[u8]()`, `Topic.new.[str]()`
        if (callee.kind === "GenericApply") {
            const inner = this.callee(callee.target, undefined);
            const args = callee.args.map((a) => this.ty(a, true));
            if (inner === "unknown" || "notCallable" in inner) return inner;
            if (inner.own.length > 0) {
                if (args.length !== inner.own.length) this.error("E_ARG_COUNT", `expected ${inner.own.length} type argument(s), found ${args.length}`, callee);
                inner.own.forEach((o, i) => args[i] && this.equal(o.v, args[i]!));
            } else {
                // a static method without generics of its own: the type's generics (`Topic.new.[str]()`)
                const owner = T.prune(inner.ret);
                if (owner.k === "named") owner.args.forEach((a, i) => args[i] && this.equal(a, args[i]!));
            }
            this.out.types.set(callee, T.UNKNOWN);
            return inner;
        }
        // a method call on a value
        if (callee.kind === "Member" && !this.w.refs.get(callee)) {
            const recv = T.prune(this.check(callee.target));
            if (recv.k === "meta") {
                const s = this.staticMember(recv.ty, callee.name, callee);
                if (s?.callable) {
                    this.out.members.set(callee, { kind: "static", decl: (s.callable.target as { decl: A.FnDecl }).decl });
                    return s.callable;
                }
                if (s?.value) return this.fromFnType(s.value, { kind: "variant", ref: this.out.variants.get(callee) ?? { union: null as never, variant: callee.name } }, expected);
                const inner = T.prune(recv.ty);
                if (inner.k === "named" || inner.k === "param") this.error("E_UNKNOWN_MEMBER", `\`${T.show(inner)}\` has no variant or static method \`${callee.name}\``, callee);
                return "unknown";
            }
            if (recv.k === "package") return "unknown";
            if (callee.optional) {
                if (this.isNamed(recv, "Option")) {
                    const m = this.method(nargs(recv)[0]!, callee.name, callee);
                    if (m && m !== "unknown") return { ...m, ret: this.isOptional(m.ret) ? m.ret : this.option(m.ret) };
                }
                return "unknown";
            }
            const m = this.method(recv, callee.name, callee);
            if (m === "unknown") return "unknown";
            if (m) {
                this.out.members.set(callee, { kind: "method", decl: m.target.kind === "method" ? m.target.decl : null });
                return m;
            }
            // a field holding a function
            const f = this.field(recv, callee.name, callee);
            return this.fromFnType(f, { kind: "value" }, expected);
        }
        if (callee.kind === "Ident") {
            const s = this.w.refs.get(callee);
            const preferred = expected ? this.expectedVariant(callee.name, callee, expected, s) : null;
            if (preferred) {
                this.out.types.set(callee, preferred);
                return this.fromFnType(preferred, { kind: "variant", ref: this.out.variants.get(callee)! }, expected);
            }
            if (s && (s.kind === "fn" || s.kind === "extern-fn") && s.decl) {
                const fn = s.decl as A.FnDecl;
                this.out.types.set(callee, T.UNKNOWN);
                return this.callable(fn, null, { kind: "fn", decl: fn });
            }
            if (s && (s.kind === "type" || s.kind === "union")) {
                // `Signal(0)` is `Signal.new(0)`
                const meta = this.symType(s, callee);
                if (meta.k === "meta") {
                    const st = this.staticMember(meta.ty, "new", callee);
                    if (st?.callable) return st.callable;
                }
                return { notCallable: meta };
            }
            const t = this.ident(callee, expected, true);
            this.out.types.set(callee, t);
            // a variant constructor, declared (`Some`) or inferred from the expected type (`Priced`)
            const ref = this.out.variants.get(callee);
            return this.fromFnType(t, ref ? { kind: "variant", ref } : { kind: "value" }, expected);
        }
        // a function of another package (`io.println`): its declaration, so variadics and generics hold
        if (callee.kind === "Member") {
            const s = this.w.refs.get(callee);
            if (s && (s.kind === "fn" || s.kind === "extern-fn") && s.decl) {
                const fn = s.decl as A.FnDecl;
                this.check(callee.target);
                this.out.types.set(callee, T.UNKNOWN);
                return this.callable(fn, null, { kind: "fn", decl: fn });
            }
        }
        const t = this.check(callee);
        return this.fromFnType(t, { kind: "value" }, expected);
    }

    fromFnType(t: Ty, target: CallTarget, _expected: Ty | undefined): Callable | "unknown" | { notCallable: Ty } {
        const p = T.prune(t);
        if (T.isOpen(p)) return "unknown";
        if (p.k === "meta") {
            const st = this.staticMember(p.ty, "new", { span: { start: 0, end: 0 } });
            return st?.callable ?? "unknown";
        }
        if (p.k !== "fn") return { notCallable: p };
        const params = p.params.map((x, i) => ({ name: `#${i}`, ty: x.ty, star: x.star, variadic: false }));
        const ret = p.async && this.isNamed(p.ret, "Promise") ? (T.prune(p.ret) as { args: Ty[] }).args[0]! : p.ret;
        return { params, ret, async: p.async, own: [], target, env: new Map(), generic: true };
    }

    /** Checks the arguments of a call: closures last, so they see what the others inferred. */
    args(c: Callable, e: A.Call): void {
        const args = e.args;
        const params = c.params;
        const variadic = params.length > 0 && params[params.length - 1]!.variadic ? params[params.length - 1]! : null;
        const fixed = variadic ? params.length - 1 : params.length;
        // missing arguments are allowed only for trailing `void` parameters (§13.5)
        // (or still unknown: `Ok()` in an untyped closure makes the payload `void`)
        const voidable = (t: Ty) => {
            const p = T.prune(t);
            return (p.k === "prim" && p.name === "void") || (p.k === "var" && p.lit === null);
        };
        let required = fixed;
        while (required > args.length && required > 0 && voidable(params[required - 1]!.ty)) {
            const p = T.prune(params[required - 1]!.ty);
            if (p.k === "var") this.bind(p, T.VOID);
            required--;
        }
        const spread = args.some((a) => a.spread);
        if (!spread && (args.length < required || (!variadic && args.length > fixed))) {
            const want = variadic ? `at least ${required}` : required === fixed ? `${fixed}` : `${required} to ${fixed}`;
            this.error("E_ARG_COUNT", `expected ${want} argument(s), found ${args.length}`, e);
        }
        const order = args.map((a, i) => i).sort((a, b) => Number(args[a]!.value.kind === "Closure") - Number(args[b]!.value.kind === "Closure"));
        for (const i of order) {
            const a = args[i]!;
            const p = i < fixed ? params[i] : variadic;
            if (!p) {
                this.check(a.value);
                continue;
            }
            const want = i >= fixed && variadic ? (T.prune(p.ty) as { args?: Ty[] }).args?.[0] ?? T.UNKNOWN : p.ty;
            if (a.spread) {
                this.check(a.value);
                continue;
            }
            this.expect(a.value, want);
        }
    }

    // ---- control flow -------------------------------------------------------------------------

    /** Branch types: each against the expected type, or the first branch's type (§7.7). */
    join(types: { t: Ty; at: { span: A.Span } }[], expected: Ty | undefined): Ty {
        if (expected) return expected;
        let result: Ty | undefined;
        for (const { t, at } of types) {
            if (T.prune(t).k === "never") continue;
            if (!result) {
                result = t;
                continue;
            }
            if (this.assignable(t, result)) continue;
            if (this.assignable(result, t)) {
                result = t;
                continue;
            }
            this.mismatch(t, result, at);
        }
        return result ?? T.NEVER;
    }

    ifExpr(e: A.If, expected: Ty | undefined, discard: boolean): Ty {
        if (e.pattern) {
            const t = this.check(e.cond);
            this.pattern(e.pattern, t);
        } else {
            this.truthy(this.check(e.cond), e.cond);
        }
        if (discard || !e.else) {
            const thenT = this.block(e.then, undefined, true);
            const elseT = e.else ? (e.else.kind === "If" ? this.ifExpr(e.else, undefined, true) : this.block(e.else, undefined, true)) : T.VOID;
            return T.prune(thenT).k === "never" && T.prune(elseT).k === "never" && e.else ? T.NEVER : T.VOID;
        }
        const thenT = this.block(e.then, expected);
        const hint = expected ?? (T.prune(thenT).k === "never" ? undefined : thenT);
        const elseT = e.else.kind === "If" ? this.ifExpr(e.else, hint, false) : this.block(e.else, hint);
        if (expected) {
            for (const [t, at] of [[thenT, e.then], [elseT, e.else]] as const) {
                if (!this.assignable(t, expected)) this.branchMismatch(t, expected, at);
            }
            return T.prune(thenT).k === "never" && T.prune(elseT).k === "never" ? T.NEVER : expected;
        }
        return this.join([{ t: thenT, at: e.then }, { t: elseT, at: e.else }], undefined);
    }

    branchMismatch(t: Ty, expected: Ty, at: A.Block | A.If): void {
        const last = at.kind === "Block" ? at.stmts[at.stmts.length - 1] : undefined;
        const p = T.prune(t);
        if (p.k === "prim" && p.name === "void") this.error("E_INVALID_BLOCK_VALUE", `this branch has no value, but \`${T.show(expected)}\` is expected`, at);
        else this.mismatch(t, expected, last?.kind === "ExprStmt" ? last.expr : at);
    }

    match(e: A.Match, expected: Ty | undefined, discard: boolean): Ty {
        const subject = e.subject ? this.check(e.subject) : undefined;
        const results: { t: Ty; at: { span: A.Span } }[] = [];
        let hint = expected;
        for (const arm of e.arms) {
            if (arm.pattern) this.pattern(arm.pattern, subject ?? T.UNKNOWN);
            if (arm.cond) this.truthy(this.check(arm.cond), arm.cond);
            if (arm.guard) this.truthy(this.check(arm.guard), arm.guard);
            const t = discard ? this.check(arm.body, undefined, true) : this.check(arm.body, hint);
            if (!discard && expected && !this.assignable(t, expected)) this.mismatch(t, expected, arm.body);
            if (!hint && !discard && T.prune(t).k !== "never") hint = t;
            results.push({ t, at: arm.body });
        }
        this.exhaustive(e, subject);
        if (discard) return results.length > 0 && results.every((r) => T.prune(r.t).k === "never") ? T.NEVER : T.VOID;
        if (results.every((r) => T.prune(r.t).k === "never")) return T.NEVER;
        return this.join(results, expected);
    }

    select(e: A.Select, expected: Ty | undefined, discard: boolean): Ty {
        if (!this.ctx.async) this.error("E_AWAIT_OUTSIDE_ASYNC", "`select` is only allowed in an `async fn` or in `main`", e);
        const results: { t: Ty; at: { span: A.Span } }[] = [];
        for (const arm of e.arms) {
            const t = T.prune(this.check(arm.expr));
            let value: Ty = T.UNKNOWN;
            if (this.isNamed(t, "Promise")) value = nargs(t)[0]!;
            else if (!T.isOpen(t)) this.error("E_SELECT_ARM_NOT_PROMISE", `a \`select\` arm waits on a Promise, not \`${T.show(t)}\``, arm.expr);
            if (arm.pattern) this.pattern(arm.pattern, value);
            results.push({ t: discard ? this.check(arm.body, undefined, true) : this.check(arm.body, expected), at: arm.body });
        }
        if (e.else) results.push({ t: discard ? this.check(e.else, undefined, true) : this.check(e.else, expected), at: e.else });
        if (discard) return T.VOID;
        return this.join(results, expected);
    }

    forExpr(e: A.For): Ty {
        const loop: Loop = { label: e.label, infinite: e.form === "infinite", breakTy: e.form === "infinite" ? this.fresh() : null, broke: false };
        if (e.form === "cond") this.truthy(this.check(e.expr!), e.expr!);
        if (e.form === "let") this.pattern(e.pattern!, this.check(e.expr!));
        if (e.form === "in") {
            const [item, second] = this.iteration(this.check(e.expr!), e.expr!, e.isAwait, e);
            this.pattern(e.pattern!, item);
            if (e.pattern2) this.pattern(e.pattern2, second);
        }
        this.ctx.loops.push(loop);
        this.block(e.body, undefined, true);
        this.ctx.loops.pop();
        if (e.isAwait && !this.ctx.async) this.error("E_AWAIT_OUTSIDE_ASYNC", "`for await` is only allowed in an `async fn` or in `main`", e);
        if (e.form !== "infinite") return T.VOID;
        if (!loop.broke) return T.NEVER;
        const b = T.prune(loop.breakTy!);
        if (b.k === "var" && b.lit === null) this.bind(b, T.VOID);
        return loop.breakTy!;
    }

    /** The item (and index / value) types of `for x in e` (§13.5). */
    iteration(t: Ty, at: { span: A.Span }, isAwait: boolean, loop?: A.For): [Ty, Ty] {
        const p = T.prune(t);
        if (T.isOpen(p)) return [T.UNKNOWN, T.UNKNOWN];
        for (const name of ["Vec", "Array", "Slice", "Set", "PVec"]) if (this.isNamed(p, name)) return [nargs(p)[0]!, T.INT];
        if (this.isNamed(p, "Map") || this.isNamed(p, "PMap")) return [nargs(p)[0]!, nargs(p)[1]!];
        if (this.isNamed(p, "Range")) return [nargs(p)[0]!, T.INT];
        if (p.k === "named" || p.k === "param") {
            const next = this.method(p, "next", at);
            if (next && next !== "unknown") {
                if (loop) this.out.ops.set(loop, next.target);
                const r = T.prune(next.ret);
                return [this.isNamed(r, "Option") ? nargs(r)[0]! : T.UNKNOWN, T.INT];
            }
            if (next === "unknown") return [T.UNKNOWN, T.UNKNOWN];
            if (!isAwait) {
                const iter = this.method(p, "iter", at);
                if (iter && iter !== "unknown") {
                    if (loop) this.out.ops.set(loop, iter.target);
                    const it = T.prune(iter.ret);
                    return it.k === "named" && it.args[0] ? [it.args[0], T.INT] : [T.UNKNOWN, T.UNKNOWN];
                }
            }
        }
        const hint = p.k === "prim" && p.name === "str" ? ": use `.chars()`, `.bytes()` or `.lines()`" : "";
        this.error("E_NOT_ITERABLE", `\`${T.show(p)}\` can't be iterated${hint}`, at);
        return [T.UNKNOWN, T.UNKNOWN];
    }

    // ---- patterns -----------------------------------------------------------------------------

    pattern(p: A.Pattern, t: Ty): void {
        const ty = T.prune(t);
        switch (p.kind) {
            case "PWild": case "PError":
                return;
            case "PBind": {
                const sym = this.w.decls.get(p);
                if (sym) this.w.symTypes.set(sym, widenLit(ty));
                return;
            }
            case "PLit": {
                const lt = this.check(p.value, ty);
                if (!T.isOpen(ty) && !this.assignable(lt, ty) && !this.assignable(ty, lt)) this.mismatch(lt, ty, p);
                return;
            }
            case "PRange": {
                const a = this.check(p.start, ty);
                this.check(p.end, ty);
                if (!T.isOpen(ty) && !this.assignable(a, ty) && !this.assignable(ty, a)) this.mismatch(a, ty, p);
                return;
            }
            case "POr":
                for (const alt of p.alts) this.pattern(alt, ty);
                return;
            case "PTuple": {
                if (ty.k === "tuple") {
                    if (!p.rest && p.elems.length !== ty.elems.length) this.error("E_TYPE_MISMATCH", `expected a tuple of ${ty.elems.length}, found ${p.elems.length}`, p);
                    p.elems.forEach((el, i) => this.pattern(el, ty.elems[i] ?? T.UNKNOWN));
                } else {
                    if (!T.isOpen(ty)) this.mismatch({ k: "tuple", elems: p.elems.map(() => T.UNKNOWN) }, ty, p);
                    for (const el of p.elems) this.pattern(el, T.UNKNOWN);
                }
                return;
            }
            case "PRecord": {
                for (const f of p.fields) this.fieldPattern(f, this.fieldOfType(ty, f.name, f));
                return;
            }
            case "PCtor":
                return this.ctorPattern(p, ty);
        }
    }

    fieldOfType(t: Ty, name: string, at: { span: A.Span }): Ty {
        const p = T.prune(t);
        if (p.k === "record") return p.fields.find((f) => f.name === name)?.ty ?? this.unknownField(p, name, at);
        if (p.k === "named") {
            const info = this.w.infos.get(p.sym);
            const f = info?.fields.get(name);
            if (f) return this.fieldType(f, this.typeEnv(info!, p.args));
            if (info) return this.unknownField(p, name, at);
        }
        return T.UNKNOWN;
    }

    unknownField(t: Ty, name: string, at: { span: A.Span }): Ty {
        this.error("E_UNKNOWN_FIELD", `\`${T.show(t)}\` has no field \`${name}\``, at);
        return T.UNKNOWN;
    }

    fieldPattern(f: A.FieldPat, t: Ty): void {
        if (f.pattern) return this.pattern(f.pattern, t);
        const sym = this.w.decls.get(f);
        if (sym) this.w.symTypes.set(sym, t);
    }

    ctorPattern(p: A.PCtor, ty: Ty): void {
        const s = this.w.refs.get(p);
        let info: TypeInfo | undefined;
        let variant: A.Variant | undefined;
        // a variant of the scrutinee's union comes before ordinary name resolution (§7.7)
        const scrut = T.prune(ty);
        const own = p.path.length === 1 && s?.kind !== "variant" && scrut.k === "named" ? this.w.infos.get(scrut.sym) : undefined;
        if (own?.kind === "union" && own.variants.has(p.path[0]!)) {
            info = own;
            variant = own.variants.get(p.path[0]!);
            if (s && (s.kind === "fn" || s.kind === "global") && s.pkg === this.out.pkg) {
                this.out.lints.push({
                    ...diag("L_SHADOWED_VARIANT", `\`${p.path[0]}\` is the variant \`${own.sym.name}.${p.path[0]}\` here, not the ${s.kind === "fn" ? "function" : "global"} \`${p.path[0]}\` of this package (§7.7)`, p.span.start, p.span.end, "rename the function or global"),
                    file: this.file,
                });
            }
        } else if (s?.kind === "variant") {
            const v = this.variantOf(s);
            info = v?.info;
            variant = v?.variant;
        } else if (s && (s.kind === "type") && p.path.length === 1) {
            // a struct pattern: `User { id, .. }`
            const sinfo = this.w.infos.get(s);
            if (sinfo?.kind === "struct") {
                const args = sinfo.generics.map(() => this.fresh() as Ty);
                const st: Ty = { k: "named", sym: s, args };
                if (!this.assignable(ty, st) && !T.isOpen(ty)) this.mismatch(st, ty, p);
                for (const f of p.fields ?? []) this.fieldPattern(f, this.fieldOfType(st, f.name, f));
                return;
            }
        } else if (s && s.kind !== "type" && s.kind !== "union") {
            // a constant
            this.symType(s, p);
            return;
        } else {
            // a bare or qualified name the resolver left: a variant of the scrutinee's union
            const name = p.path[p.path.length - 1]!;
            if (ty.k === "named") {
                const u = this.w.infos.get(ty.sym);
                if (u?.kind === "union") {
                    info = u;
                    variant = u.variants.get(name);
                    if (!variant) {
                        this.error("E_UNKNOWN_VARIANT", `union \`${u.sym.name}\` has no variant \`${name}\``, p);
                        this.payloadUnknown(p);
                        return;
                    }
                }
            }
        }
        if (!info || !variant) {
            this.payloadUnknown(p);
            return;
        }
        this.out.variants.set(p, { union: info.sym, variant: variant.name });
        const args = ty.k === "named" && ty.sym === info.sym ? ty.args : info.generics.map(() => this.fresh() as Ty);
        const union: Ty = { k: "named", sym: info.sym, args };
        if (!T.isOpen(ty) && !this.assignable(union, ty)) {
            this.error("E_TYPE_MISMATCH", `\`${variant.name}\` is a variant of \`${info.sym.name}\`, not of \`${T.show(ty)}\``, p);
            this.payloadUnknown(p);
            return;
        }
        const env = this.typeEnv(info, args);
        if (p.args) {
            const payload = (variant.tuple ?? []).map((t) => T.subst(this.ty(t), env));
            if (!p.rest && p.args.length !== payload.length && !(payload.length === 1 && T.prune(payload[0]!).k === "prim" && (payload[0] as { name?: string }).name === "void")) {
                this.error("E_TYPE_MISMATCH", `\`${variant.name}\` has ${payload.length} payload value(s), the pattern gives ${p.args.length}`, p);
            }
            p.args.forEach((a, i) => this.pattern(a, payload[i] ?? T.UNKNOWN));
        }
        if (p.fields) {
            const fields = new Map((variant.fields ?? []).map((f) => [f.name, f] as const));
            for (const f of p.fields) {
                const decl = fields.get(f.name);
                if (!decl) this.error("E_UNKNOWN_FIELD", `variant \`${variant.name}\` has no field \`${f.name}\``, f);
                this.fieldPattern(f, decl ? this.fieldType(decl, env) : T.UNKNOWN);
            }
        }
    }

    payloadUnknown(p: A.PCtor): void {
        for (const a of p.args ?? []) this.pattern(a, T.UNKNOWN);
        for (const f of p.fields ?? []) this.fieldPattern(f, T.UNKNOWN);
    }

    /** E_NON_EXHAUSTIVE_MATCH (§13.5): every value of the subject's type must reach an arm. */
    exhaustive(e: A.Match, subject: Ty | undefined): void {
        const rows = e.arms.filter((a) => !a.guard && a.pattern).map((a) => [a.pattern!]);
        if (!subject) {
            if (!e.arms.some((a) => a.pattern?.kind === "PWild")) this.error("E_NON_EXHAUSTIVE_MATCH", "a `match` without a subject needs a `_ =>` arm", e);
            return;
        }
        if (T.isOpen(subject)) return;
        const missing = this.missing(rows, [subject], 0);
        if (missing !== null) {
            this.error("E_NON_EXHAUSTIVE_MATCH", `this \`match\` doesn't cover ${missing}`, e, missing === "_" ? "add `_ =>`" : undefined);
        }
    }

    /**
     * The pattern-matrix check: null when the rows cover every value of `tys`, otherwise an example
     * of a value they miss. Constructors: union variants, `true` / `false`, the literals of a
     * literal union, and a tuple's or struct's single shape; anything else needs a wildcard.
     */
    missing(rows: A.Pattern[][], tys: Ty[], depth: number, budget = { left: 5000 }): string | null {
        if (tys.length === 0) return rows.length > 0 ? null : "_";
        // a row of wildcards covers everything; past the budget, assume covered (never exponential)
        if (depth > 12 || --budget.left < 0) return null;
        rows = rows.flatMap((r) => expandOr(r));
        if (rows.some((r) => r.every(irrefutable))) return null;
        const t = T.prune(tys[0]!);
        const rest = tys.slice(1);
        const isWild = (p: A.Pattern) => p.kind === "PWild" || p.kind === "PBind" || p.kind === "PError";
        const defaults = () => rows.filter((r) => isWild(r[0]!)).map((r) => r.slice(1));
        if (T.isOpen(t)) {
            if (rows.some((r) => isWild(r[0]!))) return this.missing(defaults(), rest, depth + 1, budget);
            // patterns we couldn't type: assume they cover
            return null;
        }
        const ctors = this.constructors(t);
        if (!ctors) {
            const m = this.missing(defaults(), rest, depth + 1, budget);
            return m === null ? null : "_";
        }
        for (const c of ctors) {
            const spec: A.Pattern[][] = [];
            for (const r of rows) {
                const head = r[0]!;
                if (isWild(head)) spec.push([...c.args.map((): A.Pattern => WILD), ...r.slice(1)]);
                else {
                    const sub = c.match(head);
                    if (sub) spec.push([...sub, ...r.slice(1)]);
                }
            }
            const m = this.missing(spec, [...c.args, ...rest], depth + 1, budget);
            if (m !== null) return c.args.length === 0 || m === "_" ? c.name : `${c.name}(…)`;
        }
        return null;
    }

    /** The constructors of a type, each with its payload types and how a pattern specialises. */
    constructors(t: Ty): { name: string; args: Ty[]; match: (p: A.Pattern) => A.Pattern[] | null }[] | null {
        if (t.k === "prim" && t.name === "bool") {
            return [true, false].map((b) => ({
                name: String(b), args: [],
                match: (p: A.Pattern) => (p.kind === "PLit" && p.value.kind === "Bool" && p.value.value === b ? [] : null),
            }));
        }
        if (t.k === "union") {
            return t.members.map((m) => ({
                name: T.show(m), args: [],
                match: (p: A.Pattern) => (p.kind === "PLit" && "value" in p.value && m.k === "lit" && (p.value as { value: unknown }).value === m.value ? [] : null),
            }));
        }
        if (t.k === "tuple") {
            return [{ name: "t(…)", args: t.elems, match: (p: A.Pattern) => (p.kind === "PTuple" ? padTo(p.elems, t.elems.length) : null) }];
        }
        if (t.k !== "named") return null;
        const info = this.w.infos.get(t.sym);
        if (!info) return null;
        const env = this.typeEnv(info, t.args);
        if (info.kind === "struct") {
            const names = [...info.fields.keys()];
            return [{
                name: info.sym.name,
                args: names.map((n) => this.fieldType(info.fields.get(n)!, env)),
                match: (p: A.Pattern) => (p.kind === "PCtor" && p.fields ? byName(p.fields, names) : p.kind === "PRecord" ? byName(p.fields, names) : null),
            }];
        }
        if (info.kind !== "union") return null;
        return [...info.variants.values()].map((v) => {
            const tuple = (v.tuple ?? []).map((x) => T.subst(this.ty(x), env));
            const names = (v.fields ?? []).map((f) => f.name);
            const fieldTys = (v.fields ?? []).map((f) => this.fieldType(f, env));
            return {
                name: v.name,
                args: v.fields ? fieldTys : tuple,
                match: (p: A.Pattern) => {
                    if (p.kind !== "PCtor" || this.out.variants.get(p)?.variant !== v.name) return null;
                    if (v.fields) return p.fields ? byName(p.fields, names) : names.map(() => WILD);
                    return p.args ? padTo(p.args, tuple.length) : tuple.map(() => WILD);
                },
            };
        });
    }

    // ---- shared places ------------------------------------------------------------------------

    /** Rooted in a `shared var`, a top-level `var`, or a `shared` field (§10.1). */
    isSharedPlace(e: A.Expr): boolean {
        switch (e.kind) {
            case "Paren":
                return this.isSharedPlace(e.expr);
            case "Ident": {
                const s = this.w.refs.get(e);
                if (!s) return true;
                if (s.kind === "global") return (s.decl as A.Item | null)?.kind === "VarDecl";
                if (s.kind === "local") return (s.decl as A.VarStmt | null)?.kind === "VarStmt" && (s.decl as A.VarStmt).shared;
                return s.kind === "import" || s.kind === "ambiguous";
            }
            case "Member": {
                const recv = T.prune(this.out.types.get(e.target) ?? T.UNKNOWN);
                if (recv.k === "named") {
                    const f = this.w.infos.get(recv.sym)?.fields.get(e.name);
                    if (f?.mode === "shared") return true;
                } else if (T.isOpen(recv)) return true;
                return this.isSharedPlace(e.target);
            }
            case "Index":
                return this.isSharedPlace(e.target);
            default:
                return false;
        }
    }
}

// ---- helpers -----------------------------------------------------------------------------------

/** The type arguments of a named type (empty for anything else). */
function nargs(t: Ty): Ty[] {
    const p = T.prune(t);
    return p.k === "named" ? p.args : [];
}

function record(fields: T.RecordField[]): Ty {
    return { k: "record", fields: [...fields].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}

function litBase(t: Ty & { k: "lit" }): string {
    return typeof t.value === "string" ? "str" : typeof t.value === "boolean" ? "bool" : "int";
}

/** A literal type stored in a binding becomes its base type: `x := "a"` is a `str`. */
function widenLit(t: Ty): Ty {
    const p = T.prune(t);
    if (p.k === "lit") return T.prim(litBase(p) as T.PrimName);
    return t;
}

function isUpperName(name: string): boolean {
    return name.length > 0 && name[0]! >= "A" && name[0]! <= "Z";
}

function isArith(op: string): boolean {
    return op in OPERATOR_METHODS;
}

const WILD: A.Pattern = { kind: "PWild", span: { start: 0, end: 0 } };

function expandOr(row: A.Pattern[]): A.Pattern[][] {
    const head = row[0];
    if (!head || head.kind !== "POr") return [row];
    return head.alts.flatMap((a) => expandOr([a, ...row.slice(1)]));
}

/** Positional payload patterns, `..` filling the rest with wildcards. */
function padTo(ps: A.Pattern[], n: number): A.Pattern[] {
    const out = ps.slice(0, n);
    while (out.length < n) out.push(WILD);
    return out;
}

/** Field patterns in declaration order; a missing field (or `..`) is a wildcard. */
function byName(fields: A.FieldPat[], names: string[]): A.Pattern[] {
    return names.map((n) => fields.find((f) => f.name === n)?.pattern ?? WILD);
}

function irrefutable(p: A.Pattern): boolean {
    switch (p.kind) {
        case "PWild": case "PBind": return true;
        case "PTuple": return p.elems.every(irrefutable);
        case "PRecord": return p.fields.every((f) => !f.pattern || irrefutable(f.pattern));
        case "POr": return p.alts.some(irrefutable);
        default: return false;
    }
}
