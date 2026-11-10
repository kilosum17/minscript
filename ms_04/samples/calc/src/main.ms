// `ms run samples/calc` runs the two built-in programs; `ms run samples/calc a.calc b.calc` runs files.
// Every source is lexed, parsed, resolved and run in its own task.
package main

import "std.fs"
import "std.env"
import "app.syntax"
import "app.sema"
import "app.eval"

let GOOD = """
    # areas
    let width = 6
    let height = 7
    fn area(w, h) = w * h
    fn half(x) = x / 2
    print area(width, height)
    half(area(width, height)) - -1
    """

let BAD = """
    let unused = 1
    print missing + 2
    print (1 + 2
    fn f(x) = x * $
    """

type Source = r{ name: str, text: str }

async fn load(path: str) -> Source {
    // `??`, not `or`: `or`'s right side would be returned from `load` (§4.6)
    text := await fs.read_text(path) ?? "# can't read ${path}"
    r{ name: path, text }
}

/// "name:line: message". `line` counts newlines before the span: views only, no allocation
/// except the final string.
fn at(src: Source, span: syntax.Span, msg: str) -> str {
    line := src.text.substring(0, span.start).split("\n").len()
    "${src.name}:${line}: ${msg}"
}

/// The whole pipeline for one source. Async only so that sources run as separate tasks.
async fn run_source(src: Source) -> Vec[str] {
    let t(tokens, lex_errors) = syntax.lex(src.text)     // tokens keep `src.text`'s buffer alive
    let t(stmts, parse_errors) = syntax.parse(tokens)    // last use of `tokens`: a move
    resolved := sema.resolve(stmts)

    var lines = [] as Vec[str]
    for e in lex_errors { lines.push(at(src, e.span, e.msg)) }
    for e in parse_errors { lines.push(at(src, e.span, e.msg)) }
    for d in resolved.diags {
        kind := if d.warning { "warning" } else { "error" }
        lines.push(at(src, d.span, "${kind}: ${d.msg}"))
    }
    if lines.any(#{ !it.contains("warning:") }) { return lines }

    match eval.run(stmts) {
        Ok(out) => {
            lines.extend(out)
            lines
        }
        Err(e) => {
            lines.push("${src.name}: runtime error: ${e}")
            lines
        }
    }
}

async fn main() {
    paths := env.args()
    var sources = [] as Vec[Source]
    if paths.is_empty() {
        sources.push(r{ name: "good", text: GOOD })
        sources.push(r{ name: "bad", text: BAD })
    } else {
        // `it` is a view of `paths`, an immutable binding: the stored promises may share it, so
        // they need no same-statement await (spec §11.2)
        sources = await Promise.all(paths.map(#{ load(it) }))
    }

    reports := await Promise.all(sources.map(#{ run_source(it) }))
    for report, i in reports {
        log.println("== ${sources[i].name}")
        for line in report { log.println(line) }
    }
}
