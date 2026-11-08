// `ms test` (spec §17.7): finds the `test_` functions of `*_test.ms` files, and runs each package's
// tests as a program. For a package, the runner generates one more file in that package, with a
// `ms_test_main` that passes every test to `std.testing.run_all` (the runner, written in MinScript).
// Test files are part of their package (white-box), but only while it is being tested:
// the loader leaves them out of every other build.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import type * as A from "./ast.ts"
import { compileToJs, runJs } from "./js/run.ts"
import type { FileDiagnostic, LoadOptions } from "./loader.ts"
import { parse } from "./parser.ts"
import { findProjectRoot, openProject, programOptions, type Project } from "./project.ts"

export const TEST_SUFFIX = "_test.ms"
export const HARNESS_FILE = "__ms_test_main.ms"

export type TestOptions = {
    /** Only tests whose name contains this. */
    filter?: string
    reporter?: string
    /** Output lines (default: the console). */
    onOutput?: (line: string) => void
}

export type TestFn = { name: string, async: boolean }

export type PackageTests = {
    dir: string
    /** The package name the test files declare. */
    pkg: string
    tests: TestFn[]
    /** Problems with the tests themselves (a `test_` function with parameters…). */
    problems: FileDiagnostic[]
}

export type TestReport = {
    packages: number
    failed: number
    /** Packages whose tests didn't compile or crashed the runner. */
    broken: number
    diagnostics: FileDiagnostic[]
}

const SKIP = new Set(["node_modules", ".git", "history"])

/** Folders at or under `path` that hold `*_test.ms` files. */
export function findTestDirs(path: string): string[] {
    const out: string[] = []
    const visit = (dir: string) => {
        let entries: string[]
        try { entries = readdirSync(dir).sort() } catch { return }
        if (entries.some((e) => e.endsWith(TEST_SUFFIX))) out.push(dir)
        for (const e of entries) {
            if (e.startsWith(".") || SKIP.has(e)) continue
            const p = join(dir, e)
            try { if (statSync(p).isDirectory()) visit(p) } catch { /* gone */ }
        }
    }
    const abs = resolve(path)
    if (abs.endsWith(TEST_SUFFIX)) out.push(join(abs, ".."))
    else visit(abs)
    return out.map((d) => resolve(d))
}

/** The `test_` functions of a folder's test files. */
export function collectTests(dir: string, filter?: string): PackageTests {
    const result: PackageTests = { dir, pkg: "main", tests: [], problems: [] }
    for (const name of readdirSync(dir).filter((f) => f.endsWith(TEST_SUFFIX)).sort()) {
        const path = join(dir, name)
        const parsed = parse(readFileSync(path, "utf8"))
        result.pkg = parsed.file.package.join(".") || "main"
        for (const item of parsed.file.items) {
            if (item.kind !== "FunDecl" || !item.name.startsWith("test_")) continue
            const problem = signatureProblem(item)
            if (problem) {
                result.problems.push({ file: path, code: "E_TEST_SIGNATURE", message: problem, span: item.span, severity: "error", pass: "load" })
                continue
            }
            if (filter && !item.name.includes(filter)) continue
            result.tests.push({ name: item.name, async: item.async })
        }
    }
    return result
}

function signatureProblem(f: A.FunDecl): string | null {
    if (f.params.length > 0 || f.receiver !== null) return `test \`${f.name}\` takes no parameters`
    if (f.ret !== null) return `test \`${f.name}\` returns nothing (fail it with an assertion or a panic)`
    if (f.generics.length > 0) return `test \`${f.name}\` can't be generic`
    return null
}

/** The generated file: `ms_test_main` runs every test with the MinScript runner. */
export function harness(t: PackageTests, display: string, reporter: string): string {
    const cases = t.tests.map((x) =>
        `        ms_testing.Case { name: ${JSON.stringify(x.name)}, run: ${x.async ? "Async" : "Sync"}(#{ ${x.name}() }) },`)
    return [
        `package ${t.pkg}`,
        "",
        `import "std.testing" as ms_testing`,
        "",
        "pub async fun ms_test_main() -> int {",
        `    await ms_testing.run_all(${JSON.stringify(display)}, [`,
        ...cases,
        `    ], ${JSON.stringify(reporter)})`,
        "}",
        "",
    ].join("\n")
}

/** Runs the tests of every package at or under `path`. */
export async function runTests(path: string, opts: TestOptions = {}): Promise<TestReport> {
    const print = opts.onOutput ?? ((l: string) => console.log(l))
    const report: TestReport = { packages: 0, failed: 0, broken: 0, diagnostics: [] }
    const projects = new Map<string, Project | null>()
    const projectOf = async (dir: string): Promise<Project | null> => {
        const root = findProjectRoot(dir)
        if (root === null) return null
        if (!projects.has(root)) {
            const p = await openProject(root)
            report.diagnostics.push(...p.diagnostics)
            for (const e of p.errors) print(`error: ${e}`)
            projects.set(root, p.diagnostics.length > 0 || p.errors.length > 0 ? null : p)
        }
        return projects.get(root)!
    }

    for (const dir of findTestDirs(path)) {
        const project = await projectOf(dir)
        const reporter = opts.reporter ?? sectionString(project, "reporter") ?? "spec"
        const t = collectTests(dir, opts.filter)
        report.diagnostics.push(...t.problems)
        if (t.problems.length > 0) { report.broken++; continue }
        if (t.tests.length === 0) continue
        report.packages++
        const display = relative(project?.root ?? process.cwd(), dir) || t.pkg
        const harnessPath = join(dir, HARNESS_FILE)
        const text = harness(t, display, reporter)
        const base: LoadOptions = project ? programOptions(project) : { appRoot: dir }
        const load: LoadOptions = {
            ...base,
            testDir: dir,
            read: (p) => (p === harnessPath ? text : (() => { try { return readFileSync(p, "utf8") } catch { return null } })()),
            list: (d) => {
                let names: string[] = []
                try { names = readdirSync(d).filter((f) => f.endsWith(".ms")) } catch { /* none */ }
                return d === dir ? [...names, HARNESS_FILE] : names
            },
        }
        // a main package is the whole folder; any other package is loaded through the harness file
        const entry = t.pkg === "main" ? dir : harnessPath
        const compiled = compileToJs(entry, load, (pkg) => (pkg === "main" ? "ms_test_main" : `${pkg}.ms_test_main`))
        if (compiled.js === null) {
            report.diagnostics.push(...compiled.diagnostics)
            report.broken++
            continue
        }
        const result = await runJs(compiled.js, print)
        if (result.panic !== null) { report.broken++; continue }
        report.failed += Number(result.value ?? 0)
    }
    return report
}

function sectionString(p: Project | null, key: string): string | undefined {
    const section = p?.config?.sections["test"] as Record<string, unknown> | undefined
    const v = section?.[key]
    return typeof v === "string" ? v : undefined
}
