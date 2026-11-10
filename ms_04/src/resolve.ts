// Name resolution (spec §8.7). Binds every name to its declaration, without types. The AST is not
// modified: the result is a set of side tables keyed by AST node.
//
// Lookup order, innermost first: block / arm / closure / `or` scopes → the function (generics,
// `this`, parameters and the body's top level share one scope) → the type body (its generics) →
// the file's explicit imports → the package's items (every file) → the file's glob imports → the
// prelude's `pub` items → the built-in types.
//
// Names that need types are left for the checker and listed in `deferred`: bare uppercase names
// that aren't declared (variants inferred from the expected type, §7.7) and every unknown name in
// an *open* file (one with a glob import of a package that isn't loaded). Member names (`x.name`)
// are the checker's too, except members of a loaded package (`lib.visible`), resolved here.

import type * as A from "./ast.ts";
import { diag, type Diagnostic } from "./diagnostic.ts";

export type SymKind =
    | "local" | "param" | "closure-param" | "implicit" | "this"
    | "fn" | "global" | "extern-fn"
    | "type" | "union" | "inter" | "generic" | "builtin-type" | "variant"
    | "package" | "import" | "ambiguous";

export interface Sym {
    id: number;
    name: string;
    kind: SymKind;
    mutable: boolean;
    /** the declaring node (null for built-ins and opaque imports) */
    decl: object | null;
    file: string | null;
    start: number;
    /** qualified name of the declaring package ("main", "prelude", "app.models") */
    pkg: string;
    pub: boolean;
    used: boolean;
    /** the resolution that declared it */
    home: Resolution | null;
    /** variant: its union */
    owner?: Sym;
    /** package: the loaded package, or null when it isn't loaded (members stay unknown) */
    target?: Resolution | null;
    /** ambiguous: the symbols two glob imports both export */
    candidates?: Sym[];
}

export interface Resolution {
    pkg: string;
    symbols: Sym[];
    /** uses → symbol: Ident, This, Member (package items), TName, TTypeOf, PCtor, record shorthands */
    refs: Map<object, Sym>;
    /** declarations → symbol: items, params, closure params, generics, pattern bindings, statements */
    decls: Map<object, Sym>;
    /** each closure's captured outer locals, in first-use order */
    captures: Map<A.Closure, Sym[]>;
    /** names left for the type checker */
    deferred: object[];
    /** the package's items by name */
    items: Map<string, Sym>;
    /** what other packages see: `pub` items and `import pub` re-exports */
    exports: Map<string, Sym>;
    diagnostics: Diagnostic[];
}

export interface ResolveFile {
    path: string;
    ast: A.File;
    src: Uint8Array;
}

/** An import as the loader found it. `pkg` is null when the package isn't loaded (§13.5 gradual). */
export interface LoadedImport {
    pkg: Resolution | null;
    /** `"std.io.println"` → "println" */
    item: string | null;
    /** `"std.io.{print, println}"` */
    items: string[] | null;
    glob: boolean;
}

export interface ResolveOptions {
    /** qualified name of the package (default "main") */
    name?: string;
    /** the resolved prelude; null while resolving the prelude itself */
    prelude?: Resolution | null;
    /** resolving std: exempt from the orphan rule (std owns the built-in types) */
    std?: boolean;
    /** imports the loader resolved; an import not listed is treated as not loaded */
    imports?: Map<A.Import, LoadedImport>;
}

export const BUILTIN_TYPES: readonly string[] = [
    "bool", "char", "byte", "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "isize", "usize",
    "int", "f32", "f64", "void", "never", "str",
    "KeyOf", "ElementOf", "IndexOf", "Partial", "Omit", "Pick",
];

/** Packages every file sees without an import: `unsafe.Ptr[T]` (§8.6). */
const BUILTIN_PACKAGES: readonly string[] = ["unsafe"];

/** Prelude unions whose variants are visible unqualified (§14.1). */
const EXPORTED_VARIANTS: ReadonlySet<string> = new Set(["Option", "Result", "Ordering"]);

const IMPLICIT = /^it(?:[1-9][0-9]*)?$/;
const LOCAL_KINDS: ReadonlySet<SymKind> = new Set(["local", "param", "closure-param", "implicit", "this"]);
const TYPE_KINDS: ReadonlySet<SymKind> = new Set(["type", "union", "inter", "generic", "builtin-type", "import", "ambiguous"]);
/** what makes a sigil letter ambiguous (`t(1)` vs a call of `t`, §1.7) */
const VALUE_KINDS: ReadonlySet<SymKind> = new Set(["local", "param", "closure-param", "fn", "global", "extern-fn", "import", "package"]);
const SIGIL_LETTERS: Readonly<Record<string, string>> = { Array: "a", Tuple: "t", Record: "r", Map: "m", Set: "s" };

const isUpper = (s: string) => s.length > 0 && s[0]! >= "A" && s[0]! <= "Z";

type ScopeKind = "builtins" | "file" | "type" | "function" | "closure" | "or" | "block";

class Scope {
    readonly names = new Map<string, Sym>();
    readonly kind: ScopeKind;
    readonly parent: Scope | null;
    /** closure scope: its node */
    closure: A.Closure | null = null;
    /** closure without a header, or `or` without a name: provides `it` */
    provider = false;
    implicit: Sym | null = null;
    /** function scope: the receiver, when there is one */
    thisSym: Sym | null = null;
    /** file scope: a glob import of a package that isn't loaded */
    open = false;
    /** file scope: names from loaded glob imports, below the package's items */
    globs = new Map<string, Sym>();

