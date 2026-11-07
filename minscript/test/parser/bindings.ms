package parser_bindings

fun main() {
    // declarations
    let a = 10
    var b = 20
    c := 30                             // let c = 30
    d :== 40                            // var d = 40
    let e: i64 = 50
    var f: string? = nil
    let g: Vec[Map[string, int]] = []
    g2 := [] as Vec[Map[string, int]]   // same type, value first (§3.3)

    // assignment never declares
    d = 41
    b += 1
    d -= 1
    d *= 2
    d /= 2
    d %= 3
    f ??= "default"

    // place expressions
    point.x = 5
    grid[0][1] = 9
    totals["alice"] += 50
    user.profile.name = "Ted"
    pair.0 = 1

    // pattern declarations
    let t(w, h) = dims()
    let t(first, _, ..) = triple()
    let User { id, name, .. } = user
    let r{ host, port } = conf

    // let … else: the else block must diverge
    let Ok(data) = read() else {
        return
    }
    let Some(x) = find(1) else { panic("missing") }

    // several statements on one line
    let p = 1; let q = 2; d = p + q
}
