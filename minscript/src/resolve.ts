// MinScript name resolution (spec §8.7).
//
// Binds every name the parser produced to the declaration it refers to, without needing types.
// The AST is not modified: the result is a set of side tables keyed by AST node.
//
// Scopes, innermost first: closure / block / function (params and the body's top level share one
// scope) → file (imports) → package (items of every file) → prelude (std stub).
// - Top-level items are order-independent; inside a function a name is visible after its `let`.
// - Redeclaring a name in the same scope is E_DUPLICATE_BINDING; an inner scope may shadow it.
// - Names that need types are left for the type checker and listed in `deferred`:
//   member names (`x.name`), bare uppercase names that aren't declared (`Text`, `Cash`: variants
//   inferred from the expected type, spec §7.6), and anything in a file with a glob import.

import type * as A from "./ast.ts"
import type { Diagnostic } from "./diagnostic.ts"
import { BUILTIN_TYPES, PRELUDE_TYPES, PRELUDE_VALUES, STD_PACKAGES } from "./std_stub.ts"
import type { Span } from "./token.ts"

export type SymbolKind =
    | "local"           // let / var / := / :== / pattern binding
    | "param"           // function parameter
    | "closure-param"
    | "implicit"        // it, it1 … itN (closure or `or` payload)
    | "this"            // method receiver
    | "fun" | "global" | "extern-fun"
    | "type" | "union" | "inter" | "generic"
    | "package"         // an imported package (`import "std.json"` → json)
    | "import"          // an imported item, or an import whose target isn't known yet
    | "builtin-type" | "prelude-type" | "prelude-value"
    | "variant"         // a union variant exported by the prelude (`Some`, `Ok`, `Less`)
    | "ambiguous"       // a name exported by two glob imports (E_AMBIGUOUS_IMPORT where it is used)

export type Sym = {
    id: number
    name: string
    kind: SymbolKind
    mutable: boolean
    decl: A.Node | null         // the declaring node (null for builtins and the prelude)
    span: Span | null
    scope: Scope
    detail?: string             // e.g. the import path
    std?: boolean               // declared by the prelude (std/prelude.ms)
    owner?: Sym                 // variant: its union
    pub?: boolean               // a top-level item declared `pub`
    pkg?: string                // a top-level item: the qualified name of its package ("main", "std.json", "app.models")
    target?: Resolution         // an imported package: its resolution
}

export type Resolution = {
    symbols: Sym[]
    /** Uses: Ident, This, TName, TTypeOf, PPath/PCall/PStruct, RecordField shorthand, Capture → symbol. */
    refs: Map<A.Node, Sym>
    /** Declarations: items, Param, ClosureParam, PBind, GenericParam → symbol. */
    decls: Map<A.Node, Sym>
    /** For each closure, the outer locals it uses (explicitly listed or not), in first-use order. */
    captures: Map<A.Node, Sym[]>
    /** Names left for the type checker. */
    deferred: A.Node[]
    /** The subset of `deferred` that is unknown only because the file has a glob import. */
    open: Set<A.Node>
    diagnostics: Diagnostic[]
    /** The package scope: its names are the package's items. */
    pkgScope: Scope
}

/** Options for `resolvePackage`. */
export type ResolveOptions = {
    /** The resolved prelude package; its items are visible everywhere. Defaults to std/prelude.ms. */
    prelude?: Resolution | null
    /** Resolving std itself: exempt from the orphan rule (std owns the built-in types). */
    std?: boolean
    /** The qualified name of the package being resolved; recorded on its items. Default "main". */
    packageName?: string
    /** Imports whose packages were loaded (src/loader.ts). Imports not listed stay opaque. */
    imports?: Map<A.Import, LoadedImport>
}

/** An import the loader found: the package, and which of its items the import names. */
export type LoadedImport = {
    pkg: Resolution
    path: string                // the package's qualified name ("std.io")
    item: string | null         // `"std.io.println"` → "println"
    items: string[] | null      // `"std.io.{print, println}"`
    glob: boolean               // `"std.collections.*"`
}

/** Unions of the prelude whose variants are visible without qualification (spec §10.1). */
const EXPORTED_VARIANTS: ReadonlySet<string> = new Set(["Option", "Result", "Ordering"])

type ScopeKind = "prelude" | "package" | "file" | "type" | "function" | "block" | "closure" | "or" | "arm"

export class Scope {
    readonly names = new Map<string, Sym>()
    readonly kind: ScopeKind
    readonly parent: Scope | null
    /** closure without a header, or `or` without a name: provides `it` */
    provider = false
    /** closure scope: the Closure node; `or` scope: the Or node (owner of the implicit `it`) */
    closure: A.Node | null = null
    /** file scope: has a glob import of a package that isn't loaded, so unknown names can't be reported */
    open = false
    /** file scope: names from loaded glob imports (searched after the package's own items) */
    globs: Map<string, Sym> | null = null
    constructor(kind: ScopeKind, parent: Scope | null) {
        this.kind = kind
        this.parent = parent
    }
}

const IMPLICIT_PARAM = /^it(?:[1-9][0-9]*)?$/
const LOCAL_KINDS: ReadonlySet<SymbolKind> = new Set(["local", "param", "closure-param", "implicit", "this"])
const TYPE_KINDS: ReadonlySet<SymbolKind> = new Set(["type", "union", "inter", "generic", "builtin-type", "prelude-type", "import", "package"])
/** Kinds that make a sigil letter ambiguous (E_SIGIL_SHADOWS_BINDING). */
const VALUE_KINDS: ReadonlySet<SymbolKind> = new Set(["local", "param", "closure-param", "fun", "global", "extern-fun", "import", "package"])

