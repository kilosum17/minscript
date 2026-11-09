// `a` imports `b`, which imports `a` back: the cycle is reported where it closes.
package main

import "app.a"

fn main() { log.println(a.one()) }
