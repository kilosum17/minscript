// Usage: node src/cli.ts lex|parse <file.ms>...
// `lex` prints the token dump (src/dump.ts); `parse` prints the AST as S-expressions (src/sexpr.ts).
// Exits with status 1 if any file has diagnostics.

import { readFileSync } from "node:fs"
import { dumpTokens } from "./dump.ts"
import { lex } from "./lexer.ts"
import { parse } from "./parser.ts"
import { printFile } from "./sexpr.ts"

const [command, ...files] = process.argv.slice(2)

if ((command !== "lex" && command !== "parse") || files.length === 0) {
    console.error("usage: node src/cli.ts lex|parse <file.ms>...")
    process.exit(2)
}

let failed = false
for (const file of files) {
    const src = readFileSync(file)
    if (files.length > 1) console.log(`== ${file}`)
    let diagnostics
    if (command === "lex") {
        const res = lex(src)
        process.stdout.write(dumpTokens(res))
        diagnostics = res.diagnostics
    } else {
        const res = parse(src)
        process.stdout.write(printFile(res.file))
        diagnostics = res.diagnostics
    }
    for (const d of diagnostics) {
        console.error(`${file}:${d.span.line}:${d.span.col}: ${d.severity} ${d.code}: ${d.message}`)
        failed = true
    }
}
process.exit(failed ? 1 : 0)