const isUpper = (s: string) => s.charCodeAt(0) >= 0x41 && s.charCodeAt(0) <= 0x5a

export function resolvePackage(files: A.File[], opts: ResolveOptions = {}): Resolution {
    const prelude = opts.prelude === undefined ? defaultPrelude() : opts.prelude
    return new Resolver(prelude, opts.std ?? false, opts.packageName ?? "main", opts.imports ?? new Map()).run(files)
}

/** The default prelude resolver, installed by src/prelude.ts (avoids an import cycle). */
let defaultPrelude: () => Resolution | null = () => null
export function setDefaultPrelude(get: () => Resolution | null): void {
    defaultPrelude = get
}

// ---------------------------------------------------------------------------------------------

type TypeCtx = { self: Sym | null }     // inside a type / union / inter / impl body
type FunCtx = { hasReceiver: boolean }

type MemberSource = { name: string, node: A.Node, from: string }   // from: "field" | "inline" | "inherent" | `impl X`

class Resolver {
    private readonly symbols: Sym[] = []
    private readonly refs = new Map<A.Node, Sym>()
    private readonly decls = new Map<A.Node, Sym>()
    private readonly captures = new Map<A.Node, Sym[]>()
    private readonly deferred: A.Node[] = []
    private readonly open = new Set<A.Node>()
    private readonly diagnostics: Diagnostic[] = []
    private readonly prelude = new Scope("prelude", null)
    private readonly pkg = new Scope("package", this.prelude)
    private typeCtx: TypeCtx | null = null
    private funCtx: FunCtx | null = null
    /** local type symbol → its members, for duplicate checks */
    private readonly members = new Map<Sym, MemberSource[]>()
    private readonly isStd: boolean
    private readonly pkgName: string
    private readonly loaded: Map<A.Import, LoadedImport>

    constructor(prelude: Resolution | null, isStd: boolean, pkgName: string, loaded: Map<A.Import, LoadedImport>) {
        this.isStd = isStd
        this.pkgName = pkgName
        this.loaded = loaded
        for (const name of BUILTIN_TYPES) this.define(this.prelude, name, "builtin-type", null, null)
        if (prelude !== null) {
            for (const [name, sym] of prelude.pkgScope.names) {
                this.prelude.names.set(name, sym)
                if (sym.kind === "union" && EXPORTED_VARIANTS.has(name) && sym.decl?.kind === "UnionDecl") {
                    for (const v of sym.decl.variants) {
                        const vs = this.define(this.prelude, v.name, "variant", v, v.span)
                        vs.std = true
                        vs.owner = sym
                    }
                }
            }
        }
        // names the prelude file doesn't declare yet (type-level forms): known, but opaque
        for (const name of PRELUDE_TYPES) if (!this.prelude.names.has(name)) this.define(this.prelude, name, "prelude-type", null, null)
        for (const [name, kind] of Object.entries(PRELUDE_VALUES)) {
            if (this.prelude.names.has(name)) continue
            const sym = this.define(this.prelude, name, kind === "package" ? "package" : "prelude-value", null, null)
            if (kind === "package") sym.detail = "std.log"
        }
    }

    run(files: A.File[]): Resolution {
        // 1. items of every file share the package scope
        for (const file of files) for (const item of file.items) this.declareItem(item)
        // 2. each file's imports, then its bodies
        for (const file of files) {
            const fileScope = new Scope("file", this.pkg)
            for (const imp of file.imports) this.declareImport(fileScope, imp)
            for (const item of file.items) this.resolveItem(fileScope, item)
        }
        // 3. member duplicates per local type
        for (const [sym, list] of this.members) this.checkMembers(sym, list)
        if (this.isStd) for (const sym of this.pkg.names.values()) sym.std = true
        return {
            symbols: this.symbols, refs: this.refs, decls: this.decls, captures: this.captures,
            deferred: this.deferred, open: this.open, diagnostics: this.diagnostics, pkgScope: this.pkg,
        }
    }

    // ---- symbols and diagnostics --------------------------------------------------------------

    private error(code: string, message: string, span: Span): void {
        this.diagnostics.push({ code, message, span: { ...span }, severity: "error" })
    }

    private define(scope: Scope, name: string, kind: SymbolKind, decl: A.Node | null, span: Span | null, mutable = false): Sym {
        const sym: Sym = { id: this.symbols.length, name, kind, mutable, decl, span, scope }
        this.symbols.push(sym)
        scope.names.set(name, sym)
        if (decl !== null) this.decls.set(decl, sym)
        return sym
    }

    /** Declares a binding, reporting redeclarations in the same scope and reserved names. */
    private bind(scope: Scope, name: string, kind: SymbolKind, decl: A.Node, span: Span, mutable = false): Sym {
        if (IMPLICIT_PARAM.test(name)) {
            this.error("E_RESERVED_IDENT", `\`${name}\` is reserved for implicit closure parameters`, span)
        }
        const prev = scope.names.get(name)
        if (prev !== undefined && name !== "_") {
            const where = prev.span ? ` (first declared at ${prev.span.line}:${prev.span.col})` : ""
            this.error("E_DUPLICATE_BINDING", `\`${name}\` is already declared in this scope${where}; a new binding may only shadow it from an inner scope`, span)
        }
        return this.define(scope, name, kind, decl, span, mutable)
    }

    private lookup(scope: Scope, name: string): Sym | undefined {
        let file: Scope | null = null
        for (let s: Scope | null = scope; s !== null; s = s.parent) {
            const sym = s.names.get(name)
            if (sym !== undefined) return sym
            if (s.kind === "file") file = s
            // glob-imported names come after the package's own items, before the prelude (spec §8.1)
            if (s.kind === "package" && file?.globs) {
                const g = file.globs.get(name)
                if (g !== undefined) return g
            }
        }
        return undefined
    }

