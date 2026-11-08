// stage1: the MinScript compiler, written in MinScript. Each command prints what stage 0's command of
// the same name prints (dumps on stdout, diagnostics on stderr), for the differential test.
//   lex <file.ms>…                          the token dump
//   parse <file.ms>…                        the AST dump
//   resolve --prelude <prelude.ms> <file.ms>…   the resolution dump (each file is its own package)
package main

import "app.lexer"
import "app.parser"
import "app.ast"
import "app.resolve"
import "std.env"
import "std.fs"
import "std.io"

async fun main() {
    var args = env.args()
    if args.is_empty() || !(args[0] == "lex" || args[0] == "parse" || args[0] == "resolve") {
        io.eprintln("usage: ms run stage1 -- lex|parse <file.ms>…  |  resolve --prelude <prelude.ms> <file.ms>…")
        return
    }
    let command = args[0].clone()
    var files = args.skip(1)
    var prelude: resolve.Resolution? = None
    var first_id = 0
    if command == "resolve" {
        if files.len() < 2 || files[0] != "--prelude" {
            io.eprintln("resolve needs `--prelude <path to std/prelude.ms>`")
            return
        }
        let bytes = await fs.read_file(files[1]) or e => {
            io.eprintln("${e}")
            return
        }
        let parsed = parser.parse(bytes)
        prelude = Some(resolve.resolve_package([parsed.file], None, resolve.ResolveOptions { std: true, package_name: "std" }))
        first_id = parsed.next_id
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
        } else {
            let parsed = parser.parse_from(bytes, first_id)
            let res = resolve.resolve_package([parsed.file], prelude, resolve.ResolveOptions {})
            io.print(resolve.dump_resolution(res))
            var all = parsed.diagnostics.clone()
            all.extend(res.diagnostics.clone())
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