    constructor(kind: ScopeKind, parent: Scope | null) {
        this.kind = kind;
        this.parent = parent;
    }
}

let nextId = 1;

/** Resolves one package: every file that declares it. */
export function resolvePackage(files: ResolveFile[], opts: ResolveOptions = {}): Resolution {
    return new Resolver(opts).run(files);
}

class Resolver {
    readonly res: Resolution;
    readonly prelude: Resolution | null;
    readonly std: boolean;
    readonly imports: Map<A.Import, LoadedImport>;
    readonly builtins: Scope;

    // current position
    file!: ResolveFile;
    fileScope!: Scope;
    scope!: Scope;
    /** inside a type / union / inter / impl body */
    selfOk = false;

    constructor(opts: ResolveOptions) {
        this.res = {
            pkg: opts.name ?? "main",
            symbols: [], refs: new Map(), decls: new Map(), captures: new Map(), deferred: [],
            items: new Map(), exports: new Map(), diagnostics: [],
        };
        this.prelude = opts.prelude ?? null;
        this.std = opts.std ?? false;
        this.imports = opts.imports ?? new Map();
        this.builtins = new Scope("builtins", null);
        for (const name of BUILTIN_TYPES) this.builtins.names.set(name, this.sym(name, "builtin-type", null, null, 0, true));
        for (const name of BUILTIN_PACKAGES) {
            const s = this.sym(name, "package", null, null, 0, true);
            s.target = null;
            this.builtins.names.set(name, s);
        }
    }

    sym(name: string, kind: SymKind, decl: object | null, file: string | null, start: number, pub = false): Sym {
        const s: Sym = {
            id: nextId++, name, kind, mutable: false, decl, file, start, pkg: this.res.pkg, pub, used: false, home: this.res,
        };
        this.res.symbols.push(s);
        return s;
    }

    error(code: string, message: string, node: { span: A.Span } | number, fix?: string): void {
        const start = typeof node === "number" ? node : node.span.start;
        const end = typeof node === "number" ? node : node.span.end;
        const d = diag(code, message, start, Math.max(end, start), fix);
        d.file = this.file.path;
        this.res.diagnostics.push(d);
    }

    run(files: ResolveFile[]): Resolution {
        const fileScopes = new Map<ResolveFile, Scope>();
        // 1. the package's items, across files
        for (const f of files) {
            this.file = f;
            this.collectItems(f.ast);
        }
        // 2. each file's imports
        for (const f of files) {
            this.file = f;
            const scope = new Scope("file", null);
            fileScopes.set(f, scope);
            this.fileScope = scope;
            this.bindImports(f.ast);
        }
        this.collectExports();
        // 3. every item's body
        const types = new TypeTable();
        for (const f of files) {
            this.file = f;
            this.fileScope = fileScopes.get(f)!;
            this.scope = this.fileScope;
            for (const item of f.ast.items) this.item(item, types);
        }
        // 4. checks across the package's members and impls
        for (const f of files) {
            this.file = f;
            for (const item of f.ast.items) if (item.kind === "ImplDecl") this.implChecks(item, types);
        }
        this.ambiguousImplMethods(types, files);
        return this.res;
    }

    // ---- items --------------------------------------------------------------------------------

    collectItems(file: A.File): void {
        const add = (name: string, kind: SymKind, node: A.Item | A.FnDecl, isPub: boolean, mutable = false) => {
            if (this.res.items.has(name)) {
                this.error("E_DUPLICATE_DECLARATION", `\`${name}\` is already declared in package ${this.res.pkg}`, node);
                return;
            }
            const s = this.sym(name, kind, node, this.file.path, node.span.start, isPub);
            s.mutable = mutable;
            this.res.items.set(name, s);
            this.res.decls.set(node, s);
            if (node.kind === "UnionDecl") {
                for (const m of node.members) {
                    if (m.kind !== "Variant") continue;
                    const v = this.sym(m.name, "variant", m, this.file.path, m.span.start, isPub);
                    v.owner = s;
                    this.res.decls.set(m, v);
                }
            }
        };
        for (const item of file.items) {
            switch (item.kind) {
                case "Fn": add(item.name, "fn", item, item.isPub); break;
                case "TypeDecl": add(item.name, "type", item, item.isPub); break;
                case "UnionDecl": add(item.name, "union", item, item.isPub); break;
                case "InterDecl": add(item.name, "inter", item, item.isPub); break;
                case "LetDecl": add(item.name, "global", item, item.isPub); break;
                case "VarDecl": add(item.name, "global", item, item.isPub, true); break;
                case "ExternDecl":
                    for (const f of item.fns) add(f.name, "extern-fn", f, f.isPub);
                    break;
                case "ImplDecl":
                    break;
            }
        }
    }

    collectExports(): void {
        for (const [name, s] of this.res.items) if (s.pub) this.res.exports.set(name, s);
        if (this.res.pkg === "prelude") {
            // the variants of Option, Result and Ordering are visible unqualified
            for (const [, s] of this.res.items) {
                if (s.kind !== "union" || !EXPORTED_VARIANTS.has(s.name)) continue;
                for (const v of this.res.symbols) if (v.owner === s) this.res.exports.set(v.name, v);
            }
        }
    }

