// std.json's tests (`ms test std/json`).
package json

import "std.testing.*"

type Point {
    x: f64
    y: f64
    label: str?
    tags: Vec[str] = []
}

union Shape {
    Empty
    Circle(f64)
    Rect(f64, f64)
}

fn test_parse_struct() {
    let p = assert_ok(parse.[Point]("{\"x\": 1.5, \"y\": 2}"))
    assert_eq(p.x, 1.5)
    assert_eq(p.label ?? "none", "none")
    assert_eq(p.tags.len(), 0)                  // missing field: its default
}

fn test_parse_nested() {
    ps := assert_ok(parse.[Vec[Point]]("[{\"x\": 0, \"y\": 0, \"label\": \"origin\", \"tags\": [\"a\"]}]"))
    assert_eq(ps.len(), 1)
    assert_eq(ps[0].label ?? "", "origin")
    assert_eq(ps[0].tags.join(","), "a")
}

fn test_parse_errors() {
    let missing = assert_err(parse.[Point]("{\"x\": 1}"))
    assert_eq(missing.message, "missing field at `y`")
    bad := assert_err(parse.[Point]("{ nope"))
    assert_true(bad.message.len() > 0, "a syntax error has a message")
    let wrong = assert_err(parse.[Vec[int]]("[1, \"two\"]"))
    assert_eq(wrong.message, "expected a number at `[1]`")
}

fn test_round_trip() {
    let p = Point { x: 3.0, y: 4.5, label: Some("p"), tags: ["t"] }
    text := stringify(p)
    assert_eq(text, "{\"x\":3,\"y\":4.5,\"label\":\"p\",\"tags\":[\"t\"]}")
    let back = assert_ok(parse.[Point](text))
    assert_eq(back.y, 4.5)
    // outside `main`, a type prints with its package
    assert_eq(back.to_str(), "json.Point { x: 3.0, y: 4.5, label: Some(\"p\"), tags: [\"t\"] }")
}

fn test_unions_and_maps() {
    shapes := [Empty, Circle(1.0), Rect(2.0, 3.0)] as Vec[Shape]
    text := stringify(shapes)
    assert_eq(text, "[\"Empty\",{\"Circle\":[1]},{\"Rect\":[2,3]}]")
    let back = assert_ok(parse.[Vec[Shape]](text))
    assert_eq(back.len(), 3)
    assert_true(back[2] == Rect(2.0, 3.0), "a variant with a payload comes back")
    let m = assert_ok(parse.[Map[str, int]]("{\"a\": 1, \"b\": 2}"))
    assert_eq(m["b"], 2)
}

fn test_value() {
    let v = assert_ok(parse.[Value]("{\"a\": [1, true, null]}"))
    match v {
        Object(m) => assert_eq(m.len(), 1)
        _ => fail("expected an object")
    }
    let back = assert_ok(from_value.[Point](to_value(Point { x: 1.0, y: 2.0, label: None })))
    assert_eq(back.x, 1.0)
}
