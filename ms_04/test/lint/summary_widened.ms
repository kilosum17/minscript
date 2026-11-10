//! effects-cap: 1
// L_SUMMARY_WIDENED (§15.1): a recursive component that didn't converge within pass 6's cap. The
// cap is normally 32; this file lowers it to 1 (the `effects-cap` header) so a two-function ring
// that needs a second round hits it.
package main

type S {
    a: Vec[int]
    b: Vec[int]
}

// fires (at the member that hit the cap): `ping` and `pong` call each other, so their summaries
// need a second evaluation
fn ping(s: *S, n: int) {
    if n > 0 {
        s.a.push(n)
        pong(s, n - 1)
    }
}

fn pong(s: *S, n: int) {                         //~ L_SUMMARY_WIDENED
    if n > 0 {
        s.b.push(n)
        ping(s, n - 1)
    }
}

// quiet: not recursive, evaluated once
fn once(s: *S) { s.a.push(0) }

fn main() {
    var s = S { a: [], b: [] }
    ping(s, 3)
    once(s)
    log.println(s.a.len(), s.b.len())
}
