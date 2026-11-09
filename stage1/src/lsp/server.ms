// The MinScript language server (LSP over stdin / stdout): `ms1 lsp`. Ported from
// minscript/tools/lsp/server.ts, which uses the `vscode-languageserver` library; here the protocol is
// written out (protocol.ms).
//
// A package is every `.ms` file in a folder that declares the same `package` (a `main` file is a
// package of its own). Each change re-runs every pass on the changed file's package and everything it
// imports (open editors override the files on disk), debounced, and publishes diagnostics for all of
// the package's files. In a project (a folder with a mod.ms), the mod.ms is evaluated (once per
// version of its text) to find the `main` folder and the `path:` dependencies.
//
// Documents are synced in full (stage 0: incrementally). The server's state is shared between the
// request loop and the debounced analyses: a `Ref`.
package lsp

import "std.fs"
import "std.io"
import "std.json"
import "std.runtime"
import "std.time"
import "app.fmt.{format}"
import "app.loader.{dirname, join}"
import "app.project.{Toolchain, find_project_root, open_project, default_main_dir, fmt_options_from, QUIET}"

type ProjectEntry = { mod_text: string, info: ProjectInfo }

type State = {
    docs: Map[string, string] = m{}
    /// each document's version (bumped by every change)
    versions: Map[string, int] = m{}
    /// the latest analysis of each package (`folder|package`), and the versions it saw
    analyses: Map[string, Ref[Analysis]] = m{}
    analysed: Map[string, int] = m{}
    /// package key → URIs with published diagnostics
    published: Map[string, Vec[string]] = m{}
    projects: Map[string, ProjectEntry] = m{}
}

/// `ms1 lsp`: serves until the client says `exit` (or closes the input).
pub async fun serve(tc: Toolchain) {
    QUIET.set(true)
    let st = Ref(State {})
    for {
        let Some(msg) = await read_message() else { break }
        let method = text_of(field(msg, "method"))
        let id = field(msg, "id")
        let params = field(msg, "params")
        if method == "exit" {
            runtime.exit(0)
        }
        let reply = recover { await handle(tc, st, method, params) }
        if is_null(id) {
            continue                    // a notification
        }
        match reply {
            Ok(inner) => match inner {
                Ok(result) => respond(id, result)
                Err(why) => respond_error(id, -32602, why)
            }
            Err(p) => {
                io.eprintln("MinScript: ${method} failed: ${p.message}")
                respond_error(id, -32603, p.message)
            }
        }
    }
}

fun capabilities() -> json.Value {
    let sig = obj([t("triggerCharacters", arr([jstr("("), jstr(",")])), t("retriggerCharacters", arr([jstr(",")]))])
    let caps = obj([
        t("textDocumentSync", num(1)),
        t("hoverProvider", json.Value.Bool(true)),
        t("definitionProvider", json.Value.Bool(true)),
        t("referencesProvider", json.Value.Bool(true)),
        t("documentSymbolProvider", json.Value.Bool(true)),
        t("completionProvider", obj([t("triggerCharacters", arr([jstr("."), jstr("\"")]))])),
        t("signatureHelpProvider", sig),
        t("inlayHintProvider", json.Value.Bool(true)),
        t("renameProvider", obj([t("prepareProvider", json.Value.Bool(true))])),
        t("documentFormattingProvider", json.Value.Bool(true)),
    ])
    obj([t("capabilities", caps), t("serverInfo", obj([t("name", jstr("minscript")), t("version", jstr("0.2.0"))]))])
}

