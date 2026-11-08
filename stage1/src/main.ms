// stage1: the MinScript compiler, written in MinScript. Each command prints what stage 0's command of
// the same name prints (dumps on stdout, diagnostics on stderr), for the differential test.
//   lex <file.ms>…                          the token dump
//   parse <file.ms>…                        the AST dump
//   resolve --prelude <prelude.ms> <file.ms>…   the resolution dump (each file is its own package)
//   types --prelude <prelude.ms> <file.ms>…     the checker dump (each file is its own package)
//   ownership --prelude <prelude.ms> <file.ms>… the ownership diagnostics (each file is its own package)
//   hir --prelude <prelude.ms> <file.ms>…       the HIR dump (each file is its own package)
// Programs and projects (src/project/; `--std <std dir>` names std, default `$MS_STD`; `--runtime <url>`
// the runtime the generated module imports, default stage 0's `<std>/../src/js/runtime.ts`):
//   run [<path>] [-- args…]      run a file, a folder or a project; `run` alone lists the scripts
//   run <script> [-- args…]      a script from mod.ms (also `<script>` as the command)
//   check [<path>…]              type-check and ownership-check, as `ms check`
//   test [<path>…] [--run <name>] [--reporter spec|dots]   as `ms test`
//   js <path>                    the generated JavaScript, as `ms js`
//   config [<path>]              the evaluated mod.ms as JSON, as `ms config`
package main

import "app.lexer"
import "app.parser"
import "app.ast"
import "app.resolve"
import "app.check"
import "app.ownership"
import "app.hir"
import "app.project"
import "std.env"
import "std.fs"
import "std.io"
import "std.runtime"

async fun main() {
    var args = env.args()
    if args.is_empty() {
        io.eprintln(USAGE)
        runtime.exit(2)
    }
    let per_file = args[0] == "lex" || args[0] == "parse" || args[0] == "resolve" || args[0] == "types" || args[0] == "ownership" || args[0] == "hir"
    if !per_file {
        let code = await program_command(args[0], args.skip(1))
        if code != 0 {
            runtime.exit(code)
        }
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

let USAGE = "usage: stage1 lex|parse <file.ms>…  |  resolve|types|ownership|hir --prelude <prelude.ms> <file.ms>…  |  run|js|check|config|test|<script> --std <std dir> …"

/// The commands on whole programs and projects (`--std <dir>` names std). Returns the exit code.
async fun program_command(command: &str, argv: Vec[string]) -> int {
    let options = project.toolchain_options(argv) or e => {
        io.eprintln("${command} ${e}")
        return 2
    }
    let t(tc, rest) = options
    if command == "run" || command == "js" || command == "config" {
        return await project.run_program_command(tc, command, rest)
    }
    if command == "check" {
        return await project.check_command(tc, rest)
    }
    if command == "test" {
        return await project.test_command(tc, rest)
    }
    // `stage1 dev`: a script of the project here
    if let Some(code) = await project.run_script_shorthand(tc, command, rest) {
        return code
    }
    io.eprintln("ms: unknown command `${command}`, and no script of that name in a mod.ms here")
    io.eprintln(USAGE)
    2
}
