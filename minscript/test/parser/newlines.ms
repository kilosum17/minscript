package parser_newlines

fun main() {
    // continuation: previous token cannot end an expression
    let total =
        a +
        b *
        c
    let call = compute(
        1,
        2,
    )
    let list = [
        1
        2
    ]
    let cond = a &&
        b

    // continuation: next line starts with . ?. && || ?? or as else ) ] } =>
    let chain = user
        .profile
        ?.display_name
    let fallback = value
        ?? "default"
    let both = a
        && b
    let either = a
        || b
    let res = read()
        or Err("x")
    let cast = n
        as i64
    let r = if a {
        1
    }
    else {                               // `else` on the next line continues the `if`
        2
    }

    // termination: next line starts with ( [ { - + * & ! .[
    foo
    (bar)                                // two statements: `foo`, `(bar)`
    baz
    [1, 2]                               // two statements: `baz`, a Vec literal
    let n = a
    -b                                   // two statements: `let n = a`, `-b`
    qux
    !flag                                // two statements

    // newlines inside ( ) and [ ] are ignored, but they matter again inside a nested { }
    let nested = run(#{ x =>
        let y = x + 1
        y * 2
    })

    // semicolons
    let x = 1; let y = 2
    let z = 3;

    // `return` / `break` / `continue` with no value end at a newline
    for {
        if x { break }
        if y { continue }
        break
    }
}

fun value_on_next_line() -> int {
    return                               // `return` with no value...
    42                                   // ...then an unreachable expression statement (lint)
}
