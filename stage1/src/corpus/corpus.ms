// The corpus runner (`ms1 corpus [--update]`), ported from minscript/test/corpus.test.ts: stage 1
// checks itself against the corpus in test/ (see test/README.md), with no other compiler.
//
// - test/lexer/*.ms:   zero diagnostics, and the token dump matches the `.tokens` snapshot;
// - test/parser/*.ms:  zero diagnostics, and the AST dump matches the `.ast` snapshot;
// - the prelude parses, resolves and type-checks cleanly;
// - test/programs:     zero diagnostics from every pass;
// - test/ownership:    type-check cleanly, and the ownership diagnostics match the `//~` annotations;
// - test/check/*.ms:   checker diagnostics match the annotations; the `.types` snapshot;
// - test/resolve/*.ms: resolver diagnostics match the annotations; the `.refs` snapshot;
// - test/errors:       lexer and parser diagnostics match the annotations (code and line);
// - test/hir/*.ms:     pass every check; the `.hir` snapshot;
// - every valid file lowers to HIR that passes `validate_hir`;
// - test/run/*.ms, and programs with a `.out` file, run and print their `.out`;
// - every valid file compiles to JavaScript;
// - every std package loads cleanly;
// - test/packages/**/main.ms: diagnostics match the annotations of every file of the program; one
//   without annotations runs and prints its `.out`;
// - test/projects/*: mod.ms evaluates (`config.json`), the main package and the task scripts run
//   (`run.out`); `script_in_eval` fails with E_SCRIPT_IN_EVAL;
// - `ms test`: std's tests, test/prelude, test/projects pass; test/testing/failing reports as in
//   `report.out`, and `--run` filters;
// - `ms fmt`: every valid file formats to the same AST, keeps its comments, and formatting again
//   changes nothing; test/fmt/*.ms format to their `.fmt` snapshot;
// - stage 1 itself (src/) checks cleanly and its unit tests pass.
//
// Per-file checks run in this process (each file its own package, as stage 0's `ms resolve`, `ms
// types`, `ms hir` do); programs run in a child process with their output captured.
// `--update` rewrites the snapshots: review the diff before committing.
package corpus

import "std.fs"
import "std.io"
import "std.runtime"
import "std.utf8"
import "app.lexer"
import "app.parser"
import "app.ast"
import "app.resolve"
import "app.check"
import "app.ownership"
import "app.hir"
import "app.fmt"
import "app.loader.{LoadOptions, FileDiagnostic, load_program, join, relative, dirname, basename, is_dir}"
import "app.project.{Toolchain, compile_to_js, compile_with, open_project, program_options, config_json, run_tests, TestOptions, ms_files, output_lines, task_command_js}"

let LEXER_CODES = ["E_UNTERMINATED_STRING", "E_UNTERMINATED_COMMENT", "E_INVALID_ESCAPE", "E_INVALID_NUMBER", "E_INVALID_CHAR", "E_UNMATCHED_DELIMITER", "E_TAGGED_RECORD_REMOVED", "E_UNKNOWN_CHARACTER"]

type Report = {
    root: string
    update: bool
    checks: int = 0
    failures: Vec[string] = []
}

impl Report {
    fun ok(&mut this) { this.checks += 1 }

    fun fail(&mut this, name: &str, detail: string) {
        this.checks += 1
        this.failures.push("FAIL ${name}\n${indented(detail)}")
        io.println("FAIL ${name}")
    }

    /// `actual == expected`, as text.
    fun same(&mut this, name: &str, actual: &str, expected: &str) {
        if actual == expected {
            this.ok()
        } else {
            this.fail(name, first_difference(actual, expected))
        }
    }

    /// Two lists of lines, in any order.
    fun same_set(&mut this, name: &str, actual: Vec[string], expected: Vec[string]) {
        var a = actual
        var b = expected
        a.sort()
        b.sort()
        if a == b {
            this.ok()
        } else {
            this.fail(name, "expected:\n${b.join("\n")}\nactual:\n${a.join("\n")}")
        }
    }