    /** E_AMBIGUOUS_IMPORT for a use of a name two globs export; true if it was ambiguous. */
    private ambiguous(sym: Sym | undefined, at: Span): boolean {
        if (sym?.kind !== "ambiguous") return false
        this.error("E_AMBIGUOUS_IMPORT", `\`${sym.name}\` is exported by more than one glob import (${sym.detail}): import it explicitly, e.g. \`import "${sym.detail?.split(", ")[0]}.${sym.name}"\``, at)
        return true
    }

    private isOpen(scope: Scope): boolean {
        for (let s: Scope | null = scope; s !== null; s = s.parent) if (s.kind === "file") return s.open
        return false
    }

    /** Records a use of `sym` from `scope`, adding it to the captures of every closure crossed. */
    private use(node: A.Node, sym: Sym, scope: Scope): void {
        this.refs.set(node, sym)
        if (!LOCAL_KINDS.has(sym.kind)) return
        for (let s: Scope | null = scope; s !== null && s !== sym.scope; s = s.parent) {
            if (s.kind === "closure" && s.closure !== null) {
                const list = this.captures.get(s.closure)!
                if (!list.includes(sym)) list.push(sym)
            }
        }
    }

    // ---- items --------------------------------------------------------------------------------

    private declareItem(item: A.Item): void {
        const top = (name: string, kind: SymbolKind, node: A.Node, span: Span): void => {
            const prev = this.pkg.names.get(name)
            if (prev !== undefined) {
                const where = prev.span ? ` (first declared at ${prev.span.line}:${prev.span.col})` : ""
                this.error("E_DUPLICATE_DECLARATION", `\`${name}\` is declared more than once in this package${where}`, span)
                return
            }
            const sym = this.define(this.pkg, name, kind, node, span)
            sym.pkg = this.pkgName
            sym.pub = "pub" in node && node.pub === true
        }
        switch (item.kind) {
            case "FunDecl": top(item.name, "fun", item, item.span); break
            case "TypeDecl": top(item.name, "type", item, item.span); break
            case "UnionDecl": top(item.name, "union", item, item.span); break
            case "InterDecl": top(item.name, "inter", item, item.span); break
            case "LetDecl": top(item.name, "global", item, item.span); break
            case "ExternDecl": for (const f of item.funs) top(f.name, "extern-fun", f, f.span); break
            case "ImplDecl": break
        }
    }

    /** An item of a loaded package, by name: it must exist and be `pub`. */
    private exported(l: LoadedImport, name: string, imp: A.Import): Sym | undefined {
        const sym = l.pkg.pkgScope.names.get(name)
        if (sym === undefined) {
            this.error("E_UNKNOWN_IMPORT", `package \`${l.path}\` has no item \`${name}\``, imp.span)
            return undefined
        }
        if (!sym.pub) this.error("E_PRIVATE_ITEM", `\`${name}\` is private to package \`${l.path}\` (declare it \`pub\` to import it)`, imp.span)
        return sym
    }

    private declareLoadedImport(file: Scope, imp: A.Import, l: LoadedImport): void {
        const bindSym = (name: string, sym: Sym) => {
            if (this.pkg.names.has(name) || file.names.has(name)) {
                this.error("E_DUPLICATE_DECLARATION", `the import binds \`${name}\`, which is already declared in this package; use \`as\` to rename it`, imp.span)
                return
            }
            file.names.set(name, sym)
        }
        if (l.glob) {
            file.globs ??= new Map()
            for (const [name, sym] of l.pkg.pkgScope.names) {
                if (!sym.pub) continue
                const prev = file.globs.get(name)
                if (prev === undefined || prev === sym) { file.globs.set(name, sym); continue }
                const from = prev.kind === "ambiguous" ? prev.detail! : prev.pkg ?? "?"
                const marker = this.define(new Scope("file", null), name, "ambiguous", null, null)
                marker.detail = `${from}, ${l.path}`
                file.globs.set(name, marker)
            }
            return
        }
        if (l.items !== null) {
            for (const name of l.items) {
                const sym = this.exported(l, name, imp)
                if (sym) bindSym(name, sym)
            }
            return
        }
        if (l.item !== null) {
            const sym = this.exported(l, l.item, imp)
            if (sym) bindSym(imp.alias ?? l.item, sym)
            return
        }
        const name = imp.alias ?? l.path.slice(l.path.lastIndexOf(".") + 1)
        if (this.pkg.names.has(name) || file.names.has(name)) {
            this.error("E_DUPLICATE_DECLARATION", `the import binds \`${name}\`, which is already declared in this package; use \`as\` to rename it`, imp.span)
            return
        }
        const sym = this.define(file, name, "package", imp, imp.span)
        sym.detail = l.path
        sym.target = l.pkg
    }

