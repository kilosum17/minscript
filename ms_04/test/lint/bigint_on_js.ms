// L_BIGINT_ON_JS (§16.1): i64 / u64 arithmetic lowers to BigInt on JS.
package main

fn main() {
    let a: i64 = 40
    b := a * 2                                   //~ L_BIGINT_ON_JS
    // quiet: int arithmetic, and comparing i64 values
    c := 40 * 2
    log.println(b, c, a > 3)
}
