package parser_type_annotation

// `expr as T` (spec §3.3): a type annotation when `expr` checks against T, otherwise a numeric cast.
// The parser always produces the same node, (as expr T); the type checker decides which it is.

fun annotations() {
    // empty collections: the value first, then its type
    g := [] as Vec[Map[string, int]]              // (:= g (as (vec) (Vec (Map string int))))
    let ids = [] as Vec[u64]
    seen :== s{} as Set[string]
    var cache = m{} as Map[string, User]
    grid := a[] as Array[i32, 0]

    // the equivalent annotation on the binding; both forms are valid
    let g2: Vec[Map[string, int]] = []

    // nil and optional
    owner := nil as User?                         // (as nil (Option User)): `?` is part of the type
    let parent = nil as Box[Node[int]]?

    // numeric literals (an annotation: no conversion takes place)
    timeout := 500 as u16
    let ratio = 0.5 as f32
    mask :== 0xFF as u8

    // inferred literals and generic calls
    cfg := _{ host: "localhost", port: 80 } as Config
    let user = json.parse(raw) as Result[User, json.Error]
    handlers := m{} as Map[string, (Request) -> Response]

    // inside other expressions
    total := sum([] as Vec[int])
    let pairs = [t(1, "a")] as Vec[t(i64, string)]
    users := (load() ?? [] as Vec[User]).len()
}

fun casts(big: i64, count: int, total: int, p: *u8) {
    let small = big as u8                         // cast: i64 → u8 (truncating)
    r := count as f64 / total as f64              // (/ (as count f64) (as total f64))
    let addr = p as usize
    neg := -big as i32                            // (as (- big) i32)
    let chained = big as i32 as f64               // (as (as big i32) f64): left associative
    var widened = count as i64 + 1                // (+ (as count i64) 1)
}
