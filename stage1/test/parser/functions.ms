package parser_functions

fun empty() {}

pub fun area(width: f32, height: f32) -> f32 {
    width * height                       // last expression is the value
}

pub fun explicit_return(x: int) -> int {
    return x * 2
}

fun void_discards() {
    compute()                            // value discarded in a void function
}

fun semicolon_discards() {
    compute();
}

fun reset(mut x: i32, y: &mut i32) {
    x = 0
    y = 0
}

fun borrow(user: &User) -> &str { user.name }

fun variadic(prefix: string, ...args: &Stringer) {
    log.println(prefix, ...args)         // spread into a variadic call
}

fun trailing_comma(
    a: int,
    b: int,
) -> int {
    a + b
}

fun returns_closure() -> (int) -> int { #[]{ it + 1 } }

pub async fun fetch_user(id: u64) -> User? {
    let raw = await db.query("select * from users where id = ${id}")
    raw?.to_user()
}

async fun no_return() {
    await runtime.yield()
}

fun calls() {
    empty()
    area(2.0, 3.0)
    variadic("x", 1, "two", 3.0)
    trailing_comma(
        1,
        2,
    )
    configure(_{ host: "localhost", port: 8080 })      // named-args style via `_{}`
    log.println("a", "b")
}
