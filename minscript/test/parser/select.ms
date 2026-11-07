package parser_select

import "std.time"

async fun basic(jobs: Queue[Job], events: Topic[Event], config: Signal[Config]) {
    var job_sub = jobs.subscribe()
    var event_sub = events.subscribe()
    cfg_watch :== config.watch()

    for {
        select {
            Some(job) = job_sub.next() => process(job)              // pattern = promise => body
            Some(ev) = event_sub.next() => log.println("event: ${ev}")
            cfg = cfg_watch.next() => reload(cfg)                   // irrefutable binding
            time.after(5000) => log.println("idle for 5s")          // shorthand: no pattern
        }
    }
}

async fun block_arms(sub: Subscription[Msg]) {
    var s = sub
    select {
        Some(msg) = s.next() => {
            log.println(msg)
            handle(msg)
        }
        time.after(100) => {
            log.println("timeout")
        },                                                          // comma after a block arm is optional
    }
}

async fun with_else(q: Queue[Job]) {
    var sub = q.subscribe()
    select {                                                        // non-blocking: else runs if nothing is ready
        Some(job) = sub.next() => process(job)
        else => log.println("nothing ready")
    }
}

async fun as_expression(sub: Subscription[int]) -> string {
    var s = sub
    label := select {
        Some(n) = s.next() => "got ${n}"
        time.after(10) => "timed out"
    }
    label
}

async fun one_line(a: Subscription[int], b: Subscription[int]) {
    var x = a
    var y = b
    select { Some(n) = x.next() => log.println(n), Some(m) = y.next() => log.println(m) }
}

async fun loops_and_control(sub: Subscription[Cmd], stop: Signal[bool]) {
    var s = sub
    var stop_watch = stop.watch()
    outer: for {
        select {
            Some(cmd) = s.next() => match cmd {
                Quit => break outer                                 // break targets the enclosing loop
                Skip => continue
                Run(x) => run(x)
            }
            _ = stop_watch.next() => break
        }
    }
}

async fun task_promises() {
    fetch := fetch_user(1)                                          // already running
    let result = select {
        user = fetch => Some(user)
        time.after(2000) => {
            fetch.cancel()                                          // losing doesn't stop the task: cancel it explicitly
            None
        }
    }
}

async fun nested_patterns(sub: Subscription[Result[Order, string]]) {
    var s = sub
    select {
        Some(Ok(order)) = s.next() => ship(order)                  // Err or None disables the arm
        time.after(1000) => {}
    }
    // One arm per wait: two arms both calling `s.next()` would take two &mut borrows of `s`.
}
