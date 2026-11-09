package main

// `Ref.get()` lends the current value without copying it, and writers never change a value that is
// lent: `update` copies it first, `set` replaces it (spec §9.9).
fun main() {
    let tokens = Ref(["a", "b"] as Vec[string])
    let before = tokens.get()
    tokens.update(#{ it.push("c") })                     // `before` is lent: the update copies
    log.println(before.join(","), tokens.get().join(","))
    let now = tokens.get()
    tokens.set(["z"])                                    // a replacement: `now` keeps its value
    log.println(now.join(","), tokens.get().join(","))

    // a borrow taken during an update sees the value as it is then, and keeps it
    n := tokens.update(#{ v =>
        v.push("y")
        let mid = tokens.get()
        v.push("x")
        mid.len()
    })
    log.println(n, tokens.get().join(","))

    // an update during a read doesn't change what the reader sees
    let seen = tokens.read(#{ v =>
        tokens.update(#{ it.push("q") })
        v.len()
    })
    log.println(seen, tokens.get().len())

    // an owned copy, when one is needed
    var mine = tokens.get().clone()
    mine.push("own")
    log.println(mine.len(), tokens.get().len())

    // unlent: updates change the value in place, and borrows read it for free
    let count = Ref(0)
    for _ in 0..3 {
        count.update(#{ it += 1 })
    }
    log.println(count.get())
}
