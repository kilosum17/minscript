package main

// Runs on the JS back end; the output must match basics.out.

type Point { x: int, y: int }
type Account { owner: str, balance: i64, tags: Vec[str] = [], note: str? }

union Shape {
    Circle { r: f64 }
    Rect(f64, f64)
    Empty

    fn area(this) -> f64 {
        match this {
            Circle { r } => 3.0 * r * r
            Rect(w, h) => w * h
            Empty => 0.0
        }
    }
}

fn fib(n: int) -> int {
    if n < 2 { return n }
    fib(n - 1) + fib(n - 2)
}

fn classify(n: int) -> str {
    match n {
        0 => "zero"
        1..=9 => "small"
        x if x < 0 => "negative"
        _ => "big"
    }
}

fn parse_all(items: Vec[str]) -> Result[int, str] {
    var total = 0
    for s in items {
        total += s.to_int()?
    }
    Ok(total)
}

fn first_even(items: Vec[int]) -> int? {
    for n in items {
        if n % 2 == 0 { return Some(n) }
    }
    None
}

fn bump(n: *int) { n += 1 }                    // writes [n]

fn main() {
    // numbers
    log.println(7 / 2, 7 % 3, -7 / 2, 2.5 * 2.0, 1 + 2 * 3)
    let big: i64 = 9_000_000_000
    let small: i32 = 5
    let sum = big + small                       // i32 widens to i64
    log.println("i64:", sum, sum / 2)
    log.println("fib(15) =", fib(15))

    // strings
    let name = "MinScript"
    log.println("hello ${name}, ${name.len()} chars, upper ${name.to_upper()}")
    var text = "a"
    text += "b"
    log.println(text + "c", " x ".trim(), "a,b,c".split(","))

    // structs, defaults, to_str, equality
    let p = Point { x: 1, y: 2 }
    let q = Point { ...p, y: 5 }
    log.println(p, q, p == Point { x: 1, y: 2 }, p == q)
    let acct = Account { owner: "ann", balance: 10 }
    log.println(acct.tags.len(), acct.note ?? "no note")

    // unions and match
    let shapes: Vec[Shape] = [Circle { r: 1.0 }, Rect(2.0, 3.0), Empty]
    for sh in shapes { log.println(sh, sh.area()) }
    log.println(classify(0), classify(5), classify(-3), classify(42))

    // options and results
    log.println(parse_all(["1", "2", "3"]), parse_all(["1", "x"]))
    log.println(first_even([1, 3, 4, 6]), first_even([1, 3]))
    let maybe: int? = nil
    log.println(maybe ?? 7, Some(3).map(#{ it * 10 }))

    // loops with labels, continue and break values
    var hits = 0
    outer: for i in 0..5 {
        for j in 0..5 {
            if j > i { continue outer }
            if i == 4 { break outer }
            hits += 1
        }
    }
    let found = for {
        hits += 1
        if hits % 7 == 0 { break hits }
    }
    log.println("hits", hits, "found", found)

    // *T through a function (unmarked call site), collections
    var n = 1
    bump(n)
    bump(n)
    var m = m{ "a": 1 }
    m["b"] = 2
    m["a"] += 10
    let set = s{ 3, 1, 3 }
    log.println(n, m, m.get("zz"), set.len(), [1, 2, 3].fold(0, #{ a, x => a + x }))

    // recover
    let r = recover { [1, 2][5] }
    if let Err(e) = r { log.println("caught:", e.message) }
}