    /** Binds a file's imports into its scope (§8.1). */
    bindImports(file: A.File): void {
        const bind = (name: string, s: Sym, node: A.Import) => {
            if (this.res.items.has(name) || this.fileScope.names.has(name)) {
                this.error("E_DUPLICATE_DECLARATION", `the import binds \`${name}\`, which is already declared here`, node, "rename it with `as`");
                return;
            }
            this.fileScope.names.set(name, s);
            this.res.refs.set(node, s);
            if (node.isPub) this.res.exports.set(name, s);
        };
        const opaque = (name: string, node: A.Import) => this.sym(name, "import", null, this.file.path, node.span.start);
        for (const imp of file.imports) {
            const li = this.imports.get(imp) ?? fallbackImport(imp.path);
            if (li.glob) {
                if (!li.pkg) {
                    this.fileScope.open = true;
                    continue;
                }
                for (const [name, s] of li.pkg.exports) {
                    const prev = this.fileScope.globs.get(name);
                    if (!prev || prev === s) {
                        this.fileScope.globs.set(name, s);
                    } else {
                        const amb = this.sym(name, "ambiguous", null, this.file.path, imp.span.start);
                        amb.candidates = [...(prev.candidates ?? [prev]), s];
                        this.fileScope.globs.set(name, amb);
                    }
                }
                continue;
            }
            const names = li.items ?? (li.item !== null ? [li.item] : null);
            if (names) {
                for (const name of names) {
                    const local = li.items === null && imp.alias ? imp.alias : name;
                    if (!li.pkg) {
                        bind(local, opaque(local, imp), imp);
                        continue;
                    }
                    const s = li.pkg.exports.get(name);
                    if (s) bind(local, s, imp);
                    else if (li.pkg.items.has(name)) this.error("E_PRIVATE_ITEM", `\`${name}\` is not \`pub\` in ${li.pkg.pkg}`, imp);
                    else this.error("E_UNKNOWN_IMPORT", `package ${li.pkg.pkg} has no item \`${name}\``, imp);
                }
                continue;
            }
            const name = imp.alias ?? lastSegment(imp.path);
            const s = this.sym(name, "package", null, this.file.path, imp.span.start);
            s.target = li.pkg;
            bind(name, s, imp);
        }
    }

    item(item: A.Item, types: TypeTable): void {
        switch (item.kind) {
            case "Fn":
                return this.fn(item, null);
            case "TypeDecl":
                return this.typeDecl(item, types);
            case "UnionDecl":
                return this.unionDecl(item, types);
            case "InterDecl":
                return this.interDecl(item);
            case "ImplDecl":
                return this.implDecl(item, types);
            case "LetDecl": case "VarDecl":
                if (item.type) this.type(item.type);
                return this.withScope(new Scope("block", this.fileScope), () => this.expr(item.value));
            case "ExternDecl":
                for (const f of item.fns) this.fn(f, null);
                return;
        }
    }

    /** A type / union / inter / impl body: its generics, and `Self`. */
    typeScope(generics: A.GenericParam[], f: () => void): void {
        const scope = new Scope("type", this.fileScope);
        const savedSelf = this.selfOk;
        this.selfOk = true;
        this.withScope(scope, () => {
            this.generics(generics);
            f();
        });
        this.selfOk = savedSelf;
    }

    generics(gs: A.GenericParam[]): void {
        for (const g of gs) this.declare(g.name, "generic", g, false);
        for (const g of gs) for (const b of g.bounds) this.type(b);
    }

    typeDecl(d: A.TypeDecl, types: TypeTable): void {
        const entry = types.add(d.name, d, this.res.decls.get(d) ?? null);
        this.typeScope(d.generics, () => {
            for (const t of d.impls) this.type(t);
            if (d.alias) this.type(d.alias);
            for (const m of d.members ?? []) {
                if (m.kind === "Field") {
                    entry.addField(m.name, m, this);
                    this.field(m);
                } else {
                    entry.addMethod(m.name, m, this);
                    this.fn(m, null);
                }
            }
        });
    }

    field(f: A.Field): void {
        this.attributes(f.attrs, null);
        this.type(f.type);
        if (f.default) this.withScope(new Scope("block", this.scope), () => this.expr(f.default!));
    }

    unionDecl(d: A.UnionDecl, types: TypeTable): void {
        const entry = types.add(d.name, d, this.res.decls.get(d) ?? null);
        this.typeScope(d.generics, () => {
            for (const t of d.impls) this.type(t);
            for (const m of d.members) {
                if (m.kind === "Variant") {
                    entry.addField(m.name, m, this);
                    for (const t of m.tuple ?? []) this.type(t);
                    const seen = new Set<string>();
                    for (const f of m.fields ?? []) {
                        if (seen.has(f.name)) this.error("E_DUPLICATE_FIELD", `field \`${f.name}\` is declared twice`, f);
                        seen.add(f.name);
                        this.field(f);
                    }
                } else {
                    entry.addMethod(m.name, m, this);
                    this.fn(m, null);
                }
            }
        });
    }

    interDecl(d: A.InterDecl): void {
        this.typeScope(d.generics, () => {
            for (const t of d.supers) this.type(t);
            if (d.alias) this.type(d.alias);
            const seen = new Set<string>();
            for (const m of d.methods ?? []) {
                if (seen.has(m.name)) this.error("E_DUPLICATE_METHOD", `method \`${m.name}\` is declared twice`, m);
                seen.add(m.name);
                this.fn(m, null);
            }
        });
    }

    implDecl(d: A.ImplDecl, types: TypeTable): void {
        this.typeScope(d.generics, () => {
            for (const t of d.inters) this.type(t);
            this.type(d.target);
            const entry = d.target.kind === "TName" && d.target.path.length === 1 ? types.get(d.target.path[0]!) : undefined;
            for (const m of d.methods) {
                entry?.addMethod(m.name, m, this);
                this.fn(m, null);
            }
        });
    }

