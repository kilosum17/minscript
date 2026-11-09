package main

import "std.runtime"

// `runtime.exit` ends the program; `recover` doesn't catch it (it isn't a panic).
fun main() {
    log.println("before")
    let r = recover { runtime.exit(0) }
    log.println("after: not printed")
}
