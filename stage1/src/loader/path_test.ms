// Unit tests of the loader's path helpers (as Node's `path` module computes them).
package loader

import "std.testing.*"

fun test_normalize_and_join() {
    assert_eq(normalize("/a/./b/../c/"), "/a/c")
    assert_eq(normalize("a/../.."), "..")
    assert_eq(normalize("/.."), "/")
    assert_eq(join("/std/", "net/ws"), "/std/net/ws")
    assert_eq(resolve_from("/work/app", "../lib"), "/work/lib")
    assert_eq(resolve_from("/work/app", "/abs"), "/abs")
}

fun test_dirname_and_relative() {
    assert_eq(dirname("/a/b/c.ms"), "/a/b")
    assert_eq(dirname("/a"), "/")
    assert_eq(dirname("c.ms"), ".")
    assert_eq(relative("/std", "/std/net/ws"), "net/ws")
    assert_eq(relative("/std", "/app/main.ms"), "../app/main.ms")
    assert_eq(relative("/std", "/std"), "")
}
