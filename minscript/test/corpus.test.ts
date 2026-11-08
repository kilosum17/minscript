// Runs the lexer, parser, resolver, type checker and ownership pass over the `.ms` corpus (see test/README.md):
// - test/lexer/*.ms:   zero diagnostics, and the token dump must match the `.tokens` snapshot;
// - test/parser/*.ms:  zero diagnostics, and the AST dump must match the `.ast` snapshot;
// - test/programs:     zero diagnostics from every pass;
// - test/errors:       the diagnostics must match the `//~` annotations exactly (code and line);
// - test/resolve/*.ms: parse cleanly, resolver diagnostics match the annotations, and the
//                      resolution dump matches the `.refs` snapshot;
// - test/check/*.ms:   parse and resolve cleanly, checker diagnostics match the annotations, and
//                      the inferred types match the `.types` snapshot;
// - test/ownership:    type-check cleanly, and ownership diagnostics match the annotations;
// - test/hir/*.ms:     pass every check, and the lowered program matches the `.hir` snapshot;
// - every valid file (programs, hir, check/inference, ownership/valid, resolve/scopes) lowers to HIR
//   that passes `validateHir` (all locals bound, labels valid, nothing unsupported);
// - test/run/*.ms, and programs with a `.out` file, run on the JS back end and print their `.out`;
// - test/packages/**/main.ms: programs of several packages (src/loader.ts). Diagnostics in any file of
//   the program must match its `//~` annotations; one without annotations must run and print its `.out`;
// - every std package (std/*/…) loads, resolves and type-checks cleanly;
// - test/projects/*: projects (src/project.ts). Each one's mod.ms evaluates (its `config.json` snapshot)
//   and its main package runs (`run.out`); `script_in_eval` must fail with E_SCRIPT_IN_EVAL;
// - `ms test` (src/test_runner.ts): std's own tests (std/**/*_test.ms) and test/projects' pass, and
//   test/testing/failing reports its failures as in `report.out`.
//
// UPDATE_SNAPSHOTS=1 rewrites the snapshots (npm run test:update). Review the diff before committing.

import "../src/prelude.ts"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { LEXER_CODES } from "../src/diagnostic.ts"
import { dumpTokens } from "../src/dump.ts"
import { lex } from "../src/lexer.ts"
import { parse } from "../src/parser.ts"
import { checkPackage } from "../src/check.ts"
import { dumpTypes } from "../src/check_dump.ts"
import { validateHir } from "../src/hir_check.ts"
import { dumpHir } from "../src/hir_dump.ts"
import { compileToJs, loadJs, runJs } from "../src/js/run.ts"
import { loadProgram, STD_DIR } from "../src/loader.ts"
import { configJson, openProject, programOptions } from "../src/project.ts"
import { runTests } from "../src/test_runner.ts"
import { resetOutput, setOutput } from "../src/js/runtime.ts"
import { lowerPackage } from "../src/lower.ts"
import { checkOwnership } from "../src/ownership.ts"
import { loadPrelude } from "../src/prelude.ts"
import { resolvePackage } from "../src/resolve.ts"
import { dumpResolution } from "../src/resolve_dump.ts"
import { printFile } from "../src/sexpr.ts"

const root = dirname(fileURLToPath(import.meta.url))
const update = process.env.UPDATE_SNAPSHOTS === "1"

function msFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) out.push(...msFiles(path))
        else if (name.endsWith(".ms")) out.push(path)
    }
    return out
}

const rel = (p: string) => relative(root, p)

function diagnosticList(src: Buffer): string[] {
    return parse(src).diagnostics.map((d) => `${d.span.line}:${d.span.col} ${d.code} ${d.message}`)
}

function snapshot(file: string, ext: string, actual: string): void {
    const snap = file.replace(/\.ms$/, ext)
    if (update || !existsSync(snap)) {
        writeFileSync(snap, actual)
        return
    }
    assert.equal(actual, readFileSync(snap, "utf8"), `${rel(snap)} is out of date (run \`npm run test:update\` and review the diff)`)
}

describe("lexer snapshots (test/lexer)", () => {
    for (const file of msFiles(join(root, "lexer"))) {
        test(rel(file), () => {
            const src = readFileSync(file)
            assert.deepEqual(diagnosticList(src), [])
            snapshot(file, ".tokens", dumpTokens(lex(src)))
        })
    }
})

