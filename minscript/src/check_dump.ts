// Readable dump of the checker's results, used for `test/check/*.types` snapshots:
// the inferred type of every binding (locals, parameters, closure parameters, pattern bindings),
// in source order, followed by any diagnostics.
//
//   12:9    total: int
//   13:24   it: string        (implicit closure parameters are listed at their first use)

import type * as A from "./ast.ts"
import type { CheckResult } from "./check.ts"
import type { Resolution } from "./resolve.ts"
import { show } from "./types.ts"

export function dumpTypes(res: Resolution, checked: CheckResult, files: A.File[]): string {
    const lines: [number, string][] = []
    const own = new Set(res.symbols)
    const firstUse = new Map<unknown, A.Node>()
    for (const [node, sym] of res.refs) {
        if (sym.kind !== "implicit") continue
        const prev = firstUse.get(sym)
        if (prev === undefined || node.span.start < prev.span.start) firstUse.set(sym, node)
    }
    for (const [sym, ty] of checked.symbols) {
        if (!own.has(sym)) continue
        if (!["local", "param", "closure-param", "implicit", "global"].includes(sym.kind)) continue
        const span = sym.span ?? firstUse.get(sym)?.span
        if (span === undefined) continue
        const name = sym.kind === "implicit" && sym.name === "it1" ? "it" : sym.name
        lines.push([span.start, `${`${span.line}:${span.col}`.padEnd(8)}${name}: ${show(ty)}`])
    }
    lines.sort((a, b) => a[0] - b[0])
    const out = lines.map((l) => l[1])
    if (checked.diagnostics.length > 0) {
        out.push("", "-- diagnostics --")
        for (const d of checked.diagnostics) out.push(`${`${d.span.line}:${d.span.col}`.padEnd(8)}${d.code} ${d.message}`)
    }
    void files
    return out.join("\n") + "\n"
}
