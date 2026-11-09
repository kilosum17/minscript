package parser_shared_state

// Map index assignment, Ref.read / Ref.update returning values, implicit handle clones
// (spec §7.2 Map indexing, §9.1 handles, §9.9 Ref).

type User = { name: string, visits: int = 0 }

fun maps() {
    var ages = m{ "ann": 31 }
    ages["bob"] = 25                                  // missing: inserts
    ages["ann"] = 32                                  // present: overwrites
    ages["ann"] += 1                                  // reads first: panics if the key is missing

    let carl = ages.get("carl") ?? 0                  // safe read
    counts := m{} as Map[string, int]
    for word in ["a", "b", "a"] {
        counts[word] = (counts.get(word) ?? 0) + 1
    }
}

fun refs() {
    users := Ref(m{ "ann": User { name: "Ann" } })
    let counter = Ref(0)

    n := users.read(#{ it.len() })                    // borrow inside the lock, no copy
    let name = users.read(#{ it.get("ann")?.name.to_str() })   // owned value out of the closure
    id := counter.update(#{ c => c += 1; c })         // change + answer under one lock
    users.update(#{ it["bob"] = User { name: "Bob" } })        // R = void
    let snapshot = counter.get()                      // clone of the whole value

    bump(counter)                                     // Ref is a handle: cloned, not moved
    bump(counter)
    log.println("counter = ${counter.get()}")
}

fun bump(c: Ref[int]) {
    c.update(#{ n => n += 1 })
}

async fun handles_in_closures() {
    hits := Ref(0)
    let room = Topic.new.[string]()
    let on_msg = #[hits, room]{ msg =>                // captured by value: each a handle clone
        hits.update(#{ n => n += 1 })
        room.publish(msg)
    }
    on_msg("hello")
    log.println("hits: ${hits.get()}, subscribers: ${room.subscribers()}")   // still usable
}
