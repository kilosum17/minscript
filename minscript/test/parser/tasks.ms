package parser_tasks

import "std.time"

type Job = {
    id: u64
    url: string
    reply: Resolver[Result[string, string]]?
}

// Topic: broadcast. WARNING: THIS FUNCTION HANGS. It parses fine, but it never finishes.
// `for await` ends only when `next()` returns None, i.e. once the topic is closed (or its last
// Topic handle is dropped) and drained. `room` is still alive here, and `room.close()` only runs
// after the loop, so after "hello" the task waits on itself forever. If no other task, timer or
// I/O can wake anything, the runtime panics with `Deadlock` (spec §9.10). The working version is
// `topics()` below, which consumes the messages in a separate task.
async fun topics_hang() {
    room := Topic.new.[string]()
    let big = Topic.with.[string](_{ buffer: 256, replay: 10 })

    var sub = room.subscribe()
    reached := room.publish("hello")                 // sync, never waits
    log.println("delivered to ${reached}")

    for await msg in sub {                           // gets "hello", then waits forever
        log.println(msg)
        lost := sub.missed()
        if lost > 0 { log.warn("missed ${lost}") }
    }

    let quick = sub.try_next() ?? "nothing"          // never reached
    room.close()                                     // never reached
}

// Topic: broadcast, with a separate task consuming the messages
async fun topics() {
    room := Topic.new.[string]()
    let big = Topic.with.[string](_{ buffer: 256, replay: 10 })

    // Subscribe BEFORE publishing: a Topic drops messages when nobody is subscribed.
    let reader = print_all(room.subscribe())         // the task starts right away and owns the subscription
    reached := room.publish("hello")                 // sync, never waits
    room.publish("world")
    log.println("delivered to ${reached}")

    room.close()                                     // the reader drains "hello" and "world", then sees None
    count := await reader
    log.println("reader got ${count} messages")
}

async fun print_all(mut sub: Subscription[string]) -> int {
    var count = 0
    for await msg in sub {                           // async iteration; ends after close + drain
        log.println(msg)
        lost := sub.missed()
        if lost > 0 { log.warn("missed ${lost}") }
        count += 1
    }
    quick := sub.try_next() ?? "nothing"             // None once closed and drained → "nothing"
    log.println(quick)
    count
}

// Queue: each message reaches one subscriber
async fun queues() {
    jobs := Queue.new.[Job]()
    let bounded = Queue.with.[Job](_{ capacity: 16 })

    for i in 0..4 {
        worker(i, jobs.subscribe()).ignore()
    }

    await jobs.publish(Job { id: 1, url: "a" }) or e => log.warn("queue closed")

    if let Err(e) = jobs.try_publish(Job { id: 2, url: "b" }) {
        match e {
            Full(job) => log.warn("full, dropping ${job.id}")
            Closed(job) => log.warn("closed, dropping ${job.id}")
        }
    }

    let res = await jobs.publish_timeout(Job { id: 3, url: "c" }, 500)
    if !res { log.warn("timed out waiting for space") }

    log.println("pending: ${jobs.len()}")
}

async fun worker(n: int, mut sub: Subscription[Job]) {
    for await job in sub {
        body := await fetch(job.url)
        if let Some(reply) = job.reply {
            reply.resolve(body)
        }
    }
}

// request/response with a one-shot promise
async fun request(jobs: Queue[Job]) -> Result[string, string] {
    let t(answer, resolver) = Promise.new.[Result[string, string]]()
    await jobs.publish(Job { id: 9, url: "x", reply: resolver }) or Err("queue closed")
    await answer
}

// Signal: shared state
async fun signals() {
    online := Signal(0)
    let theme = Signal("dark")

    online.set(5)
    online.update(#{ n => n += 1 })
    current := online.get()
    let doubled = online.read(#{ it * 2 })

    var watch = online.watch()
    for await n in watch {
        log.println("${n} online")
        if n == 0 { break }
    }
}

// readiness, timeouts, cancellation
async fun lifecycle() {
    let t(ready, resolver) = Promise.new.[void]()
    server := serve(resolver)
    await ready

    slow := fetch("http://slow")
    let res = await slow.timeout(1000)
    match res {
        Ok(body) => log.println(body)
        Err(_) => log.warn("too slow")
    }

    await time.after(50)
    server.cancel()
    log.println("server done: ${server.is_done()}")
}

async fun serve(ready: Resolver[void]) {
    ready.resolve()
    for {
        await time.after(1000)                       // cancellation takes effect at this await
    }
}

// conditional loop whose condition awaits (no `in`: not async iteration)
async fun poll() {
    for await has_more() {
        await process_next()
    }
}
