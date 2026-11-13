// Tests of the main package: they see its private functions (`greet`), and its imports.
package main

import "std.testing.{assert_eq, assert_true}"

fn test_greet() {
    assert_eq(greet("ann"), "[shared] hello, ann!")
}

fn test_greet_mentions_the_name() {
    let g = greet("bo")
    assert_true(g.contains("bo"), "the greeting names the person")
}
