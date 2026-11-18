import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    TextDocumentSyncKind
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"
import {
    Diagnostic,
    DiagnosticSeverity
} from "vscode-languageserver/node"
import { lspCheck } from "../../syntax/sem/lsp_check"
import { fileURLToPath } from "node:url"

const connection = createConnection(ProposedFeatures.all)
const documents = new TextDocuments(TextDocument)

const originalLog = console.log
const originalError = console.error
const originalWarn = console.warn

console.log = (...args) => {
    connection.console.log(args.map(String).join(" "))
    originalLog(...args)
}

console.error = (...args) => {
    connection.console.error(args.map(String).join(" "))
    originalError(...args)
}

console.warn = (...args) => {
    connection.console.warn(args.map(String).join(" "))
    originalWarn(...args)
}

connection.onInitialize(() => ({
    capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        completionProvider: {
            triggerCharacters: [".", ":"]
        }
    }
}))

async function validate(document: TextDocument) {
    const path = fileURLToPath(document.uri)
    const errors = await lspCheck({
        text: document.getText(),
        path,
    })

    return errors.map(error => {
        const severity: DiagnosticSeverity = error.severity() === 'error' ? 1 : 2
        return ({
            severity,
            range: {
                start: document.positionAt(error.span.start),
                end: document.positionAt(error.span.end)
            },
            message: error.message(),
            code: error.code,
            source: "minscript-lsp-v2"
        } satisfies Diagnostic as Diagnostic)
    })

}

documents.onDidChangeContent(async ({ document }) => {
    const diagnostics = await validate(document)
    connection.sendDiagnostics({
        uri: document.uri,
        diagnostics
    })
})

documents.onDidOpen(async ({ document }) => {
    connection.sendDiagnostics({
        uri: document.uri,
        diagnostics: await validate(document)
    })
})

connection.onHover(({ textDocument, position }) => {
    const document = documents.get(textDocument.uri)
    if (!document) return null

    const offset = document.offsetAt(position)
    const path = fileURLToPath(textDocument.uri)

    console.log({
        path,
        line: position.line,
        character: position.character,
        offset
    })

    return {
        contents: {
            kind: "markdown",
            value: `Position: ${position.line}:${position.character}\n\nOffset: ${offset}`
        }
    }
})

documents.listen(connection)
connection.listen()

