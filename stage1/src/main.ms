// stage1: the MinScript compiler, written in MinScript. Each command prints what stage 0's command of
// the same name prints (dumps on stdout, diagnostics on stderr), for the differential test.
//   lex <file.ms>…                          the token dump
//   parse <file.ms>…                        the AST dump
//   resolve --prelude <prelude.ms> <file.ms>…   the resolution dump (each file is its own package)
//   types --prelude <prelude.ms> <file.ms>…     the checker dump (each file is its own package)
//   ownership --prelude <prelude.ms> <file.ms>… the ownership diagnostics (each file is its own package)
//   hir --prelude <prelude.ms> <file.ms>…       the HIR dump (each file is its own package)
// Whole programs (the entry and every package it imports, loaded from `--std` and the entry's folder):
//   check --std <std dir> <path>…               type-check and ownership-check, as `ms check`
//   js --std <std dir> [--runtime <url>] <path>  the generated JavaScript, as `ms js`
//   run --std <std dir> [--runtime <url>] <path> [-- args…]   compile and run, as `ms run`
// The runtime the generated module imports is stage 0's (`<std>/../src/js/runtime.ts` by default).
package main

import "app.lexer"
import "app.parser"
import "app.ast"
import "app.resolve"
import "app.check"
import "app.ownership"
import "app.hir"
import "app.loader"
import "app.js"
import "std.env"
import "std.fs"
import "std.io"
import "std.runtime"

async fun main() {
    var args = env.args()
    if !args.is_empty() && (args[0] == "check" || args[0] == "js" || args[0] == "run") {
        let code = await program_command(args[0], args.skip(1))
        if code != 0 {
            runtime.exit(code)
        }
        return
    }
    if args.is_empty() || !(args[0] == "lex" || args[0] == "parse" || args[0] == "resolve" || args[0] == "types" || args[0] == "ownership" || args[0] == "hir") {
        io.eprintln("usage: ms run stage1 -- lex|parse <file.ms>…  |  resolve|types|ownership|hir --prelude <prelude.ms> <file.ms>…")
        return
    }
    let command = args[0].clone()
    var files = args.skip(1)
    var prelude: resolve.Resolution? = None
    var prelude_file: ast.File? = None
    var first_id = 0
    if command == "resolve" || command == "types" || command == "ownership" || command == "hir" {
        if files.len() < 2 || files[0] != "--prelude" {
            io.eprintln("${command} needs `--prelude <path to std/prelude.ms>`")
            return
        }
        let bytes = await fs.read_file(files[1]) or e => {
            io.eprintln("${e}")
            return
        }
        let parsed = parser.parse(bytes)
        prelude = Some(resolve.resolve_package([parsed.file], None, resolve.ResolveOptions { std: true, package_name: "std" }))
        first_id = parsed.next_id
        prelude_file = Some(parsed.file)
        files = files.skip(2)
    }
    for file in files.iter() {
        let bytes = await fs.read_file(file) or e => {
            io.eprintln("${e}")
            return
        }
        if files.len() > 1 {
            io.println("== ${file}")
        }
        if command == "lex" {
            let res = lexer.lex(bytes)
            io.print(lexer.dump(res))
            report(file, res.diagnostics)
        } else if command == "parse" {
            let res = parser.parse(bytes)
            io.print(ast.print_file(res.file))
            report(file, res.diagnostics)
        } else if command == "resolve" {
            let parsed = parser.parse_from(bytes, first_id)
            let res = resolve.resolve_package([parsed.file], prelude, resolve.ResolveOptions {})
            io.print(resolve.dump_resolution(res))
            var all = parsed.diagnostics.clone()
            all.extend(res.diagnostics.clone())
            report(file, all)
        } else {
            let parsed = parser.parse_from(bytes, first_id)
            let res = resolve.resolve_package([parsed.file], prelude, resolve.ResolveOptions {})
            let Some(pf) = &prelude_file else { return }
            let Some(pr) = &prelude else { return }
            let checked = check.check_package([parsed.file], res, pf, pr)
            var all = parsed.diagnostics.clone()
            all.extend(res.diagnostics.clone())
            all.extend(checked.diagnostics.clone())
            if command == "types" {
                io.print(check.dump_types(res, checked))
            } else if command == "hir" {
                let program = hir.lower_package([parsed.file], res, checked, pf, pr)
                io.print(hir.dump_hir(program, checked.vars, res.symbols))
            } else {
                let owned = ownership.check_ownership([parsed.file], res, checked)
                io.print(ownership.dump_ownership(owned))
                all.extend(owned)
            }
            report(file, all)
        }
    }
}