/// Ok: the result (Null for a notification); Err: an invalid request.
async fun handle(tc: &Toolchain, st: Ref[State], method: &str, params: &json.Value) -> Result[json.Value, string] {
    let doc = field(params, "textDocument")
    let uri = text_of(field(doc, "uri"))
    let pos = field(params, "position")
    if method == "initialize" {
        return Ok(capabilities())
    }
    if method == "shutdown" {
        return Ok(json.Value.Null)
    }
    if method == "textDocument/didOpen" {
        set_doc(st, uri, text_of(field(doc, "text")))
        schedule(tc, st, uri)
        return Ok(json.Value.Null)
    }
    if method == "textDocument/didChange" {
        // full sync: the last change is the whole text
        if let json.Value.Array(changes) = field(params, "contentChanges") {
            if let Some(last) = changes.last() {
                set_doc(st, uri, text_of(field(last, "text")))
                schedule(tc, st, uri)
            }
        }
        return Ok(json.Value.Null)
    }
    if method == "textDocument/didClose" {
        closed(st, uri)
        return Ok(json.Value.Null)
    }
    if method == "textDocument/formatting" {
        return Ok(await formatting(tc, st, uri, field(params, "options")))
    }
    if method == "textDocument/completion" {
        if !st.get().docs.has(uri) {
            return Ok(arr([]))
        }
        let project = await project_for(tc, st, uri)
        return Ok(arr(await completion(tc, docs_of(st), uri, pos, project)))
    }
    if method == "textDocument/signatureHelp" {
        if !st.get().docs.has(uri) {
            return Ok(json.Value.Null)
        }
        let project = await project_for(tc, st, uri)
        return Ok(await signature_help(tc, docs_of(st), uri, pos, project))
    }
    let known = method == "textDocument/hover" || method == "textDocument/definition" || method == "textDocument/references" || method == "textDocument/documentSymbol"
        || method == "textDocument/inlayHint" || method == "textDocument/prepareRename" || method == "textDocument/rename"
    if !known {
        return Ok(json.Value.Null)      // not supported: nothing
    }
    let Some(handle) = await current(tc, st, uri) else {
        return Ok(if method == "textDocument/hover" || method == "textDocument/prepareRename" || method == "textDocument/rename" { json.Value.Null } else { arr([]) })
    }
    let an = handle.get()
    if method == "textDocument/hover" {
        return Ok(hover(an, uri, pos))
    }
    if method == "textDocument/definition" {
        return Ok(definition(an, uri, pos))
    }
    if method == "textDocument/references" {
        let include = match field(field(params, "context"), "includeDeclaration") {
            json.Value.Bool(b) => b
            _ => false
        }
        return Ok(arr(references(an, uri, pos, include)))
    }
    if method == "textDocument/documentSymbol" {
        return Ok(document_symbols(an, uri))
    }
    if method == "textDocument/inlayHint" {
        return Ok(inlay_hints(an, uri, field(params, "range")))
    }
    if method == "textDocument/prepareRename" {
        return Ok(prepare_rename(an, uri, pos))
    }
    rename(an, uri, pos, text_of(field(params, "newName")))
}

fun set_doc(st: Ref[State], uri: string, text: string) {
    st.update(#[uri, text]{ s =>
        let v = (s.versions.get(uri) ?? 0) + 1
        s.versions[uri.clone()] = v
        s.docs[uri.clone()] = text.clone()
    })
}

fun docs_of(st: Ref[State]) -> Vec[Doc] {
    var out = [] as Vec[Doc]
    for uri, text in st.get().docs {
        out.push(Doc { uri: uri.clone(), text: text.clone() })
    }
    out
}

fun package_key(uri: &str, text: &str) -> string {
    match uri_path(uri) {
        Some(p) => "${dirname(p)}|${package_name(text) ?? ""}"
        None => uri.to_str()
    }
}

fun closed(st: Ref[State], uri: string) {
    let text = st.get().docs.get(uri) ?? ""
    let key = package_key(uri, text)
    for u in (st.get().published.get(key) ?? []).iter() {
        notify("textDocument/publishDiagnostics", obj([t("uri", jstr(u)), t("diagnostics", arr([]))]))
    }
    st.update(#[uri, key]{ s =>
        let _ = s.docs.remove(uri)
        let _ = s.versions.remove(uri)
        let _ = s.analysed.remove(uri)
        let _ = s.analyses.remove(key)
        let _ = s.published.remove(key)
    })
}

/// An analysis after the editor pauses typing (150 ms without a change).
fun schedule(tc: &Toolchain, st: Ref[State], uri: string) {
    let v = st.get().versions.get(uri) ?? 0
    debounce(tc.clone(), st, uri, v).ignore()
}

async fun debounce(tc: Toolchain, st: Ref[State], uri: string, version: int) {
    await time.sleep(150)
    let now = st.get().versions.get(uri) ?? -1
    let done = st.get().analysed.get(uri) ?? -1
    if now == version && done != version {
        let _ = await analyze_now(tc, st, uri)
    }
}

