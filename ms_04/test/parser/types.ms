package corpus

fn types(
    a: Vec[Map[str, Vec[User?]]],
    b: Promise[Result[User, str]],
    c: Array[i32, 4],
    d: t(int, str),
    e: r{ x: f64, y: f64 },
    f: (int, *Vec[u8]) -> bool,
    g: Reader & Writer,
    h: Self,
    i: json.Value?,
) { }
