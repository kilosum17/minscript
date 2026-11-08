// Usage: node src/cli.ts lex|parse|resolve|check|hir|js <file.ms>...   or   node src/cli.ts run <file.ms>
// `lex` prints the token dump (src/dump.ts); `parse` prints the AST as S-expressions (src/sexpr.ts);
// `resolve` prints what each name refers to (src/resolve_dump.ts); `check` type-checks, runs the
// ownership pass, and prints only diagnostics; `hir` prints the lowered program (src/hir_dump.ts);
// `js` prints the generated JS; `run` compiles and runs the program.
// Each file is its own package.
// Exits with status 1 if any file has diagnostics.

import "./prelude.ts"
import { readFileSync } from "node:fs"
import { dumpTokens } from "./dump.ts"
import { lex } from "./lexer.ts"
import { parse } from "./parser.ts"
import { checkPackage } from "./check.ts"
import { checkOwnership } from "./ownership.ts"
import { dumpHir } from "./hir_dump.ts"
import { lowerPackage } from "./lower.ts"
import { resolvePackage } from "./resolve.ts"
import { dumpResolution } from "./resolve_dump.ts"
import { printFile } from "./sexpr.ts"

const [command, ...files] = process.argv.slice(2)

if (command === "run" || command === "js") {
    const { compileToJs, runJs } = await import("./js/run.ts")
    const file = files[0]
    if (file === undefined) {
        console.error(`usage: node src/cli.ts ${command} <file.ms>`)
        process.exit(2)
    }
    const compiled = compileToJs(readFileSync(file))
    for (const d of compiled.diagnostics) console.error(`${file}:${d.span.line}:${d.span.col}: ${d.severity} ${d.code}: ${d.message}`)
    if (compiled.js === null) process.exit(1)
    if (command === "js") {
        process.stdout.write(compiled.js)
        process.exit(0)
    }
    const result = await runJs(compiled.js)
    process.exit(result.exitCode)
}

if (!["lex", "parse", "resolve", "check", "hir"].includes(command ?? "") || files.length === 0) {
    console.error("usage: node src/cli.ts lex|parse|resolve|check|hir <file.ms>...")
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
    } else if (command === "parse") {
        const res = parse(src)
        process.stdout.write(printFile(res.file))
        diagnostics = res.diagnostics
    } else if (command === "resolve") {
        const parsed = parse(src)
        const res = resolvePackage([parsed.file])
        process.stdout.write(dumpResolution(res))
        diagnostics = [...parsed.diagnostics, ...res.diagnostics]
    } else {
        // check, hir
        const parsed = parse(src)
        const res = resolvePackage([parsed.file])
        const checked = checkPackage([parsed.file], res)
        const owned = checkOwnership([parsed.file], res, checked)
        diagnostics = [...parsed.diagnostics, ...res.diagnostics, ...checked.diagnostics, ...owned.diagnostics]
        if (command === "hir") process.stdout.write(dumpHir(lowerPackage([parsed.file], res, checked)))
        else if (diagnostics.length === 0) console.log(`${file}: ok`)
    }
    for (const d of diagnostics) {
        console.error(`${file}:${d.span.line}:${d.span.col}: ${d.severity} ${d.code}: ${d.message}`)
        failed = true
    }
}
process.exit(failed ? 1 : 0)