async fun analyze_now(tc: &Toolchain, st: Ref[State], uri: &str) -> Ref[Analysis]? {
    let Some(text) = st.get().docs.get(uri) else { return None }
    let version = st.get().versions.get(uri) ?? 0
    let key = package_key(uri, text)
    let project = await project_for(tc, st, uri)
    let an = await analyze(tc, docs_of(st), uri, project)
    var now = [] as Vec[string]
    for entry in an.diagnostics.iter() {
        let t(file, diags) = entry
        notify("textDocument/publishDiagnostics", obj([t("uri", jstr(file)), t("diagnostics", arr(diags.clone()))]))
        now.push(file.clone())
    }
    for old in (st.get().published.get(key) ?? []).iter() {
        if !now.contains(old) {
            notify("textDocument/publishDiagnostics", obj([t("uri", jstr(old)), t("diagnostics", arr([]))]))
        }
    }
    let handle = Ref(an)
    st.update(#[key, now, handle, version, uri]{ s =>
        s.analyses[key.clone()] = handle
        s.published[key.clone()] = now.clone()
        s.analysed[uri.to_str()] = version
    })
    Some(handle)
}

/// The analysis to answer a request with: fresh if an edit hasn't been analysed yet.
async fun current(tc: &Toolchain, st: Ref[State], uri: &str) -> Ref[Analysis]? {
    let Some(text) = st.get().docs.get(uri) else { return None }
    let version = st.get().versions.get(uri) ?? 0
    let done = st.get().analysed.get(uri) ?? -1
    if done == version {
        if let Some(h) = st.get().analyses.get(package_key(uri, text)) {
            return Some(h)
        }
    }
    await analyze_now(tc, st, uri)
}

/// The project a file belongs to (None: none; the file is analysed on its own). Its mod.ms is
/// evaluated once per version of its text.
async fun project_for(tc: &Toolchain, st: Ref[State], uri: &str) -> ProjectInfo? {
    let Some(path) = uri_path(uri) else { return None }
    let Some(root) = await find_project_root(tc, path) else { return None }
    let mod_path = join(root, "mod.ms")
    let mod_text = match st.get().docs.get(path_uri(mod_path)) {
        Some(t) => t
        None => match await fs.read_text(mod_path) {
            Ok(t) => t
            Err(_) => ""
        }
    }
    if let Some(known) = st.get().projects.get(root) {
        if known.mod_text == mod_text {
            return Some(known.info)
        }
    }
    let p = await open_project(tc, root)
    if !p.errors.is_empty() {
        io.eprintln("MinScript: evaluating ${mod_path} failed: ${p.errors.join("; ")}")
    }
    let fmt_section = match &p.config {
        Some(c) => c.sections.get("fmt")
        None => None
    }
    let info = ProjectInfo { main_dir: p.main_dir.clone(), deps: p.deps.clone(), fmt: fmt_section }
    let entry = ProjectEntry { mod_text, info: info.clone() }
    st.update(#[root, entry]{ s => s.projects[root.clone()] = entry.clone() })
    Some(info)
}

/// The whole document, with the project's `fmt` settings (mod.ms); the editor's tab size when there
/// is no project. A document with a syntax error isn't changed.
async fun formatting(tc: &Toolchain, st: Ref[State], uri: &str, options: json.Value) -> json.Value {
    let Some(text) = st.get().docs.get(uri) else { return arr([]) }
    let project = await project_for(tc, st, uri)
    var opts = fmt_options_from(None)
    match &project {
        Some(p) => {
            if p.fmt.is_some() {
                opts = fmt_options_from(p.fmt)
            } else {
                opts.indent = int_of(field(options, "tabSize"))
            }
        }
        None => opts.indent = int_of(field(options, "tabSize"))
    }
    if opts.indent <= 0 {
        opts.indent = 4
    }
    let r = format(text, opts)
    let Some(out) = r.text else { return arr([]) }
    if out == text {
        return arr([])
    }
    let map = pos_map(text)
    let range = obj([t("start", obj([t("line", num(0)), t("character", num(0))])), t("end", map.position(map.bytes.len()))])
    arr([obj([t("range", range), t("newText", jstr(out))])])
}
