// Drives a MinScript language server over stdio with the same requests for each file, and prints the
// replies (JSON with sorted keys), so two servers can be compared: stage 0's and stage 1's.
//
//   node tools/lsp_compare.mjs <file.ms>… -- <server command…>
//
// For each file: open it, then hover / definition / references at every identifier, document
// symbols, inlay hints, formatting, prepareRename at the first identifiers; completion after every
// `x.` (the line cut just after the dot) and signature help inside every call (the line cut after
// the `(`), each sent as a change of the document.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const dash = process.argv.indexOf("--")
const files = process.argv.slice(2, dash)
const [cmd, ...args] = process.argv.slice(dash + 1)

const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] })
let buf = Buffer.alloc(0)
const waiting = new Map()
let nextId = 1
child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
        const head = buf.indexOf("\r\n\r\n")
        if (head < 0) return
        const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, head).toString())
        const len = Number(m[1])
        if (buf.length < head + 4 + len) return
        const msg = JSON.parse(buf.subarray(head + 4, head + 4 + len).toString())
        buf = buf.subarray(head + 4 + len)
        if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id) }
    }
})
const send = (msg) => { const body = JSON.stringify(msg); child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`) }
const request = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }) })
const notify = (method, params) => send({ jsonrpc: "2.0", method, params })

const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v
const show = (label, msg) => {
    let r = msg.error ? { error: msg.error.message } : msg.result ?? null
    // completion items: by label (both servers list the same names, not always in the same order)
    if (label.startsWith("completion") && Array.isArray(r)) r = [...r].sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
    console.log(`${label}: ${JSON.stringify(sorted(r))}`)
}

/** Positions (line, UTF-16 column) of every identifier start in the text. */
function identifiers(text) {
    const out = []
    text.split("\n").forEach((line, l) => {
        if (/^\s*\/\//.test(line)) return
        for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) out.push({ line: l, character: m.index })
    })
    return out
}

await request("initialize", { processId: null, rootUri: null, capabilities: {} })
notify("initialized", {})
for (const file of files) {
    const uri = pathToFileURL(file).href
    const text = readFileSync(file, "utf8")
    notify("textDocument/didOpen", { textDocument: { uri, languageId: "minscript", version: 1, text } })
    const doc = { uri }
    console.log(`== ${file}`)
    for (const p of identifiers(text)) {
        const at = `${p.line}:${p.character}`
        show(`hover ${at}`, await request("textDocument/hover", { textDocument: doc, position: p }))
        show(`definition ${at}`, await request("textDocument/definition", { textDocument: doc, position: p }))
        show(`references ${at}`, await request("textDocument/references", { textDocument: doc, position: p, context: { includeDeclaration: true } }))
    }
    show("symbols", await request("textDocument/documentSymbol", { textDocument: doc }))
    const lines = text.split("\n")
    show("inlay", await request("textDocument/inlayHint", { textDocument: doc, range: { start: { line: 0, character: 0 }, end: { line: lines.length, character: 0 } } }))
    show("format", await request("textDocument/formatting", { textDocument: doc, options: { tabSize: 4, insertSpaces: true } }))
    for (const p of identifiers(text).slice(0, 40)) show(`prepareRename ${p.line}:${p.character}`, await request("textDocument/prepareRename", { textDocument: doc, position: p }))
    // completion after `x.` and signature help after `f(`: the line cut there
    let version = 2
    for (let l = 0; l < lines.length; l++) {
        for (const m of lines[l].matchAll(/[A-Za-z_)\]][.]|[A-Za-z_][A-Za-z0-9_]*\(/g)) {
            const cut = m.index + m[0].length
            const changed = [...lines.slice(0, l), lines[l].slice(0, cut), ...lines.slice(l + 1)].join("\n")
            notify("textDocument/didChange", { textDocument: { uri, version: version++ }, contentChanges: [{ text: changed }] })
            const position = { line: l, character: cut }
            if (m[0].endsWith(".")) show(`completion ${l}:${cut}`, await request("textDocument/completion", { textDocument: doc, position }))
            else show(`signature ${l}:${cut}`, await request("textDocument/signatureHelp", { textDocument: doc, position }))
        }
    }
    notify("textDocument/didChange", { textDocument: { uri, version: version++ }, contentChanges: [{ text }] })
    notify("textDocument/didClose", { textDocument: doc })
}
await request("shutdown", null)
notify("exit", null)
child.stdin.end()