    /** The orphan rule (§8.4) and methods on aliases. */
    implChecks(d: A.ImplDecl, types: TypeTable): void {
        if (this.std) return;
        const target = d.target.kind === "TName" ? this.res.refs.get(d.target) : undefined;
        const local = (s: Sym | undefined) => s !== undefined && s.home === this.res && (s.kind === "type" || s.kind === "union" || s.kind === "inter");
        if (target && local(target) && target.decl && (target.decl as A.TypeDecl).kind === "TypeDecl" && (target.decl as A.TypeDecl).alias) {
            this.error("E_METHODS_ON_STRUCTURAL", `\`${target.name}\` is an alias: methods go on a nominal type`, d);
            return;
        }
        if (!target || target.kind === "generic") return;
        if (d.inters.length === 0) {
            if (!local(target) && target.kind !== "import") {
                this.error("E_ORPHAN_IMPL", `methods of \`${target.name}\` must be declared in its own package (${target.pkg})`, d);
            }
            return;
        }
        if (local(target) || target.kind === "import") return;
        for (const i of d.inters) {
            const s = i.kind === "TName" ? this.res.refs.get(i) : undefined;
            if (s && !local(s) && s.kind !== "import") {
                this.error("E_ORPHAN_IMPL", `\`impl ${s.name} for ${target.name}\`: neither is declared in this package`, d);
                return;
            }
        }
        void types;
    }

    /** E_AMBIGUOUS_IMPL_METHOD: two implemented interfaces declare the same method (§8.4). */
    ambiguousImplMethods(types: TypeTable, files: ResolveFile[]): void {
        const implemented = new Map<string, A.Type[]>();
        const add = (name: string, ts: A.Type[]) => implemented.set(name, [...(implemented.get(name) ?? []), ...ts]);
        for (const f of files) {
            for (const item of f.ast.items) {
                if (item.kind === "TypeDecl" || item.kind === "UnionDecl") add(item.name, item.impls);
                if (item.kind === "ImplDecl" && item.target.kind === "TName" && item.target.path.length === 1) add(item.target.path[0]!, item.inters);
            }
        }
        for (const [name, ts] of implemented) {
            const entry = types.get(name);
            if (!entry || ts.length < 2) continue;
            const origin = new Map<string, A.InterDecl>();
            for (const t of ts) {
                for (const [m, decl] of interMethods(t, this.res)) {
                    const prev = origin.get(m);
                    if (prev && prev !== decl && !entry.methods.has(m)) {
                        this.file = files.find((f) => f.ast.items.includes(entry.decl as A.Item)) ?? this.file;
                        this.error("E_AMBIGUOUS_IMPL_METHOD", `\`${name}\` implements two interfaces that both declare \`${m}\` (${prev.name} and ${decl.name})`, entry.decl as A.Item);
                    }
                    origin.set(m, decl);
                }
            }
        }
    }

    fn(f: A.FnDecl, _ctx: null): void {
        const scope = new Scope("function", this.scope);
        this.withScope(scope, () => {
            this.generics(f.generics);
            if (f.receiver) {
                scope.thisSym = this.sym("this", "this", f, this.file.path, f.span.start);
                scope.thisSym.mutable = f.receiver === "*this";
            }
            for (const p of f.params) {
                this.type(p.type);
                const s = this.declare(p.name, "param", p, p.star);
                if (s) s.mutable = p.star;
            }
            if (f.ret) this.type(f.ret);
            this.attributes(f.attrs, f);
            if (f.body) this.stmts(f.body.stmts);
        });
    }

    /** `#[effects(keeps: [v, this.items])]`: each path starts at a parameter or `this` (§8.6). */
    attributes(attrs: A.Attribute[], f: A.FnDecl | null): void {
        for (const a of attrs) {
            for (const arg of a.args) {
                for (const path of arg.paths) {
                    const root = path.split(".")[0]!;
                    const ok = f !== null && (root === "this" ? f.receiver !== null : f.params.some((p) => p.name === root));
                    if (!ok) this.error("E_UNDECLARED_NAME", `\`${root}\` in \`#[${a.name}]\` is not a parameter of this function`, a);
                }
            }
        }
    }

    // ---- scopes and declarations --------------------------------------------------------------

    withScope<T>(scope: Scope, f: () => T): T {
        const saved = this.scope;
        this.scope = scope;
        try {
            return f();
        } finally {
            this.scope = saved;
        }
    }

    declare(name: string, kind: SymKind, node: A.Span | object, mutable: boolean, into: Scope = this.scope): Sym | null {
        const start = (node as { span?: A.Span }).span?.start ?? 0;
        const at = { span: (node as { span?: A.Span }).span ?? { start, end: start } };
        if (name === "_") return null;
        if (IMPLICIT.test(name)) {
            this.error("E_RESERVED_IDENT", `\`${name}\` is reserved for implicit closure parameters`, at);
            return null;
        }
        if (into.names.has(name)) {
            this.error("E_DUPLICATE_BINDING", `\`${name}\` is already declared in this scope`, at);
            return null;
        }
        const s = this.sym(name, kind, node, this.file.path, start);
        s.mutable = mutable;
        into.names.set(name, s);
        this.res.decls.set(node, s);
        return s;
    }

    /**
     * Looks a name up. Returns the symbol and the closures crossed on the way, which capture it
     * when it is a local.
     */
    lookup(name: string): { sym: Sym; crossed: A.Closure[] } | null {
        const crossed: A.Closure[] = [];
        for (let s: Scope | null = this.scope; s && s.kind !== "file"; s = s.parent) {
            const hit = s.names.get(name);
            if (hit) return { sym: hit, crossed };
            if (s.kind === "closure" && s.closure) crossed.push(s.closure);
        }
        const hit =
            this.fileScope.names.get(name) ??
            this.res.items.get(name) ??
            this.fileScope.globs.get(name) ??
            this.prelude?.exports.get(name) ??
            this.builtins.names.get(name);
        return hit ? { sym: hit, crossed: [] } : null;
    }

