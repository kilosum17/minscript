// L_NESTED_LOCK (§10.1): a `lock` inside another `lock`.
package main

fn main() {
    shared var a = 1
    shared var b = 2
    // fires
    lock a {
        lock b {                                 //~ L_NESTED_LOCK
            a += b
        }
    }
    // quiet: one block for both
    lock a, b {
        b += a
    }
    log.println(a, b)
}
