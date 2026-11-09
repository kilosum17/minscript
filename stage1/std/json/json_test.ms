// std.json's tests, in MinScript (`ms test std`).
package json

import "std.testing.*"

type Point = {
    x: f64
    y: f64
    label: string?
    tags: Vec[string] = []
}

fun test_parse_struct() {
    let p = assert_ok(parse.[Point]("{\"x\": 1.5, \"y\": 2}"))
    assert_eq(p.x, 1.5)
    assert_eq(p.label ?? "none", "none")
    assert_eq(p.tags.len(), 0)                  // missing field: its default
}

fun test_parse_nested() {
    let ps = assert_ok(parse.[Vec[Point]]("[{\"x\": 0, \"y\": 0, \"label\": \"origin\", \"tags\": [\"a\"]}]"))
    assert_eq(ps.len(), 1)
    assert_eq(ps[0].label ?? "", "origin")
    assert_eq(ps[0].tags.join(","), "a")
}

fun test_parse_errors() {
    let missing = assert_err(parse.[Point]("{\"x\": 1}"))
    assert_eq(missing.message, "missing field at `y`")
    let bad = assert_err(parse.[Point]("{ nope"))
    assert_true(bad.message.len() > 0, "a syntax error has a message")
}

fun test_round_trip() {
    let p = Point { x: 3.0, y: 4.5, label: Some("p"), tags: ["t"] }
    let text = stringify(p)
    assert_eq(text, "{\"x\":3,\"y\":4.5,\"label\":\"p\",\"tags\":[\"t\"]}")
    let back = assert_ok(parse.[Point](text))
    assert_eq(back.y, 4.5)
}

fun test_value() {
    let v = assert_ok(parse.[Value]("{\"a\": [1, true, null]}"))
    match v {
        Object(m) => assert_eq(m.len(), 1)
        _ => fail("expected an object")
    }
    let back = assert_ok(from_value.[Point](to_value(Point { x: 1.0, y: 2.0, label: None })))
    assert_eq(back.x, 1.0)
}
