// Tests of a non-main package (`app.models`), including an async one.
package models

import "std.testing.{assert_eq, assert_ne}"
import "std.time"

fun test_item_fields() {
    let pen = Item { name: "pen", cents: 150 }
    assert_eq(pen.cents, 150)
    assert_ne(pen.name, "book")
}

async fun test_async_tests_can_wait() {
    start := time.now()
    await time.sleep(2)
    assert_eq(time.now() >= start, true)
}
