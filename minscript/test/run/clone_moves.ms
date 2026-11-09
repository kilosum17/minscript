package main

// Clones at last use (spec §14.1): a moved clone behaves like a copy, because nothing reads the
// source again; wherever the source is still alive, the clone stays a real copy.
type Doc = { lines: Vec[string] }

fun build() -> Doc { Doc { lines: ["a", "b"] } }

fun main() {
    let a = build()
    var moved = a.clone()                        // a move: `a` is dead
    moved.lines.push("c")
    log.println(moved.lines.len())

    let e = build()
    var copy = e.clone()                         // a copy: `e` is read below
    copy.lines.push("x")
    log.println(e.lines.len(), copy.lines.len())

    let t = build()
    let view = t.lines.get(0) ?? ""
    var other = t.clone()
    other.lines.clear()
    log.println(view, other.lines.len())

    let h = build()
    for i in 0..2 {
        var each = h.clone()                     // a copy per iteration
        each.lines.push("${i}")
        log.println(each.lines.len(), h.lines.len())
    }
}
