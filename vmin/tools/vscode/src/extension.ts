import * as vscode from "vscode"
import {
    LanguageClient,
    type ServerOptions,
    TransportKind
} from "vscode-languageclient/node"

let client: LanguageClient

export function activate(context: vscode.ExtensionContext) {

    const serverModule = context.asAbsolutePath("server/lsp/src/server.js")

    console.log("MinScript server:", serverModule)

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

    client.start().catch(error => {
        vscode.window.showErrorMessage(
            `MinScript LSP failed to start: ${error}`
        )
    })

    context.subscriptions.push(
        vscode.commands.registerCommand("minscript.restartServer", async () => {
            await client.restart()
            vscode.window.showInformationMessage("MinScript language server restarted")
        })
    )

    const watcher = vscode.workspace.createFileSystemWatcher("**/.minscript-reload")
    watcher.onDidCreate(async uri => {
        await vscode.workspace.fs.delete(uri)
        await vscode.commands.executeCommand("minscript.restartServer")
    })

    context.subscriptions.push(watcher)

}

export function deactivate() {
    return client?.stop()
}
