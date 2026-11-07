package parser_variants

// Variant names inferred from the expected type (spec §7.6). For the parser these are ordinary
// calls, names and struct literals; the resolver/type checker maps them to variants.

union Shape = {
    Circle { r: f64 }
    Rect { w: f64, h: f64 }
    Line(Point, Point)
    Empty
}

type Point = { x: f64, y: f64 }

union Message = {
    Text(string)
    Binary(Vec[u8])
    Close
}

type Envelope = { to: string, body: Message }

fun send(msg: Message) { log.println(msg) }
fun area(s: Shape) -> f64 { 0.0 }

fun as_arguments() {
    send(Text("hi"))                                  // Message.Text
    send(Close)                                       // Message.Close (unit variant)
    a := area(Circle { r: 1.0 })                      // struct-like variant
    let b = area(Line(Point { x: 0.0, y: 0.0 }, Point { x: 1.0, y: 1.0 }))
}

fun as_bindings() {
    let m: Message = Binary([1, 2, 3])                // annotated binding
    s := Rect { w: 2.0, h: 3.0 } as Shape             // `as` gives the expected type
    shapes := [Empty, Circle { r: 2.0 }] as Vec[Shape]   // element type of the Vec
    let env = Envelope { to: "ann", body: Text("yo") }    // field type
}

fun as_return(n: int) -> Shape {
    if n == 0 { return Empty }                        // return type
    Circle { r: n as f64 }                            // block value
}

fun qualified_still_works() {
    send(Message.Text("explicit"))
    let s = Shape.Empty
}

fun in_match(m: Message) -> Message {
    match m {
        Text(t) => Text(t.to_upper())                 // arm type known from the return type
        other => other
    }
}
