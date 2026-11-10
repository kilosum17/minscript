package main

fn main() {
    shared var a = 1
    shared var b = 2
    lock a {
        lock b { a += b }                        // allowed in mod.ms: quiet
    }
    big := 3000000000                            //~ L_INT_NOT_PORTABLE
    log.println(a, big)
}
