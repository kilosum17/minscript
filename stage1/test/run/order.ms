package main

// Evaluation order on the JS back end: arguments run left to right even when a later one is a
// block / if / match (which compile to statements). Output must match order.out.

fun note(trace: Ref[Vec[string]], s: string) -> int {
    trace.update(#{ t => t.push(s) })
    s.len()
}

fun three(a: int, b: int, c: int) -> int { a * 100 + b * 10 + c }

fun main() {
    let trace = Ref([] as Vec[string])
    let flag = true
    let r = three(
        note(trace, "a"),
        if flag { note(trace, "bb") } else { 0 },
        match note(trace, "ccc") { 3 => { note(trace, "d"); 3 }, _ => 0 },
    )
    log.println(r, trace.get())

    // `&&` / `||` / `??` still short-circuit when their right side needs statements
    let none: int? = nil
    let x = false && { note(trace, "never"); true }
    let y = none ?? { note(trace, "fallback"); 9 }
    log.println(x, y, trace.get())
}
