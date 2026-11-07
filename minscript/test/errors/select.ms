package errors_select

async fun empty_select() {
    select { }                                  //~ E_SELECT_EMPTY
}

async fun else_not_last(s: Sub[int]) {
    var sub = s
    select {
        else => log.println("x")                //~ E_SELECT_ELSE_NOT_LAST
        Some(n) = sub.next() => log.println(n)
    }
}

async fun two_else(s: Sub[int]) {
    var sub = s
    select {
        Some(n) = sub.next() => log.println(n)
        else => log.println("a")
        else => log.println("b")                //~ E_SELECT_ELSE_NOT_LAST
    }
}

async fun brace_on_next_line(s: Sub[int]) {
    var sub = s
    select                                      //~ E_OPEN_BRACE_NEWLINE
    {
        Some(n) = sub.next() => log.println(n)
    }
}

async fun missing_arrow(s: Sub[int]) {
    var sub = s
    select {
        Some(n) = sub.next() log.println(n)     //~ E_UNEXPECTED_TOKEN
    }
}

async fun for_await_without_pattern() {
    for await in items { }                      //~ E_INVALID_PATTERN
}