describe("parser snapshots (test/parser)", () => {
    for (const file of msFiles(join(root, "parser"))) {
        test(rel(file), () => {
            const src = readFileSync(file)
            const res = parse(src)
            assert.deepEqual(diagnosticList(src), [])
            snapshot(file, ".ast", printFile(res.file))
        })
    }
})

const fmt = (ds: { span: { line: number, col: number }, code: string, message: string }[]) => ds.map((d) => `${d.span.line}:${d.span.col} ${d.code} ${d.message}`)

describe("the prelude (std/prelude.ms)", () => {
    test("parses, resolves and type-checks cleanly", () => {
        const p = loadPrelude()
        assert.deepEqual(fmt(p.diagnostics), [])
        assert.deepEqual(fmt(checkPackage([p.file], p.res).diagnostics), [])
    })
})

describe("programs parse, resolve and type-check cleanly (test/programs)", () => {
    for (const file of msFiles(join(root, "programs"))) {
        test(rel(file), () => {
            const src = readFileSync(file)
            assert.deepEqual(diagnosticList(src), [])
            const parsed = parse(src)
            const res = resolvePackage([parsed.file])
            assert.deepEqual(fmt(res.diagnostics), [])
            const checked = checkPackage([parsed.file], res)
            assert.deepEqual(fmt(checked.diagnostics), [])
            assert.deepEqual(fmt(checkOwnership([parsed.file], res, checked).diagnostics), [])
        })
    }
})

describe("ownership (test/ownership)", () => {
    for (const file of msFiles(join(root, "ownership"))) {
        test(rel(file), () => {
            const text = readFileSync(file, "utf8")
            const parsed = parse(text)
            assert.deepEqual(fmt(parsed.diagnostics), [], "must parse cleanly")
            const res = resolvePackage([parsed.file])
            assert.deepEqual(fmt(res.diagnostics), [], "must resolve cleanly")
            const checked = checkPackage([parsed.file], res)
            assert.deepEqual(fmt(checked.diagnostics), [], "must type-check cleanly")
            const owned = checkOwnership([parsed.file], res, checked)
            assert.deepEqual(owned.diagnostics.map((d) => `${d.span.line} ${d.code}`).sort(), annotations(text).sort())
        })
    }
})

describe("type checker (test/check)", () => {
    for (const file of msFiles(join(root, "check"))) {
        test(rel(file), () => {
            const text = readFileSync(file, "utf8")
            const parsed = parse(text)
            assert.deepEqual(fmt(parsed.diagnostics), [], "must parse cleanly")
            const res = resolvePackage([parsed.file])
            assert.deepEqual(fmt(res.diagnostics), [], "must resolve cleanly")
            const checked = checkPackage([parsed.file], res)
            const actual = checked.diagnostics.map((d) => `${d.span.line} ${d.code}`).sort()
            assert.deepEqual(actual, annotations(text).sort())
            snapshot(file, ".types", dumpTypes(res, checked, [parsed.file]))
        })
    }
})

describe("resolver (test/resolve)", () => {
    for (const file of msFiles(join(root, "resolve"))) {
        test(rel(file), () => {
            const text = readFileSync(file, "utf8")
            const parsed = parse(text)
            assert.deepEqual(parsed.diagnostics.map((d) => `${d.span.line}:${d.span.col} ${d.code} ${d.message}`), [], "must parse cleanly")
            const res = resolvePackage([parsed.file])
            const actual = res.diagnostics.map((d) => `${d.span.line} ${d.code}`).sort()
            assert.deepEqual(actual, annotations(text).sort())
            snapshot(file, ".refs", dumpResolution(res))
        })
    }
})

/** `//~ CODE CODE2` annotations, found by scanning the raw text (see test/README.md). */
function annotations(text: string): string[] {
    const out: string[] = []
    text.split("\n").forEach((line, i) => {
        const m = /\/\/~\s*((?:E_[A-Z_]+\s*)+)/.exec(line)
        if (!m) return
        for (const code of m[1]!.trim().split(/\s+/)) out.push(`${i + 1} ${code}`)
    })
    return out
}

