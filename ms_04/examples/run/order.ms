package main

// Evaluation order on the JS back end: arguments run left to right even when a later one is a
// block / if / match (which compile to statements). Output must match order.out.
// v0.4: the v0.2 `Ref[Vec[str]]` trace is a plain `var` passed as `*Vec[str]` (spec §3).

fn note(trace: *Vec[str], s: str) -> int {
    trace.push(s)
    s.len()
}

fn three(a: int, b: int, c: int) -> int { a * 100 + b * 10 + c }

fn main() {
    var trace = [] as Vec[str]
    flag := true
    // Every argument writes `trace` through a nested call. They run one after another, so this is
    // not E_OVERLAPPING_ACCESS, which is about the place arguments of one call (spec §3).
    r := three(
        note(trace, "a"),
        if flag { note(trace, "bb") } else { 0 },
        match note(trace, "ccc") { 3 => { note(trace, "d"); 3 }, _ => 0 },
    )
    log.println(r, trace)

    // `&&` / `||` / `??` still short-circuit when their right side needs statements
    let none: int? = nil
    let x = false && { note(trace, "never"); true }
    let y = none ?? { note(trace, "fallback"); 9 }
    log.println(x, y, trace)
}
