// L_IMPLICIT_COPY (§9.1): a write that may copy a shared collection.
package main

type Doc { lines: Vec[str] }

fn build() -> Doc { Doc { lines: ["a"] } }

// fires: `copy` shares `d`, which is read again below
fn shared_then_written() {
    d := build()
    var copy = d
    copy.lines.push("x")                         //~ L_IMPLICIT_COPY
    log.println(d.lines.len(), copy.lines.len())
}

// fires: `c` holds the parameter, which the caller may still use (Appendix A.2)
fn with_line(base: Doc, s: str) -> Doc {
    var c = base
    c.lines.push(s)                              //~ L_IMPLICIT_COPY
    c
}

// quiet: the source is not used again, so the binding moves and the push writes in place
fn moved_then_written() {
    d := build()
    var mine = d
    mine.lines.push("x")
    log.println(mine.lines.len())
}

// quiet: only a non-collection field is written (copying the header is cheap)
type Point { x: int  y: int }
fn header_only() {
    p := Point { x: 1, y: 2 }
    var q = p
    q.x = 5
    log.println(p.x, q.x)
}

fn main() {
    shared_then_written()
    log.println(with_line(build(), "b").lines.len())
    moved_then_written()
    header_only()
}
