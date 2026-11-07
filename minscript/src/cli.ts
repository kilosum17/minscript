// Usage: node src/cli.ts lex <file.ms>...
// Prints the token dump (see src/dump.ts). Exits with status 1 if any file has diagnostics.

import { readFileSync } from "node:fs"
import { dumpTokens } from "./dump.ts"
import { lex } from "./lexer.ts"

const [command, ...files] = process.argv.slice(2)

if (command !== "lex" || files.length === 0) {
    console.error("usage: node src/cli.ts lex <file.ms>...")
    process.exit(2)
}

let failed = false
for (const file of files) {
    const res = lex(readFileSync(file))
    if (files.length > 1) console.log(`== ${file}`)
    process.stdout.write(dumpTokens(res))
    for (const d of res.diagnostics) {
        console.error(`${file}:${d.span.line}:${d.span.col}: ${d.severity} ${d.code}: ${d.message}`)
        failed = true
    }
}
process.exit(failed ? 1 : 0)