    private declareImport(file: Scope, imp: A.Import): void {
        const loaded = this.loaded.get(imp)
        if (loaded !== undefined) return this.declareLoadedImport(file, imp, loaded)
        const path = imp.path
        const bindOne = (name: string, kind: SymbolKind) => {
            const name2 = imp.alias ?? name
            if (this.pkg.names.has(name2) || file.names.has(name2)) {
                this.error("E_DUPLICATE_DECLARATION", `the import binds \`${name2}\`, which is already declared in this package; use \`as\` to rename it`, imp.span)
                return
            }
            const sym = this.define(file, name2, kind, imp, imp.span)
            sym.detail = path
        }

        if (path.endsWith(".*")) {
            file.open = true
            return
        }
        const brace = /^(.*)\.\{(.*)\}$/.exec(path)
        if (brace !== null) {
            for (const raw of brace[2]!.split(",")) {
                const name = raw.trim()
                if (name !== "") bindOne(name, "import")
            }
            return
        }
        const clean = path.replace(/@.*$/, "")          // tool imports pin a version: "acme.lint@^1.2"
        const segments = clean.split(/[./]/).filter((s) => s !== "" && s !== "..")
        const last = segments[segments.length - 1] ?? clean
        const parent = clean.slice(0, clean.lastIndexOf("."))
        const kind: SymbolKind = STD_PACKAGES.has(clean) || !STD_PACKAGES.has(parent) ? "package" : "import"
        bindOne(last, kind)
    }

    private resolveItem(file: Scope, item: A.Item): void {
        switch (item.kind) {
            case "FunDecl": return this.resolveFun(file, item)
            case "LetDecl":
                if (item.type) this.resolveType(file, item.type)
                return this.resolveExpr(file, item.value)
            case "ExternDecl":
                for (const f of item.funs) this.resolveFun(file, f)
                return
            case "TypeDecl": return this.resolveTypeDecl(file, item)
            case "UnionDecl": return this.resolveUnionDecl(file, item)
            case "InterDecl": return this.resolveInterDecl(file, item)
            case "ImplDecl": return this.resolveImpl(file, item)
        }
    }

    private withType<T>(ctx: TypeCtx, fn: () => T): T {
        const saved = this.typeCtx
        this.typeCtx = ctx
        try { return fn() } finally { this.typeCtx = saved }
    }

    private genericScope(parent: Scope, generics: A.GenericParam[]): Scope {
        const scope = new Scope("type", parent)
        for (const g of generics) this.bind(scope, g.name, "generic", g, g.span)
        for (const g of generics) for (const b of g.bounds) this.resolveType(scope, b)
        return scope
    }

    private memberList(sym: Sym): MemberSource[] {
        let list = this.members.get(sym)
        if (list === undefined) {
            list = []
            this.members.set(sym, list)
        }
        return list
    }

    private resolveTypeDecl(file: Scope, d: A.TypeDecl): void {
        const sym = this.pkg.names.get(d.name)
        const scope = this.genericScope(file, d.generics)
        for (const t of d.impls) this.resolveType(scope, t)
        this.withType({ self: sym ?? null }, () => {
            if (d.body.kind !== "StructBody") {
                this.resolveType(scope, d.body)
                return
            }
            const list = sym ? this.memberList(sym) : []
            for (const f of d.body.fields) {
                list.push({ name: f.name, node: f, from: "field" })
                this.resolveType(scope, f.type)
                if (f.default) this.resolveExpr(scope, f.default)
            }
            for (const m of d.body.methods) {
                list.push({ name: m.name, node: m, from: "inline" })
                this.resolveFun(scope, m)
            }
        })
    }

    private resolveUnionDecl(file: Scope, d: A.UnionDecl): void {
        const sym = this.pkg.names.get(d.name)
        const scope = this.genericScope(file, d.generics)
        for (const t of d.impls) this.resolveType(scope, t)
        this.withType({ self: sym ?? null }, () => {
            const list = sym ? this.memberList(sym) : []
            for (const v of d.variants) {
                list.push({ name: v.name, node: v, from: "variant" })
                for (const t of v.tuple ?? []) this.resolveType(scope, t)
                const seen = new Set<string>()
                for (const f of v.fields ?? []) {
                    if (seen.has(f.name)) this.error("E_DUPLICATE_FIELD", `field \`${f.name}\` is declared twice in \`${v.name}\``, f.span)
                    seen.add(f.name)
                    this.resolveType(scope, f.type)
                    if (f.default) this.resolveExpr(scope, f.default)
                }
            }
            for (const m of d.methods) {
                list.push({ name: m.name, node: m, from: "inline" })
                this.resolveFun(scope, m)
            }
        })
    }

    private resolveInterDecl(file: Scope, d: A.InterDecl): void {
        const scope = this.genericScope(file, d.generics)
        for (const t of d.supers) this.resolveType(scope, t)
        if (d.composition) this.resolveType(scope, d.composition)
        this.withType({ self: this.pkg.names.get(d.name) ?? null }, () => {
            const seen = new Set<string>()
            for (const m of d.methods ?? []) {
                if (seen.has(m.name)) this.error("E_DUPLICATE_METHOD", `method \`${m.name}\` is declared twice in \`${d.name}\``, m.span)
                seen.add(m.name)
                this.resolveFun(scope, m)
            }
        })
    }

