// `ms run samples/compiler -- lex <file.ms>...` prints, for each file, `== <path>`, the token dump
// (the format of `ms lex`) and each diagnostic as `! <start> <end> <CODE> <message>`: the format
// test/compiler_sample.test.ts compares with the TypeScript lexer. `parse` prints `== <path>`, the
// AST dump (the format of `ms parse`) and the lexer's and parser's diagnostics the same way.
package main

import "std.env"
import "std.fs"
import "std.io"
import "std.runtime"
import "app.syntax"

fn usage() -> never {
    io.eprintln("usage: ms run samples/compiler -- lex|parse <file.ms>...")
    runtime.exit(2)
}

async fn main() {
    args := env.args()
    if args.len() < 2 { usage() }
    cmd := args[0]
    for i in 1..args.len() {
        path := args[i]
        let text = await fs.read_text(path) or e => {
            io.eprintln("error: ${e}")
            runtime.exit(1)
        }
        match cmd {
            "lex" => {
                lexed := syntax.lex(text)
                io.print("== ${path}\n${syntax.dump_tokens(text, lexed.tokens)}")
                for d in lexed.diagnostics {
                    io.println("! ${d.start} ${d.end} ${d.code} ${d.message}")
                }
            }
            "parse" => {
                parsed := syntax.parse(text)
                io.print("== ${path}\n${syntax.dump_file(parsed.file)}")
                for d in parsed.diagnostics {
                    io.println("! ${d.start} ${d.end} ${d.code} ${d.message}")
                }
            }
            _ => usage()
        }
    }
}
