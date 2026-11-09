package main

import "shared"

// Another file of the main package: `main` calls `greet` without an import.
fn greet(who: str) -> str {
    let banner: str = shared.banner()
    "${banner} hello, ${who}!"
}
