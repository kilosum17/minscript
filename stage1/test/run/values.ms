// Value semantics on the JS back end: Copy records and tuples are copies (never shared); tuples
// print as tuples; floats keep `.0` inside collections; panics know where they happened.
package main

fun bump(mut p: r{ x: int, y: int }) -> int {
    p.x += 100
    p.x
}

fun main() {
    var a = r{ x: 1, y: 2 }
    var b = a
    b.x = 50
    let c = a
    a.y = 9
    log.println("copies:", a, b, c)
    log.println("mut parameter:", bump(a), a)
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
