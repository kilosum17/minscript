// Name resolution (spec §8.7), ported from minscript/src/resolve.ts.
//
// Binds every name the parser produced to the declaration it refers to, without needing types. The
// AST is not modified: the result is a set of side tables keyed by node id.
//
// Scopes, innermost first: closure / block / function (params and the body's top level share one
// scope) → file (imports) → package (items of every file) → prelude.
// - Top-level items are order-independent; inside a function a name is visible after its `let`.
// - Redeclaring a name in the same scope is E_DUPLICATE_BINDING; an inner scope may shadow it.
// - Names that need types are left for the type checker and listed in `deferred`: member names
//   (`x.name`), bare uppercase names that aren't declared (`Text`, `Cash`: variants inferred from the
//   expected type, spec §7.6), and anything in a file with a glob import.
//
// Stage 0 links symbols and scopes as objects; here they are arenas (`symbols`, `scopes`) and
// indices. A program has one arena: a package's resolution starts with the prelude's symbols and
// scopes (same indices) and appends its own (from `first_own`).
//
// Imports of packages the loader found (`LoadedImport`) bind their items; the program's arena then
// holds the loaded packages too (each package's resolution starts from the one before it, in
// dependency order), so an imported package is known by the index of its package scope.
package resolve

import "app.lexer.{Span, Diagnostic}"
import "app.ast.*"

/// The prelude's names, as the resolver of a package sees them.
pub type Sym = {
    pub id: int
    pub name: string
    /// "local", "param", "closure-param", "implicit", "this", "fun", "global", "extern-fun", "type",
    /// "union", "inter", "generic", "package", "import", "builtin-type", "prelude-type",
    /// "prelude-value", "variant", "ambiguous"
    pub kind: string
    pub mutable: bool
    /// the declaring node's id (None for builtins)
    pub decl: int?
    pub span: Span?
    pub scope: int
    /// e.g. the import path
    pub detail: string?
    /// declared by the prelude (std/prelude.ms)
    pub std: bool = false
    /// a variant: its union
    pub owner: int?
    /// a top-level item: declared `pub` (None for other symbols)
    pub is_pub: bool?
    /// a top-level item: the qualified name of its package
    pub pkg: string?
    /// a union: its variants (name, span, node id), for exported variants and `Union.Variant` checks
    pub variants: Vec[VariantInfo] = []
    /// a type: an alias of a structural type (no struct body), which can't have methods
    pub alias: bool = false
    /// an imported package the loader found: its package scope (stage 0: `target`, its resolution)
    pub target: int?
    /// its index in its own package's resolution (stage 0's `Sym.id`: arena index − `first_own`)
    pub index: int = 0
}

pub type VariantInfo = r{ name: string, span: Span, id: int }

pub type Scope = {
    pub names: Map[string, int] = m{}
    /// "prelude", "package", "file", "type", "function", "block", "closure", "or", "arm"
    pub kind: string
    pub parent: int?
    /// closure without a header, or `or` without a name: provides `it`
    pub provider: bool = false
    /// closure scope: the Closure node; `or` scope: the Or node (owner of the implicit `it`)
    pub closure: int?
    /// file scope: has a glob import of a package that isn't loaded, so unknown names can't be reported
    pub open: bool = false
    /// file scope: names from loaded glob imports (searched after the package's own items)
    pub globs: Map[string, int]?
}

/// A use of a name: the symbol, and how the dump shows the node.
pub type Ref = r{ sym: int, span: Span, label: string }

/// A name left for the type checker.
pub type Deferred = r{ id: int, span: Span, label: string }

/// The outer locals a closure uses, in first-use order.
pub type Captures = { pub span: Span, pub syms: Vec[int] = [] }

pub type Resolution = {
    pub symbols: Vec[Sym]
    pub scopes: Vec[Scope]
    /// uses: Ident, This, TName, TTypeOf, PPath/PCall/PStruct, RecordField shorthand, Capture → symbol
    pub refs: Map[int, Ref]
    /// declarations: items, Param, ClosureParam, PBind, GenericParam → symbol
    pub decls: Map[int, int]
    /// closure → the outer locals it uses
    pub captures: Map[int, Captures]
    pub deferred: Vec[Deferred]
    /// the deferred names unknown only because the file has a glob import
    pub open: Set[int]
    pub diagnostics: Vec[Diagnostic]
    /// the package scope: its names are the package's items
    pub pkg_scope: int
    /// the index of this package's first symbol (the ones before belong to the prelude)
    pub first_own: int
    /// the package's qualified name ("main", "std.json", "app.models")
    pub package_name: string = ""
}

