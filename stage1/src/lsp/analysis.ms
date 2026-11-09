// The language server's analysis, ported from minscript/tools/lsp/analysis.ts: runs the compiler
// passes on a package (every `.ms` file in a folder with the same `package` name) and answers editor
// questions from their results. No LSP plumbing beyond JSON values, so it can be tested directly.
//
// Stage 0 walks AST objects (with a parent map); here every node of every loaded file is indexed by
// id (`NodeInfo`: kind, span, parent), and declarations by node id (`DeclInfo`: what hover,
// definition, completion and signature help show).
package lsp

import "std.fs"
import "std.json"
import "std.utf8"
import "app.lexer.{Span, Trivia}"
import "app.ast.*"
import "app.parser.{parse, parse_from}"
import "app.resolve.{Sym, Scope, Resolution, ResolveOptions, resolve_package}"
import "app.check.{CheckResult, VarState, Ty, check_package, show_ty, stripped, tag, named_sym}"
import "app.ownership.{check_ownership}"
import "app.loader.{LoadOptions, load_program, dirname, basename, join}"
import "app.project.{Toolchain}"

pub type Doc = { pub uri: string, pub text: string }

/// What the server knows about the project a file is in (from its evaluated mod.ms, spec §17).
pub type ProjectInfo = { pub main_dir: string, pub deps: Map[string, string] = m{}, pub fmt: json.Value? = None }

/// A node of a file: `aux` is a Call's callee id, a Member's object id, a GenericApply's target id, or
/// 1 for a record-field shorthand; `name` an Ident's, Member's, PBind's or RecordField's name.
pub type NodeInfo = r{ id: int, span: Span, kind: string, parent: int, name: string, aux: int }

pub type FileInfo = {
    pub uri: string
    pub text: string
    pub map: PosMap
    pub nodes: Vec[NodeInfo]
    pub trivia: Vec[Trivia]
    pub file: File
    /// "main" (the package being edited), "other" (a package it imports) or "prelude"
    pub role: string
    pub pkg_name: string
}

/// A declaration, as the features show it.
pub type DeclInfo = {
    /// "fun", "type", "union", "inter", "field", "variant", "let", "impl", "extern"
    pub kind: string
    pub name: string
    /// the declaration as hover shows it
    pub code: string
    pub file: int
    pub span: Span
    /// a struct type: its fields by name (node ids)
    pub fields: Map[string, int] = m{}
    /// a function: for signature help
    pub params: Vec[string] = []
    pub variadic_at: int = -1
    pub head: string = ""
    pub ret: string = ""
}

pub type Analysis = {
    /// the package's files first (`main_count`), then the packages it imports, then the prelude
    pub files: Vec[FileInfo]
    pub main_count: int
    /// node id → (file index, node index)
    pub nodes: Map[int, t(int, int)]
    pub decls: Map[int, DeclInfo]
    pub res: Resolution
    pub syms: Ref[Vec[Sym]]
    pub scopes: Ref[Vec[Scope]]
    pub vars: Ref[Vec[VarState]]
    pub checked: CheckResult
    /// LSP diagnostics per file URI (every file of the package has an entry, possibly empty)
    pub diagnostics: Vec[t(string, Vec[json.Value])]
    /// the prelude's package scope names, for completion
    pub prelude_names: Map[string, int]
}

