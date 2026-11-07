package parser_control_flow

fun ifs(score: int, opt: User?) {
    if score > 90 {
        log.println("A")
    }

    if score > 90 { log.println("A") } else { log.println("not A") }

    let grade = if score >= 90 {
        let bonus = calc_bonus(score)
        "A"
    } else if score >= 75 {
        "B"
    } else {
        "C"
    }

    if (score > 10) && (score < 20) { }       // parentheses are only grouping

    if let Some(u) = opt {
        log.println(u.name)
    } else {
        log.println("none")
    }

    // a struct literal is not allowed directly in a header: `P` is a plain identifier here
    if x == P { log.println("x is P") }
    if x == (P { a: 1 }) { }                  // parenthesized: OK
}

fun matches(role: Role, n: int, res: Result[int, string], payment: Payment) {
    let tier = match role {
        "Admin" => "Full Access"
        "Operator" => "Standard Access"
        _ => "Read Only"
    }

    let label = match n {
        0 => "zero",
        1..=5 => "small",
        x if x > 100 => "huge",
        _ => "other",
    }

    let status = match res {
        Ok(val) => "Success: ${val}"
        Err(e) => "Error: ${e}"
    }

    match payment {
        Cash => process_cash()
        Mpesa(receipt) => {
            log.println(receipt)
            process_mpesa(receipt)
        }
        Card { number, .. } => process_card(number)
        Payment.Crypto { wallet } => {
            log.println(wallet)
        },                                    // comma after a block arm is optional
    }

    // subject-less match: the first true arm wins
    let is_adult = match {
        age >= 18 => true
        _ => false
    }
    let bucket = match {
        n < 0 => "negative",
        n == 0 => "zero",
        n < 10 && n % 2 == 0 => "small even",
        _ => "other",
    }

    let n2 = match n { 0 => 1, _ => n }       // single line
}

fun loops(items: Vec[int], users: Vec[User], map: Map[string, int], grid: Vec[Vec[int]]) {
    for {                                     // infinite
        break
    }

    var count = 0
    for count < 3 {                           // conditional
        count += 1
    }

    for let Some(item) = iter.next() {        // conditional pattern
        log.println(item)
    }

    for item in items {
        if item == 0 { continue }
        log.println(item)
    }

    for user, idx in users {
        log.println("${idx}: ${user.name}")
    }

    for key, val in map {
        log.println("${key} => ${val}")
    }

    for i in 0..10 {
        if i == 2 { continue }
        if i == 5 { break }
    }

    for i in 0..=items.len() - 1 { }

    for t(a, b) in pairs { }                  // pattern binding

    for x in items.iter_mut() { x += 1 }

    outer: for row in grid {
        for cell in row {
            if cell == 0 { continue outer }
            if cell < 0 { break outer }
        }
    }

    // `for { }` with `break value` is an expression
    let found = for {
        let n = next_number()
        if n > 100 { break n }
    }

    for items.is_empty() == false { break }
}

fun returns() -> int {
    if early() { return 1 }
    return 2
}

fun void_returns() {
    if early() { return }
    return
}
