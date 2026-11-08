// `ms test` (spec §17.7), ported from minscript/src/test_runner.ts: finds the `test_` functions of
// `*_test.ms` files, and runs each package's tests as a program. For a package, the runner generates
// one more file in that package, with a `ms_test_main` that passes every test to
// `std.testing.run_all` (the runner, written in MinScript). Test files are part of their package
// (white-box), but only while it is being tested: the loader leaves them out of every other build.
//
// The generated file exists only in memory (`LoadOptions.extra`); the program runs in a child process
// (`runtime.run_module_result`), whose entry returns the number of failed tests.
package project

import "std.fs"
import "std.io"
import "std.json"
import "std.runtime"
import "app.ast.{FunDecl}"
import "app.parser.{parse}"
import "app.loader.{LoadOptions, FileDiagnostic, join, resolve_from, relative, normalize, is_dir}"

pub let TEST_SUFFIX = "_test.ms"
pub let HARNESS_FILE = "__ms_test_main.ms"

pub type TestOptions = {
    /// Only tests whose name contains this.
    pub filter: string? = None
    pub reporter: string? = None
}

pub type TestFn = { pub name: string, pub is_async: bool }

pub type PackageTests = {
    pub dir: string
    /// The package name the test files declare.
    pub pkg: string
    pub tests: Vec[TestFn]
    /// Problems with the tests themselves (a `test_` function with parameters…).
    pub problems: Vec[FileDiagnostic]
}

pub type TestReport = {
    pub packages: int = 0
    pub failed: int = 0
    /// Packages whose tests didn't compile or crashed the runner.
    pub broken: int = 0
    pub diagnostics: Vec[FileDiagnostic] = []
}

fun skipped(name: &str) -> bool { name == "node_modules" || name == ".git" || name == "history" }

async fun sorted_names(dir: &str) -> Vec[string] {
    var names = await fs.list_dir(dir) or return []
    names.sort()
    names
}

async fun visit(dir: &str, out: &mut Vec[string]) {
    let entries = await sorted_names(dir)
    if entries.any(#{ e => e.ends_with(TEST_SUFFIX) }) {
        out.push(dir.to_str())
    }
    for e in entries.iter() {
        if e.starts_with(".") || skipped(e) {
            continue
        }
        let p = join(dir, e)
        if await is_dir(p) {
            await visit(p, out)
        }
    }
}

/// Folders at or under `path` that hold `*_test.ms` files.
pub async fun find_test_dirs(tc: &Toolchain, path: &str) -> Vec[string] {
    var out = [] as Vec[string]
    let abs = resolve_from(tc.cwd, path)
    if abs.ends_with(TEST_SUFFIX) {
        out.push(normalize("${abs}/.."))
    } else {
        await visit(abs, out)
    }
    out
}

/// The `test_` functions of a folder's test files.
pub async fun collect_tests(dir: &str, filter: &string?) -> PackageTests {
    var result = PackageTests { dir: dir.to_str(), pkg: "main", tests: [], problems: [] }
    for name in (await sorted_names(dir)).iter() {
        if !name.ends_with(TEST_SUFFIX) {
            continue
        }
        let path = join(dir, name)
        let bytes = await fs.read_file(path) or continue
        let parsed = parse(bytes)
        result.pkg = if parsed.file.package_path.is_empty() { "main" } else { parsed.file.package_path.join(".") }
        for itm in parsed.file.items.iter() {
            let Fun(f) = itm else { continue }
            if !f.name.starts_with("test_") {
                continue
            }
            if let Some(problem) = signature_problem(f) {
                result.problems.push(FileDiagnostic { file: path.clone(), code: "E_TEST_SIGNATURE", message: problem, span: f.span, pass: "load" })
                continue
            }
            if let Some(x) = filter {
                if !f.name.contains(x) {
                    continue
                }
            }
            result.tests.push(TestFn { name: f.name.clone(), is_async: f.is_async })
        }
    }
    result
}

fun signature_problem(f: &FunDecl) -> string? {
    if !f.params.is_empty() || f.receiver.is_some() {
        return Some("test `${f.name}` takes no parameters")
    }
    if f.ret.is_some() {
        return Some("test `${f.name}` returns nothing (fail it with an assertion or a panic)")
    }
    if !f.generics.is_empty() {
        return Some("test `${f.name}` can't be generic")
    }
    None
}

