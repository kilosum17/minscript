package parser_inter_impl

pub inter Reader = {
    fun read(&mut this, buf: &mut Vec[u8]) -> Result[int, string]
}

pub inter Writer = {
    fun write(&mut this, data: &Slice[u8]) -> Result[int, string]
    fun flush(&mut this) -> Result[void, string] { Ok() }      // default body
}

pub inter ReadWriter = Reader & Writer                          // composition

pub inter PartialOrd[T]: PartialEq[T] = {                       // super-interface
    fun partial_cmp(&this, other: &T) -> Ordering?
    fun lt(&this, other: &T) -> bool { this.partial_cmp(other) == Some(Less) }
}

pub inter Default = {
    fun default() -> Self                                       // static, returns Self
}

pub inter Shape = {
    fun area(&this) -> f64
    fun name(&this) -> string { "shape" }
    async fun render(&this, ctx: &mut Canvas)
}

type File = { fd: i32 }

// inherent impl (same package as the type)
impl File {
    pub fun open(path: string) -> Result[File, string] { Ok(File { fd: 3 }) }
    pub fun close(mut this) { sys.close(this.fd) }
    fun by_value(this) -> i32 { this.fd }
}

// interface impls
impl Reader for File {
    fun read(&mut this, buf: &mut Vec[u8]) -> Result[int, string] { Ok(0) }
}

impl Reader, Writer for Socket {
    fun read(&mut this, buf: &mut Vec[u8]) -> Result[int, string] { Ok(0) }
    fun write(&mut this, data: &Slice[u8]) -> Result[int, string] { Ok(data.len()) }
}

impl Drop for File {
    fun drop(mut this) { this.close() }
}

impl Plus[Money, Money], Minus[Money, Money] for Money {
    fun plus(&this, rhs: Money) -> Money { Money { cents: this.cents + rhs.cents } }
    fun minus(&this, rhs: Money) -> Money { Money { cents: this.cents - rhs.cents } }
}

impl[T] Iterator[T] for Counter[T] {
    fun next(&mut this) -> T? { nil }
}

impl Default for Config {
    fun default() -> Self { Config { host: "localhost", port: 8080 } }
}

// receivers: all four forms
type R = {
    v: int
    fun a(this) -> int { this.v }
    fun b(&this) -> int { this.v }
    fun c(&mut this) { this.v += 1 }
    fun d(mut this) -> R { this.v = 0; this }
    fun e(&this, x: int, mut y: int, z: &mut int, ...rest: &Stringer) {}
}
