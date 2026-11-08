// Starts the real language server over stdio and talks LSP to it, as an editor would.

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

type Message = { id?: number, method?: string, params?: any, result?: any }

function startServer() {
    const server = spawn(process.execPath, [fileURLToPath(new URL("./server.ts", import.meta.url)), "--stdio"], { stdio: ["pipe", "pipe", "inherit"] })
    let buffer = Buffer.alloc(0)
    const waiting: { match: (m: Message) => boolean, resolve: (m: Message) => void }[] = []
    const received: Message[] = []
    server.stdout.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
            const header = buffer.indexOf("\r\n\r\n")
            if (header < 0) return
            const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, header).toString())![1])
            if (buffer.length < header + 4 + length) return
            const msg = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString()) as Message
            buffer = buffer.subarray(header + 4 + length)
            const w = waiting.findIndex((x) => x.match(msg))
            if (w >= 0) waiting.splice(w, 1)[0]!.resolve(msg)
            else received.push(msg)
        }
    })
    let id = 0
    const send = (msg: object) => {
        const body = JSON.stringify({ jsonrpc: "2.0", ...msg })
        server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    }
    const wait = (match: (m: Message) => boolean) => new Promise<Message>((resolve) => {
        const i = received.findIndex(match)
        if (i >= 0) resolve(received.splice(i, 1)[0]!)
        else waiting.push({ match, resolve })
    })
    const request = async (method: string, params: object) => {
        const myId = ++id
        send({ id: myId, method, params })
        return (await wait((m) => m.id === myId)).result
    }
    const notify = (method: string, params: object) => send({ method, params })
    return { server, request, notify, wait }
}

describe("language server over stdio", () => {
    test("initialize, diagnostics, hover, definition, editing features, shutdown", { timeout: 20_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), "minscript-lsp-"))
        const file = join(dir, "main.ms")
        const text = "package main\n\nfun twice(n: int) -> int { n * 2 }\n\nfun main() {\n    let x = twice(21)\n    let bad: string = x\n}\n"
        writeFileSync(file, text)
        const uri = pathToFileURL(file).href
        const s = startServer()
        try {
            const init = await s.request("initialize", { processId: null, rootUri: pathToFileURL(dir).href, capabilities: {} })
            assert.equal(init.capabilities.hoverProvider, true)
            s.notify("initialized", {})
            s.notify("textDocument/didOpen", { textDocument: { uri, languageId: "minscript", version: 1, text } })

            const diags = await s.wait((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === uri)
            assert.deepEqual(diags.params.diagnostics.map((d: any) => [d.code, d.range.start.line]), [["E_TYPE_MISMATCH", 6]])

            const h = await s.request("textDocument/hover", { textDocument: { uri }, position: { line: 5, character: 8 } })
            assert.match(h.contents.value, /let x: int/)

            const def = await s.request("textDocument/definition", { textDocument: { uri }, position: { line: 5, character: 13 } })
            assert.deepEqual(def[0].range.start, { line: 2, character: 4 })

            // an edit that fixes the error clears the diagnostics
            const fixed = text.replace("let bad: string = x", "let ok: int = x")
            s.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: fixed }] })
            const after = await s.wait((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === uri && m.params.diagnostics.length === 0)
            assert.deepEqual(after.params.diagnostics, [])

            // editing features: completion while the line is incomplete, signature help, inlay hints, rename
            const typing = fixed.replace("let ok: int = x", "let ok: int = x\n    log.println(twice(")
            s.notify("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ text: typing }] })
            const sig = await s.request("textDocument/signatureHelp", { textDocument: { uri }, position: { line: 7, character: 22 } })
            assert.equal(sig.signatures[0].label, "fun twice(n: int) -> int")
            const members = await s.request("textDocument/completion", { textDocument: { uri }, position: { line: 7, character: 22 } })
            assert.ok(members.some((c: any) => c.label === "twice"), "names in scope inside the call")
            s.notify("textDocument/didChange", { textDocument: { uri, version: 4 }, contentChanges: [{ text: fixed }] })
            const hints = await s.request("textDocument/inlayHint", { textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } } })
            assert.deepEqual(hints.map((h: any) => h.label), [": int"])
            const prep = await s.request("textDocument/prepareRename", { textDocument: { uri }, position: { line: 5, character: 8 } })
            assert.equal(prep.placeholder, "x")
            const edit = await s.request("textDocument/rename", { textDocument: { uri }, position: { line: 5, character: 8 }, newName: "doubled" })
            assert.equal(edit.changes[uri].length, 2)

            // formatting: the whole document (4 spaces, from the editor's tab size: no mod.ms here)
            s.notify("textDocument/didChange", { textDocument: { uri, version: 5 }, contentChanges: [{ text: fixed.replace("    let x = twice(21)", "  let x = twice( 21 )") }] })
            const edits = await s.request("textDocument/formatting", { textDocument: { uri }, options: { tabSize: 4, insertSpaces: true } })
            assert.equal(edits.length, 1)
            assert.equal(edits[0].newText, fixed)

            await s.request("shutdown", {})
            s.notify("exit", {})
        } finally {
            s.server.kill()
        }
    })
})