    use(node: object, found: { sym: Sym; crossed: A.Closure[] }, at: { span: A.Span }): Sym {
        const { sym, crossed } = found;
        sym.used = true;
        if (sym.kind === "ambiguous") {
            const from = (sym.candidates ?? []).map((c) => c.pkg).join(" and ");
            this.error("E_AMBIGUOUS_IMPORT", `\`${sym.name}\` is exported by two glob imports (${from})`, at, "import it by name");
        }
        this.res.refs.set(node, sym);
        if (LOCAL_KINDS.has(sym.kind)) {
            for (const c of crossed) {
                const list = this.res.captures.get(c) ?? [];
                if (!list.includes(sym)) list.push(sym);
                this.res.captures.set(c, list);
            }
        }
        return sym;
    }

    /** A name in expression position. */
    name(node: A.Ident, assign = false): void {
        if (IMPLICIT.test(node.name)) return this.implicit(node);
        const found = this.lookup(node.name);
        if (found) {
            this.use(node, found, node);
            return;
        }
        if (this.fileScope.open || isUpper(node.name)) {
            this.res.deferred.push(node);
            return;
        }
        if (assign) {
            this.error("E_UNDECLARED_ASSIGNMENT", `\`${node.name}\` is not declared: use \`let\`, \`var\`, \`:=\` or \`:==\``, node);
        } else {
            this.error("E_UNDECLARED_NAME", `\`${node.name}\` is not declared`, node);
        }
    }

    /** `it` / `itN`: the innermost header-less closure or unnamed `or` (§4.4). */
    implicit(node: A.Ident): void {
        // only `or` scopes can sit between a use and its provider: a named closure stops the search
        const crossed: A.Closure[] = [];
        for (let s: Scope | null = this.scope; s && s.kind !== "function" && s.kind !== "file" && s.kind !== "type"; s = s.parent) {
            if ((s.kind === "closure" || s.kind === "or") && s.provider) {
                s.implicit ??= this.sym("it", "implicit", s.closure, this.file.path, node.span.start);
                this.use(node, { sym: s.implicit, crossed }, node);
                return;
            }
            if (s.kind === "closure") {
                this.error("E_IT_IN_NAMED_CLOSURE", `\`${node.name}\` can't be used in a closure with named parameters`, node);
                return;
            }
        }
        this.error("E_IT_OUTSIDE_CLOSURE", `\`${node.name}\` is only defined inside a closure without parameters, or after \`or\``, node);
    }

    thisExpr(node: A.This): void {
        const crossed: A.Closure[] = [];
        for (let s: Scope | null = this.scope; s && s.kind !== "file"; s = s.parent) {
            if (s.kind === "function") {
                if (s.thisSym) {
                    this.use(node, { sym: s.thisSym, crossed }, node);
                    return;
                }
                break;
            }
            if (s.kind === "closure" && s.closure) crossed.push(s.closure);
        }
        this.error("E_THIS_OUTSIDE_METHOD", "`this` exists only in methods with a receiver", node);
    }

    // ---- types --------------------------------------------------------------------------------

    type(t: A.Type): void {
        switch (t.kind) {
            case "TName":
                this.typeName(t);
                for (const a of t.args) this.type(a);
                return;
            case "TOptional":
                return this.type(t.inner);
            case "TTuple":
                for (const e of t.elems) this.type(e);
                return;
            case "TRecord":
                for (const f of t.fields) this.type(f.type);
                return;
            case "TFn":
                for (const p of t.params) this.type(p.type);
                return this.type(t.ret);
            case "TUnion":
                for (const a of t.alts) this.type(a);
                return;
            case "TInter":
                for (const p of t.parts) this.type(p);
                return;
            case "TTypeOf": {
                const found = this.lookup(t.path[0]!);
                if (found) this.use(t, found, t);
                else if (!this.fileScope.open) this.error("E_UNDECLARED_NAME", `\`${t.path[0]}\` is not declared`, t);
                return;
            }
            case "TLit": case "TError":
                return;
        }
    }

    typeName(t: A.NamedType): void {
        const first = t.path[0]!;
        if (first === "Self") {
            if (!this.selfOk) this.error("E_SELF_OUTSIDE_TYPE", "`Self` exists only inside a type, union, interface or impl", t);
            return;
        }
        const found = this.lookup(first);
        if (!found) {
            if (first === "string") this.error("E_STRING_TYPE_REMOVED", "`string` is now `str`", t, "str");
            else if (this.fileScope.open) this.res.deferred.push(t);
            else this.error("E_UNDECLARED_TYPE", `type \`${first}\` is not declared`, t);
            return;
        }
        const s = found.sym;
        if (t.path.length === 1) {
            if (s.kind === "package") this.error("E_NOT_A_TYPE", `\`${first}\` is a package, not a type`, t);
            else if (!TYPE_KINDS.has(s.kind)) this.error("E_NOT_A_TYPE", `\`${first}\` is a value, not a type`, t);
            else this.use(t, found, t);
            return;
        }
        if (s.kind === "package") {
            s.used = true;
            const item = this.packageItem(s, t.path[1]!, t, "type");
            if (item && t.path.length === 2) this.res.refs.set(t, item);
            return;
        }
        // `Union.Variant` or `Type.Assoc`: for the checker
        this.use(t, found, t);
        this.res.deferred.push(t);
    }

