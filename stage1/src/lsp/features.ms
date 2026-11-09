// The language server's features, ported from minscript/tools/lsp/analysis.ts (hover, definition,
// references, document symbols) and features.ts (completion, signature help, inlay hints, rename).
//
// Completion has to work while the code doesn't parse (`user.` with nothing after the dot): it
// analyses a copy of the document with a placeholder name at the cursor (`user.__ms_c`), and the
// checker records what the expression before the dot can be followed by (`completions`).
package lsp

import "std.fs"
import "std.json"
import "std.utf8"
import "app.lexer.{Span}"
import "app.ast.*"
import "app.check.{COMPLETION_MARK, MemberItem, tag}"
import "app.loader.{join, is_dir}"
import "app.project.{Toolchain}"

// LSP enum values
let K_METHOD = 2
let K_FUNCTION = 3
let K_FIELD = 5
let K_VARIABLE = 6
let K_MODULE = 9
let K_KEYWORD = 14
let K_ENUM = 13
let K_FOLDER = 19
let K_ENUM_MEMBER = 20
let K_CONSTANT = 21
let K_STRUCT = 22
let K_INTERFACE = 8

let KEYWORDS = ["package", "import", "pub", "type", "union", "inter", "impl", "fun", "async", "let", "var", "mut", "extern", "if", "else", "match", "select", "for", "in", "break", "continue", "return", "await", "or", "as", "unsafe", "recover", "true", "false", "nil", "this", "Self", "TypeOf"]

fun markdown(code: &str, rest: &str) -> json.Value {
    obj([t("kind", jstr("markdown")), t("value", jstr("```minscript\n${code}\n```${rest}"))])
}

// ---- hover, definition, references ----

pub fun hover(an: &Analysis, uri: &str, pos: &json.Value) -> json.Value {
    let Some(fi) = an.main_file(uri) else { return json.Value.Null }
    let f = &an.files[fi]
    let Some(n) = an.node_at(fi, f.map.offset(pos)) else { return json.Value.Null }
    let target = an.target(n)
    let ty = match an.checked.types.get(n.id) {
        Some(x) => Some(x)
        None => match &target {
            Some(Target { sym: Some(s), .. }) => an.checked.symbols.get(s)
            _ => None
        }
    }
    let decl = match &target {
        Some(tg) => tg.decl
        None => None
    }
    let info = match decl {
        Some(d) => an.decls.get(d)
        None => None
    }
    var code = ""
    if let Some(d) = &info {
        if d.kind == "fun" || d.kind == "type" || d.kind == "union" || d.kind == "inter" || d.kind == "field" || d.kind == "variant" {
            code = d.code.clone()
        }
    }
    if code.is_empty() {
        match &target {
            Some(Target { sym: Some(s), .. }) => {
                let sy = &an.syms.get()[s]
                let word = if sy.kind == "local" { if sy.mutable { "var" } else { "let" } } else if sy.kind == "this" { "this" } else { sy.kind.replace("-", " ") }
                let name = if sy.name == "it1" { "it" } else { sy.name.clone() }
                let shown = match &ty {
                    Some(x) => ": ${an.show(x)}"
                    None => ""
                }
                code = "${word} ${name}${shown}"
            }
            _ => {
                if let Some(x) = &ty {
                    if tag(x) != "unknown" {
                        code = an.show(x)
                    }
                }
            }
        }
    }
    if code.is_empty() {
        return json.Value.Null
    }
    var note = ""
    let std = match &target {
        Some(Target { sym: Some(s), .. }) => an.syms.get()[s].std
        _ => false
    }
    if let Some(d) = decl {
        if std || an.is_prelude_node(d) {
            note = "\n\n*prelude*"
        } else if let Some(p) = an.other_package_of(d) {
            note = "\n\n*package ${p}*"
        }
    } else if std {
        note = "\n\n*prelude*"
    }
    let docs = match decl {
        Some(d) => an.doc_comment(d)
        None => ""
    }
    let rest = "${if docs.is_empty() { "" } else { "\n\n${docs}" }}${note}"
    obj([t("contents", markdown(code, rest)), t("range", f.map.range(n.span.start, n.span.end))])
}

