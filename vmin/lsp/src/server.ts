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
import { compilerCheck } from "../../syntax/sem/check"
import { fileURLToPath } from "node:url"

const connection = createConnection(ProposedFeatures.all)
const documents = new TextDocuments(TextDocument)

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
    const errors = compilerCheck({
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

documents.listen(connection)
connection.listen()