    private resolveImpl(file: Scope, d: A.ImplDecl): void {
        const scope = this.genericScope(file, d.generics)
        for (const t of d.interfaces) this.resolveType(scope, t)
        this.resolveType(scope, d.target)
        const target = d.target.kind === "TName" ? this.refs.get(d.target) : undefined
        const targetName = d.target.kind === "TName" ? d.target.path.join(".") : "this type"

        // orphan rule (spec §8.4): an impl lives in the package of the type, or of the interface
        const isLocal = (sym: Sym | undefined) => sym !== undefined && (sym.scope === this.pkg || (this.isStd && sym.kind === "builtin-type"))
        if (target !== undefined) {
            if (d.interfaces.length === 0 && !isLocal(target)) {
                this.error("E_ORPHAN_IMPL", `methods for \`${targetName}\` can only be added in the package that declares it`, d.target.span)
            } else if (d.interfaces.length > 0 && !isLocal(target)) {
                for (const iface of d.interfaces) {
                    const isym = iface.kind === "TName" ? this.refs.get(iface) : undefined
                    if (isym !== undefined && !isLocal(isym)) {
                        this.error("E_ORPHAN_IMPL", `\`impl ${isym.name} for ${targetName}\` must be in the package of \`${isym.name}\` or of \`${targetName}\``, iface.span)
                    }
                }
            }
            if (target.kind === "type" && target.decl?.kind === "TypeDecl" && target.decl.body.kind !== "StructBody") {
                this.error("E_METHODS_ON_STRUCTURAL", `\`${target.name}\` is an alias for a structural type, so it can't have methods; declare it as \`type ${target.name} = { … }\``, d.target.span)
            }
        }

        const from = d.interfaces.length === 0
            ? "inherent"
            : `impl ${d.interfaces.map((t) => (t.kind === "TName" ? t.path.join(".") : "?")).join(", ")}`
        const list = target !== undefined && isLocal(target) ? this.memberList(target) : null
        this.withType({ self: target ?? null }, () => {
            for (const m of d.methods) {
                list?.push({ name: m.name, node: m, from })
                this.resolveFun(scope, m)
            }
        })
    }

    private checkMembers(sym: Sym, list: MemberSource[]): void {
        const byName = new Map<string, MemberSource[]>()
        for (const m of list) {
            const l = byName.get(m.name) ?? []
            l.push(m)
            byName.set(m.name, l)
        }
        for (const [name, ms] of byName) {
            if (ms.length < 2) continue
            const kinds = ms.map((m) => m.from)
            for (let i = 1; i < ms.length; i++) {
                const m = ms[i]!
                const first = ms[0]!
                let code = "E_DUPLICATE_METHOD"
                let msg = `\`${sym.name}\` already has a member named \`${name}\` (${first.from})`
                if ((first.from === "field" || first.from === "variant") && (m.from === "field" || m.from === "variant")) {
                    code = "E_DUPLICATE_FIELD"
                    msg = `\`${sym.name}\` already has a ${first.from} named \`${name}\``
                } else if (kinds.every((k) => k.startsWith("impl ")) && new Set(kinds).size === kinds.length) {
                    code = "E_AMBIGUOUS_IMPL_METHOD"
                    msg = `\`${name}\` is defined by more than one interface implemented by \`${sym.name}\` (${kinds.join(", ")})`
                }
                this.error(code, msg, m.node.span)
            }
        }
    }

    private resolveFun(parent: Scope, f: A.FunDecl): void {
        const scope = new Scope("function", this.genericScope(parent, f.generics))
        if (f.receiver !== null) this.define(scope, "this", "this", null, null, f.receiver === "&mut this" || f.receiver === "mut this")
        for (const p of f.params) {
            this.resolveType(scope.parent!, p.type)
            this.bind(scope, p.name, "param", p, p.span, p.mut)
        }
        if (f.ret) this.resolveType(scope.parent!, f.ret)
        if (f.body === null) return
        const saved = this.funCtx
        this.funCtx = { hasReceiver: f.receiver !== null }
        try {
            this.resolveStmts(scope, f.body.stmts)      // params and the body's top level share a scope
        } finally {
            this.funCtx = saved
        }
    }

    // ---- types --------------------------------------------------------------------------------

    resolveType(scope: Scope, t: A.Type): void {
        switch (t.kind) {
            case "TName": {
                const head = t.path[0]!
                if (head === "Self") {
                    if (this.typeCtx === null) this.error("E_SELF_OUTSIDE_TYPE", "`Self` is only available inside a type, union, interface or impl", t.span)
                    else if (this.typeCtx.self !== null) this.refs.set(t, this.typeCtx.self)
                } else {
                    const sym = this.lookup(scope, head)
                    if (this.ambiguous(sym, t.span)) { for (const a of t.args) this.resolveType(scope, a); return }
                    if (sym === undefined) {
                        if (this.isOpen(scope)) this.deferred.push(t)
                        else this.error("E_UNDECLARED_TYPE", `unknown type \`${head}\``, t.span)
                    } else if (t.path.length === 1 && !TYPE_KINDS.has(sym.kind)) {
                        this.error("E_NOT_A_TYPE", `\`${head}\` is a ${describeKind(sym.kind)}, not a type`, t.span)
                    } else {
                        this.refs.set(t, sym)
                    }
                }
                for (const a of t.args) this.resolveType(scope, a)
                return
            }
            case "TOption": case "TRef": case "TPtr": return this.resolveType(scope, t.inner)
            case "TTuple": for (const e of t.elems) this.resolveType(scope, e); return
            case "TRecord": {
                const seen = new Set<string>()
                for (const f of t.fields) {
                    if (seen.has(f.name)) this.error("E_DUPLICATE_FIELD", `field \`${f.name}\` is declared twice`, f.span)
                    seen.add(f.name)
                    this.resolveType(scope, f.type)
                }
                return
            }
            case "TFn": for (const p of t.params) this.resolveType(scope, p); return this.resolveType(scope, t.ret)
            case "TTypeOf": {
                const sym = this.lookup(scope, t.path[0]!)
                if (this.ambiguous(sym, t.span)) return
                if (sym === undefined) {
                    if (this.isOpen(scope)) this.deferred.push(t)
                    else this.error("E_UNDECLARED_NAME", `unknown name \`${t.path[0]!}\``, t.span)
                } else {
                    this.refs.set(t, sym)
                }
                return
            }
            case "TUnion": case "TIntersection": for (const m of t.members) this.resolveType(scope, m); return
            case "TLiteral": case "TError": return
        }
    }