pub fun definition(an: &Analysis, uri: &str, pos: &json.Value) -> json.Value {
    let Some(fi) = an.main_file(uri) else { return arr([]) }
    let f = &an.files[fi]
    let Some(n) = an.node_at(fi, f.map.offset(pos)) else { return arr([]) }
    let Some(tg) = an.target(n) else { return arr([]) }
    let Some(d) = tg.decl else { return arr([]) }
    match an.location(d) {
        Some(loc) => arr([loc])
        None => arr([])
    }
}

/// The symbol under the cursor, if there is one.
fun sym_at(an: &Analysis, uri: &str, pos: &json.Value) -> t(int, NodeInfo)? {
    let Some(fi) = an.main_file(uri) else { return None }
    let Some(n) = an.node_at(fi, an.files[fi].map.offset(pos)) else { return None }
    let Some(tg) = an.target(n) else { return None }
    let Some(s) = tg.sym else { return None }
    Some(t(s, n))
}

pub fun references(an: &Analysis, uri: &str, pos: &json.Value, include_declaration: bool) -> Vec[json.Value] {
    let Some(found) = sym_at(an, uri, pos) else { return [] }
    let t(s, _) = found
    var out = [] as Vec[json.Value]
    if include_declaration {
        if let Some(d) = an.syms.get()[s].decl {
            if let Some(loc) = an.location(d) {
                out.push(loc)
            }
        }
    }
    var ids = [] as Vec[int]
    for id, rf in an.res.refs {
        if rf.sym == s {
            ids.push(id)
        }
    }
    ids.sort()
    for id in ids.iter() {
        if let Some(loc) = an.location(id) {
            out.push(loc)
        }
    }
    out
}

// ---- document symbols ----

