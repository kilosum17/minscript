package parser_types

// nominal struct: newline- or comma-separated fields, pub, optional, defaults, inline methods
pub type User: Stringer = {
    pub id: u64
    pub name: string
    email: string?
    tags: Vec[string] = []
    active: bool = true

    pub fun new(id: u64, name: string) -> User {
        User { id, name }
    }

    pub fun display_email(&this) -> &str { this.email ?? "none" }

    pub fun rename(&mut this, name: string) { this.name = name }

    pub fun to_str(&this) -> string { "User(${this.id})" }

    pub async fun refresh(&mut this) { await sync(this.id) }
}

type Compact = { x: int, y: int, }
type Empty = {}
type Several: Stringer, Clone, PartialEq[Several] = { v: int }

// sum types: variants plus inline methods
pub union Payment = {
    Cash
    Mpesa(string)
    Card { number: string, exp: string }
    Split(Payment, Payment)

    pub fun is_cash(&this) -> bool {
        match this { Cash => true, _ => false }
    }
}

union Inline = { A, B, C(int) }
union Node[T] = {
    Leaf(T)
    Branch { left: Box[Node[T]], right: Box[Node[T]] }
}

// literal unions
pub type Role = "Admin" | "Operator" | "Guest"
type Code = 200 | 404 | 500
type Bit = true | false

// aliases
type UserId = u64
type Users = Vec[User]
type Point = r{ x: f64, y: f64 }
type Handler = (Request) -> Response
type Config = TypeOf(default_config)
type Fields = KeyOf[User]
type Route = ElementOf[TypeOf(routes)]

// recursive type through Box
type List[T] = {
    value: T
    next: Box[List[T]]?
}

// type grammar in parameter / return positions
fun type_forms(
    a: &User,
    b: &mut User,
    c: *mut u8,
    d: *u8,
    e: t(int, string),
    f: t(),
    g: r{ id: int, name: string },
    h: (i32, i32) -> i32,
    i: &(i32) -> i32,
    j: () -> void,
    k: (i32) -> (i32) -> i32,            // right associative
    l: User?,
    m: Vec[User?],
    n: (Vec[int])?,                      // grouping
    o: &str,
    p: Slice[u8],
    q: Array[f32, 3],
    s: Promise[Result[void, string]],
    u: &Stringer,                        // dynamic dispatch (borrowed)
    w: Vec[Shape],                       // owned interface values (boxed)
) -> never {
    panic("unreachable")
}

fun returns_fn() -> (i32) -> i32 { #[]{ it } }
fun returns_tuple() -> t(int, int) { t(1920, 1080) }
fun returns_opt() -> string? { nil }
