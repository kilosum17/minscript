package main

// Clones at last use (spec §14.1): `x.clone()` is lowered to a move when nothing can observe the
// difference. `copy`, `g` and `lines` are moves; every clone in `keeps` stays a copy.

type Doc = {
    lines: Vec[string]
    title: string
}

type Counted = {
    n: int
    fun clone(&this) -> Counted { Counted { n: this.n + 1 } }
}

fun build() -> Doc { Doc { lines: ["a", "b"], title: "t" } }

fun moves() {
    let d = build()
    log.println(d.title)
    let copy = d.clone()                          // the last use of `d`
    for i in 0..2 {
        let f = build()
        let g = f.clone()                         // declared in the loop body
        log.println(i, g.title, copy.title)
    }
    let m = build()
    let lines = m.lines.clone()                   // a field of a binding nobody reads again
    log.println(lines.len())
}

fun keeps(p: Doc, s: Doc) {
    let e = build()
    let a = e.clone()                             // `e` is read afterwards
    log.println(e.title, a.title)
    let h = build()
    for _ in 0..2 {
        let k = h.clone()                         // a later iteration needs `h` again
        log.println(k.title)
    }
    let q = p.clone()                             // a parameter: the caller may share it
    let part = s.lines                            // not a fresh value: it is (part of) `s`
    let r = part.clone()
    let t = build()
    let view = t.title.trim()                     // a borrow of `t` is still live
    let u = t.clone()
    log.println(view, u.title, q.title, r.len())
    let w = build()
    let show = #{ w.title.len() }                 // a closure reads `w`
    let x = w.clone()
    log.println(show(), x.title)
    let y = build()
    log.println(y.title, y.clone().title)         // read in the same statement
    var z = build()
    let z2 = z.clone()
    z = build()                                   // reassigned
    log.println(z.title, z2.title)
    let c = Counted { n: 0 }
    let c2 = c.clone()                            // a user-defined clone: called
    log.println(c2.n)
    let o = build()
    match o.lines.len() {
        2 => {
            let o2 = o.clone()                    // inside a construct whose header reads `o`
            log.println(o2.title)
        }
        _ => {}
    }
}

fun main() {
    moves()
    keeps(build(), build())
}
