package main

// v0.4 port of the v0.2 `Ref` snapshot test (spec §10): `Ref[T]` is gone, `shared var` replaces it.
// Reading a shared cell gives a snapshot (§10.1); writers never change a snapshot someone holds,
// because the write copies first (copy-on-write, §9.1). Output must match ref_snapshot.out.
fn main() {
    shared var tokens = ["a", "b"] as Vec[str]
    before := tokens                                     // a snapshot (a share of the buffer)
    tokens.push("c")                                     // `before` is still held: the push copies
    log.println(before.join(","), tokens.join(","))
    now := tokens
    tokens = ["z"]                                       // a replacement: `now` keeps its value
    log.println(now.join(","), tokens.join(","))

    // a snapshot taken inside a lock sees the value as it is then, and keeps it
    // `lock` is an expression: its value is the block's value (spec §10.1)
    n := lock tokens {
        tokens.push("y")
        mid := tokens                                    // a view of a shared cell: always a
        tokens.push("x")                                 //   counted share (spec §9.6)
        mid.len()
    }
    log.println(n, tokens.join(","))

    // a write while a snapshot is held doesn't change what the holder sees
    seen := lock tokens {
        v := tokens
        tokens.push("q")                                 // no relocking inside `lock` (spec §10.1)
        v.len()
    }
    log.println(seen, tokens.len())

    // an independent copy: no `.clone()`, a plain `var` (copy-on-write at the push)
    var mine = tokens
    mine.push("own")
    log.println(mine.len(), tokens.len())

    // a shared counter: each statement is its own critical section
    shared var count = 0
    for _ in 0..3 {
        count += 1                                       // one atomic add per statement (§10.2)
    }
    log.println(count)
}