    // ---- statements ---------------------------------------------------------------------------

    private resolveStmts(scope: Scope, stmts: A.Stmt[]): void {
        for (const s of stmts) {
            if (s.kind === "ExprStmt") {
                this.resolveExpr(scope, s.expr)
                continue
            }
            this.resolveExpr(scope, s.value)            // `let x = x + 1` sees the outer `x`
            if (s.type) this.resolveType(scope, s.type)
            if (s.else) this.resolveBlock(scope, s.else)
            this.bindPattern(scope, s.pattern, s.mutable)
        }
    }

    private resolveBlock(parent: Scope, b: A.Block): void {
        this.resolveStmts(new Scope("block", parent), b.stmts)
    }

    // ---- patterns -----------------------------------------------------------------------------

    /** Resolves the paths in a pattern and declares its bindings in `scope`. */
    private bindPattern(scope: Scope, p: A.Pattern, mutable: boolean): void {
        const binds = new Map<string, A.Node[]>()
        this.patternNames(scope, p, binds, mutable)
        for (const [name, nodes] of binds) {
            const first = nodes[0]!
            const sym = this.bind(scope, name, "local", first, first.span, mutable || (first.kind === "PBind" && first.mut))
            for (const n of nodes.slice(1)) this.decls.set(n, sym)
        }
    }

    /**
     * Collects the bindings of `p` into `out` (name → binding nodes) and resolves its paths.
     * Or-patterns must bind the same names in every alternative.
     */
    private patternNames(scope: Scope, p: A.Pattern, out: Map<string, A.Node[]>, mutable: boolean): void {
        switch (p.kind) {
            case "PBind": {
                const prev = out.get(p.name)
                if (prev !== undefined) {
                    this.error("E_DUPLICATE_BINDING", `\`${p.name}\` is bound twice in the same pattern`, p.span)
                    return
                }
                out.set(p.name, [p])
                return
            }
            case "PPath": return this.resolvePatternPath(scope, p, p.path)
            case "PCall":
                this.resolvePatternPath(scope, p, p.path)
                for (const a of p.args) this.patternNames(scope, a, out, mutable)
                return
            case "PStruct":
                if (p.path !== null) this.resolvePatternPath(scope, p, p.path)
                for (const f of p.fields) {
                    if (f.pattern === null) {
                        // shorthand `Card { number }` binds `number`
                        if (out.has(f.name)) this.error("E_DUPLICATE_BINDING", `\`${f.name}\` is bound twice in the same pattern`, f.span)
                        else out.set(f.name, [f])
                    } else {
                        this.patternNames(scope, f.pattern, out, mutable)
                    }
                }
                return
            case "PTuple": for (const e of p.elems) this.patternNames(scope, e, out, mutable); return
            case "POr": {
                const alts = p.alts.map((alt) => {
                    const m = new Map<string, A.Node[]>()
                    this.patternNames(scope, alt, m, mutable)
                    return m
                })
                const first = alts[0]!
                const names = [...first.keys()].sort().join(",")
                for (let i = 1; i < alts.length; i++) {
                    if ([...alts[i]!.keys()].sort().join(",") !== names) {
                        this.error("E_INCONSISTENT_OR_BINDINGS", "every alternative of an or-pattern must bind the same names", p.alts[i]!.span)
                    }
                }
                for (const m of alts) {
                    for (const [name, nodes] of m) {
                        const prev = out.get(name)
                        if (prev === undefined) out.set(name, [...nodes])
                        else if (m !== first || !first.has(name)) prev.push(...nodes)
                        else this.error("E_DUPLICATE_BINDING", `\`${name}\` is bound twice in the same pattern`, nodes[0]!.span)
                    }
                }
                return
            }
            case "PWild": case "PLit": case "PRange": case "PError": return
        }
    }

    private resolvePatternPath(scope: Scope, node: A.Node, path: string[]): void {
        const head = path[0]!
        if (head === "Self") {
            if (this.typeCtx?.self) this.refs.set(node, this.typeCtx.self)
            else if (this.typeCtx === null) this.error("E_SELF_OUTSIDE_TYPE", "`Self` is only available inside a type, union, interface or impl", node.span)
            return
        }
        const sym = this.lookup(scope, head)
        if (this.ambiguous(sym, node.span)) return
        if (sym === undefined) {
            // `Cash`, `Close`: variants of the scrutinee's type (spec §6)
            if (path.length === 1 || isUpper(head) || this.isOpen(scope)) this.deferred.push(node)
            else this.error("E_UNDECLARED_NAME", `unknown name \`${head}\``, node.span)
            return
        }
        this.refs.set(node, sym)
        // `Shape.Line` in a pattern: a union of this package must have that variant
        if (path.length === 2 && sym.kind === "union" && sym.decl?.kind === "UnionDecl") {
            const variant = path[1]!
            if (!sym.decl.variants.some((v) => v.name === variant)) {
                this.error("E_UNKNOWN_VARIANT", `\`${sym.name}\` has no variant \`${variant}\``, node.span)
            }
        }
    }

    // ---- expressions --------------------------------------------------------------------------

