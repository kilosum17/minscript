package parser_patterns

fun main() {
    match value {
        // literals
        1 => "one"
        -1 => "minus one"
        1.5 => "float"
        "hi" => "string"
        'c' => "char"
        true => "bool"
        nil => "nil"

        // wildcard and bindings
        _ => "anything"
    }

    match opt {
        Some(x) => x
        None => 0
    }

    match res {
        Ok(Some(v)) => v                       // nested payload
        Ok(None) => 0
        Err(_) => -1
    }

    match shape {
        Circle { r } => r * r
        Rect { w: width, h: height } => width * height     // renaming fields
        Point { .. } => 0.0
        Shape.Line(a, b) => a.dist(b)                      // qualified
        geometry.Shape.Empty => 0.0                        // package-qualified
    }

    match n {
        0 | 1 => "tiny"                        // or-pattern
        2..=9 => "digit"
        10.. => "big"
        _ => "negative"
    }

    match ch {
        'a'..='z' | 'A'..='Z' => "letter"
        '0'..='9' => "digit"
        _ => "other"
    }

    match tuple {
        t(0, y) => y
        t(x, 0) => x
        t(_, _, ..) => -1
    }

    match rec {
        r{ kind: "user", id } => id
        r{ kind, .. } => 0
    }

    match pair {
        t(Some(a), Some(b)) if a == b => "same"
        t(Some(a), _) if a > 10 => "big a"
        t(mut a, b) => { a += b; "sum" }
    }

    match msg {
        Text(text) => log.println(text)
        Binary(bytes) => log.println(bytes.len())
        Close => {}
    }
}
