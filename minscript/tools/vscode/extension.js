// MinScript for VS Code: the grammar is declarative (package.json); this file starts the language
// server (tools/lsp/server.ts) with a system Node ≥ 23.6, which runs the compiler's TypeScript directly.

const fs = require("node:fs")
const path = require("node:path")
const vscode = require("vscode")
const { LanguageClient } = require("vscode-languageclient/node")

/** @type {LanguageClient | undefined} */
let client

function serverPath(context) {
    const configured = vscode.workspace.getConfiguration("minscript").get("serverPath")
    if (configured) return configured
    // the extension folder may be a symlink into the repository: resolve it, then go to tools/lsp
    return path.join(fs.realpathSync(context.extensionPath), "..", "lsp", "server.ts")
}

async function start(context) {
    const node = vscode.workspace.getConfiguration("minscript").get("node") || "node"
    const server = serverPath(context)
    if (!fs.existsSync(server)) {
        vscode.window.showErrorMessage(`MinScript: language server not found at ${server}. Set "minscript.serverPath".`)
        return
    }
    const run = { command: node, args: [server, "--stdio"] }
    client = new LanguageClient("minscript", "MinScript", { run, debug: run }, {
        documentSelector: [{ scheme: "file", language: "minscript" }, { scheme: "untitled", language: "minscript" }],
    })
    await client.start()
}

async function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand("minscript.restartServer", async () => {
        if (client) await client.stop()
        await start(context)
    }))
    await start(context)
}

async function deactivate() {
    if (client) await client.stop()
}

module.exports = { activate, deactivate }
