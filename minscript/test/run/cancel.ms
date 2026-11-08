// Cancelling tasks (spec §9.6): a cancelled task stops at its next `await` with a `Cancelled` panic,
// which `recover` can catch; a task that loses a `select` is cancelled.
package main

import "std.time"

async fun ticker(count: Ref[int]) {
    for {
        await time.sleep(2)
        count.update(#{ n => n += 1 })
    }
}

async fun guarded() -> string {
    let r = recover {
        await time.sleep(1000)
        "finished"
    }
    match r {
        Ok(s) => s
        Err(p) => "caught ${p.kind}"
    }
}

async fun main() {
    let count = Ref(0)
    let t = ticker(count)
    await time.sleep(20)
    t.cancel()
    let seen = count.get()
    await time.sleep(20)
    log.println("a cancelled loop stops: ${count.get() == seen && seen > 0}")

    let g = guarded()
    await time.sleep(2)
    g.cancel()
    log.println("recover sees it: ${await g}")

    let slow = guarded()
    select {
        _ = slow => log.println("the slow task won")
        time.after(2) => log.println("the timeout won")
    }
    log.println("the loser was cancelled: ${await slow}")

    let t2 = ticker(count)
    t2.cancel()
    let r = recover { await t2 }
    match r {
        Ok(_) => log.println("awaiting a cancelled task: no panic?")
        Err(p) => log.println("awaiting a cancelled task: ${p.kind}")
    }
}
