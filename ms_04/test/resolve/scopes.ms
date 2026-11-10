// Valid resolution: what each name binds to (the `.refs` snapshot).
package scopes

let LIMIT = later() + 1                       // items are order-independent

fn later() -> int { 2 }

type Counter {
    n: int
    shared hits: int = 0

    fn bump(*this, by: int) -> int {
        add := #{ this.n += by; this.n }      // captures `this` and `by`
        add()
    }
}

fn shadowing(x: int) -> int {
    y := x
    if y > 0 {
        let x = y * 2                         // shadows the parameter in an inner scope
        return x
    }
    for x in [1, 2] { log.println(x) }        // loop item shadows too
    var total = 0
    [1, 2, 3].for_each(#{ total += it })      // header-less closure: `it`
    pairs := [1, 2].map(#{ v, i => v + i + total })
    found := pairs.find(#{ it > LIMIT }) or 0
    fallback := pairs.first() or e => -1
    match found {
        0 | 1 => 0
        n if n > LIMIT => n
        _ => total
    }
}

fn patterns(r: Result[int, str]) -> int {
    let Ok(v) = r else { return 0 }
    if let Some(var w) = Some(v) { w += 1 }
    v
}