/// An import the loader found: the package (its package scope in the arena), and which of its items
/// the import names.
pub type LoadedImport = {
    pub pkg_scope: int
    /// the package's qualified name ("std.io")
    pub path: string
    /// `"std.io.println"` → "println"
    pub item: string?
    /// `"std.io.{print, println}"`
    pub items: Vec[string]?
    /// `"std.collections.*"`
    pub glob: bool
}

/// Options for `resolve_package`.
pub type ResolveOptions = {
    /// resolving std itself: exempt from the orphan rule (std owns the built-in types)
    pub std: bool = false
    /// the qualified name of the package being resolved; recorded on its items
    pub package_name: string = "main"
}

// ---- tables ---------------------------------------------------------------------------------------

/// Primitive types (spec §7.2).
fun builtin_types() -> Vec[string] {
    ["bool", "char", "byte", "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "isize", "usize",
        "int", "f32", "f64", "void", "never", "string", "str"]
}

/// Prelude types and interfaces the prelude file may not declare (spec §10.1, §10.2, §9.10, §7.5).
fun prelude_types() -> Vec[string] {
    ["Option", "Result", "Promise", "Resolver", "Ref", "Box", "Weak", "Vec", "Map", "Set", "Array", "Slice",
        "Panic", "PanicKind", "Ordering", "Timeout",
        "Topic", "Queue", "Signal", "Sub", "Watcher", "TopicOptions", "QueueOptions", "PublishError",
        "Copy", "Clone", "Drop", "Default", "Stringer", "PartialEq", "PartialOrd", "Hash", "Handle",
        "Plus", "Minus", "Times", "Divide", "Remainder",
        "PlusAssign", "MinusAssign", "TimesAssign", "DivideAssign", "RemainderAssign",
        "Index", "IndexMut", "Iterator", "AsyncIterator", "Iterable",
        "KeyOf", "ElementOf", "IndexOf", "Partial", "Omit", "Pick"]
}

/// Prelude values: variants of prelude unions, functions, and the `log` package (name, kind).
fun prelude_values() -> Vec[t(string, string)] {
    [t("Some", "variant"), t("None", "variant"), t("Ok", "variant"), t("Err", "variant"),
        t("Less", "variant"), t("Equal", "variant"), t("Greater", "variant"),
        t("assert", "fun"), t("panic", "fun"), t("log", "package")]
}

fun std_package(path: &str) -> bool {
    match path {
        "std" | "std.io" | "std.log" | "std.fs" | "std.json" | "std.time" | "std.runtime" | "std.env" | "std.math" => true
        "std.crypto" | "std.collections" | "std.net" | "std.net.ws" | "std.net.http" | "std.process" | "std.test" => true
        _ => false
    }
}

/// Unions of the prelude whose variants are visible without qualification (spec §10.1).
fun exported_variants(name: &str) -> bool { name == "Option" || name == "Result" || name == "Ordering" }

fun local_kind(k: &str) -> bool {
    match k {
        "local" | "param" | "closure-param" | "implicit" | "this" => true
        _ => false
    }
}

fun type_kind(k: &str) -> bool {
    match k {
        "type" | "union" | "inter" | "generic" | "builtin-type" | "prelude-type" | "import" | "package" => true
        _ => false
    }
}

/// Kinds that make a sigil letter ambiguous (E_SIGIL_SHADOWS_BINDING).
fun value_kind(k: &str) -> bool {
    match k {
        "local" | "param" | "closure-param" | "fun" | "global" | "extern-fun" | "import" | "package" => true
        _ => false
    }
}

fun is_upper(s: &str) -> bool {
    if s.is_empty() {
        return false
    }
    let c = s.byte_at(0) as int
    c >= 0x41 && c <= 0x5a
}

/// `it`, `it1`, `it2`, …
fun is_implicit_param(name: &str) -> bool {
    if name == "it" {
        return true
    }
    if !name.starts_with("it") || name.len() < 3 {
        return false
    }
    let first = name.byte_at(2) as int
    if first < 0x31 || first > 0x39 {
        return false
    }
    var i = 3
    for i < name.len() {
        let c = name.byte_at(i) as int
        if c < 0x30 || c > 0x39 {
            return false
        }
        i += 1
    }
    true
}

pub fun describe_kind(kind: &str) -> string {
    match kind {
        "local" => "variable"
        "param" => "parameter"
        "closure-param" => "closure parameter"
        "implicit" => "implicit parameter"
        "this" => "receiver"
        "fun" => "function"
        "global" => "global"
        "extern-fun" => "extern function"
        "type" => "type"
        "union" => "union"
        "inter" => "interface"
        "generic" => "type parameter"
        "package" => "package"
        "import" => "imported name"
        "builtin-type" => "built-in type"
        "prelude-type" => "prelude type"
        "prelude-value" => "prelude value"
        "variant" => "variant"
        _ => "ambiguous name"
    }
}

