// `ms test` (spec §17.7): finds the `test_` functions of `*_test.ms` files and runs each package's
// tests as a program. For a package, the runner generates one more file in it (in memory), with a
// `ms_test_main` that passes every test to `std.testing.run_all`, the runner written in MinScript.
// Test files are part of their package (white-box), but only while it is being tested.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type * as A from "./ast.ts";
import { formatDiagnostic, LineMap, type Diagnostic } from "./diagnostic.ts";
import { compile, runJs } from "./js/run.ts";
import { parse } from "./parser.ts";

export const TEST_SUFFIX = "_test.ms";
export const HARNESS_FILE = "__ms_test_main.ms";

export interface TestOptions {
    /** only tests whose name contains this */
    filter?: string;
    /** "spec" (a line per test) or "dots" */
    reporter?: string;
}

export interface PackageTests {
    dir: string;
    /** the package the test files declare */
    pkg: string;
    tests: { name: string; async: boolean }[];
    /** problems with the tests themselves (E_TEST_SIGNATURE) */
    problems: Diagnostic[];
}

export interface TestReport {
    packages: number;
    failed: number;
    /** packages whose tests didn't compile or crashed the runner */
    broken: number;
}

const SKIP = new Set(["node_modules", ".git", "history"]);

/** Folders at or under `path` that hold `*_test.ms` files. */
export function findTestDirs(path: string): string[] {
    const abs = resolve(path);
    if (abs.endsWith(TEST_SUFFIX)) return [resolve(abs, "..")];
    const out: string[] = [];
    const visit = (dir: string) => {
        let entries: string[];
        try {
            entries = readdirSync(dir).sort();
        } catch {
            return;
        }
        if (entries.some((e) => e.endsWith(TEST_SUFFIX))) out.push(dir);
        for (const e of entries) {
            if (e.startsWith(".") || SKIP.has(e)) continue;
            const p = join(dir, e);
            if (statSync(p).isDirectory()) visit(p);
        }
    };
    visit(abs);
    return out;
}

/** The `test_` functions of a folder's test files. */
export function collectTests(dir: string, filter?: string): PackageTests {
    const out: PackageTests = { dir, pkg: "main", tests: [], problems: [] };
    for (const name of readdirSync(dir).filter((f) => f.endsWith(TEST_SUFFIX)).sort()) {
        const path = join(dir, name);
        const parsed = parse(readFileSync(path));
        out.pkg = parsed.file.package.join(".") || "main";
        for (const item of parsed.file.items) {
            if (item.kind !== "Fn" || !item.name.startsWith("test_")) continue;
            const problem = signatureProblem(item);
            if (problem) {
                out.problems.push({ code: "E_TEST_SIGNATURE", message: problem, start: item.span.start, end: item.span.end, severity: "error", file: path });
                continue;
            }
            if (filter && !item.name.includes(filter)) continue;
            out.tests.push({ name: item.name, async: item.isAsync });
        }
    }
    return out;
}

function signatureProblem(f: A.FnDecl): string | null {
    if (f.params.length > 0 || f.receiver !== null) return `test \`${f.name}\` takes no parameters`;
    if (f.ret !== null) return `test \`${f.name}\` returns nothing (fail it with an assertion or a panic)`;
    if (f.generics.length > 0) return `test \`${f.name}\` can't be generic`;
    return null;
}

/** The generated file: `ms_test_main` runs every test with the MinScript runner. */
export function harness(t: PackageTests, display: string, reporter: string): string {
    // qualified: the package under test may have its own `Case` or `Sync`; std.testing itself
    // can't import itself, so its harness names them directly
    const self = resolve(t.dir) === resolve(import.meta.dirname, "..", "std", "testing");
    const q = self ? "" : "ms_testing.";
    const cases = t.tests.map((x) => `        ${q}Case { name: ${JSON.stringify(x.name)}, run: ${q}TestFn.${x.async ? "Async" : "Sync"}(#{ ${x.name}() }) },`);
    return [
        `package ${t.pkg}`,
        "",
        ...(self ? [] : [`import "std.testing" as ms_testing`, ""]),
        "pub async fn ms_test_main() -> int {",
        `    await ${q}run_all(${JSON.stringify(display)}, [`,
        ...cases,
        `    ], ${JSON.stringify(reporter)})`,
        "}",
        "",
    ].join("\n");
}

function printDiagnostics(ds: Diagnostic[]): void {
    const maps = new Map<string, LineMap>();
    for (const d of ds) {
        const file = d.file ?? "?";
        let m = maps.get(file);
        if (!m) {
            let src = new Uint8Array();
            try {
                src = readFileSync(file);
            } catch {
                // a generated file
            }
            maps.set(file, (m = new LineMap(src)));
        }
        console.log(formatDiagnostic(d, relative(process.cwd(), file), m));
    }
}

/** Runs the tests of every package at or under `path`. */
export async function runTests(path: string, opts: TestOptions = {}): Promise<TestReport> {
    const report: TestReport = { packages: 0, failed: 0, broken: 0 };
    for (const dir of findTestDirs(path)) {
        const t = collectTests(dir, opts.filter);
        if (t.problems.length > 0) {
            printDiagnostics(t.problems);
            report.broken++;
            continue;
        }
        if (t.tests.length === 0) continue;
        report.packages++;
        const display = relative(process.cwd(), dir) || t.pkg;
        const harnessPath = join(dir, HARNESS_FILE);
        const virtual = new Map([[harnessPath, harness(t, display, opts.reporter ?? "spec")]]);
        // a main package is the whole folder; any other package is loaded through the harness file
        const entry = t.pkg === "main" ? dir : harnessPath;
        const c = compile(entry, { load: { testDir: dir, virtual }, entryFn: "ms_test_main" });
        if (c.js === null) {
            printDiagnostics(c.diagnostics.filter((d) => d.severity === "error"));
            report.broken++;
            continue;
        }
        const r = await runJs(c.js, { entry: "main" });
        if (r.code !== 0) {
            report.broken++;
            continue;
        }
        report.failed += Number(r.value ?? 0);
    }
    return report;
}