/// The generated file: `ms_test_main` runs every test with the MinScript runner.
pub fun harness(tests: &PackageTests, display: &str, reporter: &str) -> string {
    var lines = ["package ${tests.pkg}", "", "import \"std.testing\" as ms_testing", "", "pub async fun ms_test_main() -> int {", "    await ms_testing.run_all(${json.stringify(display)}, ["] as Vec[string]
    for x in tests.tests.iter() {
        // qualified: the package under test may have its own `Sync` / `Async`
        let kind = if x.is_async { "Async" } else { "Sync" }
        lines.push("        ms_testing.Case { name: ${json.stringify(x.name)}, run: ms_testing.TestFn.${kind}(#{ ${x.name}() }) },")
    }
    lines.push("    ], ${json.stringify(reporter)})")
    lines.push("}")
    lines.push("")
    lines.join("\n")
}

fun section_string(p: &Project?, key: &str) -> string? {
    let Some(project) = p else { return None }
    let Some(c) = &project.config else { return None }
    let Some(section) = c.sections.get("test") else { return None }
    if let Object(fields) = section {
        if let Some(Str(s)) = fields.get(key) {
            return Some(s)
        }
    }
    None
}

/// Runs the tests of every package at or under `path`.
pub async fun run_tests(tc: &Toolchain, path: &str, opts: &TestOptions) -> TestReport {
    var report = TestReport {}
    var projects = m{} as Map[string, Project?]
    for dir in (await find_test_dirs(tc, path)).iter() {
        var project: Project? = None
        if let Some(root) = await find_project_root(tc, dir) {
            if !projects.has(root) {
                let p = await open_project(tc, root)
                report.diagnostics.extend(p.diagnostics.clone())
                for e in p.errors.iter() {
                    io.println("error: ${e}")
                }
                let usable = p.diagnostics.is_empty() && p.errors.is_empty()
                projects[root.clone()] = if usable { Some(p) } else { None }
            }
            project = projects.get(root) ?? None
        }
        let reporter = opts.reporter ?? section_string(project, "reporter") ?? "spec"
        let tests = await collect_tests(dir, opts.filter)
        report.diagnostics.extend(tests.problems.clone())
        if !tests.problems.is_empty() {
            report.broken += 1
            continue
        }
        if tests.tests.is_empty() {
            continue
        }
        report.packages += 1
        let base_dir = match &project {
            Some(p) => p.root.clone()
            None => tc.cwd.clone()
        }
        let rel = relative(base_dir, dir)
        let display = if rel.is_empty() { tests.pkg.clone() } else { rel }
        let harness_path = join(dir, HARNESS_FILE)
        var load = match &project {
            Some(p) => program_options(p)
            None => LoadOptions { app_root: Some(dir.clone()) }
        }
        load.test_dir = Some(dir.clone())
        load.extra[harness_path.clone()] = harness(tests, display, reporter)
        // a main package is the whole folder; any other package is loaded through the harness file
        let entry = if tests.pkg == "main" { dir.clone() } else { harness_path }
        let compiled = await compile_to_js(tc, entry, load, "ms_test_main", true)
        let Some(code) = compiled.js else {
            report.diagnostics.extend(compiled.diagnostics)
            report.broken += 1
            continue
        }
        let r = await runtime.run_module_result(code, [], false)
        if r.code != 0 {
            report.broken += 1
            continue
        }
        report.failed += r.value
    }
    report
}

/// `ms test [<path>…] [--run <name>] [--reporter spec|dots]`. Returns the exit code.
pub async fun test_command(tc: &Toolchain, argv: &Vec[string]) -> int {
    var paths = [] as Vec[string]
    var opts = TestOptions {}
    var i = 0
    for i < argv.len() {
        let a = argv[i].clone()
        if a == "--run" {
            opts.filter = argv.get(i + 1)
            i += 1
        } else if a == "--reporter" {
            opts.reporter = argv.get(i + 1)
            i += 1
        } else if a == "--parallel" {
            // accepted; tests run one at a time for now (spec §17.7)
        } else {
            paths.push(a)
        }
        i += 1
    }
    var failed = 0
    var broken = 0
    var packages = 0
    for path in (if paths.is_empty() { ["."] as Vec[string] } else { paths }).iter() {
        let r = await run_tests(tc, path, opts)
        print_diagnostics(tc, r.diagnostics)
        failed += r.failed
        broken += r.broken
        packages += r.packages
    }
    if packages == 0 && broken == 0 {
        let matching = match &opts.filter {
            Some(f) => " matching `${f}`"
            None => ""
        }
        io.println("no tests${matching}")
    } else if packages > 1 || broken > 0 {
        let s = if packages == 1 { "" } else { "s" }
        let outcome = if failed == 0 && broken == 0 {
            "all passed"
        } else {
            let more = if broken > 0 { ", ${broken} couldn't run" } else { "" }
            "${failed} failed${more}"
        }
        io.println("\n${packages} package${s}: ${outcome}")
    }
    if failed > 0 || broken > 0 { 1 } else { 0 }
}