/// Diagnostics on stderr, as stage 0 prints them.
fun report(file: &str, diagnostics: &Vec[lexer.Diagnostic]) {
    for d in diagnostics.iter() {
        io.eprintln("${file}:${d.span.line}:${d.span.col}: error ${d.code}: ${d.message}")
    }
}

/// A path as stage 0 shows it: relative to the current folder when it is inside it.
fun show_path(p: &str) -> string {
    let r = loader.relative(env.cwd(), p)
    if r.is_empty() { "." } else if r.starts_with("..") { p.to_str() } else { r }
}

fun print_diagnostics(ds: &Vec[loader.FileDiagnostic]) {
    for d in ds.iter() {
        io.eprintln("${show_path(d.file)}:${d.span.line}:${d.span.col}: error ${d.code}: ${d.message}")
    }
}

/// `check`, `js` and `run`: whole programs. Returns the exit code.
async fun program_command(command: &str, argv: Vec[string]) -> int {
    var std_dir = ""
    var runtime_url = ""
    var paths = [] as Vec[string]
    var program_args = [] as Vec[string]
    var i = 0
    for i < argv.len() {
        if argv[i] == "--" {
            program_args = argv.skip(i + 1)
            break
        }
        if argv[i] == "--std" && i + 1 < argv.len() {
            std_dir = argv[i + 1].clone()
            i += 2
            continue
        }
        if argv[i] == "--runtime" && i + 1 < argv.len() {
            runtime_url = argv[i + 1].clone()
            i += 2
            continue
        }
        paths.push(argv[i].clone())
        i += 1
    }
    if std_dir.is_empty() {
        io.eprintln("${command} needs `--std <path to the std folder>`")
        return 2
    }
    if runtime_url.is_empty() {
        runtime_url = "file://${loader.resolve_from(env.cwd(), "${std_dir}/../src/js/runtime.ts")}"
    }
    if command == "js" || command == "run" {
        let Some(path) = paths.get(0) else {
            io.eprintln("${command} needs a file or folder")
            return 2
        }
        let loaded = await loader.load_program(path, std_dir)
        let program = loaded or e => {
            io.eprintln(e)
            return 1
        }
        print_diagnostics(program.diagnostics)
        if !program.diagnostics.is_empty() {
            return 1
        }
        var lowered = loader.lower_program(program)
        hir.compute_witnesses(lowered)
        let code = js.emit_js(lowered, program.syms(), program.vars(), runtime_url, "main")
        if command == "js" {
            io.print(code)
            return 0
        }
        return await runtime.run_module(code, program_args)
    }
    var failed = false
    for path in (if paths.is_empty() { ["."] as Vec[string] } else { paths }).iter() {
        let loaded = await loader.load_program(path, std_dir)
        let program = loaded or e => {
            io.eprintln(e)
            return 1
        }
        print_diagnostics(program.diagnostics)
        if !program.diagnostics.is_empty() {
            failed = true
            continue
        }
        let n = program.order.len()
        io.println("${path}: ok (${n} package${if n == 1 { "" } else { "s" }}, ${program.file_count()} files)")
    }
    if failed { 1 } else { 0 }
}
