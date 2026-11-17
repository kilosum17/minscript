import * as vscode from "vscode"
import {
    LanguageClient,
    type ServerOptions,
    TransportKind
} from "vscode-languageclient/node"

let client: LanguageClient

export function activate(context: vscode.ExtensionContext) {
    const serverModule = context.asAbsolutePath(
        "../lsp/dist/lsp/src/server.js"
    )
    
    // console.log("MinScript server:", serverModule)

    const serverOptions: ServerOptions = {
        run: {
            module: serverModule,
            transport: TransportKind.ipc
        },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: {
                execArgv: ["--nolazy", "--inspect=6009"]
            }
        }
    }

    const clientOptions = {
        documentSelector: [
            { scheme: "file", language: "minscript" }
        ]
    }

    client = new LanguageClient(
        "minscript",
        "MinScript Language Server",
        serverOptions,
        clientOptions
    )

    client.start()
}

export function deactivate() {
    return client?.stop()
}