describe("diagnostics match annotations (test/errors)", () => {
    for (const file of msFiles(join(root, "errors"))) {
        const text = readFileSync(file, "utf8")
        test(`${rel(file)}: lexer`, () => {
            const expected = annotations(text).filter((a) => LEXER_CODES.has(a.split(" ")[1]!)).sort()
            const actual = lex(text).diagnostics.map((d) => `${d.span.line} ${d.code}`).sort()
            assert.deepEqual(actual, expected)
        })
        test(`${rel(file)}: lexer + parser`, () => {
            const expected = annotations(text).sort()
            const actual = parse(text).diagnostics.map((d) => `${d.span.line} ${d.code}`).sort()
            assert.deepEqual(actual, expected)
        })
    }
})

describe("lowering (test/hir)", () => {
    for (const file of msFiles(join(root, "hir"))) {
        test(rel(file), () => {
            const parsed = parse(readFileSync(file))
            assert.deepEqual(fmt(parsed.diagnostics), [], "must parse cleanly")
            const res = resolvePackage([parsed.file])
            const checked = checkPackage([parsed.file], res)
            assert.deepEqual(fmt([...res.diagnostics, ...checked.diagnostics, ...checkOwnership([parsed.file], res, checked).diagnostics]), [], "must pass every check")
            snapshot(file, ".hir", dumpHir(lowerPackage([parsed.file], res, checked)))
        })
    }
})

describe("every valid file lowers to well-formed HIR", () => {
    const valid = [
        ...msFiles(join(root, "programs")), ...msFiles(join(root, "hir")),
        join(root, "check", "inference.ms"), join(root, "ownership", "valid.ms"), join(root, "resolve", "scopes.ms"),
    ]
    for (const file of valid) {
        test(rel(file), () => {
            const parsed = parse(readFileSync(file))
            const res = resolvePackage([parsed.file])
            const checked = checkPackage([parsed.file], res)
            assert.deepEqual(validateHir(lowerPackage([parsed.file], res, checked)), [])
        })
    }
})

describe("running on the JS back end (test/run, programs with .out)", () => {
    const programs = msFiles(join(root, "programs")).filter((f) => existsSync(f.replace(/\.ms$/, ".out")))
    for (const file of [...msFiles(join(root, "run")), ...programs]) {
        test(rel(file), async () => {
            const compiled = compileToJs(file)
            assert.deepEqual(fmt(compiled.diagnostics), [], "must compile cleanly")
            const lines: string[] = []
            const result = await runJs(compiled.js!, (line) => lines.push(line))
            assert.equal(result.panic, null, `panicked:\n${lines.join("\n")}`)
            snapshot(file, ".out", lines.join("\n") + "\n")
        })
    }
})

describe("every valid file compiles to JS that loads", () => {
    const valid = [
        ...msFiles(join(root, "programs")), ...msFiles(join(root, "hir")), ...msFiles(join(root, "run")),
        join(root, "check", "inference.ms"), join(root, "ownership", "valid.ms"), join(root, "resolve", "scopes.ms"),
    ]
    for (const file of valid) {
        test(rel(file), async () => {
            const compiled = compileToJs(file)
            assert.deepEqual(fmt(compiled.diagnostics), [], "must compile cleanly")
            const mod = await loadJs(compiled.js!)
            assert.equal(typeof mod.$main, "function")
        })
    }
})

describe("std packages load cleanly (std/)", () => {
    for (const file of msFiles(STD_DIR).filter((f) => !f.endsWith("prelude.ms") && !f.endsWith("_test.ms"))) {
        test(relative(STD_DIR, file), () => {
            const p = loadProgram(file)
            assert.deepEqual(p.diagnostics.map((d) => `${relative(STD_DIR, d.file)}:${d.span.line}:${d.span.col} ${d.code} ${d.message}`), [])
        })
    }
})

