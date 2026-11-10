package main

// v0.4: no `.clone()` (spec §9.1, §9.1). Assigning to a `var` is a move at the source's last use and
// a share otherwise; the first write to a shared buffer copies it (copy-on-write). The output is
// the same as v0.2's explicit clones.
type Doc { lines: Vec[str] }

fn build() -> Doc { Doc { lines: ["a", "b"] } }

fn main() {
    a := build()
    var moved = a                                // a move: `a` is dead, the push writes in place
    moved.lines.push("c")
    log.println(moved.lines.len())

    e := build()
    var copy = e                                 // a share: `e` is read below, so the push copies
    copy.lines.push("x")                         // L_IMPLICIT_COPY
    log.println(e.lines.len(), copy.lines.len())

    t := build()
    view := t.lines.get(0) ?? ""                 // a str: immutable, its own buffer
    var other = t
    other.lines.clear()                          // `t` moved: written in place; `view` is unaffected
    log.println(view, other.lines.len())

    h := build()
    for i in 0..2 {
        var each = h                             // a share per iteration, copied at the push
        each.lines.push("${i}")
        log.println(each.lines.len(), h.lines.len())
    }
}
