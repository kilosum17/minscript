// The MinScript language server (LSP over stdio). Run with Node ≥ 23.6: `node tools/lsp/server.ts --stdio`.
// The VS Code extension (tools/vscode) starts it; any LSP client can.
//
// A package is every `.ms` file in a folder that declares the same `package` (open editors override
// the files on disk). Each change re-runs every pass on the changed file's package (debounced), and
// publishes diagnostics for all of its files.

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import lsp from "vscode-languageserver/node.js"
import { TextDocument } from "vscode-languageserver-textdocument"
import { analyze, definition, documentSymbols, hover, packageName, references, type Analysis, type Doc } from "./analysis.ts"

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

/** The files of a document's package: open documents first, then the rest of the folder from disk. */
function packageDocs(uri: string, text: string): Doc[] {
    if (!uri.startsWith("file:")) return [{ uri, text }]
    const name = packageName(text)
    const dir = dirname(fileURLToPath(uri))
    const docs: Doc[] = [{ uri, text }]
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { /* the folder may be gone */ }
    for (const entry of entries) {
        if (!entry.endsWith(".ms")) continue
        const other = pathToFileURL(join(dir, entry)).href
        if (other === uri) continue
        const open = documents.get(other)
        let content: string
        try { content = open ? open.getText() : readFileSync(join(dir, entry), "utf8") } catch { continue }
        if (packageName(content) === name) docs.push({ uri: other, text: content })
    }
    return docs
}

function analyzeNow(uri: string): Analysis | null {
    const doc = documents.get(uri)
    if (!doc) return null
    const text = doc.getText()
    const key = packageKey(uri, text)
    let an: Analysis
    try {
        an = analyze(packageDocs(uri, text), uri)
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
