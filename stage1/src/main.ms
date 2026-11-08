// stage1: the MinScript compiler, written in MinScript. For now: `lex <file.ms>…` prints the token
// dump (the same text as stage 0's `ms lex`).
package main

import "app.lexer"
import "std.env"
import "std.fs"
import "std.io"

async fun main() {
    let args = env.args()
    if args.len() < 2 || args[0] != "lex" {
        io.eprintln("usage: ms run stage1 -- lex <file.ms>…")
        return
    }
    let files = args.skip(1)
    for file in files.iter() {
        let bytes = await fs.read_file(file) or e => {
            io.eprintln("${e}")
            return
        }
        if files.len() > 1 {
            io.println("== ${file}")
        }
        let res = lexer.lex(bytes)
        io.print(lexer.dump(res))
    }
}
