// Integers on the JS back end (spec §9.5): overflow always panics; `as` wraps (from floats it
// saturates); shifts wrap and panic past the width; `wrapping_*` / `saturating_*` / `checked_*`.
package main

fun attempt(name: string, f: &() -> int) {
    let r = recover { f() }
    match r {
        Ok(v) => log.println("${name}: ${v}")
        Err(p) => log.println("${name}: ${p.kind}: ${p.message}")
    }
}

fun main() {
    let max: int = 2147483647
    attempt("int max + 1", #{ max + 1 })
    attempt("int * int", #{ 100000 * 100000 })
    attempt("min / -1", #{ (-2147483647 - 1) / -1 })
    attempt("divide by zero", #{ 1 / (max - max) })
    attempt("negate min", #{ -(-2147483647 - 1) })
    let small: u8 = 250
    attempt("u8 + 10", #{ (small + 10) as int })
    let zero: u32 = 0
    attempt("u32 0 - 1", #{ (zero - 1) as int })
    var counter = 2147483640
    attempt("+= past the max", #[&mut counter]{
        for {
            counter += 3
        }
    })

    let wide: int = 300
    let neg: int = -1
    let w2: int = 70000
    let f = 3.9
    log.println("casts:", wide as u8, neg as u8, w2 as i16, f as int, -f as int, 1e20 as i32, (0.0 / 0.0) as int)
    let big: i64 = 9223372036854775807
    log.println("i64:", recover { big + 1 }.is_err(), (big as u64) + 1, neg as u64, big as i32)

    let one: u8 = 1
    let none: u8 = 0
    log.println("bits:", one << 7, (one << 7) >> 3, !none, 1 << 30, recover { 1 << 40 }.is_err())

    log.println("explicit:", max.wrapping_add(1), max.saturating_add(5), max.checked_add(1).is_none(), small.saturating_add(10), small.wrapping_add(10), zero.checked_sub(1) ?? 99)
}
