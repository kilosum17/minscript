package corpus

fn patterns(x: Shape) {
    match x {
        Circle { r } => r
        Rect { w: 0, h } | Rect { w, h: 0 } => 0
        Payment.Card { number, .. } => 1
        Some(0) | None => 2
        Ok(t(a, b, ..)) => a
        r{ name, .. } => 3
        -1 => 4
        'a'..='z' => 5
        "hi" => 6
        nil => 7
        Mpesa(phone) if phone == "07" => 8
        Some(var v) => v
        _ => 9
    }
}