/// The `package` name a file declares (cheap scan, used to group a folder's files).
pub fun package_name(text: &str) -> string? {
    let bytes = utf8.encode(text)
    var i = 0
    let n = bytes.len()
    for i < n {
        let c = bytes[i]
        if c == 32 || c == 9 || c == 10 || c == 13 {
            i += 1
        } else if c == 47 && i + 1 < n && bytes[i + 1] == 47 {
            for i < n && bytes[i] != 10 {
                i += 1
            }
        } else if c == 47 && i + 1 < n && bytes[i + 1] == 42 {
            i += 2
            for i + 1 < n && !(bytes[i] == 42 && bytes[i + 1] == 47) {
                i += 1
            }
            i += 2
        } else {
            break
        }
    }
    let rest = utf8.decode_range(bytes, i, n)
    if !rest.starts_with("package") {
        return None
    }
    let after = rest.substring(7, rest.len())
    let trimmed = after.trim()
    if trimmed.len() == after.len() {
        return None                 // `packagex`
    }
    var end = 0
    for end < trimmed.len() {
        let b = trimmed.byte_at(end)
        let word = (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b == 95 || b == 46
        if !word {
            break
        }
        end += 1
    }
    if end == 0 { None } else { Some(trimmed.substring(0, end).to_str()) }
}

async fun read_text(path: &str) -> string? {
    match await fs.read_text(path) {
        Ok(t) => Some(t)
        Err(_) => None
    }
}

/// Runs every pass on the package of `primary` and on everything it imports. `docs` are the open
/// editors: they override the files on disk. A document that isn't a file is analysed alone.
pub async fun analyze(tc: &Toolchain, docs: &Vec[Doc], primary: &str, project: &ProjectInfo?) -> Analysis {
    let Some(path) = uri_path(primary) else { return analyze_alone(tc, docs, primary) }
    var open = m{} as Map[string, string]
    var uris = m{} as Map[string, string]
    for d in docs.iter() {
        if let Some(p) = uri_path(d.uri) {
            open[p.clone()] = d.text.clone()
            uris[p] = d.uri.clone()
        }
    }
    let text = match open.get(path) {
        Some(t) => t
        None => await read_text(path) ?? ""
    }
    // a `package main` file of the project's main folder: the whole folder is the package
    let main_dir = match project {
        Some(p) => p.main_dir.clone()
        None => ""
    }
    let whole_main = project.is_some() && dirname(path) == main_dir && (package_name(text) ?? "main") == "main"
    var opts = LoadOptions { test_dir: Some(dirname(path)), extra: open.clone() }
    if let Some(p) = project {
        opts.app_root = Some(p.main_dir.clone())
        opts.deps = p.deps.clone()
    }
    let entry = if whole_main { main_dir } else { path.clone() }
    let loaded = await load_program(entry, tc.std_dir, opts)
    let Ok(program) = loaded else { return analyze_alone(tc, docs, primary) }

    var files = [] as Vec[FileInfo]
    let main_pkg = program.packages[program.main].clone()
    var main_paths = [] as Vec[string]
    // the package being edited, then the packages it imports
    var order = [program.main] as Vec[int]
    for i in program.order.iter() {
        if i != program.main {
            order.push(i)
        }
    }
    for pi in order.iter() {
        let pkg = &program.packages[pi]
        if pkg.slot < 0 {
            continue
        }
        let dep = &program.analysed[pkg.slot]
        var k = 0
        for sf in pkg.files.iter() {
            let ftext = match open.get(sf.path) {
                Some(t) => t
                None => await read_text(sf.path) ?? ""
            }
            let uri = uris.get(sf.path) ?? path_uri(sf.path)
            let role = if pi == program.main { "main" } else { "other" }
            if pi == program.main {
                main_paths.push(sf.path.clone())
            }
            files.push(file_info(uri, ftext, dep.files[k].clone(), sf.parsed.lexed.trivia.clone(), role, pkg.name))
            k += 1
        }
    }
    let main_count = main_paths.len()
    // the prelude: its file, and its comments (it is parsed the same way again: the same node ids)
    let prelude_path = join(tc.std_dir, "prelude.ms")
    let ptext = await read_text(prelude_path) ?? ""
    let preparsed = parse(utf8.encode(ptext))
    files.push(file_info(path_uri(prelude_path), ptext, program.prelude_file.clone(), preparsed.lexed.trivia, "prelude", "std"))

    // diagnostics of the package's files; type and ownership errors on half-parsed code are mostly
    // noise: they are shown once the syntax is valid
    let parse_errors = program.diagnostics.any(#{ d => d.pass == "parse" && main_paths.contains(d.file) })
    var diagnostics = [] as Vec[t(string, Vec[json.Value])]
    var fi = 0
    for p in main_paths.iter() {
        var list = [] as Vec[json.Value]
        for d in program.diagnostics.iter() {
            if d.file != p || (parse_errors && (d.pass == "check" || d.pass == "ownership")) {
                continue
            }
            list.push(lsp_diagnostic(files[fi].map, d.span, d.code, d.message))
        }
        diagnostics.push(t(files[fi].uri.clone(), list))
        fi += 1
    }
    let slot = main_pkg.slot
    let res = if slot >= 0 { program.analysed[slot].res.clone() } else { program.prelude.clone() }
    let checked = if slot >= 0 { program.analysed[slot].checked.clone() } else { program.prelude_checked.clone() }
    finish(files, main_count, res, program.shared.syms, program.shared.scopes, program.shared.vars, checked, diagnostics, program.prelude.scopes[program.prelude.pkg_scope].names.clone())
}

/// One document on its own (not a file on disk): no imports are loaded.
fun analyze_alone(tc: &Toolchain, docs: &Vec[Doc], primary: &str) -> Analysis {
    let text = match docs.find(#{ d, _ => d.uri == primary }) {
        Some(d) => d.text
        None => ""
    }
    let parsed = parse(utf8.encode(text))
    let res = resolve_package([parsed.file.clone()], None, ResolveOptions {})
    let checked = check_package([parsed.file.clone()], res, parsed.file, res)
    var files = [file_info(primary.to_str(), text, parsed.file.clone(), parsed.lexed.trivia.clone(), "main", "main")] as Vec[FileInfo]
    var list = parsed.diagnostics.map(#{ d => lsp_diagnostic(files[0].map, d.span, d.code, d.message) })
    for d in res.diagnostics.iter() {
        list.push(lsp_diagnostic(files[0].map, d.span, d.code, d.message))
    }
    if parsed.diagnostics.is_empty() {
        for d in checked.diagnostics.iter() {
            list.push(lsp_diagnostic(files[0].map, d.span, d.code, d.message))
        }
    }
    let syms = Ref(res.symbols.clone())
    let scopes = Ref(res.scopes.clone())
    let vars = Ref(checked.vars.clone())
    finish(files, 1, res, syms, scopes, vars, checked, [t(primary.to_str(), list)], m{})
}

fun finish(files: Vec[FileInfo], main_count: int, res: Resolution, syms: Ref[Vec[Sym]], scopes: Ref[Vec[Scope]], vars: Ref[Vec[VarState]], checked: CheckResult, diagnostics: Vec[t(string, Vec[json.Value])], prelude_names: Map[string, int]) -> Analysis {
    var nodes = m{} as Map[int, t(int, int)]
    var decls = m{} as Map[int, DeclInfo]
    var fi = 0
    for f in files.iter() {
        var ni = 0
        for n in f.nodes.iter() {
            if n.id >= 0 && !nodes.has(n.id) {
                nodes[n.id] = t(fi, ni)
            }
            ni += 1
        }
        index_decls(f.file, fi, decls)
        fi += 1
    }
    Analysis { files, main_count, nodes, decls, res, syms, scopes, vars, checked, diagnostics, prelude_names }
}

pub fun lsp_diagnostic(map: &PosMap, span: Span, code: &str, message: &str) -> json.Value {
    obj([t("range", map.range(span.start, span.end)), t("severity", num(1)), t("code", jstr(code)), t("source", jstr("minscript")), t("message", jstr(message))])
}

fun file_info(uri: string, text: string, file: File, trivia: Vec[Trivia], role: &str, pkg_name: &str) -> FileInfo {
    var nodes = [] as Vec[NodeInfo]
    collect_file(file, nodes)
    FileInfo { uri, map: pos_map(text), text, nodes, trivia, file, role: role.to_str(), pkg_name: pkg_name.to_str() }
}

impl Analysis {
    pub fun file_index(&this, uri: &str) -> int? {
        var i = 0
        for f in this.files.iter() {
            if f.uri == uri {
                return Some(i)
            }
            i += 1
        }
        None
    }

    /// A file of the package being edited.
    pub fun main_file(&this, uri: &str) -> int? {
        let Some(i) = this.file_index(uri) else { return None }
        if i < this.main_count { Some(i) } else { None }
    }

    pub fun node(&this, id: int) -> NodeInfo? {
        let Some(at) = this.nodes.get(id) else { return None }
        let t(fi, ni) = at
        Some(this.files[fi].nodes[ni])
    }

    pub fun file_of(&this, id: int) -> int? {
        match this.nodes.get(id) {
            Some(at) => Some(at.0)
            None => None
        }
    }

    pub fun show(&this, t: &Ty) -> string { show_ty(t, this.vars.get(), this.syms.get()) }

    /// The smallest node containing the offset; prefers nodes the resolver knows about.
    pub fun node_at(&this, fi: int, offset: int) -> NodeInfo? {
        var best: NodeInfo? = None
        for n in this.files[fi].nodes.iter() {
            if n.kind == "File" || offset < n.span.start || offset > n.span.end {
                continue
            }
            if offset == n.span.end && n.span.end > n.span.start && !is_name(n.kind) {
                continue
            }
            let size = n.span.end - n.span.start
            match &best {
                None => best = Some(n)
                Some(b) => {
                    let bsize = b.span.end - b.span.start
                    if size < bsize || (size == bsize && (this.res.refs.has(n.id) || this.res.decls.has(n.id))) {
                        best = Some(n)
                    }
                }
            }
        }
        best
    }

    /// What a node names: a symbol (through the resolver), or a member's declaration (through the checker).
    pub fun target(&this, n: &NodeInfo) -> Target? {
        if let Some(found) = this.target_of(n) {
            return Some(found)
        }
        // `x.method` / `T.method` as the callee of a call: the checker records the target on the call
        let Some(fi) = this.file_of(n.id) else { return None }
        if n.parent < 0 {
            return None
        }
        var p = this.files[fi].nodes[n.parent]
        if p.kind == "GenericApply" && p.aux == n.id && p.parent >= 0 {
            p = this.files[fi].nodes[p.parent]
        }
        if p.kind == "Call" {
            let callee = this.node(p.aux)
            let is_callee = p.aux == n.id || match &callee {
                Some(c) => c.kind == "GenericApply" && c.aux == n.id
                None => false
            }
            if is_callee {
                if let Some(decl) = this.call_decl(p.id) {
                    return Some(Target { sym: None, decl: Some(decl), name: this.decl_name(decl) })
                }
            }
        }
        None
    }

    fun decl_name(&this, decl: int) -> string {
        match this.decls.get(decl) {
            Some(d) => d.name
            None => ""
        }
    }

    pub fun call_decl(&this, call: int) -> int? {
        let Some(info) = this.checked.calls.get(call) else { return None }
        match &info.target {
            CFun(d) => Some(d)
            CMethod { decl, .. } => decl
            CStatic { decl, .. } => Some(decl)
            _ => None
        }
    }

    fun target_of(&this, n: &NodeInfo) -> Target? {
        if let Some(rf) = this.res.refs.get(n.id) {
            let s = &this.syms.get()[rf.sym]
            return Some(Target { sym: Some(rf.sym), decl: s.decl, name: s.name.clone() })
        }
        if let Some(sym) = this.res.decls.get(n.id) {
            let s = &this.syms.get()[sym]
            return Some(Target { sym: Some(sym), decl: Some(s.decl ?? n.id), name: s.name.clone() })
        }
        if n.kind == "Member" || n.kind == "OptMember" {
            match this.checked.members.get(n.id) {
                Some(MMethod { decl, .. }) => {
                    if let Some(d) = decl {
                        return Some(Target { sym: None, decl: Some(d), name: n.name })
                    }
                }
                Some(MStatic { decl, .. }) => return Some(Target { sym: None, decl: Some(decl), name: n.name })
                Some(MVariant(v)) => {
                    let owner = &this.syms.get()[v.owner]
                    let vid = match owner.variants.find(#{ x, _ => x.name == v.variant }) {
                        Some(x) => Some(x.id)
                        None => owner.decl
                    }
                    return Some(Target { sym: None, decl: vid, name: n.name })
                }
                Some(MField) => {
                    if let Some(f) = this.field_decl(n.aux, n.name) {
                        return Some(Target { sym: None, decl: Some(f), name: n.name })
                    }
                }
                _ => {}
            }
        }
        if n.kind == "Call" {
            if let Some(d) = this.call_decl(n.id) {
                return Some(Target { sym: None, decl: Some(d), name: this.decl_name(d) })
            }
        }
        None
    }

    /// The field `name` of the struct type of the expression `object`.
    fun field_decl(&this, object: int, name: &str) -> int? {
        let Some(ty) = this.checked.types.get(object) else { return None }
        let t = stripped(ty, this.vars.get())
        if tag(t) != "named" {
            return None
        }
        let Some(decl) = this.syms.get()[named_sym(t)].decl else { return None }
        let Some(d) = this.decls.get(decl) else { return None }
        d.fields.get(name)
    }

    /// Where a declaration (or any node) is: its file and, for a declaration, its name.
    pub fun location(&this, id: int) -> json.Value? {
        let Some(at) = this.nodes.get(id) else { return None }
        let t(fi, ni) = at
        let f = &this.files[fi]
        let n = f.nodes[ni]
        let span = name_span(f, n) ?? n.span
        Some(obj([t("uri", jstr(f.uri)), t("range", f.map.range(span.start, span.end))]))
    }

    /// `///` lines directly above a declaration.
    pub fun doc_comment(&this, decl: int) -> string {
        let Some(at) = this.nodes.get(decl) else { return "" }
        let t(fi, ni) = at
        let f = &this.files[fi]
        var lines = [] as Vec[string]
        var line = f.nodes[ni].span.line - 1
        var docs = f.trivia.filter(#{ x => x.kind == "doc" })
        docs.sort_by(#{ a, b => if a.span.line > b.span.line { Less } else if a.span.line < b.span.line { Greater } else { Equal } })
        for d in docs.iter() {
            if d.span.line != line {
                continue
            }
            var text = d.text.substring(3, d.text.len()).to_str()
            if text.starts_with(" ") {
                text = text.substring(1, text.len()).to_str()
            }
            lines.insert(0, text)
            line -= 1
        }
        lines.join("\n")
    }

    pub fun is_prelude_node(&this, id: int) -> bool {
        match this.file_of(id) {
            Some(fi) => this.files[fi].role == "prelude"
            None => false
        }
    }

    pub fun other_package_of(&this, id: int) -> string? {
        let Some(fi) = this.file_of(id) else { return None }
        if this.files[fi].role == "other" { Some(this.files[fi].pkg_name.clone()) } else { None }
    }
}

pub type Target = { pub sym: int?, pub decl: int?, pub name: string }

fun is_name(kind: &str) -> bool { kind == "Ident" || kind == "This" || kind == "TName" || kind == "Member" || kind == "OptMember" }

/// For a declaration, the span of its name (so "go to definition" lands on it, not on `pub fun`).
fun name_span(f: &FileInfo, n: NodeInfo) -> Span? {
    // the nodes with a `name` in stage 0's AST (not Ident / PBind, whose whole span is the name)
    let named = ["FunDecl", "TypeDecl", "UnionDecl", "InterDecl", "Field", "Variant", "Param", "GenericParam", "LetDecl", "ClosureParam", "Capture", "PatField", "Member", "OptMember", "Or"]
    if n.name.is_empty() || !named.contains(n.kind) {
        return None
    }
    let word = n.name
    let slice = utf8.decode_range(f.map.bytes, n.span.start, n.span.end)
    var from = 0
    for let Some(k) = slice.find(word, from) {
        let before_ok = k == 0 || !is_word_byte(slice.byte_at(k - 1))
        let end = k + word.len()
        let after_ok = end >= slice.len() || !is_word_byte(slice.byte_at(end))
        if before_ok && after_ok {
            return Some(r{ start: n.span.start + k, end: n.span.start + end, line: n.span.line, col: n.span.col })
        }
        from = k + 1
    }
    None
}

fun is_word_byte(b: u8) -> bool { (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b == 95 }

// ---- declarations ----

fun index_decls(file: &File, fi: int, out: &mut Map[int, DeclInfo]) {
    for itm in file.items.iter() {
        match itm {
            Fun(f) => index_fun(f, fi, out)
            TypeDef(d) => {
                var info = DeclInfo { kind: "type", name: d.name.clone(), code: "type ${d.name}", file: fi, span: d.span }
                if let Struct(b) = &d.body {
                    for x in b.fields.iter() {
                        info.fields[x.name.clone()] = x.id
                        out[x.id] = DeclInfo { kind: "field", name: x.name.clone(), code: "${x.name}: ${type_text(x.ty)}", file: fi, span: x.span }
                    }
                    for m in b.methods.iter() {
                        index_fun(m, fi, out)
                    }
                }
                out[d.id] = info
            }
            Union(d) => {
                out[d.id] = DeclInfo { kind: "union", name: d.name.clone(), code: "union ${d.name}", file: fi, span: d.span }
                for v in d.variants.iter() {
                    out[v.id] = DeclInfo { kind: "variant", name: v.name.clone(), code: "variant ${v.name}", file: fi, span: v.span }
                }
                for m in d.methods.iter() {
                    index_fun(m, fi, out)
                }
            }
            Inter(d) => {
                out[d.id] = DeclInfo { kind: "inter", name: d.name.clone(), code: "inter ${d.name}", file: fi, span: d.span }
                for m in (d.methods ?? []).iter() {
                    index_fun(m, fi, out)
                }
            }
            Impl(d) => {
                for m in d.methods.iter() {
                    index_fun(m, fi, out)
                }
            }
            Let(d) => {
                out[d.id] = DeclInfo { kind: "let", name: d.name.clone(), code: "", file: fi, span: d.span }
            }
            Extern(d) => {
                for m in d.funs.iter() {
                    index_fun(m, fi, out)
                }
            }
        }
    }
}

fun index_fun(f: &FunDecl, fi: int, out: &mut Map[int, DeclInfo]) {
    var params = [] as Vec[string]
    var variadic_at = -1
    var i = 0
    for p in f.params.iter() {
        if p.variadic && variadic_at < 0 {
            variadic_at = i
        }
        params.push("${if p.variadic { "..." } else { "" }}${p.name}: ${type_text(p.ty)}")
        i += 1
    }
    let ret = match &f.ret {
        Some(t) => " -> ${type_text(t)}"
        None => ""
    }
    out[f.id] = DeclInfo {
        kind: "fun", name: f.name.clone(), code: signature(f), file: fi, span: f.span, params, variadic_at,
        head: "${if f.is_async { "async " } else { "" }}fun ${f.name}(", ret,
    }
}

pub fun signature(f: &FunDecl) -> string {
    let generics = if f.generics.is_empty() { "" } else {
        let gs = f.generics.map(#{ g => if g.bounds.is_empty() { g.name.clone() } else { "${g.name}: ${g.bounds.map(#{ b => type_text(b) }).join(" & ")}" } })
        "[${gs.join(", ")}]"
    }
    var params = [] as Vec[string]
    if let Some(r) = &f.receiver {
        params.push(r.clone())
    }
    for p in f.params.iter() {
        params.push("${if p.variadic { "..." } else { "" }}${if p.is_mut { "mut " } else { "" }}${p.name}: ${type_text(p.ty)}")
    }
    let ret = match &f.ret {
        Some(t) => " -> ${type_text(t)}"
        None => ""
    }
    "${if f.is_pub { "pub " } else { "" }}${if f.is_async { "async " } else { "" }}fun ${f.name}${generics}(${params.join(", ")})${ret}"
}

pub fun type_text(t: &Type) -> string {
    match &t.kind {
        TName { path, args } => "${path.join(".")}${if args.is_empty() { "" } else { "[${args.map(#{ x => type_text(x) }).join(", ")}]" }}"
        TOption(x) => "${type_text(x.get())}?"
        TRef { is_mut, inner } => "&${if is_mut { "mut " } else { "" }}${type_text(inner.get())}"
        TPtr { is_mut, inner } => "*${if is_mut { "mut " } else { "" }}${type_text(inner.get())}"
        TTuple(ts) => "t(${ts.map(#{ x => type_text(x) }).join(", ")})"
        TRecord(fs) => "r{ ${fs.map(#{ f => "${f.name}: ${type_text(f.ty)}" }).join(", ")} }"
        TFn { params, ret } => "(${params.map(#{ x => type_text(x) }).join(", ")}) -> ${type_text(ret.get())}"
        TTypeOf(path) => "TypeOf(${path.join(".")})"
        TLiteral(lit) => match lit {
            LitStr(s) => json.stringify(s)
            LitInt(s) => s.clone()
            LitBool(b) => if b { "true" } else { "false" }
        }
        TUnion(ts) => ts.map(#{ x => type_text(x) }).join(" | ")
        TIntersection(ts) => ts.map(#{ x => type_text(x) }).join(" & ")
        TError => "?"
    }
}

// ---- nodes: every node of a file, with its kind and parent ----

fun add_node(out: &mut Vec[NodeInfo], id: int, span: Span, kind: &str, parent: int, name: &str, aux: int) -> int {
    out.push(r{ id, span, kind: kind.to_str(), parent, name: name.to_str(), aux })
    out.len() - 1
}

fun collect_file(f: &File, out: &mut Vec[NodeInfo]) {
    let root = add_node(out, f.id, f.span, "File", -1, "", 0)
    for imp in f.imports.iter() {
        let _ = add_node(out, imp.id, imp.span, "Import", root, "", 0)
    }
    for itm in f.items.iter() {
        collect_item(itm, root, out)
    }
}

fun collect_generics(gs: &Vec[GenericParam], parent: int, out: &mut Vec[NodeInfo]) {
    for g in gs.iter() {
        let me = add_node(out, g.id, g.span, "GenericParam", parent, g.name, 0)
        for b in g.bounds.iter() {
            collect_type(b, me, out)
        }
    }
}

fun collect_fun(f: &FunDecl, parent: int, out: &mut Vec[NodeInfo]) {
    let me = add_node(out, f.id, f.span, "FunDecl", parent, f.name, 0)
    collect_generics(f.generics, me, out)
    for p in f.params.iter() {
        let pi = add_node(out, p.id, p.span, "Param", me, p.name, 0)
        collect_type(p.ty, pi, out)
    }
    if let Some(r) = &f.ret {
        collect_type(r, me, out)
    }
    if let Some(b) = &f.body {
        collect_block(b, me, out)
    }
}

fun collect_field(f: &Field, parent: int, out: &mut Vec[NodeInfo]) {
    let me = add_node(out, f.id, f.span, "Field", parent, f.name, 0)
    collect_type(f.ty, me, out)
    if let Some(d) = &f.default {
        collect_expr(d, me, out)
    }
}

fun collect_item(itm: &Item, parent: int, out: &mut Vec[NodeInfo]) {
    match itm {
        Fun(f) => collect_fun(f, parent, out)
        TypeDef(d) => {
            let me = add_node(out, d.id, d.span, "TypeDecl", parent, d.name, 0)
            collect_generics(d.generics, me, out)
            for t in d.impls.iter() {
                collect_type(t, me, out)
            }
            match &d.body {
                Struct(b) => {
                    let bi = add_node(out, b.id, b.span, "StructBody", me, "", 0)
                    for f in b.fields.iter() {
                        collect_field(f, bi, out)
                    }
                    for m in b.methods.iter() {
                        collect_fun(m, bi, out)
                    }
                }
                Alias(t) => collect_type(t, me, out)
            }
        }
        Union(d) => {
            let me = add_node(out, d.id, d.span, "UnionDecl", parent, d.name, 0)
            collect_generics(d.generics, me, out)
            for t in d.impls.iter() {
                collect_type(t, me, out)
            }
            for v in d.variants.iter() {
                let vi = add_node(out, v.id, v.span, "Variant", me, v.name, 0)
                if let Some(ts) = &v.tuple {
                    for t in ts.iter() {
                        collect_type(t, vi, out)
                    }
                }
                if let Some(fs) = &v.fields {
                    for f in fs.iter() {
                        collect_field(f, vi, out)
                    }
                }
            }
            for m in d.methods.iter() {
                collect_fun(m, me, out)
            }
        }
        Inter(d) => {
            let me = add_node(out, d.id, d.span, "InterDecl", parent, d.name, 0)
            collect_generics(d.generics, me, out)
            for t in d.supers.iter() {
                collect_type(t, me, out)
            }
            for m in (d.methods ?? []).iter() {
                collect_fun(m, me, out)
            }
            if let Some(c) = &d.composition {
                collect_type(c, me, out)
            }
        }
        Impl(d) => {
            let me = add_node(out, d.id, d.span, "ImplDecl", parent, "", 0)
            collect_generics(d.generics, me, out)
            for t in d.interfaces.iter() {
                collect_type(t, me, out)
            }
            collect_type(d.target, me, out)
            for m in d.methods.iter() {
                collect_fun(m, me, out)
            }
        }
        Let(d) => {
            let me = add_node(out, d.id, d.span, "LetDecl", parent, d.name, 0)
            if let Some(t) = &d.ty {
                collect_type(t, me, out)
            }
            collect_expr(d.value, me, out)
        }
        Extern(d) => {
            let me = add_node(out, d.id, d.span, "ExternDecl", parent, "", 0)
            for f in d.funs.iter() {
                collect_fun(f, me, out)
            }
        }
    }
}

fun collect_type(t: &Type, parent: int, out: &mut Vec[NodeInfo]) {
    let kind = match &t.kind {
        TName { .. } => "TName"
        TOption(_) => "TOption"
        TRef { .. } => "TRef"
        TPtr { .. } => "TPtr"
        TTuple(_) => "TTuple"
        TRecord(_) => "TRecord"
        TFn { .. } => "TFn"
        TTypeOf(_) => "TTypeOf"
        TLiteral(_) => "TLiteral"
        TUnion(_) => "TUnion"
        TIntersection(_) => "TIntersection"
        TError => "TError"
    }
    let me = add_node(out, t.id, t.span, kind, parent, "", 0)
    match &t.kind {
        TName { args, .. } => {
            for a in args.iter() {
                collect_type(a, me, out)
            }
        }
        TOption(x) => collect_type(x.get(), me, out)
        TRef { inner, .. } | TPtr { inner, .. } => collect_type(inner.get(), me, out)
        TTuple(ts) | TUnion(ts) | TIntersection(ts) => {
            for x in ts.iter() {
                collect_type(x, me, out)
            }
        }
        TRecord(fs) => {
            for f in fs.iter() {
                collect_field(f, me, out)
            }
        }
        TFn { params, ret } => {
            for x in params.iter() {
                collect_type(x, me, out)
            }
            collect_type(ret.get(), me, out)
        }
        _ => {}
    }
}

fun collect_block(b: &Block, parent: int, out: &mut Vec[NodeInfo]) {
    let me = add_node(out, b.id, b.span, "Block", parent, "", 0)
    for s in b.stmts.iter() {
        match s {
            Let(l) => {
                // name: the value's kind; aux: 1 when a type is written
                let li = add_node(out, l.id, l.span, "Let", me, expr_kind(l.value), if l.ty.is_some() { 1 } else { 0 })
                collect_pattern(l.pattern, li, out)
                if let Some(t) = &l.ty {
                    collect_type(t, li, out)
                }
                collect_expr(l.value, li, out)
                if let Some(eb) = &l.else_branch {
                    collect_block(eb, li, out)
                }
            }
            ExprStmt(es) => {
                let ei = add_node(out, es.id, es.span, "ExprStmt", me, "", 0)
                collect_expr(es.expr, ei, out)
            }
        }
    }
}

fun collect_elems(elems: &Vec[Elem], parent: int, out: &mut Vec[NodeInfo]) {
    for el in elems.iter() {
        match el {
            EValue(x) => collect_expr(x, parent, out)
            ESpread { span, expr } => {
                let si = add_node(out, -1, span, "Spread", parent, "", 0)
                collect_expr(expr, si, out)
            }
        }
    }
}

fun collect_items(items: &Vec[RecordItem], parent: int, out: &mut Vec[NodeInfo]) {
    for f in items.iter() {
        match f {
            RField(rf) => {
                let ri = add_node(out, rf.id, rf.span, "RecordField", parent, rf.key, if rf.value.is_none() { 1 } else { 0 })
                if let Some(v) = &rf.value {
                    collect_expr(v, ri, out)
                }
            }
            RSpread { span, expr } => {
                let si = add_node(out, -1, span, "Spread", parent, "", 0)
                collect_expr(expr, si, out)
            }
        }
    }
}

fun opt_expr(e: &Box[Expr]?, parent: int, out: &mut Vec[NodeInfo]) {
    if let Some(x) = e {
        collect_expr(x.get(), parent, out)
    }
}

fun expr_kind(e: &Expr) -> string {
    match &e.kind {
        Ident(_) => "Ident"
        This => "This"
        Int(_) => "Int"
        Float(_) => "Float"
        Str { .. } => "Str"
        Template(_) => "Template"
        Char(_) => "Char"
        Bool(_) => "Bool"
        Nil => "Nil"
        Paren(_) => "Paren"
        VecLit(_) => "Vec"
        ArrayLit(_) => "Array"
        TupleLit(_) => "Tuple"
        RecordLit(_) => "Record"
        MapLit(_) => "Map"
        SetLit(_) => "Set"
        Inferred(_) => "Inferred"
        StructLit { .. } => "StructLit"
        Closure { .. } => "Closure"
        Unary { .. } => "Unary"
        Await(_) => "Await"
        Binary { .. } => "Binary"
        Assign { .. } => "Assign"
        RangeExpr { .. } => "Range"
        As { .. } => "As"
        Or { .. } => "Or"
        Member { .. } => "Member"
        OptMember { .. } => "OptMember"
        Call { .. } => "Call"
        IndexExpr { .. } => "Index"
        GenericApply { .. } => "GenericApply"
        Try(_) => "Try"
        If { .. } => "If"
        Match { .. } => "Match"
        Select { .. } => "Select"
        For { .. } => "For"
        BlockExpr(_) => "Block"
        Unsafe(_) => "Unsafe"
        Recover(_) => "Recover"
        Return(_) => "Return"
        Break { .. } => "Break"
        Continue(_) => "Continue"
        Error => "Error"
    }
}

pub fun expr_kind_name(e: &Expr) -> string { expr_kind(e) }

fun collect_expr(e: &Expr, parent: int, out: &mut Vec[NodeInfo]) {
    let name = match &e.kind {
        Ident(n) => n.clone()
        Member { name, .. } | OptMember { name, .. } => name.clone()
        For { form, .. } => form.clone()
        // `x or e => …`: the node declares `e`
        Or { name, .. } => name ?? ""
        _ => ""
    }
    let aux = match &e.kind {
        Call { callee, .. } => callee.get().id
        Member { object, .. } | OptMember { object, .. } => object.get().id
        GenericApply { target, .. } => target.get().id
        _ => 0
    }
    let me = add_node(out, e.id, e.span, expr_kind(e), parent, name, aux)
    match &e.kind {
        Template(parts) => {
            for p in parts.iter() {
                if let Interp(x) = p {
                    collect_expr(x, me, out)
                }
            }
        }
        Paren(x) | Await(x) | Try(x) => collect_expr(x.get(), me, out)
        VecLit(elems) | ArrayLit(elems) | TupleLit(elems) | SetLit(elems) => collect_elems(elems, me, out)
        RecordLit(items) | Inferred(items) => collect_items(items, me, out)
        MapLit(entries) => {
            for en in entries.iter() {
                match en {
                    MEntry(m) => {
                        let mi = add_node(out, m.id, m.span, "MapEntry", me, "", 0)
                        collect_expr(m.key, mi, out)
                        collect_expr(m.value, mi, out)
                    }
                    MSpread { span, expr } => {
                        let si = add_node(out, -1, span, "Spread", me, "", 0)
                        collect_expr(expr, si, out)
                    }
                }
            }
        }
        StructLit { ty, fields } => {
            collect_expr(ty.get(), me, out)
            collect_items(fields, me, out)
        }
        Closure { captures, params, ret, body } => {
            for c in (captures ?? []).iter() {
                let _ = add_node(out, c.id, c.span, "Capture", me, c.name, 0)
            }
            for p in (params ?? []).iter() {
                let pi = add_node(out, p.id, p.span, "ClosureParam", me, p.name, if p.ty.is_none() { 1 } else { 0 })
                if let Some(t) = &p.ty {
                    collect_type(t, pi, out)
                }
            }
            if let Some(r) = ret {
                collect_type(r, me, out)
            }
            collect_block(body, me, out)
        }
        Unary { expr, .. } => collect_expr(expr.get(), me, out)
        Binary { left, right, .. } | Assign { target: left, value: right, .. } => {
            collect_expr(left.get(), me, out)
            collect_expr(right.get(), me, out)
        }
        RangeExpr { start, end, .. } => {
            opt_expr(start, me, out)
            opt_expr(end, me, out)
        }
        As { expr, ty } => {
            collect_expr(expr.get(), me, out)
            collect_type(ty, me, out)
        }
        Or { expr, rhs, .. } => {
            collect_expr(expr.get(), me, out)
            collect_expr(rhs.get(), me, out)
        }
        Member { object, .. } | OptMember { object, .. } => collect_expr(object.get(), me, out)
        Call { callee, args } => {
            collect_expr(callee.get(), me, out)
            collect_elems(args, me, out)
        }
        IndexExpr { object, index } => {
            collect_expr(object.get(), me, out)
            collect_expr(index.get(), me, out)
        }
        GenericApply { target, args } => {
            collect_expr(target.get(), me, out)
            for a in args.iter() {
                collect_type(a, me, out)
            }
        }
        If { cond, then, else_branch } => {
            match cond {
                CExpr(x) => collect_expr(x.get(), me, out)
                CLet(lc) => {
                    let li = add_node(out, lc.id, lc.span, "LetCond", me, "", 0)
                    collect_pattern(lc.pattern, li, out)
                    collect_expr(lc.value.get(), li, out)
                }
            }
            collect_block(then, me, out)
            opt_expr(else_branch, me, out)
        }
        Match { subject, arms } => {
            opt_expr(subject, me, out)
            for a in arms.iter() {
                let ai = add_node(out, a.id, a.span, "MatchArm", me, "", 0)
                if let Some(p) = &a.pattern {
                    collect_pattern(p, ai, out)
                }
                if let Some(x) = &a.test {
                    collect_expr(x, ai, out)
                }
                if let Some(g) = &a.guard {
                    collect_expr(g, ai, out)
                }
                collect_expr(a.body, ai, out)
            }
        }
        Select { arms, else_branch } => {
            for a in arms.iter() {
                let ai = add_node(out, a.id, a.span, "SelectArm", me, "", 0)
                if let Some(p) = &a.pattern {
                    collect_pattern(p, ai, out)
                }
                collect_expr(a.expr, ai, out)
                collect_expr(a.body, ai, out)
            }
            opt_expr(else_branch, me, out)
        }
        For { pattern, pattern2, expr, body, .. } => {
            if let Some(p) = pattern {
                collect_pattern(p, me, out)
            }
            if let Some(p) = pattern2 {
                collect_pattern(p, me, out)
            }
            opt_expr(expr, me, out)
            collect_block(body, me, out)
        }
        BlockExpr(b) | Unsafe(b) | Recover(b) => collect_block(b, me, out)
        Return(v) => opt_expr(v, me, out)
        Break { value, .. } => opt_expr(value, me, out)
        _ => {}
    }
}

fun collect_pattern(p: &Pattern, parent: int, out: &mut Vec[NodeInfo]) {
    let t(kind, name) = match &p.kind {
        PWild => t("PWild", "")
        PBind { name, .. } => t("PBind", name.clone())
        PLit(_) => t("PLit", "")
        PRange { .. } => t("PRange", "")
        PPath(_) => t("PPath", "")
        PCall { .. } => t("PCall", "")
        PStruct { .. } => t("PStruct", "")
        PTuple { .. } => t("PTuple", "")
        POr(_) => t("POr", "")
        PError => t("PError", "")
    }
    let me = add_node(out, p.id, p.span, kind, parent, name, 0)
    match &p.kind {
        PLit(x) => collect_expr(x.get(), me, out)
        PRange { start, end, .. } => {
            opt_expr(start, me, out)
            opt_expr(end, me, out)
        }
        PCall { args, .. } => {
            for a in args.iter() {
                collect_pattern(a, me, out)
            }
        }
        PStruct { fields, .. } => {
            for f in fields.iter() {
                let fi = add_node(out, f.id, f.span, "PatField", me, f.name, 0)
                if let Some(fp) = &f.pattern {
                    collect_pattern(fp, fi, out)
                }
            }
        }
        PTuple { elems, .. } => {
            for x in elems.iter() {
                collect_pattern(x, me, out)
            }
        }
        POr(alts) => {
            for x in alts.iter() {
                collect_pattern(x, me, out)
            }
        }
        _ => {}
    }
}