fun sigil_opener(letter: &str) -> string {
    match letter {
        "t" => "("
        "a" => "["
        "r" => "{` / `r\""
        _ => "{"
    }
}

// ---- entry point ----------------------------------------------------------------------------------

/// Resolves the files of one package. `prelude`: the resolved prelude (None when resolving it).
pub fun resolve_package(files: &Vec[File], prelude: &Resolution?, opts: ResolveOptions) -> Resolution {
    var r = Resolver { is_std: opts.std, pkg_name: opts.package_name }
    match prelude {
        Some(p) => {
            r.begin(p.symbols.clone(), p.scopes.clone())
            r.add_prelude(p)
        }
        None => r.begin([], [])
    }
    r.finish_prelude()
    r.run(files)
}

/// Resolves a package of a loaded program: `symbols` and `scopes` are the arenas so far (those of the
/// package analysed before this one, which this resolution continues), `imports` the loaded imports
/// by Import id.
pub fun resolve_loaded(files: &Vec[File], prelude: &Resolution, symbols: Vec[Sym], scopes: Vec[Scope], imports: Map[int, LoadedImport], opts: ResolveOptions) -> Resolution {
    var r = Resolver { is_std: opts.std, pkg_name: opts.package_name, loaded: imports }
    r.begin(symbols, scopes)
    r.add_prelude(prelude)
    r.finish_prelude()
    r.run(files)
}

/// What a member of a local type is, for the duplicate checks.
type MemberSource = r{ name: string, span: Span, from: string }

/// A binding a pattern makes: its node, and whether it is `mut`.
type BindNode = r{ id: int, span: Span, is_mut: bool }