    fun none(&mut this, name: &str, problems: Vec[string]) {
        if problems.is_empty() { this.ok() } else { this.fail(name, problems.join("\n")) }
    }

    fun rel(&this, p: &str) -> string { relative(this.root, p) }

    /// The snapshot next to `file` (`x.ms` → `x<ext>`): written if missing (or with `--update`),
    /// otherwise compared.
    async fun snapshot(&mut this, file: &str, ext: &str, actual: &str) {
        let snap = "${file.substring(0, file.len() - 3)}${ext}"
        if this.update || !await fs.exists(snap) {
            let _ = await fs.write_text(snap, actual)
            this.ok()
            return
        }
        let expected = await text_of(snap)
        if actual == expected {
            this.ok()
        } else {
            this.fail("${this.rel(snap)}", "out of date (run `ms1 corpus --update` and review the diff)\n${first_difference(actual, expected)}")
        }
    }
}

fun indented(s: &str) -> string { s.split("\n").map(#{ l => "    ${l}" }).join("\n") }

fun first_difference(actual: &str, expected: &str) -> string {
    let xs = actual.split("\n")
    let ys = expected.split("\n")
    var i = 0
    for i < xs.len() && i < ys.len() && xs[i] == ys[i] {
        i += 1
    }
    let got = xs.get(i) ?? "(end)"
    let want = ys.get(i) ?? "(end)"
    "first difference at line ${i + 1}:\n  actual:   ${got}\n  expected: ${want}"
}

fun diag_lines(ds: &Vec[lexer.Diagnostic]) -> Vec[string] { ds.map(#{ d => "${d.span.line}:${d.span.col} ${d.code} ${d.message}" }) }

fun code_lines(ds: &Vec[lexer.Diagnostic]) -> Vec[string] { ds.map(#{ d => "${d.span.line} ${d.code}" }) }

/// `//~ CODE CODE2` annotations (codes `E_…`), by line.
fun annotations(text: &str) -> Vec[string] {
    var out = [] as Vec[string]
    var n = 0
    for line in text.split("\n").iter() {
        n += 1
        let Some(at) = line.find("//~", 0) else { continue }
        for code in codes_after(line.substring(at + 3, line.len()), true).iter() {
            out.push("${n} ${code}")
        }
    }
    out
}

/// The codes at the start of `rest`: whitespace-separated words of `A-Z` and `_`. With `e_only`
/// (stage 0's `/\/\/~\s*((?:E_[A-Z_]+\s*)+)/`), each must start with `E_` and the list stops at the
/// first word that doesn't; otherwise (`/\/\/~((?:\s+[A-Z_]+)+)\s*$/`) every word must be a code.
fun codes_after(rest: &str, e_only: bool) -> Vec[string] {
    var out = [] as Vec[string]
    var i = 0
    let n = rest.len()
    if !e_only && (n == 0 || !is_space(rest.byte_at(0))) {
        return []
    }
    for {
        for i < n && is_space(rest.byte_at(i)) {
            i += 1
        }
        if i >= n {
            break
        }
        let start = i
        for i < n && ((rest.byte_at(i) >= 65 && rest.byte_at(i) <= 90) || rest.byte_at(i) == 95) {
            i += 1
        }
        let word = rest.substring(start, i)
        let ends = i >= n || is_space(rest.byte_at(i))
        if e_only {
            if word.len() < 3 || !word.starts_with("E_") || !ends {
                // `E_FOO` must be a whole word to count; the list ends at the first other word
                if word.len() >= 3 && word.starts_with("E_") {
                    out.push(word.to_str())
                }
                break
            }
            out.push(word.to_str())
        } else {
            if word.is_empty() || !ends {
                return []
            }
            out.push(word.to_str())
        }
    }
    out
}

fun is_space(b: u8) -> bool { b == 32 || b == 9 || b == 13 || b == 10 }

/// One file through the passes, as its own package.
type Analysed = { parsed: parser.ParseResult, res: resolve.Resolution, checked: check.CheckResult }

type Prelude = { file: ast.File, res: resolve.Resolution, next_id: int, diagnostics: Vec[lexer.Diagnostic] }

async fun files_in(dir: &str) -> Vec[string] {
    var out = [] as Vec[string]
    await ms_files(dir, out)
    out
}

async fun bytes_of(path: &str) -> Vec[u8] {
    match await fs.read_file(path) {
        Ok(b) => b
        Err(_) => []
    }
}

async fun text_of(path: &str) -> string {
    match await fs.read_text(path) {
        Ok(t) => t
        Err(_) => ""
    }
}

/// `ms1 corpus [--update]`: every check, from the stage 1 folder `root`. Returns the exit code.
pub async fun corpus_command(tc: &Toolchain, root: &str, args: &Vec[string]) -> int {
    var r = Report { root: join(root, "test"), update: args.contains("--update") }
    let test_dir = join(root, "test")
    // the prelude, which every per-file check resolves against
    let pbytes = await bytes_of(join(tc.std_dir, "prelude.ms"))
    let pp = parser.parse(pbytes)
    let pres = resolve.resolve_package([pp.file], None, resolve.ResolveOptions { std: true, package_name: "std" })
    var pdiags = pp.diagnostics.clone()
    pdiags.extend(pres.diagnostics.clone())
    let prelude = Prelude { file: pp.file, res: pres, next_id: pp.next_id, diagnostics: pdiags }

    await lexer_and_parser(r, test_dir)
    prelude_check(r, prelude)
    await per_file(r, test_dir, prelude)
    await programs(r, tc, test_dir)
    await std_packages(r, tc)
    await packages(r, tc, test_dir)
    await projects(r, tc, test_dir)
    await ms_test(r, tc, test_dir)
    await formatting(r, tc, test_dir)
    await itself(r, tc, root)

    io.println("")
    for f in r.failures.iter() {
        io.println(f)
    }
    let failed = r.failures.len()
    io.println("${r.checks} checks: ${if failed == 0 { "all passed" } else { "${failed} failed" }}")
    if failed == 0 { 0 } else { 1 }
}

async fun lexer_and_parser(r: &mut Report, test_dir: &str) {
    for file in (await files_in(join(test_dir, "lexer"))).iter() {
        let src = await bytes_of(file)
        r.none("${r.rel(file)}: parses cleanly", diag_lines(parser.parse(src.clone()).diagnostics))
        await r.snapshot(file, ".tokens", lexer.dump(lexer.lex(src)))
    }
    for file in (await files_in(join(test_dir, "parser"))).iter() {
        let src = await bytes_of(file)
        let res = parser.parse(src)
        r.none("${r.rel(file)}: parses cleanly", diag_lines(res.diagnostics))
        await r.snapshot(file, ".ast", ast.print_file(res.file))
    }
    for file in (await files_in(join(test_dir, "errors"))).iter() {
        let text = await text_of(file)
        let src = utf8.encode(text)
        let expected = annotations(text)
        let lexer_expected = expected.filter(#{ x => LEXER_CODES.contains(x.split(" ")[1].to_str()) })
        r.same_set("${r.rel(file)}: lexer", code_lines(lexer.lex(src.clone()).diagnostics), lexer_expected)
        r.same_set("${r.rel(file)}: lexer + parser", code_lines(parser.parse(src).diagnostics), expected)
    }
}

fun prelude_check(r: &mut Report, p: &Prelude) {
    r.none("the prelude parses and resolves cleanly", diag_lines(p.diagnostics))
    let checked = check.check_package([p.file.clone()], p.res, p.file, p.res)
    r.none("the prelude type-checks cleanly", diag_lines(checked.diagnostics))
}

fun analyse(p: &Prelude, src: Vec[u8]) -> Analysed {
    let parsed = parser.parse_from(src, p.next_id)
    let res = resolve.resolve_package([parsed.file.clone()], Some(p.res.clone()), resolve.ResolveOptions {})
    let checked = check.check_package([parsed.file.clone()], res, p.file, p.res)
    Analysed { parsed, res, checked }
}

async fun per_file(r: &mut Report, test_dir: &str, p: &Prelude) {
    for file in (await files_in(join(test_dir, "programs"))).iter() {
        var a = analyse(p, await bytes_of(file))
        let name = r.rel(file)
        r.none("${name}: parses", diag_lines(a.parsed.diagnostics))
        r.none("${name}: resolves", diag_lines(a.res.diagnostics))
        r.none("${name}: type-checks", diag_lines(a.checked.diagnostics))
        r.none("${name}: ownership", diag_lines(ownership.check_ownership([a.parsed.file.clone()], a.res, a.checked).diagnostics))
    }
    for file in (await files_in(join(test_dir, "ownership"))).iter() {
        let text = await text_of(file)
        var a = analyse(p, utf8.encode(text))
        let name = r.rel(file)
        r.none("${name}: parses", diag_lines(a.parsed.diagnostics))
        r.none("${name}: resolves", diag_lines(a.res.diagnostics))
        r.none("${name}: type-checks", diag_lines(a.checked.diagnostics))
        let owned = ownership.check_ownership([a.parsed.file.clone()], a.res, a.checked)
        r.same_set("${name}: ownership diagnostics", code_lines(owned.diagnostics), annotations(text))
    }
    for file in (await files_in(join(test_dir, "check"))).iter() {
        let text = await text_of(file)
        let a = analyse(p, utf8.encode(text))
        let name = r.rel(file)
        r.none("${name}: parses", diag_lines(a.parsed.diagnostics))
        r.none("${name}: resolves", diag_lines(a.res.diagnostics))
        r.same_set("${name}: checker diagnostics", code_lines(a.checked.diagnostics), annotations(text))
        await r.snapshot(file, ".types", check.dump_types(a.res, a.checked))
    }
    for file in (await files_in(join(test_dir, "resolve"))).iter() {
        let text = await text_of(file)
        let parsed = parser.parse_from(utf8.encode(text), p.next_id)
        let res = resolve.resolve_package([parsed.file.clone()], Some(p.res.clone()), resolve.ResolveOptions {})
        let name = r.rel(file)
        r.none("${name}: parses", diag_lines(parsed.diagnostics))
        r.same_set("${name}: resolver diagnostics", code_lines(res.diagnostics), annotations(text))
        await r.snapshot(file, ".refs", resolve.dump_resolution(res))
    }
    for file in (await files_in(join(test_dir, "hir"))).iter() {
        var a = analyse(p, await bytes_of(file))
        let name = r.rel(file)
        r.none("${name}: parses", diag_lines(a.parsed.diagnostics))
        let owned = ownership.check_ownership([a.parsed.file.clone()], a.res, a.checked)
        var all = a.res.diagnostics.clone()
        all.extend(a.checked.diagnostics.clone())
        all.extend(owned.diagnostics.clone())
        r.none("${name}: passes every check", diag_lines(all))
        let program = hir.lower_package([a.parsed.file.clone()], a.res, a.checked, p.file, p.res, owned.moves)
        await r.snapshot(file, ".hir", hir.dump_hir(program, a.checked.vars, a.res.symbols))
    }
    // every valid file lowers to well-formed HIR
    for file in (await valid_files(test_dir, false)).iter() {
        let a = analyse(p, await bytes_of(file))
        let program = hir.lower_package([a.parsed.file.clone()], a.res, a.checked, p.file, p.res, Set.new())
        r.none("${r.rel(file)}: well-formed HIR", hir.validate_hir(program))
    }
}

/// The files that must pass every check: programs, hir, and one file each of check, ownership and
/// resolve (with `run`, also test/run).
async fun valid_files(test_dir: &str, with_run: bool) -> Vec[string] {
    var out = await files_in(join(test_dir, "programs"))
    out.extend(await files_in(join(test_dir, "hir")))
    if with_run {
        out.extend(await files_in(join(test_dir, "run")))
    }
    out.push(join(test_dir, "check/inference.ms"))
    out.push(join(test_dir, "ownership/valid.ms"))
    out.push(join(test_dir, "resolve/scopes.ms"))
    out
}

/// A program's output as a `.out` snapshot holds it.
fun out_text(stdout: &str) -> string { "${output_lines(stdout).join("\n")}\n" }

async fun run_program(r: &mut Report, tc: &Toolchain, name: &str, entry: &str, opts: LoadOptions) -> string? {
    let compiled = await compile_to_js(tc, entry, opts, "main", false)
    let Some(code) = compiled.js else {
        r.fail("${name}: compiles", compiled.diagnostics.map(#{ d => "${d.file}:${d.span.line}:${d.span.col} ${d.code} ${d.message}" }).join("\n"))
        return None
    }
    let res = await runtime.run_module_captured(code, [])
    if res.code != 0 {
        r.fail("${name}: runs", "exit code ${res.code}:\n${res.stdout}")
        return None
    }
    r.ok()
    Some(out_text(res.stdout))
}

async fun programs(r: &mut Report, tc: &Toolchain, test_dir: &str) {
    var runnable = await files_in(join(test_dir, "run"))
    for f in (await files_in(join(test_dir, "programs"))).iter() {
        if await fs.exists("${f.substring(0, f.len() - 3)}.out") {
            runnable.push(f.clone())
        }
    }
    for file in runnable.iter() {
        let name = r.rel(file)
        if let Some(out) = await run_program(r, tc, name, file, LoadOptions {}) {
            await r.snapshot(file, ".out", out)
        }
    }
    // every valid file compiles to JavaScript
    for file in (await valid_files(test_dir, true)).iter() {
        let compiled = await compile_to_js(tc, file, LoadOptions {}, "main", false)
        match compiled.js {
            Some(js) => if js.contains("export async function $main") { r.ok() } else { r.fail("${r.rel(file)}: compiles to a module", "no `$main`") }
            None => r.fail("${r.rel(file)}: compiles to a module", compiled.diagnostics.map(#{ d => "${d.code} ${d.message}" }).join("\n"))
        }
    }
}

async fun std_packages(r: &mut Report, tc: &Toolchain) {
    for file in (await files_in(tc.std_dir)).iter() {
        if file.ends_with("prelude.ms") || file.ends_with("_test.ms") {
            continue
        }
        let loaded = await load_program(file, tc.std_dir, LoadOptions {})
        let name = "std/${relative(tc.std_dir, file)}: loads cleanly"
        match loaded {
            Ok(p) => r.none(name, p.diagnostics.map(#{ d => "${relative(tc.std_dir, d.file)}:${d.span.line}:${d.span.col} ${d.code} ${d.message}" }))
            Err(e) => r.fail(name, e)
        }
    }
}

async fun packages(r: &mut Report, tc: &Toolchain, test_dir: &str) {
    for entry in (await files_in(join(test_dir, "packages"))).iter() {
        if !entry.ends_with("/main.ms") {
            continue
        }
        let name = r.rel(entry)
        let loaded = await load_program(entry, tc.std_dir, LoadOptions {})
        let program = loaded or e => {
            r.fail(name, e)
            continue
        }
        var expected = [] as Vec[string]
        for pkg in program.packages.iter() {
            if !relative(tc.std_dir, pkg.dir).starts_with("..") {
                continue
            }
            for f in pkg.files.iter() {
                let text = await text_of(f.path)
                var n = 0
                for line in text.split("\n").iter() {
                    n += 1
                    let Some(at) = line.find("//~", 0) else { continue }
                    for code in codes_after(trim_end(line.substring(at + 3, line.len())), false).iter() {
                        expected.push("${r.rel(f.path)}:${n} ${code}")
                    }
                }
            }
        }
        let actual = program.diagnostics.map(#{ d => "${r.rel(d.file)}:${d.span.line} ${d.code}" })
        r.same_set("${name}: diagnostics", actual, expected.clone())
        if !expected.is_empty() {
            continue
        }
        if let Some(out) = await run_program(r, tc, name, entry, LoadOptions {}) {
            await r.snapshot(entry, ".out", out)
        }
    }
}

fun trim_end(s: &str) -> string {
    var end = s.len()
    for end > 0 && is_space(s.byte_at(end - 1)) {
        end -= 1
    }
    s.substring(0, end).to_str()
}

async fun projects(r: &mut Report, tc: &Toolchain, test_dir: &str) {
    let dir = join(test_dir, "projects")
    var names = match await fs.list_dir(dir) {
        Ok(ns) => ns
        Err(_) => [] as Vec[string]
    }
    names.sort()
    for name in names.iter() {
        let path = join(dir, name)
        if !await is_dir(path) || !(await fs.exists(join(path, "main.ms")) || await fs.exists(join(path, "mod.ms"))) {
            continue
        }
        let p = await open_project(tc, path)
        if name == "script_in_eval" {
            let failed = p.config.is_none() && p.errors.join("\n").contains("E_SCRIPT_IN_EVAL")
            if failed { r.ok() } else { r.fail("projects/script_in_eval: evaluating fails with E_SCRIPT_IN_EVAL", p.errors.join("\n")) }
            continue
        }
        var problems = p.diagnostics.map(#{ d => "${d.code} ${d.message}" })
        problems.extend(p.errors.clone())
        r.none("projects/${name}: opens", problems)
        if let Some(c) = &p.config {
            await r.snapshot(join(path, "config.ms"), ".json", "${config_json(c)}\n")
        }
        let Some(out) = await run_program(r, tc, "projects/${name}", p.main_dir, program_options(p)) else { continue }
        var lines = if out == "\n" { [] as Vec[string] } else { output_lines(out) }
        // task scripts: run as `ms run <name> -- --verbose` would, their lines prefixed by the name
        if let Some(c) = &p.config {
            for script, kind in c.scripts {
                let is_task = match kind {
                    Task => true
                    _ => false
                }
                if is_task {
                    let Some(js) = await task_command_js(tc, p.mod_file ?? "", script) else {
                        r.fail("projects/${name}: task ${script} compiles", "")
                        continue
                    }
                    let res = await runtime.run_module_captured(js, ["--verbose"])
                    for l in output_lines(res.stdout).iter() {
                        lines.push("[${script}] ${l}")
                    }
                }
            }
        }
        await r.snapshot(join(path, "run.ms"), ".out", "${lines.join("\n")}\n")
    }
}

async fun ms_test(r: &mut Report, tc: &Toolchain, test_dir: &str) {
    let quiet = TestOptions { capture: true }
    let std = await run_tests(tc, tc.std_dir, quiet)
    if std.packages >= 2 && std.failed == 0 && std.broken == 0 && std.diagnostics.is_empty() { r.ok() } else { r.fail("ms test std", std.lines.join("\n")) }
    let pre = await run_tests(tc, join(test_dir, "prelude"), quiet)
    if pre.packages == 1 && pre.failed == 0 && pre.broken == 0 && pre.diagnostics.is_empty() { r.ok() } else { r.fail("ms test test/prelude", pre.lines.join("\n")) }
    let proj = await run_tests(tc, join(test_dir, "projects"), quiet)
    if proj.packages == 2 && proj.failed == 0 && proj.broken == 0 { r.ok() } else { r.fail("ms test test/projects", proj.lines.join("\n")) }
    let failing_dir = join(test_dir, "testing/failing")
    let failing = await run_tests(tc, failing_dir, quiet)
    if failing.packages == 1 && failing.failed == 3 && failing.broken == 0 { r.ok() } else { r.fail("ms test test/testing/failing: 3 failures", failing.lines.join("\n")) }
    let report = failing.lines.map(#{ l => normalize_ms(l) })
    await r.snapshot(join(failing_dir, "report.ms"), ".out", "${report.join("\n")}\n")
    let filtered = await run_tests(tc, failing_dir, TestOptions { capture: true, filter: Some("passes") })
    let shown = filtered.lines.filter(#{ l => l.starts_with("ok ") || l.starts_with("FAIL ") }).len()
    if filtered.failed == 0 && shown == 1 { r.ok() } else { r.fail("ms test --run passes", filtered.lines.join("\n")) }
}

/// `(12 ms)` → `(… ms)`: timings change from run to run.
fun normalize_ms(l: &str) -> string {
    let Some(open) = l.find("(", 0) else { return l.to_str() }
    let Some(close) = l.find(" ms)", open) else { return l.to_str() }
    let digits = l.substring(open + 1, close)
    if digits.is_empty() || !digits.bytes().all(#{ b => b >= 48 && b <= 57 }) {
        return l.to_str()
    }
    "${l.substring(0, open)}(… ms)${l.substring(close + 4, l.len())}"
}

async fun formatting(r: &mut Report, tc: &Toolchain, test_dir: &str) {
    var files = await files_in(tc.std_dir)
    let errors = join(test_dir, "errors")
    for f in (await files_in(test_dir)).iter() {
        if !relative(errors, f).starts_with("..") {
            continue
        }
        files.push(f.clone())
    }
    let defaults = fmt.FmtOptions {}
    for file in files.iter() {
        let src = await text_of(file)
        let before = parser.parse(utf8.encode(src))
        if !before.diagnostics.is_empty() {
            continue
        }
        let name = "fmt round trip: ${if relative(tc.std_dir, file).starts_with("..") { r.rel(file) } else { "std/${relative(tc.std_dir, file)}" }}"
        let Some(out) = fmt.format(src, &defaults).text else {
            r.fail(name, "not formatted")
            continue
        }
        let after = parser.parse(utf8.encode(out))
        if !after.diagnostics.is_empty() {
            r.fail(name, "the output doesn't parse: ${diag_lines(after.diagnostics).join("\n")}")
            continue
        }
        r.same("${name}: same AST", ast.print_file_loose(after.file), ast.print_file_loose(before.file))
        let c1 = before.lexed.trivia.map(#{ t => t.text.trim().to_str() })
        let c2 = after.lexed.trivia.map(#{ t => t.text.trim().to_str() })
        r.same("${name}: every comment, in order", c2.join("\n"), c1.join("\n"))
        let again = fmt.format(out, &defaults).text ?? ""
        r.same("${name}: idempotent", again, out)
    }
    for file in (await files_in(join(test_dir, "fmt"))).iter() {
        let src = await text_of(file)
        await r.snapshot(file, ".fmt", fmt.format(src, &defaults).text ?? "")
    }
}

/// Stage 1 checks cleanly and its unit tests pass.
async fun itself(r: &mut Report, tc: &Toolchain, root: &str) {
    let src = join(root, "src")
    match await load_program(src, tc.std_dir, LoadOptions { app_root: Some(src.clone()) }) {
        Ok(p) => r.none("stage 1 (src/) checks cleanly", p.diagnostics.map(#{ d => "${relative(root, d.file)}:${d.span.line} ${d.code} ${d.message}" }))
        Err(e) => r.fail("stage 1 (src/) checks cleanly", e)
    }
    let t = await run_tests(tc, src, TestOptions { capture: true })
    if t.failed == 0 && t.broken == 0 && t.packages > 0 { r.ok() } else { r.fail("stage 1's unit tests pass", t.lines.join("\n")) }
}
