// Usage: node src/cli.ts lex|parse|resolve|check|hir <file.ms>...
//        node src/cli.ts run|js [<file.ms> | <folder>] [-- args…]     node src/cli.ts run <script> [-- args…]
//        node src/cli.ts config [<folder>]
// `lex` prints the token dump (src/dump.ts); `parse` prints the AST as S-expressions (src/sexpr.ts);
// `resolve` prints what each name refers to (src/resolve_dump.ts); `check` type-checks, runs the
// ownership pass, and prints only diagnostics; `hir` prints the lowered program (src/hir_dump.ts);
// `js` prints the generated JS; `run` compiles and runs a program with its imported packages
// (src/loader.ts). A folder, or a file inside a project's `main` folder, runs the project (src/project.ts):
// every `package main` file of `main`, with mod.ms's `path:` deps. `run <name>` runs a mod.ms script;
// `run` alone lists them. `config` prints the evaluated mod.ms. Arguments after the program go to `env.args()`.
// For the other commands, each file is its own package.
// Exits with status 1 if any file has diagnostics.

import "./prelude.ts"
import { readFileSync } from "node:fs"
import { relative } from "node:path"
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

if (command === "run" || command === "js" || command === "config") {
    const { runProgramCommand } = await import("./project_cli.ts")
    process.exit(await runProgramCommand(command, files))
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
