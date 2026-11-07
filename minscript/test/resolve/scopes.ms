package resolve_scopes

// Valid scoping: this file must resolve with zero diagnostics. See scopes.refs for what each name binds to.

import "std.json"
import "std.io.println"

// top-level items are order-independent: `helper` and `Point` are declared further down
fun main() {
    let p = Point { x: 1, y: 2 }
    helper(p)
    println(json.stringify(p))
}

fun shadowing(x: int) -> int {
    let y = x + 1                       // the parameter
    if y > 0 {
        let x = y * 2                   // inner scope: shadows the parameter
        let y = x                       // inner scope: shadows the outer `y`
        return y
    }
    let z = {
        let y = 10                      // a block is an inner scope too
        y
    }
    y + z
}

fun sequential() {
    let a = 1
    let b = a + 1                       // `a` is visible after its `let`
    c := b
    d :== c
    d = d + a
    let a2 = {
        let a = a + 1                   // the value sees the outer `a`, then the new `a` shadows it
        a
    }
}

fun patterns(res: Result[int, string], pair: t(int, int), opt: int?) {
    if let Ok(v) = res { println(v) }   // `v` only in the then-block
    match res {
        Ok(n) if n > 0 => println(n)    // arm bindings are visible in the guard and the body
        Ok(n) => println(-n)
        Err(e) => println(e)
    }
    let t(w, h) = pair
    let Some(o) = opt else { return }
    println(w + h + o)
    for t(i, j) in [pair] { println(i + j) }
    match pair {
        t(0, k) | t(k, 0) => println(k)  // both alternatives bind `k`
        _ => {}
    }
}

fun closures(items: Vec[int]) {
    var total = 0
    let factor = 3
    items.for_each(#[&mut total]{ total += it })
    let scaled = items.map(#{ it * factor })            // `factor` is captured implicitly
    let pairs = items.map(#{ n => #{ m => n + m + factor } })
    let first = items.get(0) or 0
    let checked = items.get(1) or Err("missing: ${it}")   // `it` is the payload of `or`
    let named = items.get(2) or e => Err(e)
}

fun loops(grid: Vec[Vec[int]]) {
    outer: for row in grid {
        for cell in row {
            if cell < 0 { break outer }
        }
    }
    var n = 0
    for n < 10 { n += 1 }
}

// generics and Self
type Stack[T] = {
    items: Vec[T]

    fun new() -> Self { Stack { items: [] } }
    fun push(&mut this, v: T) { this.items.push(v) }
    fun peek(&this) -> T? { this.items.last() }
}

union Shape = {
    Circle { r: f64 }
    Square(f64)
    Empty

    fun area(&this) -> f64 {
        match this {
            Shape.Circle { r } => r * r * 3.14
            Square(s) => s * s
            Empty => 0.0
        }
    }
}

type Point = { x: int, y: int }

fun helper(p: Point) -> Shape {
    let s = Shape.Square(p.x as f64)
    s
}

fun records(name: string, port: int) {
    let cfg = r{ name, port }           // shorthand fields read `name` and `port`
    let pt = Point { x: port, y: 1 }
    println(cfg.name)
}
