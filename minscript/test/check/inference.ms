package check_inference

// Valid code: this file must type-check with zero diagnostics. inference.types lists what every
// binding was inferred to be.

type Point = { x: int, y: int }
type Money = { cents: i64 }

impl Plus[Money, Money] for Money {
    fun plus(&this, rhs: Money) -> Money { Money { cents: this.cents + rhs.cents } }
}

union Shape = {
    Circle { r: f64 }
    Square(f64)
    Empty

    fun area(&this) -> f64 {
        match this {
            Circle { r } => r * r * 3.14
            Square(s) => s * s
            Empty => 0.0
        }
    }
}

type Stack[T] = {
    items: Vec[T]

    fun new() -> Self { Stack { items: [] } }
    fun push(&mut this, v: T) { this.items.push(v) }
    fun peek(&this) -> T? { this.items.last() }
}

fun identity[T](v: T) -> T { v }
fun pair[A, B](a: A, b: B) -> t(A, B) { t(a, b) }

fun literals() {
    let a = 1                           // int (default)
    let b = 2.5                         // f64 (default)
    let c: u8 = 7                       // the literal adopts u8
    d := 10 as i64                      // annotation with `as`
    let e = a + 1
    let f = b * 2.0
    let s = "x" + "y"
    let ch = 'c'
    let flag = !true
}

fun collections() {
    let v = [1, 2, 3]
    let names = ["a", "b"]
    let empty = [] as Vec[Point]
    var later = []
    later.push(Point { x: 1, y: 2 })
    let m = m{ "one": 1, "two": 2 }
    let set = s{ 1.5, 2.5 }
    let tup = t(1, "one", true)
    let first = tup.0
    let arr = a[1, 2, 3]
    let rec = r{ name: "Ann", age: 30 }
    let age = rec.age
}

fun generics_and_closures(items: Vec[int]) {
    let same = identity("x")
    let p = pair(1, "one")
    let doubled = items.map(#{ it * 2 })
    let labels = items.map(#{ n, i => "${i}: ${n}" })
    let big = items.filter(#{ it > 10 })
    let total = items.fold(0, #{ acc, n => acc + n })
    let any_big = items.any(#{ it > 100 })
    let adder = #{ a: int, b: int -> int => a + b }
    let seven = adder(3, 4)
}

fun options(users: Vec[Point], key: string, cache: Map[string, int]) -> Result[int, string] {
    let first = users.get(0)
    let x = users.get(0)?.x ?? 0
    let hit = cache.get(key) ?? -1
    let found = cache.get(key) or Err("missing ${key}")
    let parsed = "42".to_int()?
    let maybe = cache.get(key).map(#{ it + 1 })
    Ok(x + hit + found + parsed)
}

fun structs_and_variants() -> f64 {
    let p = Point { x: 1, y: 2 }
    let q: Point = r{ x: 3, y: 4 }      // record → struct (spec §7.4)
    let moved = Point { ...p, x: 9 }
    let shapes: Vec[Shape] = [Circle { r: 1.0 }, Square(2.0), Empty]
    let s = Shape.Square(3.0)
    var stack = Stack.new.[string]()
    stack.push("a")
    let top = stack.peek()
    let wallet = Money { cents: 5 } + Money { cents: 7 }
    s.area()
}

fun control_flow(n: int, o: int?) -> string {
    let label = if n > 0 { "positive" } else { "not positive" }
    let size = match n {
        0 => "zero"
        1..=9 => "small"
        _ => "big"
    }
    let inner = match o { Some(v) => v, None => 0 }
    for i in 0..n { let sq = i * i }
    for k, v in m{ "a": 1 } { let both = "${k}${v}" }
    for item, idx in ["x", "y"] { let line = "${idx}: ${item}" }
    let found = for {
        if n > 3 { break n * 2 }
    }
    label
}

async fun tasks() -> int {
    let room = Topic.new.[string]()
    var sub = room.subscribe()
    room.publish("hi")
    let online = Signal(0)
    let now = online.update(#{ c => c += 1; c })
    let t(ready, resolver) = Promise.new.[int]()
    resolver.resolve(5)
    let v = await ready
    let got = select {
        Some(msg) = sub.next() => msg.len()
        else => 0
    }
    let counter = Ref(0)
    counter.update(#{ c => c += 1 })
    v + got + now + counter.get()
}