    /** `pkg.name` for a package symbol: the item, or a diagnostic. Unloaded packages stay unknown. */
    packageItem(pkg: Sym, name: string, at: { span: A.Span }, what: "type" | "value"): Sym | null {
        const target = pkg.target;
        if (!target) {
            this.res.deferred.push(at);
            return null;
        }
        const s = target.exports.get(name);
        if (s) return s;
        if (target.items.has(name)) {
            this.error("E_PRIVATE_ITEM", `\`${name}\` is not \`pub\` in ${target.pkg}`, at);
        } else if (what === "type") {
            this.error("E_UNDECLARED_TYPE", `package ${target.pkg} has no type \`${name}\``, at);
        } else {
            this.error("E_UNDECLARED_NAME", `package ${target.pkg} has no item \`${name}\``, at);
        }
        return null;
    }

    // ---- statements ---------------------------------------------------------------------------

    stmts(list: A.Stmt[]): void {
        for (const s of list) this.stmt(s);
    }

    stmt(s: A.Stmt): void {
        switch (s.kind) {
            case "LetStmt":
                if (s.type) this.type(s.type);
                this.expr(s.value);
                if (s.else) this.block(s.else);
                this.bindPattern(s.pattern, false);
                return;
            case "VarStmt": {
                if (s.type) this.type(s.type);
                // `var p = p` at the top of a body redeclares a parameter as a local copy (§5.1)
                const prev = this.scope.kind === "function" ? this.scope.names.get(s.name) : undefined;
                const redeclare = prev !== undefined && prev.kind === "param" && !prev.used;
                this.expr(s.value);
                if (redeclare) this.scope.names.delete(s.name);
                this.declare(s.name, "local", s, true);
                return;
            }
            case "ShortDecl":
                this.expr(s.value);
                this.declare(s.name, "local", s, s.mutable);
                return;
            case "ExprStmt":
                return this.expr(s.expr);
        }
    }

    block(b: A.Block): void {
        this.withScope(new Scope("block", this.scope), () => this.stmts(b.stmts));
    }

    // ---- patterns -----------------------------------------------------------------------------

    /** Binds a pattern's names into the current scope. */
    bindPattern(p: A.Pattern, isVarDefault: boolean, reuse?: Map<string, Sym>, seen?: Set<string>): void {
        switch (p.kind) {
            case "PWild": case "PLit": case "PRange": case "PError":
                return;
            case "PBind":
                return this.bindName(p.name, p, p.isVar || isVarDefault, reuse, seen);
            case "PTuple":
                for (const e of p.elems) this.bindPattern(e, isVarDefault, reuse, seen);
                return;
            case "PRecord":
                for (const f of p.fields) this.fieldPattern(f, isVarDefault, reuse, seen);
                return;
            case "PCtor":
                this.ctorPath(p);
                for (const a of p.args ?? []) this.bindPattern(a, isVarDefault, reuse, seen);
                for (const f of p.fields ?? []) this.fieldPattern(f, isVarDefault, reuse, seen);
                return;
            case "POr": {
                // every alternative binds the same names, to the same symbols (§8.7)
                const first = new Set<string>();
                const before = new Map(this.scope.names);
                this.bindPattern(p.alts[0]!, isVarDefault, reuse, first);
                const bound = new Map<string, Sym>();
                for (const [n, s] of this.scope.names) if (before.get(n) !== s) bound.set(n, s);
                for (const alt of p.alts.slice(1)) {
                    const names = new Set<string>();
                    this.bindPattern(alt, isVarDefault, bound, names);
                    const same = names.size === first.size && [...names].every((n) => first.has(n));
                    if (!same) {
                        const fmt = (xs: Set<string>) => (xs.size ? [...xs].join(", ") : "nothing");
                        this.error("E_INCONSISTENT_OR_BINDINGS", `this alternative binds ${fmt(names)}, the first binds ${fmt(first)}`, alt);
                    }
                }
                if (seen) for (const n of first) seen.add(n);
                return;
            }
        }
    }

    bindName(name: string, node: object, mutable: boolean, reuse?: Map<string, Sym>, seen?: Set<string>): void {
        seen?.add(name);
        const prev = reuse?.get(name);
        if (prev) {
            this.res.decls.set(node, prev);
            return;
        }
        this.declare(name, "local", node, mutable);
    }

    fieldPattern(f: A.FieldPat, isVarDefault: boolean, reuse?: Map<string, Sym>, seen?: Set<string>): void {
        if (f.pattern) this.bindPattern(f.pattern, isVarDefault, reuse, seen);
        else this.bindName(f.name, f, f.isVar || isVarDefault, reuse, seen);
    }

    /** The constructor of a pattern: `Some`, `Payment.Card`, `models.Role.Admin`. */
    ctorPath(p: A.PCtor): void {
        const first = p.path[0]!;
        const found = this.lookup(first);
        if (!found) {
            this.res.deferred.push(p);
            return;
        }
        if (p.path.length === 1) {
            this.use(p, found, p);
            return;
        }
        const s = found.sym;
        if (s.kind === "package") {
            s.used = true;
            const item = this.packageItem(s, p.path[1]!, p, "value");
            if (item && p.path.length === 2) this.res.refs.set(p, item);
            else this.res.deferred.push(p);
            return;
        }
        if (s.kind === "union" && s.decl && p.path.length === 2) {
            const u = s.decl as A.UnionDecl;
            const variant = u.members.find((m) => m.kind === "Variant" && m.name === p.path[1]);
            if (!variant) {
                this.error("E_UNKNOWN_VARIANT", `union \`${s.name}\` has no variant \`${p.path[1]}\``, p);
                return;
            }
            const v = s.home?.decls.get(variant);
            if (v) this.res.refs.set(p, v);
            s.used = true;
            return;
        }
        this.use(p, found, p);
        this.res.deferred.push(p);
    }

