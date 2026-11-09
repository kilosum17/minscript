package main

import "shared"

// Another file of the main package: `main` calls `greet` without an import.
fun greet(who: string) -> string {
    let banner: string = shared.banner()
    "${banner} hello, ${who}!"
}
