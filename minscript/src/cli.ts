// The `ms` command (bin/ms.js; also `node src/cli.ts …` and the npm scripts). `ms help` lists the commands.
//
// - `run`, `js`, `config` and scripts: src/project_cli.ts (spec §17.3).
// - `check` loads whole programs (src/loader.ts): a file with its imports, or a folder / project.
// - `lex`, `parse`, `resolve`, `hir` are for working on the compiler: each file is its own package
//   (imported members are `unknown`), and they print the token dump (src/dump.ts), the AST
//   (src/sexpr.ts), what each name refers to (src/resolve_dump.ts) or the lowered HIR (src/hir_dump.ts).
// Exits with status 1 if there are diagnostics, 2 on a usage error.

import "./prelude.ts"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { show } from "./project_cli.ts"
import { dumpTokens } from "./dump.ts"
import { lex } from "./lexer.ts"
import { parse } from "./parser.ts"
import { checkPackage } from "./check.ts"
import { dumpHir } from "./hir_dump.ts"
import { loadProgram } from "./loader.ts"
import { lowerPackage } from "./lower.ts"
import { resolvePackage } from "./resolve.ts"
import { dumpResolution } from "./resolve_dump.ts"
import { dumpTypes } from "./check_dump.ts"
import { printFile } from "./sexpr.ts"

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string

const HELP = `ms ${VERSION}: the MinScript toolchain

usage: ms <command> [arguments]

programs and projects
  run [<path>] [-- args…]   run a program: a file, a folder, or a project (default: list the scripts)
  run <script> [-- args…]   run a script from mod.ms (also: ms <script>, when it isn't a command)
  check [<path>…]           type-check and ownership-check a program with its imports (default: .)
  test [<path>…] [--run <name>] [--reporter spec|dots]
                            run the test_ functions of *_test.ms files at or under each path (default: .)
  fmt [<path>…] [--check]   format .ms files in place (--check: only report, for CI)
  js <path>                 print the generated JavaScript
  config [<path>]           print the evaluated mod.ms as JSON

compiler internals (each file on its own)
  lex | parse | resolve | types | hir <file.ms>…

  help                      this message
  version                   the toolchain version
`

/** Exits once stdout and stderr have been written out: on a pipe, Node writes them asynchronously,
 *  and `process.exit` would cut off what a program printed last. */
async function exit(code: number): Promise<never> {
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()))
    await new Promise<void>((resolve) => process.stderr.write("", () => resolve()))
    process.exit(code)
}

const COMMANDS = new Set(["run", "js", "config", "check", "test", "fmt", "lex", "parse", "resolve", "types", "hir", "help", "version"])
const [command, ...rest] = process.argv.slice(2)

if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP)
    await exit(0)
}
if (command === undefined) throw new Error("unreachable")     // (narrowing: `await exit()` above doesn't)

if (command === "version" || command === "--version" || command === "-v") {
    console.log(`ms ${VERSION} (node ${process.versions.node})`)
    await exit(0)
}

if (command === "run" || command === "js" || command === "config") {
    const { runProgramCommand } = await import("./project_cli.ts")
    await exit(await runProgramCommand(command, rest))
}

if (command === "check") {
    const { entryFor, printDiagnostics } = await import("./project_cli.ts")
    let failed = false
    for (const path of rest.length > 0 ? rest : ["."]) {
        const found = await entryFor(resolve(path))
        if (found === null) { failed = true; continue }
        const program = loadProgram(found.entry, found.opts)
        printDiagnostics(program.diagnostics)
        if (program.diagnostics.length > 0) failed = true
        else console.log(`${path}: ok (${program.packages.length} package${program.packages.length === 1 ? "" : "s"}, ${program.packages.reduce((n, p) => n + p.files.length, 0)} files)`)
    }
    await exit(failed ? 1 : 0)
}

if (command === "fmt") {
    const { runFmt } = await import("./fmt_cli.ts")
    await exit(await runFmt(rest))
}

if (command === "test") {
    const { runTests } = await import("./test_runner.ts")
    const { printDiagnostics } = await import("./project_cli.ts")
    const paths: string[] = []
    let filter: string | undefined, reporter: string | undefined
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!
        if (a === "--run") filter = rest[++i]
        else if (a === "--reporter") reporter = rest[++i]
        else if (a === "--parallel") { /* accepted; tests run one at a time for now (spec §17.7) */ }
        else paths.push(a)
    }
    let failed = 0, broken = 0, packages = 0
    for (const path of paths.length > 0 ? paths : ["."]) {
        const r = await runTests(path, { filter, reporter })
        printDiagnostics(r.diagnostics)
        failed += r.failed; broken += r.broken; packages += r.packages
    }
    if (packages === 0 && broken === 0) console.log(`no tests${filter ? ` matching \`${filter}\`` : ""}`)
    else if (packages > 1 || broken > 0) console.log(`\n${packages} package${packages === 1 ? "" : "s"}: ${failed === 0 && broken === 0 ? "all passed" : `${failed} failed${broken > 0 ? `, ${broken} couldn't run` : ""}`}`)
    await exit(failed > 0 || broken > 0 ? 1 : 0)
}

if (!COMMANDS.has(command)) {
    // `ms dev`: a script of the project here
    const { runScriptShorthand } = await import("./project_cli.ts")
    const code = await runScriptShorthand(command, rest)
    if (code !== null) await exit(code)
    console.error(`ms: unknown command \`${command}\`, and no script of that name in a mod.ms here (\`ms help\` lists the commands)`)
    await exit(2)
}

if (rest.length === 0) {
    console.error(`usage: ms ${command} <file.ms>…`)
    await exit(2)
}

let failed = false
for (const file of rest) {
    const src = readFileSync(file)
    if (rest.length > 1) console.log(`== ${file}`)
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
    } else if (command === "types") {
        const parsed = parse(src)
        const res = resolvePackage([parsed.file])
        const checked = checkPackage([parsed.file], res)
        process.stdout.write(dumpTypes(res, checked, [parsed.file]))
        diagnostics = [...parsed.diagnostics, ...res.diagnostics, ...checked.diagnostics]
    } else {
        // hir
        const parsed = parse(src)
        const res = resolvePackage([parsed.file])
        const checked = checkPackage([parsed.file], res)
        diagnostics = [...parsed.diagnostics, ...res.diagnostics, ...checked.diagnostics]
        process.stdout.write(dumpHir(lowerPackage([parsed.file], res, checked)))
    }
    for (const d of diagnostics) {
        console.error(`${show(resolve(file))}:${d.span.line}:${d.span.col}: ${d.severity} ${d.code}: ${d.message}`)
        failed = true
    }
}
await exit(failed ? 1 : 0)
