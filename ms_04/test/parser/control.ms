package corpus

fn control() {
    if res { }
    if !opt && flag { }
    if let Some(var u) = find(1) { u.age += 1 } else if x { } else { }
    grade := if score >= 90 { "A" } else { "B" }
    label := match n {
        0 => "zero"
        1..=5 => "small"
        x if x > 100 => "huge"
        _ => "other"
    }
    adult := match { age >= 18 => true, _ => false }
    kind := match c { b'a'..=b'z' => 1, b'0'..=b'9' => 2, _ => 0 }
    for { break }
    for i < 3 { i += 1 }
    for x in xs { }
    for k, v in m { }
    for let Some(x) = it.next() { }
    for var line in lines { line.push(1) }
    for await m in sub { }
    for await var o in jobs { }
    for await ready() { }
    outer: for x in xs { for y in ys { if y { break outer } else { continue outer } } }
    v := for { break 5 }
    select { Some(j) = q.next() => run(j), time.after(10) => idle(), else => skip() }
    select {
        Some(r) = results.next() => outcomes.push(r)
        time.after(2_000) => {
            log.warn("late")
        }
    }
    r := recover { risky() }
    fd := unsafe { open(path) }
    lock a { a += 1 }
    lock from, to { from.balance -= n; to.balance += n }
    n := lock tokens { tokens.push(x); tokens.len() }
    let t(w, h) = dims()
    let Ok(v) = r else { return }
    let User { id, name, .. } = user
    let event: Event = match status { Paid { total, .. } => Sold { total }, _ => Empty }
    x := find(1) or return
    y := lines.next() or break
}