    // ---- expressions --------------------------------------------------------------------------

    expr(e: A.Expr): void {
        switch (e.kind) {
            case "Ident":
                return this.name(e);
            case "This":
                return this.thisExpr(e);
            case "SelfExpr":
                if (!this.selfOk) this.error("E_SELF_OUTSIDE_TYPE", "`Self` exists only inside a type, union, interface or impl", e);
                return;
            case "Int": case "Float": case "Str": case "Char": case "Byte": case "Bool": case "Nil": case "Error":
                return;
            case "Template":
                for (const x of e.exprs) this.expr(x);
                return;
            case "Vec": case "Array": case "Tuple": case "Set":
                this.sigil(e);
                for (const el of e.elems) this.expr(el.value);
                return;
            case "Record": case "Inferred":
                this.sigil(e);
                return this.recItems(e.items);
            case "Struct":
                this.expr(e.type);
                return this.recItems(e.items);
            case "Map":
                this.sigil(e);
                for (const en of e.entries) {
                    if (en.kind === "Entry") this.expr(en.key);
                    this.expr(en.value);
                }
                return;
            case "Closure":
                return this.closure(e);
            case "Paren":
                return this.expr(e.expr);
            case "Unary": case "Await":
                return this.expr(e.operand);
            case "Binary":
                this.expr(e.left);
                return this.expr(e.right);
            case "Assign":
                if (e.target.kind === "Ident") this.name(e.target, true);
                else this.expr(e.target);
                return this.expr(e.value);
            case "Range":
                if (e.start) this.expr(e.start);
                if (e.end) this.expr(e.end);
                return;
            case "As":
                this.expr(e.expr);
                return this.type(e.type);
            case "Or": {
                this.expr(e.expr);
                const scope = new Scope("or", this.scope);
                scope.provider = e.name === null;
                return this.withScope(scope, () => {
                    if (e.name !== null) this.declare(e.name, "local", e, false);
                    this.expr(e.rhs);
                });
            }
            case "Call":
                this.expr(e.callee);
                for (const a of e.args) this.expr(a.value);
                return;
            case "Index":
                this.expr(e.target);
                return this.expr(e.index);
            case "Member":
                return this.member(e);
            case "GenericApply":
                this.expr(e.target);
                for (const t of e.args) this.type(t);
                return;
            case "Try":
                return this.expr(e.expr);
            case "If":
                return this.ifExpr(e);
            case "Match":
                if (e.subject) this.expr(e.subject);
                for (const arm of e.arms) {
                    this.withScope(new Scope("block", this.scope), () => {
                        if (arm.pattern) this.bindPattern(arm.pattern, false);
                        if (arm.cond) this.expr(arm.cond);
                        if (arm.guard) this.expr(arm.guard);
                        this.expr(arm.body);
                    });
                }
                return;
            case "Select":
                for (const arm of e.arms) {
                    this.expr(arm.expr);
                    this.withScope(new Scope("block", this.scope), () => {
                        if (arm.pattern) this.bindPattern(arm.pattern, false);
                        this.expr(arm.body);
                    });
                }
                if (e.else) this.expr(e.else);
                return;
            case "Lock":
                for (const p of e.places) this.expr(p);
                return this.block(e.body);
            case "For":
                return this.forExpr(e);
            case "Block":
                return this.block(e);
            case "Unsafe": case "Recover":
                return this.block(e.body);
            case "Return":
                if (e.value) this.expr(e.value);
                return;
            case "Break":
                if (e.value) this.expr(e.value);
                return;
            case "Continue":
                return;
        }
    }

    member(e: A.Member): void {
        if (e.target.kind === "Ident" && !IMPLICIT.test(e.target.name)) {
            const found = this.lookup(e.target.name);
            if (found && found.sym.kind === "package") {
                this.use(e.target, found, e.target);
                const item = this.packageItem(found.sym, e.name, e, "value");
                if (item) this.res.refs.set(e, item);
                return;
            }
        }
        this.expr(e.target);
    }

    recItems(items: A.RecItem[]): void {
        const seen = new Set<string>();
        for (const it of items) {
            if (it.kind === "Spread") {
                this.expr(it.value);
                continue;
            }
            if (seen.has(it.name)) this.error("E_DUPLICATE_FIELD", `field \`${it.name}\` is given twice`, it);
            seen.add(it.name);
            if (it.value) this.expr(it.value);
            else {
                // shorthand `{ name }` reads the local `name`
                const ident: A.Ident = { kind: "Ident", span: it.span, name: it.name };
                this.name(ident);
                const s = this.res.refs.get(ident);
                if (s) this.res.refs.set(it, s);
            }
        }
    }

    /** E_SIGIL_SHADOWS_BINDING: `t(…)`, `a[…]`, `r{`, `m{`, `s{` while a value of that name is visible (§1.7). */
    sigil(e: A.Expr): void {
        const letter = SIGIL_LETTERS[e.kind];
        if (!letter || this.file.src[e.span.start] !== letter.charCodeAt(0)) return;
        const found = this.lookup(letter);
        if (found && VALUE_KINDS.has(found.sym.kind)) {
            this.error("E_SIGIL_SHADOWS_BINDING", `\`${letter}${e.kind === "Tuple" ? "(" : e.kind === "Array" ? "[" : "{"}\` is a literal, but \`${letter}\` is also a visible name here`, { span: { start: e.span.start, end: e.span.start + 2 } }, "rename the binding");
        }
    }