    private resolveName(scope: Scope, node: A.Node, name: string, assigning = false): void {
        if (IMPLICIT_PARAM.test(name)) return this.resolveImplicit(scope, node, name)
        if (name === "Self") {
            if (this.typeCtx === null) this.error("E_SELF_OUTSIDE_TYPE", "`Self` is only available inside a type, union, interface or impl", node.span)
            else if (this.typeCtx.self !== null) this.refs.set(node, this.typeCtx.self)
            return
        }
        if (name === "_") return
        const sym = this.lookup(scope, name)
        if (this.ambiguous(sym, node.span)) return
        if (sym !== undefined) return this.use(node, sym, scope)
        if (isUpper(name) || this.isOpen(scope)) {
            this.deferred.push(node)
            if (this.isOpen(scope)) this.open.add(node)
            return
        }
        if (assigning) this.error("E_UNDECLARED_ASSIGNMENT", `\`${name}\` is not declared: declare it with \`let\`, \`var\`, \`:=\` or \`:==\``, node.span)
        else this.error("E_UNDECLARED_NAME", `unknown name \`${name}\``, node.span)
    }

    /** `it` / `itN`: the payload of the innermost header-less closure or unnamed `or`. */
    private resolveImplicit(scope: Scope, node: A.Node, name: string): void {
        for (let s: Scope | null = scope; s !== null; s = s.parent) {
            if (s.kind === "closure" && !s.provider) return     // named closure: the parser reported E_IT_IN_NAMED_CLOSURE
            if ((s.kind === "closure" || s.kind === "or") && s.provider) {
                const key = name === "it" ? "it1" : name
                let sym = s.names.get(key)
                if (sym === undefined) {
                    sym = this.define(s, key, "implicit", null, null)
                    if (name === "it" || name === "it1") s.names.set(name === "it" ? "it1" : "it", sym)
                }
                return this.use(node, sym, scope)
            }
            if (s.kind === "function" || s.kind === "file") break
        }
        this.error("E_IT_OUTSIDE_CLOSURE", `\`${name}\` is only available in a closure without parameters (\`#{ … }\`) or after \`or\``, node.span)
    }

    private checkSigil(scope: Scope, letter: string, span: Span): void {
        const sym = this.lookup(scope, letter)
        if (sym !== undefined && VALUE_KINDS.has(sym.kind)) {
            this.error("E_SIGIL_SHADOWS_BINDING", `\`${letter}\` is a ${describeKind(sym.kind)} here, so \`${letter}${sigilOpener(letter)}…\` is ambiguous; rename the ${describeKind(sym.kind)}`, span)
        }
    }

    private resolveFields(scope: Scope, fields: (A.RecordField | A.Spread)[]): void {
        const seen = new Set<string>()
        for (const f of fields) {
            if (f.kind === "Spread") { this.resolveExpr(scope, f.expr); continue }
            if (f.key !== "" && seen.has(f.key)) this.error("E_DUPLICATE_FIELD", `field \`${f.key}\` is given twice`, f.span)
            seen.add(f.key)
            if (f.value !== null) this.resolveExpr(scope, f.value)
            else this.resolveName(scope, f, f.key)          // shorthand `r{ name }` reads `name`
        }
    }

    private resolveElems(scope: Scope, elems: (A.Expr | A.Spread)[]): void {
        for (const e of elems) this.resolveExpr(scope, e.kind === "Spread" ? e.expr : e)
    }

