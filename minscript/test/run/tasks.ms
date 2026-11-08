package main

import "std.time"

// Inter-task communication on the JS back end (spec §9.6, §9.10); output must match tasks.out.

async fun worker(id: int, mut sub: Sub[int], results: Queue[string]) {
    for await job in sub {
        await results.publish("w${id}:${job * job}") or return
    }
}

async fun count_down(online: Signal[int]) {
    for i in 0..3 {
        await time.after(5)
        online.update(#{ n => n -= 1 })
    }
}

async fun main() {
    // Topic: every subscriber gets every message
    let room = Topic.new.[string]()
    var a = room.subscribe()
    var b = room.subscribe()
    room.publish("hi")
    room.publish("there")
    room.close()
    var got = [] as Vec[string]
    for await m in a { got.push("a:${m}") }
    for await m in b { got.push("b:${m}") }
    log.println(got)

    // Queue: each job reaches one worker
    let jobs = Queue.new.[int]()
    let results = Queue.new.[string]()
    worker(1, jobs.subscribe(), results).ignore()
    worker(2, jobs.subscribe(), results).ignore()
    for j in 1..=4 { await jobs.publish(j) or return }
    var out = results.subscribe()
    var squares = [] as Vec[int]
    for i in 0..4 {
        let Some(r) = await out.next() else { break }
        squares.push(r.split(":")[1].to_int() ?? 0)
    }
    squares.sort()
    log.println("squares", squares)

    // Promise.new: a one-shot answer
    let t(answer, resolver) = Promise.new.[int]()
    resolver.resolve(42)
    log.println("answer", await answer)

    // Signal + Watcher
    let online = Signal(3)
    var watch = online.watch()
    count_down(online).ignore()
    var seen = [] as Vec[int]
    for await n in watch {
        seen.push(n)
        if n == 0 { break }
    }
    log.println("online", seen)

    // select: a ready message wins over a timer; the losing wait gives nothing away
    let topic = Topic.new.[int]()
    var sub = topic.subscribe()
    topic.publish(7)
    let first = select {
        Some(v) = sub.next() => "message ${v}"
        time.after(1000) => "timeout"
    }
    let second = select {
        Some(v) = sub.next() => "message ${v}"
        time.after(10) => "timeout"
    }
    topic.publish(8)
    log.println(first, second, sub.try_next())

    // timeouts and recover across tasks
    let slow = time.after(50).timeout(5)
    log.println("timed out:", (await slow).is_err())
}