    closure(c: A.Closure): void {
        const scope = new Scope("closure", this.scope);
        scope.closure = c;
        scope.provider = c.params === null;
        this.res.captures.set(c, []);
        this.withScope(scope, () => {
            for (const p of c.params ?? []) {
                if (p.type) this.type(p.type);
                this.declare(p.name, "closure-param", p, p.isVar || p.star);
            }
            if (c.ret) this.type(c.ret);
            this.stmts(c.body);
        });
    }

    ifExpr(e: A.If): void {
        this.expr(e.cond);
        if (e.pattern) {
            this.withScope(new Scope("block", this.scope), () => {
                this.bindPattern(e.pattern!, false);
                this.block(e.then);
            });
        } else {
            this.block(e.then);
        }
        if (e.else) {
            if (e.else.kind === "If") this.ifExpr(e.else);
            else this.block(e.else);
        }
    }

    forExpr(e: A.For): void {
        if (e.expr) this.expr(e.expr);
        this.withScope(new Scope("block", this.scope), () => {
            if (e.pattern) this.bindPattern(e.pattern, false);
            if (e.pattern2) this.bindPattern(e.pattern2, false);
            this.block(e.body);
        });
    }
}

// ---- members of local types --------------------------------------------------------------------

class TypeEntry {
    readonly decl: A.TypeDecl | A.UnionDecl;
    readonly sym: Sym | null;
    readonly fields = new Map<string, object>();
    readonly methods = new Map<string, object>();

    constructor(decl: A.TypeDecl | A.UnionDecl, sym: Sym | null) {
        this.decl = decl;
        this.sym = sym;
    }

    addField(name: string, node: { span: A.Span }, r: Resolver): void {
        const what = this.decl.kind === "UnionDecl" ? "variant" : "field";
        if (this.fields.has(name)) r.error("E_DUPLICATE_FIELD", `${what} \`${name}\` is declared twice`, node);
        else this.fields.set(name, node);
    }

    addMethod(name: string, node: { span: A.Span }, r: Resolver): void {
        if (this.methods.has(name)) r.error("E_DUPLICATE_METHOD", `\`${this.decl.name}\` already has a method \`${name}\``, node);
        else if (this.fields.has(name)) r.error("E_DUPLICATE_METHOD", `\`${name}\` is already a field of \`${this.decl.name}\`: a method can't share its name`, node);
        else this.methods.set(name, node);
    }
}

class TypeTable {
    readonly entries = new Map<string, TypeEntry>();

    add(name: string, decl: A.TypeDecl | A.UnionDecl, sym: Sym | null): TypeEntry {
        const e = new TypeEntry(decl, sym);
        if (!this.entries.has(name)) this.entries.set(name, e);
        return this.entries.get(name)!;
    }

    get(name: string): TypeEntry | undefined {
        return this.entries.get(name);
    }
}

/** The methods an interface type brings, each with the interface that declares it. */
function interMethods(t: A.Type, res: Resolution, seen = new Set<object>()): Map<string, A.InterDecl> {
    const out = new Map<string, A.InterDecl>();
    const parts = t.kind === "TInter" ? t.parts : [t];
    for (const part of parts) {
        if (part.kind !== "TName") continue;
        const s = res.refs.get(part);
        const decl = s?.decl as A.InterDecl | undefined;
        if (!decl || decl.kind !== "InterDecl" || seen.has(decl)) continue;
        seen.add(decl);
        const home = s!.home ?? res;
        for (const m of decl.methods ?? []) out.set(m.name, decl);
        for (const sup of decl.supers) for (const [k, v] of interMethods(sup, home, seen)) if (!out.has(k)) out.set(k, v);
        if (decl.alias) for (const [k, v] of interMethods(decl.alias, home, seen)) if (!out.has(k)) out.set(k, v);
    }
    return out;
}

// ---- import paths ------------------------------------------------------------------------------

export interface ImportPath {
    /** the package part, without the item / items / glob suffix */
    base: string;
    items: string[] | null;
    glob: boolean;
}

/** Splits `"pkg.{a, b}"` and `"pkg.*"`; a plain path is returned whole (the loader decides item vs package). */
export function splitImportPath(path: string): ImportPath {
    const brace = /^(.*)\.\{([^}]*)\}$/.exec(path);
    if (brace) return { base: brace[1]!, items: brace[2]!.split(",").map((s) => s.trim()).filter(Boolean), glob: false };
    if (path.endsWith(".*")) return { base: path.slice(0, -2), items: null, glob: true };
    return { base: path, items: null, glob: false };
}

function lastSegment(path: string): string {
    const parts = path.split(/[./]/).filter((p) => p !== "" && p !== "..");
    return parts[parts.length - 1] ?? path;
}

/** Without a loader, an import binds what its path names, and its members stay unknown. */
function fallbackImport(path: string): LoadedImport {
    const p = splitImportPath(path);
    if (p.glob) return { pkg: null, item: null, items: null, glob: true };
    if (p.items) return { pkg: null, item: null, items: p.items, glob: false };
    const last = lastSegment(path);
    // `"std.io.println"` names an item; `"std.json"` a package. Without the file system, a
    // lowercase last segment after two segments of `std` reads as an item only if it isn't a
    // known package; keep it simple: bind the name, which works for both.
    return { pkg: null, item: isUpper(last) ? last : null, items: null, glob: false };
}