type Resolver = {
    symbols: Vec[Sym] = []
    scopes: Vec[Scope] = []
    refs: Map[int, Ref] = m{}
    decls: Map[int, int] = m{}
    captures: Map[int, Captures] = m{}
    deferred: Vec[Deferred] = []
    open: Set[int] = s{}
    diagnostics: Vec[Diagnostic] = []
    prelude: int = 0
    pkg: int = 1
    /// inside a type / union / inter / impl body: Self (None: Self unknown; outer None: not in one)
    type_ctx: TypeCtx? = None
    /// inside a function: does it have a receiver?
    fun_ctx: bool? = None
    /// local type symbol → its members, in declaration order (and the types, in first-seen order)
    members: Map[int, Vec[MemberSource]] = m{}
    is_std: bool
    pkg_name: string
    first_own: int = 0
    /// the imports the loader found, by Import id
    loaded: Map[int, LoadedImport] = m{}

    /// One arena per program: the prelude's (and loaded packages') symbols and scopes keep their indices.
    fun begin(&mut this, symbols: Vec[Sym], scopes: Vec[Scope]) {
        this.symbols = symbols
        this.scopes = scopes
        this.first_own = this.symbols.len()
        this.prelude = this.new_scope("prelude", None)
        this.pkg = this.new_scope("package", Some(this.prelude))
        for name in builtin_types().iter() {
            let _ = this.define(this.prelude, name, "builtin-type", None, None, false)
        }
    }

    fun add_prelude(&mut this, p: &Resolution) {
        for name, idx in p.scopes[p.pkg_scope].names {
            let sym = &p.symbols[idx]
            if sym.is_pub == Some(false) {
                continue                   // the prelude's private helpers (`is_space`)
            }
            this.scopes[this.prelude].names[name.clone()] = idx
            if sym.kind == "union" && exported_variants(name) {
                for v in sym.variants.iter() {
                    let vs = this.define(this.prelude, v.name, "variant", Some(v.id), Some(v.span), false)
                    this.symbols[vs].std = true
                    this.symbols[vs].owner = Some(idx)
                }
            }
        }
    }

    fun finish_prelude(&mut this) {
        // names the prelude file doesn't declare yet (type-level forms): known, but opaque
        for name in prelude_types().iter() {
            if !this.scopes[this.prelude].names.has(name) {
                let _ = this.define(this.prelude, name, "prelude-type", None, None, false)
            }
        }
        for entry in prelude_values().iter() {
            let t(name, kind) = entry
            if this.scopes[this.prelude].names.has(name) {
                continue
            }
            let sym = this.define(this.prelude, name, if kind == "package" { "package" } else { "prelude-value" }, None, None, false)
            if kind == "package" {
                this.symbols[sym].detail = Some("std.log")
            }
        }
    }

    fun run(mut this, files: &Vec[File]) -> Resolution {
        // 1. items of every file share the package scope
        for f in files.iter() {
            for itm in f.items.iter() {
                this.declare_item(itm)
            }
        }
        // resolving the prelude itself: `Some`, `Ok`, `Less`… are the variants of its own unions
        if this.is_std && this.pkg_name == "std" {
            for name, idx in this.scopes[this.pkg].names.clone() {
                let sym = this.symbols[idx].clone()
                if sym.kind != "union" || !exported_variants(name) {
                    continue
                }
                for v in sym.variants.iter() {
                    let _ = this.scopes[this.prelude].names.remove(v.name)
                    let vs = this.define(this.prelude, v.name, "variant", Some(v.id), Some(v.span), false)
                    this.symbols[vs].std = true
                    this.symbols[vs].owner = Some(idx)
                }
            }
        }
        // 2. each file's imports, then its bodies
        for f in files.iter() {
            let file_scope = this.new_scope("file", Some(this.pkg))
            for imp in f.imports.iter() {
                this.declare_import(file_scope, imp)
            }
            for itm in f.items.iter() {
                this.resolve_item(file_scope, itm)
            }
        }
        // 3. member duplicates per local type
        for sym, list in this.members.clone() {
            this.check_members(sym, list)
        }
        if this.is_std {
            for _, idx in this.scopes[this.pkg].names.clone() {
                this.symbols[idx].std = true
            }
        }
        Resolution {
            symbols: this.symbols, scopes: this.scopes, refs: this.refs, decls: this.decls, captures: this.captures,
            deferred: this.deferred, open: this.open, diagnostics: this.diagnostics, pkg_scope: this.pkg, first_own: this.first_own,
            package_name: this.pkg_name.clone(),
        }
    }

    // ---- symbols and diagnostics ----

    fun error(&mut this, code: &str, message: string, span: Span) {
        this.diagnostics.push(Diagnostic { code: code.to_str(), message, span })
    }

    fun new_scope(&mut this, kind: &str, parent: int?) -> int {
        this.scopes.push(Scope { kind: kind.to_str(), parent, closure: None })
        this.scopes.len() - 1
    }

    fun define(&mut this, scope: int, name: &str, kind: &str, decl: int?, span: Span?, mutable: bool) -> int {
        let id = this.symbols.len()
        this.symbols.push(Sym { id, name: name.to_str(), kind: kind.to_str(), mutable, decl, span, scope, detail: None, owner: None, is_pub: None, pkg: None, target: None, index: id - this.first_own })
        this.scopes[scope].names[name.to_str()] = id
        if let Some(d) = decl {
            this.decls[d] = id
        }
        id
    }

    /// Declares a binding, reporting redeclarations in the same scope and reserved names.
    fun bind(&mut this, scope: int, name: &str, kind: &str, decl: int, span: Span, mutable: bool) -> int {
        if is_implicit_param(name) {
            this.error("E_RESERVED_IDENT", "`${name}` is reserved for implicit closure parameters", span)
        }
        if let Some(prev) = this.scopes[scope].names.get(name) {
            if name != "_" {
                let loc = match this.symbols[prev].span {
                    Some(s) => " (first declared at ${s.line}:${s.col})"
                    None => ""
                }
                this.error("E_DUPLICATE_BINDING", "`${name}` is already declared in this scope${loc}; a new binding may only shadow it from an inner scope", span)
            }
        }
        this.define(scope, name, kind, Some(decl), Some(span), mutable)
    }

    fun lookup(&this, scope: int, name: &str) -> int? {
        var file: int? = None
        var s: int? = Some(scope)
        for let Some(i) = s {
            if let Some(sym) = this.scopes[i].names.get(name) {
                return Some(sym)
            }
            if this.scopes[i].kind == "file" {
                file = Some(i)
            }
            // glob-imported names come after the package's own items, before the prelude (spec §8.1)
            if this.scopes[i].kind == "package" {
                if let Some(f) = file {
                    if let Some(globs) = &this.scopes[f].globs {
                        if let Some(g) = globs.get(name) {
                            return Some(g)
                        }
                    }
                }
            }
            s = this.scopes[i].parent
        }
        None
    }

    /// E_AMBIGUOUS_IMPORT for a use of a name two globs export; true if it was ambiguous.
    fun ambiguous(&mut this, sym: int?, at: Span) -> bool {
        let Some(i) = sym else { return false }
        if this.symbols[i].kind != "ambiguous" {
            return false
        }
        let s = this.symbols[i].clone()
        let detail = s.detail ?? ""
        let first = detail.split(", ")[0].to_str()
        this.error("E_AMBIGUOUS_IMPORT", "`${s.name}` is exported by more than one glob import (${detail}): import it explicitly, e.g. `import \"${first}.${s.name}\"`", at)
        true
    }

    fun is_open(&this, scope: int) -> bool {
        var s: int? = Some(scope)
        for let Some(i) = s {
            if this.scopes[i].kind == "file" {
                return this.scopes[i].open
            }
            s = this.scopes[i].parent
        }
        false
    }

    fun set_ref(&mut this, id: int, span: Span, label: &str, sym: int) {
        this.refs[id] = r{ sym, span, label: label.to_str() }
    }

    fun defer(&mut this, id: int, span: Span, label: &str) {
        this.deferred.push(r{ id, span, label: label.to_str() })
    }

    /// Records a use of `sym` from `scope`, adding it to the captures of every closure crossed.
    fun use_sym(&mut this, id: int, span: Span, label: &str, sym: int, scope: int) {
        this.set_ref(id, span, label, sym)
        if !local_kind(this.symbols[sym].kind) {
            return
        }
        let home = this.symbols[sym].scope
        var s: int? = Some(scope)
        for let Some(i) = s {
            if i == home {
                break
            }
            if this.scopes[i].kind == "closure" {
                if let Some(c) = this.scopes[i].closure {
                    if !this.captures[c].syms.contains(sym) {
                        this.captures[c].syms.push(sym)
                    }
                }
            }
            s = this.scopes[i].parent
        }
    }

    // ---- items ----

    fun top(&mut this, name: &str, kind: &str, id: int, span: Span, is_pub: bool) -> int? {
        if let Some(prev) = this.scopes[this.pkg].names.get(name) {
            let loc = match this.symbols[prev].span {
                Some(s) => " (first declared at ${s.line}:${s.col})"
                None => ""
            }
            this.error("E_DUPLICATE_DECLARATION", "`${name}` is declared more than once in this package${loc}", span)
            return None
        }
        let sym = this.define(this.pkg, name, kind, Some(id), Some(span), false)
        this.symbols[sym].pkg = Some(this.pkg_name.clone())
        this.symbols[sym].is_pub = Some(is_pub)
        Some(sym)
    }

    fun declare_item(&mut this, itm: &Item) {
        match itm {
            Fun(f) => { let _ = this.top(f.name, "fun", f.id, f.span, f.is_pub) }
            TypeDef(d) => {
                if let Some(sym) = this.top(d.name, "type", d.id, d.span, d.is_pub) {
                    if let Alias(_) = &d.body {
                        this.symbols[sym].alias = true
                    }
                }
            }
            Union(d) => {
                if let Some(sym) = this.top(d.name, "union", d.id, d.span, d.is_pub) {
                    this.symbols[sym].variants = d.variants.map(#{ v => r{ name: v.name.clone(), span: v.span, id: v.id } })
                }
            }
            Inter(d) => { let _ = this.top(d.name, "inter", d.id, d.span, d.is_pub) }
            Let(d) => { let _ = this.top(d.name, "global", d.id, d.span, d.is_pub) }
            Extern(d) => {
                for f in d.funs.iter() {
                    let _ = this.top(f.name, "extern-fun", f.id, f.span, f.is_pub)
                }
            }
            Impl(_) => {}
        }
    }

    /// An item of a loaded package, by name: it must exist and be `pub`.
    fun exported(&mut this, l: &LoadedImport, name: &str, imp: &Import) -> int? {
        let Some(sym) = this.scopes[l.pkg_scope].names.get(name) else {
            this.error("E_UNKNOWN_IMPORT", "package `${l.path}` has no item `${name}`", imp.span)
            return None
        }
        if this.symbols[sym].is_pub != Some(true) {
            this.error("E_PRIVATE_ITEM", "`${name}` is private to package `${l.path}` (declare it `pub` to import it)", imp.span)
        }
        Some(sym)
    }

    fun bind_loaded(&mut this, file: int, imp: &Import, name: &str, sym: int) {
        if this.scopes[this.pkg].names.has(name) || this.scopes[file].names.has(name) {
            this.error("E_DUPLICATE_DECLARATION", "the import binds `${name}`, which is already declared in this package; use `as` to rename it", imp.span)
            return
        }
        this.scopes[file].names[name.to_str()] = sym
    }

    fun declare_loaded_import(&mut this, file: int, imp: &Import, l: LoadedImport) {
        if l.glob {
            var globs = this.scopes[file].globs ?? m{}
            for name, sym in this.scopes[l.pkg_scope].names.clone() {
                if this.symbols[sym].is_pub != Some(true) {
                    continue
                }
                let Some(prev) = globs.get(name) else {
                    globs[name.clone()] = sym
                    continue
                }
                if prev == sym {
                    continue
                }
                let from = if this.symbols[prev].kind == "ambiguous" { this.symbols[prev].detail ?? "" } else { this.symbols[prev].pkg ?? "?" }
                let scratch = this.new_scope("file", None)
                let marker = this.define(scratch, name, "ambiguous", None, None, false)
                this.symbols[marker].detail = Some("${from}, ${l.path}")
                globs[name.clone()] = marker
            }
            this.scopes[file].globs = Some(globs)
            return
        }
        if let Some(items) = &l.items {
            for name in items.iter() {
                if let Some(sym) = this.exported(l, name, imp) {
                    this.bind_loaded(file, imp, name, sym)
                }
            }
            return
        }
        if let Some(item) = &l.item {
            if let Some(sym) = this.exported(l, item, imp) {
                this.bind_loaded(file, imp, imp.alias ?? item.clone(), sym)
            }
            return
        }
        var dot = -1
        var k = 0
        for k < l.path.len() {
            if l.path.byte_at(k) == 46 {
                dot = k
            }
            k += 1
        }
        let name = imp.alias ?? l.path.substring(dot + 1, l.path.len()).to_str()
        if this.scopes[this.pkg].names.has(name) || this.scopes[file].names.has(name) {
            this.error("E_DUPLICATE_DECLARATION", "the import binds `${name}`, which is already declared in this package; use `as` to rename it", imp.span)
            return
        }
        let sym = this.define(file, name, "package", Some(imp.id), Some(imp.span), false)
        this.symbols[sym].detail = Some(l.path.clone())
        this.symbols[sym].target = Some(l.pkg_scope)
    }

    fun declare_import(&mut this, file: int, imp: &Import) {
        if let Some(l) = this.loaded.get(imp.id) {
            return this.declare_loaded_import(file, imp, l)
        }
        let path = imp.path.clone()
        if path.ends_with(".*") {
            this.scopes[file].open = true
            return
        }
        // `"pkg.{a, b}"`: the last `.{` (stage 0: /^(.*)\.\{(.*)\}$/)
        if path.ends_with("}") {
            var at = -1
            var from = 0
            for let Some(k) = path.find(".{", from) {
                at = k
                from = k + 1
            }
            if at >= 0 {
                for raw in path.substring(at + 2, path.len() - 1).split(",").iter() {
                    let name = raw.trim()
                    if !name.is_empty() {
                        this.bind_import(file, imp, name, "import")
                    }
                }
                return
            }
        }
        // tool imports pin a version: "acme.lint@^1.2"
        let clean = match path.find("@", 0) {
            Some(k) => path.substring(0, k).to_str()
            None => path.clone()
        }
        var segments = [] as Vec[string]
        for part in clean.replace("/", ".").split(".").iter() {
            if !part.is_empty() && part != ".." {
                segments.push(part.to_str())
            }
        }
        let last = segments.last() ?? clean.clone()
        // JavaScript's `clean.slice(0, clean.lastIndexOf("."))`: without a dot, all but the last character
        var dot = -1
        var k = 0
        for k < clean.len() {
            if clean.byte_at(k) == 46 {
                dot = k
            }
            k += 1
        }
        let parent = if dot >= 0 { clean.substring(0, dot).to_str() } else { clean.substring(0, if clean.len() > 0 { clean.len() - 1 } else { 0 }).to_str() }
        let kind = if std_package(clean) || !std_package(parent) { "package" } else { "import" }
        this.bind_import(file, imp, last, kind)
    }

    fun bind_import(&mut this, file: int, imp: &Import, name: &str, kind: &str) {
        let bound = imp.alias ?? name.to_str()
        if this.scopes[this.pkg].names.has(bound) || this.scopes[file].names.has(bound) {
            this.error("E_DUPLICATE_DECLARATION", "the import binds `${bound}`, which is already declared in this package; use `as` to rename it", imp.span)
            return
        }
        let sym = this.define(file, bound, kind, Some(imp.id), Some(imp.span), false)
        this.symbols[sym].detail = Some(imp.path.clone())
    }

    fun resolve_item(&mut this, file: int, itm: &Item) {
        match itm {
            Fun(f) => this.resolve_fun(file, f)
            Let(d) => {
                if let Some(t) = &d.ty {
                    this.resolve_type(file, t)
                }
                this.resolve_expr(file, d.value)
            }
            Extern(d) => {
                for f in d.funs.iter() {
                    this.resolve_fun(file, f)
                }
            }
            TypeDef(d) => this.resolve_type_decl(file, d)
            Union(d) => this.resolve_union_decl(file, d)
            Inter(d) => this.resolve_inter_decl(file, d)
            Impl(d) => this.resolve_impl(file, d)
        }
    }

    fun generic_scope(&mut this, parent: int, generics: &Vec[GenericParam]) -> int {
        let scope = this.new_scope("type", Some(parent))
        for g in generics.iter() {
            let _ = this.bind(scope, g.name, "generic", g.id, g.span, false)
        }
        for g in generics.iter() {
            for b in g.bounds.iter() {
                this.resolve_type(scope, b)
            }
        }
        scope
    }

    fun add_member(&mut this, sym: int?, name: &str, span: Span, from: &str) {
        let Some(s) = sym else { return }
        if !this.members.has(s) {
            this.members[s] = []
        }
        this.members[s].push(r{ name: name.to_str(), span, from: from.to_str() })
    }

    /// Opens the member list of a local type (stage 0 creates it on first use, which fixes the order
    /// the duplicate checks run in).
    fun touch_members(&mut this, sym: int?) {
        if let Some(s) = sym {
            if !this.members.has(s) {
                this.members[s] = []
            }
        }
    }

    fun with_type(&mut this, self_sym: int?) -> TypeCtx? {
        let saved = this.type_ctx
        this.type_ctx = Some(r{ self_sym })
        saved
    }

    fun resolve_type_decl(&mut this, file: int, d: &TypeDecl) {
        let sym = this.scopes[this.pkg].names.get(d.name)
        let scope = this.generic_scope(file, d.generics)
        for t in d.impls.iter() {
            this.resolve_type(scope, t)
        }
        let saved = this.with_type(sym)
        match &d.body {
            Alias(t) => this.resolve_type(scope, t)
            Struct(b) => {
                this.touch_members(sym)
                for f in b.fields.iter() {
                    this.add_member(sym, f.name, f.span, "field")
                    this.resolve_type(scope, f.ty)
                    if let Some(def) = &f.default {
                        this.resolve_expr(scope, def)
                    }
                }
                for m in b.methods.iter() {
                    this.add_member(sym, m.name, m.span, "inline")
                    this.resolve_fun(scope, m)
                }
            }
        }
        this.type_ctx = saved
    }

    fun resolve_union_decl(&mut this, file: int, d: &UnionDecl) {
        let sym = this.scopes[this.pkg].names.get(d.name)
        let scope = this.generic_scope(file, d.generics)
        for t in d.impls.iter() {
            this.resolve_type(scope, t)
        }
        let saved = this.with_type(sym)
        this.touch_members(sym)
        for v in d.variants.iter() {
            this.add_member(sym, v.name, v.span, "variant")
            if let Some(ts) = &v.tuple {
                for t in ts.iter() {
                    this.resolve_type(scope, t)
                }
            }
            var seen = s{} as Set[string]
            if let Some(fs) = &v.fields {
                for f in fs.iter() {
                    if seen.has(f.name) {
                        this.error("E_DUPLICATE_FIELD", "field `${f.name}` is declared twice in `${v.name}`", f.span)
                    }
                    let _ = seen.insert(f.name.clone())
                    this.resolve_type(scope, f.ty)
                    if let Some(def) = &f.default {
                        this.resolve_expr(scope, def)
                    }
                }
            }
        }
        for m in d.methods.iter() {
            this.add_member(sym, m.name, m.span, "inline")
            this.resolve_fun(scope, m)
        }
        this.type_ctx = saved
    }

    fun resolve_inter_decl(&mut this, file: int, d: &InterDecl) {
        let scope = this.generic_scope(file, d.generics)
        for t in d.supers.iter() {
            this.resolve_type(scope, t)
        }
        if let Some(c) = &d.composition {
            this.resolve_type(scope, c)
        }
        let saved = this.with_type(this.scopes[this.pkg].names.get(d.name))
        var seen = s{} as Set[string]
        if let Some(ms) = &d.methods {
            for m in ms.iter() {
                if seen.has(m.name) {
                    this.error("E_DUPLICATE_METHOD", "method `${m.name}` is declared twice in `${d.name}`", m.span)
                }
                let _ = seen.insert(m.name.clone())
                this.resolve_fun(scope, m)
            }
        }
        this.type_ctx = saved
    }

    /// A symbol of this package (or, resolving std, a built-in type).
    fun is_local(&this, sym: int?) -> bool {
        let Some(s) = sym else { return false }
        this.symbols[s].scope == this.pkg || (this.is_std && this.symbols[s].kind == "builtin-type")
    }

    fun resolve_impl(&mut this, file: int, d: &ImplDecl) {
        let scope = this.generic_scope(file, d.generics)
        for t in d.interfaces.iter() {
            this.resolve_type(scope, t)
        }
        this.resolve_type(scope, d.target)
        var target: int? = None
        var target_name = "this type"
        if let TName { path, .. } = &d.target.kind {
            target = this.ref_sym(d.target.id)
            target_name = path.join(".")
        }

        // orphan rule (spec §8.4): an impl lives in the package of the type, or of the interface
        if let Some(t) = target {
            if d.interfaces.is_empty() && !this.is_local(target) {
                this.error("E_ORPHAN_IMPL", "methods for `${target_name}` can only be added in the package that declares it", d.target.span)
            } else if !d.interfaces.is_empty() && !this.is_local(target) {
                for iface in d.interfaces.iter() {
                    var isym: int? = None
                    if let TName { .. } = &iface.kind {
                        isym = this.ref_sym(iface.id)
                    }
                    if let Some(i) = isym {
                        if !this.is_local(isym) {
                            let iname = this.symbols[i].name.clone()
                            this.error("E_ORPHAN_IMPL", "`impl ${iname} for ${target_name}` must be in the package of `${iname}` or of `${target_name}`", iface.span)
                        }
                    }
                }
            }
            if this.symbols[t].kind == "type" && this.symbols[t].alias && this.symbols[t].decl.is_some() {
                let tname = this.symbols[t].name.clone()
                this.error("E_METHODS_ON_STRUCTURAL", "`${tname}` is an alias for a structural type, so it can't have methods; declare it as `type ${tname} = { … }`", d.target.span)
            }
        }

        var from = "inherent"
        if !d.interfaces.is_empty() {
            let names = d.interfaces.map(#{ t => match &t.kind {
                TName { path, .. } => path.join(".")
                _ => "?"
            } })
            from = "impl ${names.join(", ")}"
        }
        let local = this.is_local(target)
        let saved = this.with_type(target)
        if local {
            this.touch_members(target)
        }
        for m in d.methods.iter() {
            if local {
                this.add_member(target, m.name, m.span, from)
            }
            this.resolve_fun(scope, m)
        }
        this.type_ctx = saved
    }

    fun ref_sym(&this, id: int) -> int? {
        match this.refs.get(id) {
            Some(r) => Some(r.sym)
            None => None
        }
    }

    fun check_members(&mut this, sym: int, list: Vec[MemberSource]) {
        var by_name = m{} as Map[string, Vec[MemberSource]]
        for m in list.iter() {
            if !by_name.has(m.name) {
                by_name[m.name.clone()] = []
            }
            by_name[m.name.clone()].push(m.clone())
        }
        let sym_name = this.symbols[sym].name.clone()
        for name, ms in by_name {
            if ms.len() < 2 {
                continue
            }
            let kinds = ms.map(#{ m => m.from.clone() })
            var distinct = s{} as Set[string]
            for k in kinds.iter() {
                let _ = distinct.insert(k.clone())
            }
            var i = 1
            for i < ms.len() {
                let mm = ms[i]
                let first = ms[0]
                var code = "E_DUPLICATE_METHOD"
                var msg = "`${sym_name}` already has a member named `${name}` (${first.from})"
                if (first.from == "field" || first.from == "variant") && (mm.from == "field" || mm.from == "variant") {
                    code = "E_DUPLICATE_FIELD"
                    msg = "`${sym_name}` already has a ${first.from} named `${name}`"
                } else if kinds.all(#{ k => k.starts_with("impl ") }) && distinct.len() == kinds.len() {
                    code = "E_AMBIGUOUS_IMPL_METHOD"
                    msg = "`${name}` is defined by more than one interface implemented by `${sym_name}` (${kinds.join(", ")})"
                }
                this.error(code, msg, mm.span)
                i += 1
            }
        }
    }

    fun resolve_fun(&mut this, parent: int, f: &FunDecl) {
        let gscope = this.generic_scope(parent, f.generics)
        let scope = this.new_scope("function", Some(gscope))
        if let Some(r) = &f.receiver {
            let _ = this.define(scope, "this", "this", None, None, r == "&mut this" || r == "mut this")
        }
        for p in f.params.iter() {
            this.resolve_type(gscope, p.ty)
            let _ = this.bind(scope, p.name, "param", p.id, p.span, p.is_mut)
        }
        if let Some(t) = &f.ret {
            this.resolve_type(gscope, t)
        }
        let Some(body) = &f.body else { return }
        let saved = this.fun_ctx
        this.fun_ctx = Some(f.receiver.is_some())
        this.resolve_stmts(scope, body.stmts)       // params and the body's top level share a scope
        this.fun_ctx = saved
    }
}

/// The `Self` of a type body (None: an impl whose target isn't known).
type TypeCtx = r{ self_sym: int? }
