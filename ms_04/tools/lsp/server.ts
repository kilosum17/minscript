// The MinScript v0.4 language server (LSP over stdio): `node tools/lsp/server.ts --stdio` (Node ≥ 23.6).
// The VS Code extension (tools/vscode) starts it; any LSP client can.
//
// A package is every `.ms` file in a folder that declares the same `package`; `package main` files
// of a folder are one package (§17.6). Each change re-runs the whole front end on the changed
// file's package and everything it imports (open editors override the files on disk), debounced,
// and publishes diagnostics (lints included) for every file of the package. In a project, the
// evaluated mod.ms says where `main` is and which `path:` dependencies exist (src/project.ts).

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import lsp from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { analyze, definition, documentSymbols, hover, packageName, references, type Analysis, type Doc } from "./analysis.ts";
import { completion, inlayHints, prepareRename, rename, signatureHelp } from "./features.ts";

const connection = lsp.createConnection(lsp.ProposedFeatures.all);
const documents = new lsp.TextDocuments(TextDocument);

/** The latest analysis of each package, keyed by `folder|package`. */
const analyses = new Map<string, Analysis>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** package key → URIs with published diagnostics */
const published = new Map<string, Set<string>>();

function packageKey(uri: string, text: string): string {
    if (!uri.startsWith("file:")) return uri;
    return `${dirname(fileURLToPath(uri))}|${packageName(text) ?? ""}`;
}

/** Every open editor (they override the files on disk; the loader reads the rest from disk). */
function openDocs(): Doc[] {
    return documents.all().map((d) => ({ uri: d.uri, text: d.getText() }));
}

function analyzeNow(uri: string): Analysis | null {
    const doc = documents.get(uri);
    if (!doc || !uri.startsWith("file:")) return null;
    const key = packageKey(uri, doc.getText());
    let an: Analysis;
    try {
        an = analyze(openDocs(), uri);
    } catch (e) {
        logError(`analysis of ${uri}`, e);
        return null;
    }
    analyses.set(key, an);
    const now = new Set(an.diagnostics.keys());
    for (const [file, diags] of an.diagnostics) connection.sendDiagnostics({ uri: file, diagnostics: diags });
    for (const old of published.get(key) ?? []) if (!now.has(old)) connection.sendDiagnostics({ uri: old, diagnostics: [] });
    published.set(key, now);
    return an;
}

function schedule(uri: string): void {
    const t = pending.get(uri);
    if (t) clearTimeout(t);
    pending.set(uri, setTimeout(() => {
        pending.delete(uri);
        analyzeNow(uri);
    }, 150));
}

/** The analysis to answer a request with: fresh if an edit is still pending. */
function current(uri: string): Analysis | null {
    const doc = documents.get(uri);
    if (!doc) return null;
    if (pending.has(uri)) {
        clearTimeout(pending.get(uri));
        pending.delete(uri);
        return analyzeNow(uri);
    }
    return analyses.get(packageKey(uri, doc.getText())) ?? analyzeNow(uri);
}

connection.onInitialize(() => ({
    capabilities: {
        textDocumentSync: lsp.TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        completionProvider: { triggerCharacters: [".", "\""] },
        signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
        inlayHintProvider: true,
        renameProvider: { prepareProvider: true },
    },
    serverInfo: { name: "minscript", version: "0.4.0" },
}));

// (opening a document also fires a content change)
documents.onDidChangeContent((e) => schedule(e.document.uri));
documents.onDidClose((e) => {
    // the package still exists on disk: forget the editor's version and its diagnostics
    const key = packageKey(e.document.uri, e.document.getText());
    if (!analyses.has(key)) return;
    for (const uri of published.get(key) ?? []) connection.sendDiagnostics({ uri, diagnostics: [] });
    analyses.delete(key);
    published.delete(key);
});

connection.onHover((p) => {
    const an = current(p.textDocument.uri);
    return an ? hover(an, p.textDocument.uri, p.position) : null;
});
connection.onDefinition((p) => {
    const an = current(p.textDocument.uri);
    return an ? definition(an, p.textDocument.uri, p.position) : [];
});
connection.onReferences((p) => {
    const an = current(p.textDocument.uri);
    return an ? references(an, p.textDocument.uri, p.position, p.context.includeDeclaration) : [];
});
connection.onDocumentSymbol((p) => {
    const an = current(p.textDocument.uri);
    return an ? documentSymbols(an, p.textDocument.uri) : [];
});

// completion and signature help analyse the text as typed (with a placeholder at the cursor), so
// they don't wait for the debounced analysis
connection.onCompletion((p) => {
    if (!documents.get(p.textDocument.uri)) return [];
    try {
        return completion(openDocs(), p.textDocument.uri, p.position);
    } catch (e) {
        logError("completion", e);
        return [];
    }
});
connection.onSignatureHelp((p) => {
    if (!documents.get(p.textDocument.uri)) return null;
    try {
        return signatureHelp(openDocs(), p.textDocument.uri, p.position);
    } catch (e) {
        logError("signature help", e);
        return null;
    }
});
connection.languages.inlayHint.on((p) => {
    const an = current(p.textDocument.uri);
    return an ? inlayHints(an, p.textDocument.uri, p.range) : [];
});
connection.onPrepareRename((p) => {
    const an = current(p.textDocument.uri);
    return an ? prepareRename(an, p.textDocument.uri, p.position) : null;
});
connection.onRenameRequest((p) => {
    const an = current(p.textDocument.uri);
    if (!an) return null;
    try {
        return rename(an, p.textDocument.uri, p.position, p.newName);
    } catch (e) {
        throw new lsp.ResponseError(lsp.ErrorCodes.InvalidParams, e instanceof Error ? e.message : String(e));
    }
});

function logError(what: string, e: unknown): void {
    connection.console.error(`MinScript: ${what} failed: ${e instanceof Error ? e.stack : String(e)}`);
}

documents.listen(connection);
connection.listen();
