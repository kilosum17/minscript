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
//   test/testing/failing reports its failures as in `report.out`;
// - ../stage1 (the self-hosted compiler): it checks cleanly, its tests pass, and its lexer, parser,
//   resolver, checker, ownership pass and lowering produce exactly stage 0's output (dumps and
//   diagnostics) on every file, and its loader and JS back end compile every runnable program (stage 1
//   itself included) to exactly stage 0's JavaScript;
// - `ms fmt` (src/fmt.ts): every valid file formats to the same AST, keeps its comments, and formatting
//   again changes nothing; test/fmt/*.ms format to their `.fmt` snapshot.
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
import { format } from "../src/fmt.ts"
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
    test("the prelude's MinScript methods (test/prelude)", async () => {
        const lines: string[] = []
        const r = await runTests(join(root, "prelude"), { onOutput: quiet(lines) })
        assert.deepEqual([r.packages, r.failed, r.broken, fmt(r.diagnostics)], [1, 0, 0, []], lines.join("\n"))
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

/** A `;` means something only after a block's last statement (spec §5.4): forget the others. */
function semis<T>(node: T): T {
    const seen = new Set<object>()
    const visit = (x: unknown): void => {
        if (typeof x !== "object" || x === null || seen.has(x)) return
        seen.add(x)
        const stmts = (x as { stmts?: unknown }).stmts
        if (Array.isArray(stmts)) stmts.slice(0, -1).forEach((s) => { if (s && typeof s === "object" && "semi" in s) (s as { semi: boolean }).semi = false })
        for (const v of Object.values(x)) visit(v)
    }
    visit(node)
    return node
}

describe("ms fmt (src/fmt.ts)", () => {
    const valid = [...msFiles(STD_DIR), ...msFiles(root).filter((f) => !f.includes(`${join(root, "errors")}/`))]
    for (const file of valid) {
        const src = readFileSync(file, "utf8")
        if (parse(src).diagnostics.length > 0) continue
        test(`round trip: ${file.startsWith(STD_DIR) ? `std/${relative(STD_DIR, file)}` : rel(file)}`, () => {
            const out = format(src).text!
            const before = parse(src), after = parse(out)
            assert.deepEqual(fmt(after.diagnostics), [], "the output parses")
            assert.equal(printFile(semis(after.file)), printFile(semis(before.file)), "same AST")
            assert.deepEqual(after.lex.trivia.map((t) => t.text.trim()), before.lex.trivia.map((t) => t.text.trim()), "every comment, in order")
            assert.equal(format(out).text, out, "idempotent")
        })
    }
    for (const file of msFiles(join(root, "fmt"))) {
        test(`snapshot: ${rel(file)}`, () => snapshot(file, ".fmt", format(readFileSync(file, "utf8")).text!))
    }
})

describe("stage 1 (../stage1, the self-hosted compiler)", () => {
    const stage1 = join(root, "..", "..", "stage1")
    if (!existsSync(join(stage1, "mod.ms"))) return
    test("checks cleanly and its tests pass", { timeout: 60_000 }, async () => {
        const p = await openProject(stage1)
        assert.deepEqual([...fmt(p.diagnostics), ...p.errors], [])
        const program = loadProgram(p.mainDir, programOptions(p))
        assert.deepEqual(program.diagnostics.map((d) => `${relative(stage1, d.file)}:${d.span.line} ${d.code} ${d.message}`), [])
        const lines: string[] = []
        const r = await runTests(stage1, { onOutput: (l) => lines.push(l) })
        assert.deepEqual([r.failed, r.broken], [0, 0], lines.join("\n"))
    })
    const files = () => [...msFiles(join(root, "..", "std")), ...msFiles(root), ...msFiles(join(stage1, "src"))]
    const stage1Run = async (command: string, list: string[]) => {
        const { spawnSync } = await import("node:child_process")
        const ms = join(root, "..", "bin", "ms.js")
        return spawnSync(process.execPath, [ms, "run", stage1, "--", command, ...list], { encoding: "utf8", maxBuffer: 1 << 28 })
    }
    const same = (actual: string, expected: string, what: string) => {
        if (actual === expected) return
        const a = actual.split("\n"), b = expected.split("\n")
        const i = a.findIndex((l, k) => l !== b[k])
        assert.fail(`${what}: first difference at line ${i + 1}:\n  stage 1: ${a[i]}\n  stage 0: ${b[i]}`)
    }
    const diagnosticLines = (file: string, ds: { span: { line: number, col: number }, code: string, message: string }[]) =>
        ds.map((d) => `${file}:${d.span.line}:${d.span.col}: error ${d.code}: ${d.message}\n`).join("")
    test("its lexer dumps every file like stage 0's", { timeout: 60_000 }, async () => {
        const list = files()
        const r = await stage1Run("lex", list)
        assert.equal(r.status, 0, r.stderr)
        same(r.stdout, list.map((f) => `== ${f}\n${dumpTokens(lex(readFileSync(f)))}`).join(""), "token dumps")
        same(r.stderr, list.map((f) => diagnosticLines(f, lex(readFileSync(f)).diagnostics)).join(""), "diagnostics")
    })
    test("its resolver gives the same resolution and diagnostics as stage 0's on every file", { timeout: 60_000 }, async () => {
        const list = files()
        const r = await stage1Run("resolve", ["--prelude", join(root, "..", "std", "prelude.ms"), ...list])
        assert.equal(r.status, 0, r.stderr)
        const resolved = list.map((f) => { const p = parse(readFileSync(f)); return { f, p, res: resolvePackage([p.file]) } })
        same(r.stdout, resolved.map(({ f, res }) => `== ${f}\n${dumpResolution(res)}`).join(""), "resolution dumps")
        same(r.stderr, resolved.map(({ f, p, res }) => diagnosticLines(f, [...p.diagnostics, ...res.diagnostics])).join(""), "diagnostics")
    })
    test("its checker gives the same types and diagnostics as stage 0's on every file", { timeout: 120_000 }, async () => {
        const list = files()
        const r = await stage1Run("types", ["--prelude", join(root, "..", "std", "prelude.ms"), ...list])
        assert.equal(r.status, 0, r.stderr)
        const checked = list.map((f) => {
            const p = parse(readFileSync(f))
            const res = resolvePackage([p.file])
            return { f, p, res, checked: checkPackage([p.file], res) }
        })
        same(r.stdout, checked.map(({ f, p, res, checked }) => `== ${f}\n${dumpTypes(res, checked, [p.file])}`).join(""), "type dumps")
        same(r.stderr, checked.map(({ f, p, res, checked }) => diagnosticLines(f, [...p.diagnostics, ...res.diagnostics, ...checked.diagnostics])).join(""), "diagnostics")
    })
    test("its ownership pass gives the same diagnostics as stage 0's on every file", { timeout: 120_000 }, async () => {
        const list = files()
        const r = await stage1Run("ownership", ["--prelude", join(root, "..", "std", "prelude.ms"), ...list])
        assert.equal(r.status, 0, r.stderr)
        const owned = list.map((f) => {
            const p = parse(readFileSync(f))
            const res = resolvePackage([p.file])
            const checked = checkPackage([p.file], res)
            return { f, p, res, checked, owned: checkOwnership([p.file], res, checked).diagnostics }
        })
        const line = (d: { span: { line: number, col: number }, code: string, message: string }) => `${`${d.span.line}:${d.span.col}`.padEnd(8)}${d.code} ${d.message}\n`
        same(r.stdout, owned.map(({ f, owned }) => `== ${f}\n${owned.map(line).join("")}`).join(""), "ownership diagnostics")
        same(r.stderr, owned.map(({ f, p, res, checked, owned }) => diagnosticLines(f, [...p.diagnostics, ...res.diagnostics, ...checked.diagnostics, ...owned])).join(""), "diagnostics")
    })
    test("its lowering gives the same HIR as stage 0's on every file", { timeout: 120_000 }, async () => {
        const list = files()
        const r = await stage1Run("hir", ["--prelude", join(root, "..", "std", "prelude.ms"), ...list])
        assert.equal(r.status, 0, r.stderr)
        const lowered = list.map((f) => {
            const p = parse(readFileSync(f))
            const res = resolvePackage([p.file])
            const checked = checkPackage([p.file], res)
            return { f, p, res, checked, hir: dumpHir(lowerPackage([p.file], res, checked)) }
        })
        same(r.stdout, lowered.map(({ f, hir }) => `== ${f}\n${hir}`).join(""), "HIR dumps")
        same(r.stderr, lowered.map(({ f, p, res, checked }) => diagnosticLines(f, [...p.diagnostics, ...res.diagnostics, ...checked.diagnostics])).join(""), "diagnostics")
    })
    test("it compiles every program (itself included) to the same JavaScript as stage 0", { timeout: 300_000 }, async () => {
        const { spawn } = await import("node:child_process")
        const ms = join(root, "..", "bin", "ms.js")
        const std = join(root, "..", "std")
        const entries = [
            ...readdirSync(join(root, "run")).filter((f) => f.endsWith(".ms")).map((f) => join(root, "run", f)),
            ...readdirSync(join(root, "packages")).map((d) => join(root, "packages", d, "main.ms")).filter((f) => existsSync(f)),
            stage1,
        ]
        const stage1Js = (entry: string) => new Promise<{ code: number | null, out: string, err: string }>((resolveRun) => {
            const child = spawn(process.execPath, [ms, "run", stage1, "--", "js", "--std", std, entry])
            let out = "", err = ""
            child.stdout.on("data", (d) => { out += d })
            child.stderr.on("data", (d) => { err += d })
            child.on("close", (code) => resolveRun({ code, out, err }))
        })
        const results = await Promise.all(entries.map(stage1Js))
        entries.forEach((entry, i) => {
            const r = results[i]!
            assert.equal(r.code, 0, `${entry}: ${r.err}`)
            // stage 1 is a project whose main is ./src (`ms js ../stage1`)
            const expected = entry === stage1 ? compileToJs(join(stage1, "src"), { appRoot: join(stage1, "src") }) : compileToJs(entry)
            assert.deepEqual(expected.diagnostics, [])
            same(r.out, expected.js!, `JavaScript of ${relative(root, entry)}`)
        })
    })
    test("its parser builds the same AST and diagnostics as stage 0's on every file", { timeout: 60_000 }, async () => {
        const list = files()
        const r = await stage1Run("parse", list)
        assert.equal(r.status, 0, r.stderr)
        same(r.stdout, list.map((f) => `== ${f}\n${printFile(parse(readFileSync(f)).file)}`).join(""), "AST dumps")
        same(r.stderr, list.map((f) => diagnosticLines(f, parse(readFileSync(f)).diagnostics)).join(""), "diagnostics")
    })
})
