package hir_lowering

// One case per desugaring (see lowering.hir). Must pass every check with zero diagnostics.

type Config = { host: string, port: int = 8080, tls: bool? }
type Big = { total: i64 }
type Money = { cents: i64 }

impl Plus[Money, Money] for Money {
    fun plus(&this, rhs: Money) -> Money { Money { cents: this.cents + rhs.cents } }
}

union Shape = {
    Circle { r: f64 }
    Square(f64)
    Empty
}

inter Named = { fun label(&this) -> string }
type Tag = { name: string }
impl Named for Tag { fun label(&this) -> string { this.name } }

fun area(s: Shape) -> f64 {
    match s {
        Circle { r } => r * r
        Square(x) => x * x
        Empty => 0.0
    }
}

fun describe(n: &Named) -> string { n.label() }                 // dynamic dispatch
fun log_all(prefix: string, ...rest: &Stringer) { log.println(prefix, ...rest) }

fun defaults_and_spread() -> Config {
    let a = Config { host: "x" }                                // port = 8080, tls = None
    let b = Config { ...a, port: 1 }
    let c: Config = _{ host: "y" }
    b
}

fun variants_and_widen(n: i32) -> Big {
    let s: Shape = Square(2.0)                                  // inferred variant
    let r: Result[void, string] = Ok()                          // void payload filled in
    let total: i64 = n                                          // int → i64: `widen`
    let wallet = Money { cents: 1 } + Money { cents: 2 }        // operator interface
    Big { total: total + 1 }
}

fun options(o: int?, r: Result[int, string]) -> Result[int, string] {
    let a = o ?? 0
    let b = r?
    let c = o or Err("none")
    var slot: int? = nil
    slot ??= 5
    if let Some(v) = slot { log.println(v) }
    let Some(d) = o else { return Err("no d") }
    Ok(a + b + c + d)
}

fun strings(name: string, n: int) -> string {
    var s = "hi ${name}, you are ${n}"
    s += "!"
    s
}

fun loops(items: Vec[string], m: Map[string, int]) -> int {
    var total = 0
    for i in 0..3 { total += i }
    for item, idx in items {
        if idx == 0 { continue }
        total += item.len()
    }
    for k, v in m { total += v }
    var n = 0
    for n < 10 { n += 1 }
    outer: for {
        for i in 0..=2 {
            if i == 2 { break outer }
        }
    }
    total
}

fun conditions(a: int, flag: bool, o: int?) -> string {
    let kind = match {
        a > 10 => "big"
        a < 0 => "negative"
        _ => "small"
    }
    if o && flag { return kind }
    let t(x, y) = t(1, 2)
    kind
}

async fun waits(sub: Sub[int], p: Promise[int]) -> int {
    var s = sub
    let v = select {
        Some(n) = s.next() => n
        else => 0
    }
    var sum = 0
    for await x in s { sum += x }
    v + sum + await p
}

fun closures(xs: Vec[int]) -> Vec[int] {
    let k = 2
    var count = 0
    xs.for_each(#[&mut count]{ count += 1 })
    log_all("count", count)
    xs.map(#{ it * k })
}
