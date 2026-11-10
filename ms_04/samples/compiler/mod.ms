// compiler: the MinScript front end written in MinScript (v0.4), grown as a sample before it
// becomes the self-hosted compiler (spec §21 step 11). It reproduces the TypeScript compiler's
// output exactly, so the two can be compared on the whole corpus:
//   ms run samples/compiler -- lex <file.ms>      the `.tokens` dump (same as `ms lex`)
//   ms run samples/compiler -- parse <file.ms>    the `.ast` dump (same as `ms parse`)
package mod

import "build.*"

pub fn config() -> Config {
    Config {
        name: "compiler"
        version: "0.1.0"
        scripts: m{
            "test": sh("ms test .")
        }
    }
}