describe("programs of several packages (test/packages)", () => {
    const entries = msFiles(join(root, "packages")).filter((f) => f.endsWith("/main.ms"))
    for (const entry of entries) {
        test(rel(entry), async () => {
            const program = loadProgram(entry)
            const expected: string[] = []
            for (const pkg of program.packages) {
                if (pkg.dir.startsWith(STD_DIR)) continue
                for (const f of pkg.files) {
                    f.text.split("\n").forEach((line, i) => {
                        const m = /\/\/~((?:\s+[A-Z_]+)+)\s*$/.exec(line)
                        if (m) for (const code of m[1]!.trim().split(/\s+/)) expected.push(`${rel(f.path)}:${i + 1} ${code}`)
                    })
                }
            }
            const actual = program.diagnostics.map((d) => `${rel(d.file)}:${d.span.line} ${d.code}`)
            assert.deepEqual(actual.sort(), expected.sort(), program.diagnostics.map((d) => `${rel(d.file)}:${d.span.line} ${d.code} ${d.message}`).join("\n"))
            if (expected.length > 0) return
            const compiled = compileToJs(entry)
            const lines: string[] = []
            const result = await runJs(compiled.js!, (line) => lines.push(line))
            assert.equal(result.panic, null, `panicked:\n${lines.join("\n")}`)
            snapshot(entry, ".out", lines.join("\n") + "\n")
        })
    }
})

describe("projects (test/projects)", () => {
    const dir = join(root, "projects")
    const projects = readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory() && existsSync(join(dir, d, "main.ms")) || existsSync(join(dir, d, "mod.ms")))
    for (const name of projects.filter((d) => d !== "script_in_eval")) {
        test(name, async () => {
            const p = await openProject(join(dir, name))
            assert.deepEqual([...fmt(p.diagnostics), ...p.errors], [])
            if (p.config) snapshot(join(dir, name, "config.ms"), ".json", configJson(p.config) + "\n")
            const compiled = compileToJs(p.mainDir, programOptions(p))
            assert.deepEqual(fmt(compiled.diagnostics), [])
            const lines: string[] = []
            const result = await runJs(compiled.js!, (line) => lines.push(line))
            assert.equal(result.panic, null, lines.join("\n"))
            // task scripts run in-process: call them as `ms run <name>` would
            for (const [script, s] of p.config?.scripts ?? []) {
                if (s.kind !== "Task") continue
                setOutput((line) => lines.push(`[${script}] ${line}`))
                try { s.fn({ $t: "std.build.Args", list: ["--verbose"] }) } finally { resetOutput() }
            }
            snapshot(join(dir, name, "run.ms"), ".out", lines.join("\n") + "\n")
        })
    }
    test("script_in_eval: running a script while config() is evaluated fails", async () => {
        const p = await openProject(join(dir, "script_in_eval"))
        assert.equal(p.config, null)
        assert.match(p.errors.join("\n"), /E_SCRIPT_IN_EVAL/)
    })
})

describe("ms test", () => {
    const quiet = (lines: string[]) => (line: string) => lines.push(line)
    test("std's tests (written in MinScript) pass", async () => {
        const lines: string[] = []
        const r = await runTests(STD_DIR, { onOutput: quiet(lines) })
        assert.ok(r.packages >= 2, "std has tests")
        assert.deepEqual([r.failed, r.broken, fmt(r.diagnostics)], [0, 0, []], lines.join("\n"))
    })
    test("test/projects: main and non-main packages, sync and async tests", async () => {
        const lines: string[] = []
        const r = await runTests(join(root, "projects"), { onOutput: quiet(lines) })
        assert.deepEqual([r.packages, r.failed, r.broken], [2, 0, 0], lines.join("\n"))
    })
    test("test/testing/failing: failures are reported and the other tests still run", async () => {
        const lines: string[] = []
        const r = await runTests(join(root, "testing", "failing"), { onOutput: quiet(lines) })
        assert.deepEqual([r.packages, r.failed, r.broken], [1, 3, 0])
        snapshot(join(root, "testing", "failing", "report.ms"), ".out", lines.map((l) => l.replace(/\(\d+ ms\)/, "(… ms)")).join("\n") + "\n")
    })
    test("--run filters by name", async () => {
        const lines: string[] = []
        const r = await runTests(join(root, "testing", "failing"), { onOutput: quiet(lines), filter: "passes" })
        assert.deepEqual([r.failed, lines.filter((l) => /^(ok|FAIL) /.test(l)).length], [0, 1])
    })
})
