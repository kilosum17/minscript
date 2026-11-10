// L_TASK_SEES_SNAPSHOT (§10.3): a closure handed to a detached task captured a copy of a `var` the
// spawner writes afterwards.
package main

import "std.time"

async fn later(f: () -> int) -> int {
    await time.sleep(1)
    f()
}

async fn main() {
    // fires: the task's closure sees `count` as it was when it was created
    var count = 1
    p := later(#{ count })                       //~ L_TASK_SEES_SNAPSHOT
    count += 1
    log.println(await p, count)

    // quiet: awaited in its statement
    var n = 1
    log.println(await later(#{ n }))
    n += 1

    // quiet: a `shared var` is the same cell in the task
    shared var live = 1
    q := later(#{ live })
    live += 1
    log.println(await q)

    // quiet: not written afterwards
    var done = 5
    r := later(#{ done })
    log.println(await r, done)
}
