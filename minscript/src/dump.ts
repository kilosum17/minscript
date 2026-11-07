// Human-readable token dump, used for `test/lexer/*.tokens` snapshots and `ms-lex`.
//
//   4:5     nl let
//   4:9     ws Ident "a"
//   4:13    ws Int 1
//   5:20       ( → 5:31
//
// Columns: line:col, then the flag (`nl` = newline before, `ws` = whitespace or comment before,
// blank = glued to the previous token), the kind, the value, `"""` for multi-line strings, and
// `→ line:col` of the matching closer for openers.

import type { LexResult } from "./lexer.ts"
import type { Token } from "./token.ts"

export function formatValue(tok: Token): string {
    const v = tok.value
    if (v === undefined) return ""
    if (typeof v === "string") return JSON.stringify(v)
    return String(v)
}

export function dumpTokens(res: LexResult): string {
    const out: string[] = []
    for (const tok of res.tokens) {
        const pos = `${tok.span.line}:${tok.span.col}`.padEnd(8)
        const flag = tok.nl_before ? "nl" : tok.ws_before ? "ws" : "  "
        let line = `${pos}${flag} ${tok.kind}`
        const value = formatValue(tok)
        if (value) line += ` ${value}`
        if (tok.multiline) line += ` """`
        if (tok.match !== undefined) {
            const closer = res.tokens[tok.match]!
            line += ` → ${closer.span.line}:${closer.span.col}`
        }
        out.push(line)
    }
    if (res.trivia.length > 0) {
        out.push("", "-- trivia --")
        for (const t of res.trivia) {
            out.push(`${`${t.span.line}:${t.span.col}`.padEnd(8)}${t.kind} ${JSON.stringify(t.text)}`)
        }
    }
    if (res.diagnostics.length > 0) {
        out.push("", "-- diagnostics --")
        for (const d of res.diagnostics) {
            out.push(`${`${d.span.line}:${d.span.col}`.padEnd(8)}${d.code} ${d.message}`)
        }
    }
    return out.join("\n") + "\n"
}
