// Value semantics on the JS back end: Copy records and tuples are copies (never shared); tuples
// print as tuples; floats keep `.0` inside collections; panics know where they happened.
// v0.4: every value has these semantics now (spec §2), not only `Copy` ones.
package main

// v0.2 `mut p: T` is removed: a parameter may be redeclared as a local `var` copy (spec §3).
fn bump(p: r{ x: int, y: int }) -> int {
    var p = p
    p.x += 100
    p.x
}

fn main() {
    var a = r{ x: 1, y: 2 }
    var b = a
    b.x = 50
    let c = a
    a.y = 9
    log.println("copies:", a, b, c)
    log.println("local copy:", bump(a), a)
    var pair = t(1, 2)
    var other = pair
    other.0 = 7
    log.println("tuples:", pair, other)
    var list = [r{ x: 1, y: 1 }]
    var first = list[0]
    first.x = 5
    log.println("from a Vec:", list, first)

    let xs = [1.0, 2.5]
    let o: f64? = Some(2.0)
    log.println("floats:", xs, o, [[3.0]], "${xs}")

    let none: int? = None
    let caught = recover { none.unwrap() }
    if let Err(p) = caught { log.println("unwrap panics at the caller: ${p.file.ends_with("values.ms")} line ${p.line}") }
}
