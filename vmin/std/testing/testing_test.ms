// std.testing's own tests: each assertion passes on what it should, and fails with its message.
package testing

fn message_of(f: () -> void) -> str {
    match recover { f() } {
        Ok(_) => "no panic"
        Err(p) => p.message
    }
}

fn test_assert_eq() {
    assert_eq(2 + 2, 4)
    assert_eq(message_of(#{ assert_eq("a", "b") }), "assert_eq failed\n       got: a\n      want: b")
}

fn test_assert_ne_and_true() {
    assert_ne(1, 2)
    assert_eq(message_of(#{ assert_ne(3, 3) }), "assert_ne failed: both are 3")
    assert_eq(message_of(#{ assert_true(false, "the reason") }), "assert_true failed: the reason")
}

fn test_results_and_options() {
    let ok: Result[int, str] = Ok(1)
    let bad: Result[int, str] = Err("no")
    assert_eq(assert_ok(ok), 1)
    assert_eq(assert_err(bad), "no")
    assert_eq(message_of(#{ let _ = assert_ok(bad) }), "assert_ok failed: Err(no)")
    let none: int? = None
    assert_eq(message_of(#{ let _ = assert_some(none) }), "assert_some failed: the option is None")
}

async fn test_run_one_reports_a_panic() {
    out := await run_one(Case { name: "boom", run: Sync(#{ fail("boom!") }) })
    assert_true(!out.ok, "a panicking test fails")
    assert_eq(out.message, "boom!")
}