    resolveExpr(scope: Scope, e: A.Expr): void {
        switch (e.kind) {
            case "Ident": return this.resolveName(scope, e, e.name)
            case "This": {
                const sym = this.lookup(scope, "this")
                if (sym === undefined) {
                    const where = this.funCtx === null ? "here" : "in a function without a receiver"
                    this.error("E_THIS_OUTSIDE_METHOD", `\`this\` is not available ${where}: only methods declared with \`this\`, \`&this\`, \`&mut this\` or \`mut this\` have it`, e.span)
                    return
                }
                return this.use(e, sym, scope)
            }
            case "Int": case "Float": case "Char": case "Bool": case "Nil": case "Error": return
            case "Str":
                if (e.raw) this.checkSigil(scope, "r", e.span)
                return
            case "Template": for (const p of e.parts) if (typeof p !== "string") this.resolveExpr(scope, p); return
            case "Paren": return this.resolveExpr(scope, e.expr)
            case "Vec": return this.resolveElems(scope, e.elems)
            case "Array": this.checkSigil(scope, "a", e.span); return this.resolveElems(scope, e.elems)
            case "Tuple": this.checkSigil(scope, "t", e.span); return this.resolveElems(scope, e.elems)
            case "Set": this.checkSigil(scope, "s", e.span); return this.resolveElems(scope, e.elems)
            case "Record": this.checkSigil(scope, "r", e.span); return this.resolveFields(scope, e.fields)
            case "Inferred": return this.resolveFields(scope, e.fields)
            case "Map":
                this.checkSigil(scope, "m", e.span)
                for (const m of e.entries) {
                    if (m.kind === "Spread") this.resolveExpr(scope, m.expr)
                    else { this.resolveExpr(scope, m.key); this.resolveExpr(scope, m.value) }
                }
                return
            case "StructLit": {
                this.resolveExpr(scope, e.type)
                const head = structHead(e.type)
                const sym = head ? this.refs.get(head) : undefined
                if (sym !== undefined && head !== null && head === e.type && !TYPE_KINDS.has(sym.kind)) {
                    this.error("E_NOT_A_TYPE", `\`${sym.name}\` is a ${describeKind(sym.kind)}, not a type`, head.span)
                }
                return this.resolveFields(scope, e.fields)
            }
            case "Closure": return this.resolveClosure(scope, e)
            case "Unary": case "Await": case "Try": return this.resolveExpr(scope, e.expr)
            case "Binary": this.resolveExpr(scope, e.left); return this.resolveExpr(scope, e.right)
            case "Assign":
                if (e.target.kind === "Ident") this.resolveName(scope, e.target, e.target.name, true)
                else this.resolveExpr(scope, e.target)
                return this.resolveExpr(scope, e.value)
            case "Range":
                if (e.start) this.resolveExpr(scope, e.start)
                if (e.end) this.resolveExpr(scope, e.end)
                return
            case "As": this.resolveExpr(scope, e.expr); return this.resolveType(scope, e.type)
            case "Or": {
                this.resolveExpr(scope, e.expr)
                const orScope = new Scope("or", scope)
                orScope.closure = e             // owner node: links the implicit `it` back to this `or`
                if (e.name === null) orScope.provider = true
                else this.bind(orScope, e.name, "local", e, e.nameSpan ?? e.span)
                return this.resolveExpr(orScope, e.rhs)
            }
            // member names (`x.name`, `Shape.Line`, `json.parse`) need types: the type checker resolves them
            case "Member": case "OptMember": return this.resolveExpr(scope, e.object)
            case "Call": this.resolveExpr(scope, e.callee); return this.resolveElems(scope, e.args)
            case "Index": this.resolveExpr(scope, e.object); return this.resolveExpr(scope, e.index)
            case "GenericApply": this.resolveExpr(scope, e.target); for (const t of e.args) this.resolveType(scope, t); return
            case "If": {
                const thenScope = new Scope("arm", scope)
                if (e.cond.kind === "LetCond") {
                    this.resolveExpr(scope, e.cond.value)
                    this.bindPattern(thenScope, e.cond.pattern, false)
                } else {
                    this.resolveExpr(scope, e.cond)
                }
                this.resolveBlock(thenScope, e.then)
                if (e.else) {
                    if (e.else.kind === "Block") this.resolveBlock(scope, e.else)
                    else this.resolveExpr(scope, e.else)
                }
                return
            }
            case "Match": {
                if (e.subject) this.resolveExpr(scope, e.subject)
                for (const arm of e.arms) {
                    const armScope = new Scope("arm", scope)
                    if (arm.pattern) this.bindPattern(armScope, arm.pattern, false)
                    if (arm.test) this.resolveExpr(scope, arm.test)
                    if (arm.guard) this.resolveExpr(armScope, arm.guard)
                    this.resolveExpr(armScope, arm.body)
                }
                return
            }
            case "Select": {
                for (const arm of e.arms) {
                    this.resolveExpr(scope, arm.expr)
                    const armScope = new Scope("arm", scope)
                    if (arm.pattern) this.bindPattern(armScope, arm.pattern, false)
                    this.resolveExpr(armScope, arm.body)
                }
                if (e.else) this.resolveExpr(scope, e.else)
                return
            }
            case "For": {
                const bodyScope = new Scope("arm", scope)
                if (e.expr) this.resolveExpr(scope, e.expr)
                if (e.pattern) this.bindPattern(bodyScope, e.pattern, false)
                if (e.pattern2) this.bindPattern(bodyScope, e.pattern2, false)
                return this.resolveBlock(bodyScope, e.body)
            }
            case "Block": return this.resolveBlock(scope, e)
            case "Unsafe": case "Recover": return this.resolveBlock(scope, e.body)
            case "Return": if (e.value) this.resolveExpr(scope, e.value); return
            case "Break": if (e.value) this.resolveExpr(scope, e.value); return
            case "Continue": return
        }
    }

    private resolveClosure(parent: Scope, c: Extract<A.Expr, { kind: "Closure" }>): void {
        const scope = new Scope("closure", parent)
        scope.closure = c
        scope.provider = c.params === null
        this.captures.set(c, [])
        for (const cap of c.captures ?? []) {
            const sym = this.lookup(parent, cap.name)
            if (sym === undefined) {
                this.error("E_UNDECLARED_NAME", `unknown name \`${cap.name}\` in the capture list`, cap.span)
            } else if (!LOCAL_KINDS.has(sym.kind)) {
                this.error("E_INVALID_CAPTURE", `\`${cap.name}\` is a ${describeKind(sym.kind)}; only local variables are captured`, cap.span)
            } else {
                this.refs.set(cap, sym)
                const list = this.captures.get(c)!
                if (!list.includes(sym)) list.push(sym)
                // a capture crossing outer closures is captured by them too
                this.use(cap, sym, parent)
            }
        }
        for (const p of c.params ?? []) {
            if (p.type) this.resolveType(parent, p.type)
            this.bind(scope, p.name, "closure-param", p, p.span, p.mut)
        }
        if (c.ret) this.resolveType(parent, c.ret)
        this.resolveStmts(scope, c.body.stmts)
    }
}

// ---------------------------------------------------------------------------------------------

/** The Ident at the head of a struct literal's type path (`models.User` → models). */
function structHead(e: A.Expr): A.Expr | null {
    if (e.kind === "Ident") return e
    if (e.kind === "Member") return structHead(e.object)
    if (e.kind === "GenericApply") return structHead(e.target)
    return null
}

function sigilOpener(letter: string): string {
    return letter === "t" ? "(" : letter === "a" ? "[" : letter === "r" ? "{` / `r\"" : "{"
}

export function describeKind(kind: SymbolKind): string {
    switch (kind) {
        case "local": return "variable"
        case "param": return "parameter"
        case "closure-param": return "closure parameter"
        case "implicit": return "implicit parameter"
        case "this": return "receiver"
        case "fun": return "function"
        case "global": return "global"
        case "extern-fun": return "extern function"
        case "type": return "type"
        case "union": return "union"
        case "inter": return "interface"
        case "generic": return "type parameter"
        case "package": return "package"
        case "import": return "imported name"
        case "builtin-type": return "built-in type"
        case "prelude-type": return "prelude type"
        case "prelude-value": return "prelude value"
        case "variant": return "variant"
        case "ambiguous": return "ambiguous name"
    }
}
