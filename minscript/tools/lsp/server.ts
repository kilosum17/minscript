// The MinScript language server (LSP over stdio). Run with Node ≥ 23.6: `node tools/lsp/server.ts --stdio`.
// The VS Code extension (tools/vscode) starts it; any LSP client can.
//
// A package is every `.ms` file in a folder that declares the same `package` (a `main` file is a
// package of its own). Each change re-runs every pass on the changed file's package and everything
// it imports (src/loader.ts; open editors override the files on disk), debounced, and publishes
// diagnostics for all of the package's files. In a project (a folder with a mod.ms), the mod.ms is
// evaluated (once per version of its text) to find the `main` folder and the `path:` dependencies.

import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import lsp from "vscode-languageserver/node.js"
import { TextDocument } from "vscode-languageserver-textdocument"
import { defaultMainDir, findProjectRoot, MOD_FILE, openProject } from "../../src/project.ts"
import { analyze, definition, documentSymbols, hover, packageName, references, type Analysis, type Doc, type ProjectInfo } from "./analysis.ts"

const connection = lsp.createConnection(lsp.ProposedFeatures.all)
const documents = new lsp.TextDocuments(TextDocument)

/** The latest analysis of each package, keyed by `folder|package`. */
const analyses = new Map<string, Analysis>()
const pending = new Map<string, ReturnType<typeof setTimeout>>()
const published = new Map<string, Set<string>>()       // package key → URIs with published diagnostics

function packageKey(uri: string, text: string): string {
    if (!uri.startsWith("file:")) return uri
    return `${dirname(fileURLToPath(uri))}|${packageName(text) ?? ""}`
}

/** Every open editor (they override the files on disk; the loader reads the rest from disk). */
function openDocs(): Doc[] {
    return documents.all().map((d) => ({ uri: d.uri, text: d.getText() }))
}

// ---- projects: each mod.ms is evaluated once per version of its text (spec §17.5) -------------

const projects = new Map<string, { modText: string, info: ProjectInfo, evaluating: boolean }>()

function modText(root: string): string {
    const path = `${root}/${MOD_FILE}`
    const open = documents.get(pathToFileURL(path).href)
    if (open) return open.getText()
    try { return readFileSync(path, "utf8") } catch { return "" }
}

/** The project a file belongs to (null: none; the file is analysed on its own). Until its mod.ms has
 *  been evaluated, the default `main` folder is used; the evaluation re-analyses the open files. */
function projectFor(uri: string): ProjectInfo | null {
    if (!uri.startsWith("file:")) return null
    const root = findProjectRoot(fileURLToPath(uri))
    if (root === null) return null
    const text = modText(root)
    const known = projects.get(root)
    if (known && known.modText === text) return known.info
    const info: ProjectInfo = known?.info ?? { mainDir: defaultMainDir(root), deps: new Map() }
    projects.set(root, { modText: text, info, evaluating: true })
    const read = (p: string) => { const d = documents.get(pathToFileURL(p).href); if (d) return d.getText(); try { return readFileSync(p, "utf8") } catch { return null } }
    openProject(root, { read }).then((p) => {
        if (projects.get(root)?.modText !== text) return            // edited again meanwhile
        projects.set(root, { modText: text, info: { mainDir: p.mainDir, deps: p.deps }, evaluating: false })
        for (const d of documents.all()) if (d.uri.startsWith(pathToFileURL(root).href)) schedule(d.uri)
    }, (e) => connection.console.error(`MinScript: evaluating ${root}/${MOD_FILE} failed: ${e instanceof Error ? e.message : String(e)}`))
    return info
}

function analyzeNow(uri: string): Analysis | null {
    const doc = documents.get(uri)
    if (!doc) return null
    const text = doc.getText()
    const key = packageKey(uri, text)
    let an: Analysis
    try {
        an = analyze(openDocs(), uri, projectFor(uri))
    } catch (e) {
        connection.console.error(`MinScript: analysis failed for ${uri}: ${e instanceof Error ? e.stack : String(e)}`)
        return null
    }
    analyses.set(key, an)
    const now = new Set(an.diagnostics.keys())
    for (const [file, diags] of an.diagnostics) connection.sendDiagnostics({ uri: file, diagnostics: diags })
    for (const old of published.get(key) ?? []) if (!now.has(old)) connection.sendDiagnostics({ uri: old, diagnostics: [] })
    published.set(key, now)
    return an
}

function schedule(uri: string): void {
    const t = pending.get(uri)
    if (t) clearTimeout(t)
    pending.set(uri, setTimeout(() => {
        pending.delete(uri)
        analyzeNow(uri)
    }, 150))
}

/** The analysis to answer a request with: fresh if an edit is still pending. */
function current(uri: string): Analysis | null {
    const doc = documents.get(uri)
    if (!doc) return null
    if (pending.has(uri)) {
        clearTimeout(pending.get(uri))
        pending.delete(uri)
        return analyzeNow(uri)
    }
    return analyses.get(packageKey(uri, doc.getText())) ?? analyzeNow(uri)
}

connection.onInitialize(() => ({
    capabilities: {
        textDocumentSync: lsp.TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
    },
    serverInfo: { name: "minscript", version: "0.1.0" },
}))

// (opening a document also fires a content change)
documents.onDidChangeContent((e) => schedule(e.document.uri))
documents.onDidClose((e) => {
    // the package still exists on disk: re-check it from there so its diagnostics stay right
    const key = packageKey(e.document.uri, e.document.getText())
    if (!analyses.has(key)) return
    for (const uri of published.get(key) ?? []) connection.sendDiagnostics({ uri, diagnostics: [] })
    analyses.delete(key)
    published.delete(key)
})

connection.onHover((p) => {
    const an = current(p.textDocument.uri)
    return an ? hover(an, p.textDocument.uri, p.position) : null
})
connection.onDefinition((p) => {
    const an = current(p.textDocument.uri)
    return an ? definition(an, p.textDocument.uri, p.position) : []
})
connection.onReferences((p) => {
    const an = current(p.textDocument.uri)
    return an ? references(an, p.textDocument.uri, p.position, p.context.includeDeclaration) : []
})
connection.onDocumentSymbol((p) => {
    const an = current(p.textDocument.uri)
    return an ? documentSymbols(an, p.textDocument.uri) : []
})

documents.listen(connection)
connection.listen()
