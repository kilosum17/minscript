// Starts the real language server over stdio and talks LSP to it, as an editor would.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

interface Message {
    id?: number;
    method?: string;
    params?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    result?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

test("the server publishes diagnostics and answers hover over stdio", async () => {
    const server = spawn(process.execPath, [fileURLToPath(new URL("./server.ts", import.meta.url)), "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
    let buffer = Buffer.alloc(0);
    const waiting: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
    const received: Message[] = [];
    server.stdout.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
            const header = buffer.indexOf("\r\n\r\n");
            if (header < 0) return;
            const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, header).toString())![1]);
            if (buffer.length < header + 4 + length) return;
            const msg = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString()) as Message;
            buffer = buffer.subarray(header + 4 + length);
            const w = waiting.findIndex((x) => x.match(msg));
            if (w >= 0) waiting.splice(w, 1)[0]!.resolve(msg);
            else received.push(msg);
        }
    });
    const send = (msg: object) => {
        const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
        server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    const wait = (match: (m: Message) => boolean) =>
        new Promise<Message>((resolve) => {
            const i = received.findIndex(match);
            if (i >= 0) resolve(received.splice(i, 1)[0]!);
            else waiting.push({ match, resolve });
        });
    try {
        send({ id: 1, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
        const init = await wait((m) => m.id === 1);
        assert.ok(init.result.capabilities.hoverProvider);
        send({ method: "initialized", params: {} });

        const dir = mkdtempSync(join(tmpdir(), "ms-lsp-server-"));
        const path = join(dir, "main.ms");
        const text = "package main\n\nfn main() {\n    n := 1\n    let s: str = n\n}\n";
        writeFileSync(path, text);
        const uri = pathToFileURL(path).href;
        send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "minscript", version: 1, text } } });
        const diags = await wait((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === uri);
        assert.deepEqual(diags.params.diagnostics.map((d: { code: string }) => d.code), ["E_TYPE_MISMATCH"]);

        send({ id: 2, method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 3, character: 4 } } });
        const h = await wait((m) => m.id === 2);
        assert.match(h.result.contents.value, /let n: int/);
        send({ id: 3, method: "shutdown" });
        await wait((m) => m.id === 3);
        send({ method: "exit" });
    } finally {
        server.kill();
    }
});
