// Readable dump of a Resolution, used for `test/resolve/*.refs` snapshots and `ms resolve`.
//
//   5:9     x → 3:9 local
//   6:5     log → prelude package std.log
//   7:13    Cash → deferred
//   9:14    closure captures count@3:5, total@4:5
//
// One line per use, deferred name and closure, in source order.

import type * as A from "./ast.ts"
import type { Resolution, Sym } from "./resolve.ts"

function target(sym: Sym): string {
    if (sym.std) return "prelude"
    const where = sym.span ? `${sym.span.line}:${sym.span.col} ` : ""
    switch (sym.kind) {
        case "builtin-type": return "builtin"
        case "prelude-type": case "prelude-value": return "prelude"
        case "this": return "this"
        case "implicit": return `implicit ${sym.name === "it1" ? "it" : sym.name}`
        case "package": case "import": return `${where}${sym.kind} ${JSON.stringify(sym.detail ?? "")}`.replace(/^\s+/, "")
        default: return `${where}${sym.kind}`
    }
}

function nameOf(node: A.Node): string {
    switch (node.kind) {
        case "Ident": return node.name
        case "This": return "this"
        case "TName": return node.path.join(".")
        case "TTypeOf": return `TypeOf(${node.path.join(".")})`
        case "PPath": case "PCall": return node.path.join(".")
        case "PStruct": return node.path ? node.path.join(".") : "r{"
        case "RecordField": return node.key
        case "Capture": return `capture ${node.name}`
        default: return node.kind
    }
}

export function dumpResolution(res: Resolution): string {
    const lines: [number, number, string][] = []
    for (const [node, sym] of res.refs) {
        lines.push([node.span.start, 0, `${pos(node)}${nameOf(node)} → ${target(sym)}`])
    }
    for (const node of res.deferred) {
        lines.push([node.span.start, 1, `${pos(node)}${nameOf(node)} → deferred`])
    }
    for (const [node, syms] of res.captures) {
        if (syms.length === 0) continue
        const list = syms.map((s) => (s.span ? `${s.name}@${s.span.line}:${s.span.col}` : s.name === "it1" ? "it" : s.name)).join(", ")
        lines.push([node.span.start, -1, `${pos(node)}closure captures ${list}`])
    }
    lines.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const out = lines.map((l) => l[2])
    if (res.diagnostics.length > 0) {
        out.push("", "-- diagnostics --")
        for (const d of res.diagnostics) out.push(`${`${d.span.line}:${d.span.col}`.padEnd(8)}${d.code} ${d.message}`)
    }
    return out.join("\n") + "\n"
}

function pos(node: A.Node): string {
    return `${node.span.line}:${node.span.col}`.padEnd(8)
}
