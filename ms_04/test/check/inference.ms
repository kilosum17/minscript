// Valid code: what the checker infers (the `.types` snapshot).
package inference

type Pair[A, B] { first: A, second: B }

union Shape { Circle(f64)  Rect { w: f64, h: f64 } }

fn area(s: Shape) -> f64 {
    match s {
        Circle(r) => 3.14 * r * r
        Rect { w, h } => w * h
    }
}

fn swap[A, B](p: Pair[A, B]) -> Pair[B, A] { Pair { first: p.second, second: p.first } }

fn inference(xs: Vec[int]) -> str {
    n := 1
    big := n as i64 + 2
    ratio := 1.5
    var names = []
    names.push("a")
    doubled := xs.map(#{ it * 2 })
    pairs := xs.map(#{ x, i => t(x, i) })
    total := xs.fold(0, #{ acc, x => acc + x })
    first := xs.first() ?? 0
    p := swap(Pair { first: 1, second: "one" })
    lookup := m{ "a": 1 } as Map[str, int]
    found := lookup.get("a")
    let shape: Shape = Circle(2.0)
    let label = if total > 10 { "big" } else { "small" }
    r := recover { area(Rect { w: 1.0, h: 2.0 }) }
    "${label} ${p.first} ${names.len()}"
}
