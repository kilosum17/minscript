// Cancelling tasks (spec §11.1): a cancelled task stops at its next `await` with a `Cancelled` panic,
// which `recover` can catch. A task that loses a `select` keeps running (spec §4.9), so it is cancelled
// explicitly.
// v0.4: the v0.2 `Ref[int]` counter is a `shared var` passed to a `*int` parameter (spec §10.1).
package main

import "std.time"

async fn ticker(count: *int) {                     // writes [count], awaits
    for {
        await time.sleep(2)
        count += 1
    }
}

async fn guarded() -> str {
    let r = recover {
        await time.sleep(1000)
        "finished"
    }
    match r {
        Ok(s) => s
        Err(p) => "caught ${p.kind}"
    }
}

async fn main() {
    shared var count = 0
    // A detached task may take a `shared` cell through `*T`: it keeps an alias (spec §10.1, §11.2).
    t := ticker(count)
    await time.sleep(20)
    t.cancel()
    seen := count                                   // a snapshot
    await time.sleep(20)
    log.println("a cancelled loop stops: ${count == seen && seen > 0}")

    g := guarded()
    await time.sleep(2)
    g.cancel()
    log.println("recover sees it: ${await g}")

    slow := guarded()
    select {
        _ = slow => log.println("the slow task won")
        time.after(2) => {
            log.println("the timeout won")
            slow.cancel()
        }
    }
    log.println("the loser was cancelled: ${await slow}")

    t2 := ticker(count)
    t2.cancel()
    let r = recover { await t2 }
    match r {
        Ok(_) => log.println("awaiting a cancelled task: no panic?")
        Err(p) => log.println("awaiting a cancelled task: ${p.kind}")
    }
}