pub fun document_symbols(an: &Analysis, uri: &str) -> json.Value {
    let Some(fi) = an.main_file(uri) else { return arr([]) }
    let f = &an.files[fi]
    var out = [] as Vec[json.Value]
    for itm in f.file.items.iter() {
        match itm {
            Fun(d) => out.push(fun_symbol(an, fi, d, 12))
            TypeDef(d) => {
                var children = [] as Vec[json.Value]
                let is_struct = match &d.body {
                    Struct(b) => {
                        for x in b.fields.iter() {
                            children.push(symbol(an, fi, x.name, 8, x.id, x.span, [], Some(type_text(x.ty))))
                        }
                        for m in b.methods.iter() {
                            children.push(fun_symbol(an, fi, m, 6))
                        }
                        true
                    }
                    Alias(_) => false
                }
                out.push(symbol(an, fi, d.name, if is_struct { 23 } else { 26 }, d.id, d.span, children, None))
            }
            Union(d) => {
                var children = d.variants.map(#{ v => symbol(an, fi, v.name, 22, v.id, v.span, [], None) })
                for m in d.methods.iter() {
                    children.push(fun_symbol(an, fi, m, 6))
                }
                out.push(symbol(an, fi, d.name, 10, d.id, d.span, children, None))
            }
            Inter(d) => {
                let children = (d.methods ?? []).map(#{ m => fun_symbol(an, fi, m, 6) })
                out.push(symbol(an, fi, d.name, 11, d.id, d.span, children, None))
            }
            Impl(d) => {
                let ifaces = d.interfaces.map(#{ x => type_text(x) })
                let name = if ifaces.is_empty() { "impl ${type_text(d.target)}" } else { "impl ${ifaces.join(", ")} for ${type_text(d.target)}" }
                let children = d.methods.map(#{ m => fun_symbol(an, fi, m, 6) })
                out.push(symbol(an, fi, name, 3, d.id, d.span, children, None))
            }
            Let(d) => out.push(symbol(an, fi, d.name, 14, d.id, d.span, [], None))
            Extern(d) => {
                let children = d.funs.map(#{ m => fun_symbol(an, fi, m, 12) })
                out.push(symbol(an, fi, "extern ${json.stringify(d.abi)}", 3, d.id, d.span, children, None))
            }
        }
    }
    arr(out)
}

fun fun_symbol(an: &Analysis, fi: int, f: &FunDecl, kind: int) -> json.Value {
    // the signature after the name: `(a: int) -> int`, `[T](x: T)`
    let sig = signature(f)
    let head = "fun ${f.name}"
    let detail = match sig.find(head, 0) {
        Some(k) => sig.substring(k + head.len(), sig.len()).to_str()
        None => sig
    }
    symbol(an, fi, f.name, kind, f.id, f.span, [], Some(detail))
}

fun symbol(an: &Analysis, fi: int, name: &str, kind: int, id: int, span: Span, children: Vec[json.Value], detail: string?) -> json.Value {
    let f = &an.files[fi]
    let sel = match an.location(id) {
        Some(loc) => field(loc, "range")
        None => f.map.range(span.start, span.end)
    }
    var fields = [t("name", jstr(name)), t("kind", num(kind))] as Vec[t(string, json.Value)]
    if let Some(d) = detail {
        fields.push(t("detail", jstr(d)))
    }
    fields.push(t("range", f.map.range(span.start, span.end)))
    fields.push(t("selectionRange", sel))
    fields.push(t("children", arr(children)))
    obj(fields)
}

// ---- completion ----

fun is_ident_byte(b: u8) -> bool { (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b == 95 }

pub async fun completion(tc: &Toolchain, docs: &Vec[Doc], uri: &str, pos: &json.Value, project: &ProjectInfo?) -> Vec[json.Value] {
    let Some(doc) = docs.find(#{ d, _ => d.uri == uri }) else { return [] }
    let text = doc.text
    let map = pos_map(text)
    let index = map.offset(pos)
    let bytes = utf8.encode(text)
    var line_start = index
    for line_start > 0 && bytes[line_start - 1] != 10 {
        line_start -= 1
    }
    let before = utf8.decode_range(bytes, line_start, index)
    if let Some(typed) = import_prefix(before) {
        return await import_paths(tc, typed, project)
    }
    var start = index
    for start > line_start && is_ident_byte(bytes[start - 1]) {
        start -= 1
    }
    // the identifier must not start with a digit (`/[A-Za-z_][\w]*$/`)
    for start < index && bytes[start] >= 48 && bytes[start] <= 57 {
        start += 1
    }
    let head = utf8.decode_range(bytes, 0, start)
    let patched = "${head}${COMPLETION_MARK}${open_closers(head)}${utf8.decode_range(bytes, index, bytes.len())}"
    let others = docs.map(#{ d => if d.uri == uri { Doc { uri: uri.to_str(), text: patched.clone() } } else { d.clone() } })
    let an = await analyze(tc, others, uri, project)
    let Some(fi) = an.main_file(uri) else { return [] }
    let after_dot = start > 0 && bytes[start - 1] == 46
    if after_dot {
        for n in an.files[fi].nodes.iter() {
            if (n.kind == "Member" || n.kind == "OptMember") && n.name == COMPLETION_MARK {
                return member_items(an, n.id)
            }
        }
        return []
    }
    scope_items(an, fi, start)
}

/// `import "std.js` → `std.js`.
fun import_prefix(before: &str) -> string? {
    let s = before.trim()
    if !s.starts_with("import") {
        return None
    }
    var rest = s.substring(6, s.len()).trim().to_str()
    if rest.starts_with("pub ") {
        rest = rest.substring(4, rest.len()).trim().to_str()
    }
    if !rest.starts_with("\"") {
        return None
    }
    let typed = rest.substring(1, rest.len())
    if typed.contains("\"") { None } else { Some(typed.to_str()) }
}

fun member_items(an: &Analysis, member: int) -> Vec[json.Value] {
    let Some(items) = an.checked.completions.get(member) else { return [] }
    items.map(#{ m => member_item(an, m) })
}

fun member_item(an: &Analysis, m: &MemberItem) -> json.Value {
    let kind = if m.kind == "field" { K_FIELD } else if m.kind == "variant" { K_ENUM_MEMBER } else if m.kind == "item" { item_kind(an, m.sym) } else if m.kind == "static" { K_FUNCTION } else { K_METHOD }
    var fields = [t("label", jstr(m.name)), t("kind", num(kind))] as Vec[t(string, json.Value)]
    let info = match m.decl {
        Some(d) => an.decls.get(d)
        None => None
    }
    if let Some(d) = &info {
        if d.kind == "fun" || d.kind == "field" {
            fields.push(t("detail", jstr(d.code)))
        }
    } else if m.decl.is_none() && m.kind == "method" {
        fields.push(t("detail", jstr("auto-generated (spec §9.7)")))
    }
    if let Some(d) = m.decl {
        let docs = an.doc_comment(d)
        if !docs.is_empty() {
            fields.push(t("documentation", obj([t("kind", jstr("markdown")), t("value", jstr(docs))])))
        }
    }
    // methods last, so fields come first (sortText is compared as text)
    let sort = if m.kind == "field" || m.kind == "variant" { "0" } else if m.decl.is_none() { "2" } else { "1" }
    fields.push(t("sortText", jstr("${sort}${m.name}")))
    obj(fields)
}

fun item_kind(an: &Analysis, sym: int?) -> int {
    let Some(s) = sym else { return K_VARIABLE }
    let k = an.syms.get()[s].kind.clone()
    if k == "fun" || k == "extern-fun" { K_FUNCTION } else if k == "type" { K_STRUCT } else if k == "union" { K_ENUM } else if k == "inter" { K_INTERFACE } else if k == "global" { K_CONSTANT } else if k == "package" { K_MODULE } else { K_VARIABLE }
}

fun scope_node(kind: &str) -> bool {
    kind == "Block" || kind == "FunDecl" || kind == "Closure" || kind == "For" || kind == "MatchArm" || kind == "If" || kind == "SelectArm"
}

/// Names visible at `offset`: locals in an enclosing scope declared before it, the package's items,
/// the file's imports, the prelude, and keywords.
fun scope_items(an: &Analysis, fi: int, offset: int) -> Vec[json.Value] {
    var items = [] as Vec[json.Value]
    var seen = Set.new() as Set[string]
    let f = &an.files[fi]
    let syms = an.syms.get()
    for sy in syms.iter() {
        let local = sy.kind == "local" || sy.kind == "param" || sy.kind == "closure-param" || sy.kind == "this"
        if !local {
            continue
        }
        let Some(decl) = sy.decl else { continue }
        let Some(span) = sy.span else { continue }
        if an.file_of(decl) != Some(fi) || span.start >= offset {
            continue
        }
        let Some(dn) = an.node(decl) else { continue }
        // the scope it is declared in must contain the offset
        var scope = dn.parent
        for scope >= 0 && !scope_node(f.nodes[scope].kind) {
            scope = f.nodes[scope].parent
        }
        if scope >= 0 && (offset < f.nodes[scope].span.start || offset > f.nodes[scope].span.end) {
            continue
        }
        let detail = match an.checked.symbols.get(sy.id) {
            Some(ty) => Some("${if sy.mutable { "var" } else { "let" }} ${sy.name}: ${an.show(ty)}")
            None => None
        }
        add_item(items, seen, sy.name, K_VARIABLE, detail, "0")
    }
    for name, s in an.scopes.get()[an.res.pkg_scope].names {
        add_item(items, seen, name, item_kind(an, Some(s)), detail_of(an, s), "1")
    }
    for sy in syms.iter() {
        if (sy.kind == "package" || sy.kind == "import") && sy.decl.is_some() && an.file_of(sy.decl ?? -1) == Some(fi) {
            add_item(items, seen, sy.name, if sy.kind == "package" { K_MODULE } else { K_VARIABLE }, sy.detail, "1")
        }
    }
    for name, s in an.prelude_names {
        if syms[s].is_pub == Some(true) && !name.starts_with("_") {
            add_item(items, seen, name, item_kind(an, Some(s)), detail_of(an, s), "2")
        }
    }
    for v in ["Some", "None", "Ok", "Err"].iter() {
        add_item(items, seen, v, K_ENUM_MEMBER, Some("prelude variant"), "2")
    }
    for kw in KEYWORDS.iter() {
        add_item(items, seen, kw, K_KEYWORD, None, "3")
    }
    items
}

fun add_item(items: &mut Vec[json.Value], seen: &mut Set[string], label: &str, kind: int, detail: string?, sort: &str) {
    if label == COMPLETION_MARK || label.starts_with("$") || !seen.insert(label.to_str()) {
        return
    }
    var fields = [t("label", jstr(label)), t("kind", num(kind))] as Vec[t(string, json.Value)]
    if let Some(d) = detail {
        fields.push(t("detail", jstr(d)))
    }
    fields.push(t("sortText", jstr("${sort}${label}")))
    items.push(obj(fields))
}

fun detail_of(an: &Analysis, s: int) -> string? {
    let Some(d) = an.syms.get()[s].decl else { return None }
    let Some(info) = an.decls.get(d) else { return None }
    if info.kind == "fun" || info.kind == "type" || info.kind == "union" || info.kind == "inter" { Some(info.code) } else { None }
}

/// `import "std.` → std packages; `"app.` → folders under main; `path:` dependencies.
async fun import_paths(tc: &Toolchain, typed: &str, project: &ProjectInfo?) -> Vec[json.Value] {
    let dot = last_index(typed, ".")
    let parent = if dot < 0 { "" } else { typed.substring(0, dot).to_str() }
    let segs = if parent.is_empty() { [] as Vec[string] } else { parent.split(".").map(#{ s => s.to_str() }) }
    var roots = [t("std", tc.std_dir.clone())] as Vec[t(string, string)]
    if let Some(p) = project {
        roots.push(t("app", p.main_dir.clone()))
        for name, dir in p.deps {
            roots.push(t(name.clone(), dir.clone()))
        }
    }
    if segs.is_empty() {
        return roots.map(#{ r => obj([t("label", jstr(r.0)), t("kind", num(K_MODULE))]) })
    }
    let Some(root) = roots.find(#{ r, _ => r.0 == segs[0] }) else { return [] }
    var dir = root.1
    var i = 1
    for i < segs.len() {
        dir = join(dir, segs[i])
        i += 1
    }
    var names = match await fs.list_dir(dir) {
        Ok(ns) => ns
        Err(_) => return []
    }
    names.sort()
    var out = [] as Vec[json.Value]
    for e in names.iter() {
        if !e.starts_with(".") && e != "node_modules" && await is_dir(join(dir, e)) {
            out.push(obj([t("label", jstr(e)), t("kind", num(K_FOLDER))]))
        }
    }
    out
}

fun last_index(s: &str, needle: &str) -> int {
    var found = -1
    var from = 0
    for let Some(k) = s.find(needle, from) {
        found = k
        from = k + 1
    }
    found
}

/// What would close the brackets still open at the end of `before`, back to the innermost open block.
/// A block's `{` ends its header line, so a `{` with more on its line is inline (a closure `#{`, a
/// literal) and is closed too. Strings and comments are skipped.
fun open_closers(before: &str) -> string {
    let b = utf8.encode(before)
    var stack = [] as Vec[u8]
    var i = 0
    let n = b.len()
    for i < n {
        let c = b[i]
        if c == 47 && i + 1 < n && b[i + 1] == 47 {
            for i < n && b[i] != 10 {
                i += 1
            }
            if i >= n {
                break
            }
            i += 1
            continue
        }
        if c == 34 {
            i += 1
            for i < n && b[i] != 34 && b[i] != 10 {
                if b[i] == 92 {
                    i += 1
                }
                i += 1
            }
            i += 1
            continue
        }
        if c == 40 || c == 91 {
            stack.push(c)
        } else if c == 123 {
            // a block when nothing but whitespace follows on its line
            var k = i + 1
            for k < n && b[k] != 10 && (b[k] == 32 || b[k] == 9 || b[k] == 13) {
                k += 1
            }
            stack.push(if k < n && b[k] == 10 { 66 } else { 123 })
        } else if (c == 41 || c == 93 || c == 125) && !stack.is_empty() {
            let _ = stack.pop()
        }
        i += 1
    }
    var out = ""
    var j = stack.len() - 1
    for j >= 0 && stack[j] != 66 {
        out = "${out}${if stack[j] == 40 { ")" } else if stack[j] == 91 { "]" } else { " }" }}"
        j -= 1
    }
    out
}

// ---- signature help ----

pub async fun signature_help(tc: &Toolchain, docs: &Vec[Doc], uri: &str, pos: &json.Value, project: &ProjectInfo?) -> json.Value {
    let Some(doc) = docs.find(#{ d, _ => d.uri == uri }) else { return json.Value.Null }
    let bytes = utf8.encode(doc.text)
    let index = pos_map(doc.text).offset(pos)
    let head = utf8.decode_range(bytes, 0, index)
    // a placeholder argument, and the closers of what is still open, keep `f(a, ` parseable
    let patched = "${head}${COMPLETION_MARK}${open_closers(head)}${utf8.decode_range(bytes, index, bytes.len())}"
    let others = docs.map(#{ d => if d.uri == uri { Doc { uri: uri.to_str(), text: patched.clone() } } else { d.clone() } })
    let an = await analyze(tc, others, uri, project)
    let Some(fi) = an.main_file(uri) else { return json.Value.Null }
    let offset = index
    var best: NodeInfo? = None
    for n in an.files[fi].nodes.iter() {
        if n.kind != "Call" {
            continue
        }
        let Some(callee) = an.node(n.aux) else { continue }
        if offset <= callee.span.end || offset > n.span.end {
            continue
        }
        match &best {
            Some(b) => if n.span.end - n.span.start < b.span.end - b.span.start { best = Some(n) }
            None => best = Some(n)
        }
    }
    let Some(call) = best else { return json.Value.Null }
    let Some(callee0) = an.node(call.aux) else { return json.Value.Null }
    let callee = if callee0.kind == "GenericApply" { an.node(callee0.aux) ?? callee0 } else { callee0 }
    let decl = match an.call_decl(call.id) {
        Some(d) => Some(d)
        None => match an.target(callee) {
            Some(tg) => tg.decl
            None => None
        }
    }
    let Some(d) = decl else { return json.Value.Null }
    let Some(info) = an.decls.get(d) else { return json.Value.Null }
    if info.kind != "fun" {
        return json.Value.Null
    }
    var label = info.head.clone()
    var ranges = [] as Vec[json.Value]
    var i = 0
    for p in info.params.iter() {
        if i > 0 {
            label = "${label}, "
        }
        let at = u16(label)
        ranges.push(obj([t("label", arr([num(at), num(at + u16(p))]))]))
        label = "${label}${p}"
        i += 1
    }
    label = "${label})${info.ret}"
    let pbytes = utf8.encode(patched)
    let between = utf8.decode_range(pbytes, callee0.span.end, index)
    var active = top_level_commas(between)
    if info.variadic_at >= 0 && active > info.variadic_at {
        active = info.variadic_at
    }
    let last = if info.params.is_empty() { 0 } else { info.params.len() - 1 }
    var sig = [t("label", jstr(label)), t("parameters", arr(ranges))] as Vec[t(string, json.Value)]
    let about = an.doc_comment(d)
    if !about.is_empty() {
        sig.push(t("documentation", obj([t("kind", jstr("markdown")), t("value", jstr(about))])))
    }
    obj([t("signatures", arr([obj(sig)])), t("activeSignature", num(0)), t("activeParameter", num(if active < last { active } else { last }))])
}

fun u16(s: &str) -> int {
    var n = 0
    var i = 0
    for i < s.len() {
        let b = s.byte_at(i)
        if b < 128 || b >= 192 {
            n += 1
        }
        if b >= 240 {
            n += 1
        }
        i += 1
    }
    n
}

/// Commas between `(` and the cursor that separate arguments of this call (not of nested ones).
fun top_level_commas(s: &str) -> int {
    var depth = 0
    var n = 0
    var in_string = false
    var i = 0
    for i < s.len() {
        let c = s.byte_at(i)
        if in_string {
            if c == 92 {
                i += 1
            } else if c == 34 {
                in_string = false
            }
        } else if c == 34 {
            in_string = true
        } else if c == 40 || c == 91 || c == 123 {
            depth += 1
        } else if c == 41 || c == 93 || c == 125 {
            depth -= 1
        } else if c == 44 && depth == 1 {
            n += 1
        }
        i += 1
    }
    n
}

// ---- inlay hints ----

let OBVIOUS = ["StructLit", "Str", "Int", "Float", "Bool", "Char", "As", "Template"]

/// Inferred types where the code doesn't write one: `let` / `:=` without a type, closure parameters,
/// `for` bindings.
pub fun inlay_hints(an: &Analysis, uri: &str, range: &json.Value) -> json.Value {
    let Some(fi) = an.main_file(uri) else { return arr([]) }
    let f = &an.files[fi]
    let from = f.map.offset(field(range, "start"))
    let to = f.map.offset(field(range, "end"))
    var hints = [] as Vec[t(int, json.Value)]
    var i = 0
    for n in f.nodes.iter() {
        if n.kind == "Let" && n.aux == 0 && !OBVIOUS.contains(n.name) {
            // its first child is the pattern
            if let Some(p) = first_child(f, i) {
                if p.kind == "PBind" {
                    hint(an, f, p, from, to, hints)
                }
            }
        } else if n.kind == "ClosureParam" && n.aux == 1 {
            hint(an, f, n, from, to, hints)
        } else if n.kind == "For" && n.name == "in" {
            var k = i + 1
            for k < f.nodes.len() && f.nodes[k].parent == i && f.nodes[k].kind.starts_with("P") {
                if f.nodes[k].kind == "PBind" {
                    hint(an, f, f.nodes[k], from, to, hints)
                }
                k += 1
            }
        }
        i += 1
    }
    hints.sort_by(#{ a, b => if a.0 < b.0 { Less } else if a.0 > b.0 { Greater } else { Equal } })
    arr(hints.map(#{ h => h.1.clone() }))
}

fun first_child(f: &FileInfo, i: int) -> NodeInfo? {
    if i + 1 < f.nodes.len() && f.nodes[i + 1].parent == i { Some(f.nodes[i + 1]) } else { None }
}

fun hint(an: &Analysis, f: &FileInfo, n: NodeInfo, from: int, to: int, out: &mut Vec[t(int, json.Value)]) {
    let Some(s) = an.res.decls.get(n.id) else { return }
    let Some(ty) = an.checked.symbols.get(s) else { return }
    let shown = an.show(ty)
    if shown.contains("unknown") || shown.contains("{integer}") || shown.contains("{float}") || has_hole(shown) {
        return
    }
    let end = n.span.start + n.name.len()
    if end < from || end > to {
        return
    }
    out.push(t(end, obj([t("position", f.map.position(end)), t("label", jstr(": ${shown}")), t("kind", num(1)), t("paddingLeft", json.Value.Bool(false))])))
}

/// A `_` standing alone (`/\b_\b/`): a type not inferred yet.
fun has_hole(s: &str) -> bool {
    var i = 0
    for i < s.len() {
        if s.byte_at(i) == 95 {
            let before = i == 0 || !is_ident_byte(s.byte_at(i - 1))
            let after = i + 1 >= s.len() || !is_ident_byte(s.byte_at(i + 1))
            if before && after {
                return true
            }
        }
        i += 1
    }
    false
}

// ---- rename ----

fun renamable(kind: &str) -> bool {
    kind == "local" || kind == "param" || kind == "closure-param" || kind == "fun" || kind == "global" || kind == "type" || kind == "union" || kind == "inter"
}

/// The name under the cursor, if it can be renamed: declared in this package, not `this` / `it`.
fun rename_target(an: &Analysis, uri: &str, pos: &json.Value) -> t(int, json.Value)? {
    let Some(found) = sym_at(an, uri, pos) else { return None }
    let t(s, n) = found
    let sy = &an.syms.get()[s]
    let is_it = sy.name == "it" || (sy.name.starts_with("it") && sy.name.substring(2, sy.name.len()).bytes().all(#{ b => b >= 48 && b <= 57 }))
    if !renamable(sy.kind) || sy.std || is_it {
        return None
    }
    let Some(d) = sy.decl else { return None }
    let Some(dfile) = an.file_of(d) else { return None }
    if dfile >= an.main_count {
        return None                 // declared outside this package
    }
    let Some(loc) = an.location(n.id) else { return None }
    Some(t(s, field(loc, "range")))
}

pub fun prepare_rename(an: &Analysis, uri: &str, pos: &json.Value) -> json.Value {
    let Some(found) = rename_target(an, uri, pos) else { return json.Value.Null }
    let t(s, range) = found
    obj([t("range", range), t("placeholder", jstr(an.syms.get()[s].name))])
}

/// Ok: the workspace edit (Null: nothing to rename); Err: why the new name is invalid.
pub fun rename(an: &Analysis, uri: &str, pos: &json.Value, new_name: &str) -> Result[json.Value, string] {
    let Some(found) = rename_target(an, uri, pos) else { return Ok(json.Value.Null) }
    let t(s, _) = found
    let valid = !new_name.is_empty() && !(new_name.byte_at(0) >= 48 && new_name.byte_at(0) <= 57) && new_name.bytes().all(#{ b => is_ident_byte(b) })
    if !valid || KEYWORDS.contains(new_name.to_str()) || ["while", "loop", "yield", "macro", "where", "dyn"].contains(new_name.to_str()) {
        return Err("`${new_name}` isn't a valid name")
    }
    var changes = m{} as Map[string, Vec[json.Value]]
    for loc in references(an, uri, pos, true).iter() {
        let u = text_of(field(loc, "uri"))
        var list = changes.get(u) ?? []
        list.push(obj([t("range", field(loc, "range")), t("newText", jstr(new_name))]))
        changes[u] = list
    }
    // `User { name }` uses a local through the field shorthand: keep the field, rename the local
    for id, rf in an.res.refs {
        if rf.sym != s {
            continue
        }
        let Some(n) = an.node(id) else { continue }
        if n.kind != "RecordField" || n.aux != 1 {
            continue
        }
        let Some(loc) = an.location(id) else { continue }
        let u = text_of(field(loc, "uri"))
        let start = field(field(loc, "range"), "start")
        var list = changes.get(u) ?? []
        var k = 0
        for k < list.len() {
            let rs = field(field(list[k], "range"), "start")
            if int_of(field(rs, "line")) == int_of(field(start, "line")) && int_of(field(rs, "character")) == int_of(field(start, "character")) {
                list[k] = obj([t("range", field(list[k], "range")), t("newText", jstr("${n.name}: ${new_name}"))])
            }
            k += 1
        }
        changes[u] = list
    }
    var out = m{} as Map[string, json.Value]
    for u, list in changes {
        out[u.clone()] = arr(list.clone())
    }
    Ok(obj([t("changes", json.Value.Object(out))]))
}
