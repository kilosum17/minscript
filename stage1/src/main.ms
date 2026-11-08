// stage1: the MinScript compiler, written in MinScript.
//   lex <file.ms>…     the token dump (the same text as stage 0's `ms lex`)
//   parse <file.ms>…   the AST dump on stdout, diagnostics on stderr (as stage 0's `ms parse`)
package main

import "app.lexer"
import "app.parser"
import "app.ast"
import "std.env"
import "std.fs"
import "std.io"

async fun main() {
    let args = env.args()
    if args.len() < 2 || (args[0] != "lex" && args[0] != "parse") {
        io.eprintln("usage: ms run stage1 -- lex|parse <file.ms>…")
        return
    }
    let command = args[0].clone()
    let files = args.skip(1)
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
        } else {
            let res = parser.parse(bytes)
            io.print(ast.print_file(res.file))
            report(file, res.diagnostics)
        }
    }
}

/// Diagnostics on stderr, as stage 0 prints them.
fun report(file: &str, diagnostics: &Vec[lexer.Diagnostic]) {
    for d in diagnostics.iter() {
        io.eprintln("${file}:${d.span.line}:${d.span.col}: error ${d.code}: ${d.message}")
    }
}
