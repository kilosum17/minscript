// L_SELF_WAIT (§11.3): `for await` over a subscription whose topic this task closes after the loop.
package main

async fn drain(q: Queue[int]) -> int {
    var sum = 0
    var sub = q.subscribe()
    for await n in sub { sum += n }
    sum
}

async fn main() {
    // fires: the loop ends only when `t` closes, and this task closes it after the loop
    t := Topic.new() as Topic[int]
    var sub = t.subscribe()
    for await n in sub {                         //~ L_SELF_WAIT
        log.println(n)
    }
    t.close()

    // quiet: closed before the loop
    u := Topic.new() as Topic[int]
    var sub2 = u.subscribe()
    u.publish(1)
    u.close()
    for await n in sub2 { log.println(n) }

    // quiet: another task iterates
    q := Queue.new() as Queue[int]
    p := drain(q)
    await q.publish(3)
    q.close()
    log.println(await p)
}
