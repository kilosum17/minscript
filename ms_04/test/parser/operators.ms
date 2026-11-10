package corpus

fn operators() {
    a := t.0.1
    b := 1..10
    c := 1..=10
    d := ..5
    e := 1.to_str()
    f := a[0]
    g := x.a[0]
    h := json.parse.[User](s)
    i := Vec.[u8].new()
    j := a<b
    k := a >> b
    l := x.or(1)
    m := x or 1
    n := x or e => Err(e)
    o := a ?? b ?? c
    p := a?.b ?? "x"
    x ??= 5
    q := x as i32?
    r := a as f64 / b as f64
    s := flags as u8 & MASK
    u := await f()?
    v := await f()?.name
    w := (await f()).trim()
    y := user?.name
    z := (user?).name
    aa := -x as f64
    bb := a + b * c - d % e
    cc := a == b && c != d || !e
    dd := x << 2 | y & 3 ^ z
    m[k] = v
    total += 1
    user.tags[0] = "x"
}
