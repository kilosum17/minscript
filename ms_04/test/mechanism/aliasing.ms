// Pass 8 must never change what a program means: each case is one where a wrong move (or a
// skipped uniqueness check) would let a write through one binding show up in another.
package main

type Pair {
    items: Vec[int]
    n: int
}

// `v` moves into `w`, so `v` is owned: callers hand it over, sharing it when they use it again
fn grow(v: Vec[int]) -> int {
    var w = v
    w.push(1)
    w.len()
}

fn append(acc: Vec[int], x: int) -> Vec[int] {
    var out = acc
    out.push(x)
    out
}

// used as a value below: its parameter stays borrowed, so `var w = v` shares
fn shrink(v: Vec[int]) -> int {
    var w = v
    w.pop()
    w.len()
}

async fn later(v: Vec[int]) -> Vec[int] {
    var w = v
    w.push(7)
    w
}

async fn main() {
    // the accumulator moves through `append` on every iteration: written in place
    var acc = [] as Vec[int]
    for i in 0..3 { acc = append(acc, i) }
    log.println("loop accumulate: ${acc}")

    // `base` is used again on the next iteration: shared, so `c` copies
    base := [1]
    for i in 0..2 {
        var c = base
        c.push(i)
        log.println("per iteration: ${c}")
    }
    log.println("base kept: ${base}")

    // a move in one branch, a use in the other
    x := [1, 2]
    if acc.len() > 10 {
        log.println("never ${x}")
    } else {
        var y = x
        y.push(3)
        log.println("moved in a branch: ${y}")
    }

    // a use after the branch keeps it shared
    z := [5]
    if acc.len() > 0 {
        var y = z
        y.push(6)
    }
    log.println("used after the branch: ${z}")

    // what is live after `recover` can't move inside it
    r0 := [9]
    r := recover {
        var y = r0
        y.push(10)
        let k = y[5]
        k
    }
    log.println("recover: ${r.is_err()} ${r0}")

    // captured by a closure: never moved
    cap := [4]
    f := #{ cap.len() }
    var w = cap
    w.push(4)
    log.println("captured: ${f()} ${w.len()}")

    // an owned parameter: the caller shares what it uses again
    a := [1]
    log.println("owned param: ${grow(a)} ${a}")

    // a function used as a value keeps its parameters borrowed
    g := shrink
    b := [2, 2]
    log.println("as a value: ${g(b)} ${b}")

    // a struct built from a value that is read again in the same literal
    xs := [1, 2, 3]
    var p = Pair { items: xs, n: xs.len() }
    p.items.push(4)
    log.println("struct: ${p.items} ${xs}")

    // a fresh literal never shared is written in place; a view of an element is still a snapshot
    var fresh = [Pair { items: [], n: 0 }]
    let o = fresh.first()
    fresh[0].n = 5
    log.println("view result: ${o.map(#{ q => q.n }) ?? -1} ${fresh[0].n}")

    // an iterator taken before a push sees the old elements
    var nums = [1, 2]
    var walker = nums.iter()
    nums.push(3)
    var seen = 0
    for _ in walker { seen += 1 }
    log.println("iterator: ${seen} ${nums.len()}")

    // match bindings share their part of the subject
    opt := Some([8])
    match opt {
        Some(v) => {
            var m = v
            m.push(8)
            log.println("match: ${m} ${opt}")
        }
        None => {}
    }

    // an owned parameter of an async fn: the task gets its own value
    t := [6]
    log.println("async: ${await later(t)} ${t}")
}
