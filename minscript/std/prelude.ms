package prelude

// The MinScript prelude (spec §10.1, §10.2, §9.9, §9.10): every name here is visible in every
// package without an import. Bodies are `_builtin()`, implemented by each back end; the type
// checker only reads the signatures. Auto-generated methods (`to_str`, `clone`, `eq`, `hash`,
// spec §9.7) exist on every type and are not declared here.

pub fun _builtin() -> never { _builtin() }

pub fun assert(cond: bool, msg: string) {
    if !cond {
        panic(msg)
    }
}
pub fun panic(msg: string) -> never { _builtin() }

/// A panic of a given kind (`Unwrap`, `OutOfBounds`…), for the prelude's own checks.
fun _panic_kind(kind: PanicKind, msg: string) -> never { _builtin() }

// ---- Option, Result, Ordering ------------------------------------------------------------------

pub union Option[T] = {
    Some(T)
    None

    pub fun is_some(&this) -> bool {
        match this {
            Some(_) => true
            None => false
        }
    }
    pub fun is_none(&this) -> bool { !this.is_some() }
    pub fun unwrap(this) -> T {
        match this {
            Some(v) => v
            None => _panic_kind(Unwrap, "unwrap of None")
        }
    }
    pub fun expect(this, msg: &str) -> T {
        match this {
            Some(v) => v
            None => _panic_kind(Unwrap, msg.to_str())
        }
    }
    pub fun or[F](this, fallback: F) -> T { _builtin() }          // a value, or `#{…}` (lazy): core until §18 #8
    pub fun map[U](this, f: &(T) -> U) -> U? {
        match this {
            Some(v) => Some(f(v))
            None => None
        }
    }
    pub fun and_then[U](this, f: &(T) -> U?) -> U? {
        match this {
            Some(v) => f(v)
            None => None
        }
    }
    pub fun ok_or[E](this, err: E) -> Result[T, E] {
        match this {
            Some(v) => Ok(v)
            None => Err(err)
        }
    }
    pub fun filter(this, f: &(&T) -> bool) -> T? {
        match this {
            Some(v) => if f(v) { Some(v) } else { None }
            None => None
        }
    }
}

pub union Result[T, E] = {
    Ok(T)
    Err(E)

    pub fun is_ok(&this) -> bool {
        match this {
            Ok(_) => true
            Err(_) => false
        }
    }
    pub fun is_err(&this) -> bool { !this.is_ok() }
    pub fun unwrap(this) -> T {
        match this {
            Ok(v) => v
            Err(e) => _panic_kind(Unwrap, "unwrap of Err(${e})")
        }
    }
    pub fun expect(this, msg: &str) -> T {
        match this {
            Ok(v) => v
            Err(_) => _panic_kind(Unwrap, msg.to_str())
        }
    }
    pub fun unwrap_err(this) -> E {
        match this {
            Ok(_) => _panic_kind(Unwrap, "unwrap_err of Ok")
            Err(e) => e
        }
    }
    pub fun ok(this) -> T? {
        match this {
            Ok(v) => Some(v)
            Err(_) => None
        }
    }
    pub fun err(this) -> E? {
        match this {
            Ok(_) => None
            Err(e) => Some(e)
        }
    }
    pub fun or[F](this, fallback: F) -> T { _builtin() }          // core until §18 #8
    pub fun map[U](this, f: &(T) -> U) -> Result[U, E] {
        match this {
            Ok(v) => Ok(f(v))
            Err(e) => Err(e)
        }
    }
    pub fun map_err[F](this, f: &(E) -> F) -> Result[T, F] {
        match this {
            Ok(v) => Ok(v)
            Err(e) => Err(f(e))
        }
    }
    pub fun and_then[U](this, f: &(T) -> Result[U, E]) -> Result[U, E] {
        match this {
            Ok(v) => f(v)
            Err(e) => Err(e)
        }
    }
}

pub union Ordering = { Less  Equal  Greater }

// ---- collections ------------------------------------------------------------------------------

// Core builtins are storage and hashing (`len`, `push`, `pop`, `insert`, `remove`, `truncate`, `swap`,
// `sort_by`, `iter`, Map / Set access); everything else is MinScript on top of them.

pub type Range[T] = {
    pub fun contains(&this, v: &T) -> bool { _builtin() }
    pub fun len(&this) -> int { _builtin() }
    pub fun rev(&this) -> Iterator[T] { _builtin() }
    pub fun iter(&this) -> Iterator[&T] { _builtin() }
}

pub type Vec[T] = {
    pub fun new() -> Vec[T] { [] }
    pub fun with_capacity(n: int) -> Vec[T] { _builtin() }

    pub fun len(&this) -> int { _builtin() }
    pub fun is_empty(&this) -> bool { this.len() == 0 }
    pub fun get(&this, i: int) -> T? {
        if i >= 0 && i < this.len() { Some(this[i].clone()) } else { None }
    }
    /// Like `get`, and a negative index counts from the end (`at(-1)` is the last item).
    pub fun at(&this, i: int) -> T? {
        this.get(if i < 0 { this.len() + i } else { i })
    }
    pub fun first(&this) -> T? { this.get(0) }
    pub fun last(&this) -> T? { this.get(this.len() - 1) }
    pub fun contains(&this, v: &T) -> bool { this.index_of(v).is_some() }
    pub fun index_of(&this, v: &T) -> int? {
        for x, i in this {
            if x == v {
                return Some(i)
            }
        }
        None
    }

    pub fun push(&mut this, v: T) { _builtin() }
    pub fun pop(&mut this) -> T? { _builtin() }
    pub fun insert(&mut this, i: int, v: T) { _builtin() }
    pub fun remove(&mut this, i: int) -> T { _builtin() }
    /// Keeps the first `n` items.
    pub fun truncate(&mut this, n: int) { _builtin() }
    pub fun swap(&mut this, i: int, j: int) { _builtin() }
    pub fun clear(&mut this) { this.truncate(0) }
    /// Moves every item out (no copies) and leaves this Vec empty: how a large value is handed on from
    /// a field (`let arena = this.state.items.drain()`).
    pub fun drain(&mut this) -> Vec[T] { _builtin() }
    pub fun extend(&mut this, other: Vec[T]) {
        var rest = other
        rest.reverse()
        for let Some(x) = rest.pop() {
            this.push(x)
        }
    }
    pub fun sort_by(&mut this, f: &(&T, &T) -> Ordering) { _builtin() }
    pub fun reverse(&mut this) {
        var i = 0
        var j = this.len() - 1
        for i < j {
            this.swap(i, j)
            i += 1
            j -= 1
        }
    }

    pub fun iter(&this) -> Iterator[&T] { _builtin() }
    pub fun iter_mut(&mut this) -> Iterator[&mut T] { _builtin() }
    // pipeline callbacks receive (item, index); a callback may take fewer parameters (spec §4.4)
    pub fun map[U](&this, f: &(&T, int) -> U) -> Vec[U] {
        var out = Vec.with_capacity.[U](this.len())
        for x, i in this {
            out.push(f(x, i))
        }
        out
    }
    pub fun filter(&this, f: &(&T, int) -> bool) -> Vec[T] {
        var out = [] as Vec[T]
        for x, i in this {
            if f(x, i) {
                out.push(x.clone())
            }
        }
        out
    }
    pub fun find(&this, f: &(&T, int) -> bool) -> T? {
        for x, i in this {
            if f(x, i) {
                return Some(x.clone())
            }
        }
        None
    }
    pub fun any(&this, f: &(&T, int) -> bool) -> bool {
        for x, i in this {
            if f(x, i) {
                return true
            }
        }
        false
    }
    pub fun all(&this, f: &(&T, int) -> bool) -> bool {
        for x, i in this {
            if !f(x, i) {
                return false
            }
        }
        true
    }
    pub fun count(&this, f: &(&T, int) -> bool) -> int {
        var n = 0
        for x, i in this {
            if f(x, i) {
                n += 1
            }
        }
        n
    }
    pub fun for_each(&this, f: &(&T, int) -> void) {
        for x, i in this {
            f(x, i)
        }
    }
    pub fun fold[A](&this, init: A, f: &(A, &T) -> A) -> A {
        var acc = init
        for x in this {
            acc = f(acc, x)
        }
        acc
    }
    pub fun reduce[A](&this, init: A, f: &(A, &T) -> A) -> A { this.fold(init, f) }
    pub fun take(&this, n: int) -> Vec[T] { this.filter(#{ _, i => i < n }) }
    pub fun skip(&this, n: int) -> Vec[T] { this.filter(#{ _, i => i >= n }) }
    pub fun to_vec(&this) -> Vec[T] { this.filter(#{ true }) }
}

// methods that need something of the items: only on Vecs whose items have it
impl[T: PartialOrd[T]] Vec[T] {
    pub fun max(&this) -> T? {
        var best: T? = None
        for x in this {
            best = match best {
                Some(b) => Some(if x > b { x.clone() } else { b })
                None => Some(x.clone())
            }
        }
        best
    }
    pub fun min(&this) -> T? {
        var best: T? = None
        for x in this {
            best = match best {
                Some(b) => Some(if x < b { x.clone() } else { b })
                None => Some(x.clone())
            }
        }
        best
    }
    pub fun sort(&mut this) {
        this.sort_by(#{ a, b => if a < b { Less } else if a > b { Greater } else { Equal } })
    }
}

impl[T: Stringer] Vec[T] {
    pub fun join(&this, sep: &str) -> string {
        var out = ""
        for x, i in this {
            if i > 0 {
                out += sep
            }
            out += x.to_str()
        }
        out
    }
}

impl[T: Plus[T, T] & Default] Vec[T] {
    pub fun sum(&this) -> T {
        var total = T.default()             // through T's type witness (spec §14.1)
        for x in this {
            total = total + x
        }
        total
    }
}

pub type Array[T, N] = {
    pub fun len(&this) -> int { _builtin() }
    pub fun get(&this, i: int) -> T? {
        if i >= 0 && i < this.len() { Some(this[i].clone()) } else { None }
    }
    pub fun iter(&this) -> Iterator[&T] { _builtin() }
    pub fun to_vec(&this) -> Vec[T] {
        var out = [] as Vec[T]
        for x in this {
            out.push(x.clone())
        }
        out
    }
}

pub type Slice[T] = {
    pub fun len(&this) -> int { _builtin() }
    pub fun is_empty(&this) -> bool { this.len() == 0 }
    pub fun get(&this, i: int) -> T? {
        if i >= 0 && i < this.len() { Some(this[i].clone()) } else { None }
    }
    pub fun iter(&this) -> Iterator[&T] { _builtin() }
    pub fun to_vec(&this) -> Vec[T] {
        var out = [] as Vec[T]
        for x in this {
            out.push(x.clone())
        }
        out
    }
}

pub type Map[K, V] = {
    pub fun new() -> Map[K, V] { _builtin() }
    pub fun len(&this) -> int { _builtin() }
    pub fun is_empty(&this) -> bool { this.len() == 0 }
    pub fun get(&this, k: &K) -> V? { _builtin() }
    pub fun has(&this, k: &K) -> bool { _builtin() }
    pub fun insert(&mut this, k: K, v: V) -> V? { _builtin() }
    pub fun remove(&mut this, k: &K) -> V? { _builtin() }
    pub fun clear(&mut this) { _builtin() }
    /// Moves every entry out (no copies) into a new Map and leaves this one empty (as `Vec.drain`).
    pub fun drain(&mut this) -> Map[K, V] { _builtin() }
    pub fun keys(&this) -> Vec[K] {
        var out = [] as Vec[K]
        for k, _ in this {
            out.push(k.clone())
        }
        out
    }
    pub fun values(&this) -> Vec[V] {
        var out = [] as Vec[V]
        for _, v in this {
            out.push(v.clone())
        }
        out
    }
    pub fun iter(&this) -> Iterator[t(&K, &V)] { _builtin() }
}

pub type Set[T] = {
    pub fun new() -> Set[T] { _builtin() }
    pub fun len(&this) -> int { _builtin() }
    pub fun is_empty(&this) -> bool { this.len() == 0 }
    pub fun has(&this, v: &T) -> bool { _builtin() }
    pub fun insert(&mut this, v: T) -> bool { _builtin() }
    pub fun remove(&mut this, v: &T) -> bool { _builtin() }
    pub fun iter(&this) -> Iterator[&T] { _builtin() }
}

// ---- integers: explicit overflow behaviour (spec §9.5: `+`, `-`, `*` always panic on overflow) ---------
// `wrapping_*` wraps around (two's complement), `saturating_*` stops at the type's bounds, and
// `checked_*` is `None` on overflow.

impl int {
    pub fun wrapping_add(this, o: int) -> int { _builtin() }
    pub fun saturating_add(this, o: int) -> int { _builtin() }
    pub fun checked_add(this, o: int) -> int? { _builtin() }
    pub fun wrapping_sub(this, o: int) -> int { _builtin() }
    pub fun saturating_sub(this, o: int) -> int { _builtin() }
    pub fun checked_sub(this, o: int) -> int? { _builtin() }
    pub fun wrapping_mul(this, o: int) -> int { _builtin() }
    pub fun saturating_mul(this, o: int) -> int { _builtin() }
    pub fun checked_mul(this, o: int) -> int? { _builtin() }
}

impl isize {
    pub fun wrapping_add(this, o: isize) -> isize { _builtin() }
    pub fun saturating_add(this, o: isize) -> isize { _builtin() }
    pub fun checked_add(this, o: isize) -> isize? { _builtin() }
    pub fun wrapping_sub(this, o: isize) -> isize { _builtin() }
    pub fun saturating_sub(this, o: isize) -> isize { _builtin() }
    pub fun checked_sub(this, o: isize) -> isize? { _builtin() }
    pub fun wrapping_mul(this, o: isize) -> isize { _builtin() }
    pub fun saturating_mul(this, o: isize) -> isize { _builtin() }
    pub fun checked_mul(this, o: isize) -> isize? { _builtin() }
}

impl usize {
    pub fun wrapping_add(this, o: usize) -> usize { _builtin() }
    pub fun saturating_add(this, o: usize) -> usize { _builtin() }
    pub fun checked_add(this, o: usize) -> usize? { _builtin() }
    pub fun wrapping_sub(this, o: usize) -> usize { _builtin() }
    pub fun saturating_sub(this, o: usize) -> usize { _builtin() }
    pub fun checked_sub(this, o: usize) -> usize? { _builtin() }
    pub fun wrapping_mul(this, o: usize) -> usize { _builtin() }
    pub fun saturating_mul(this, o: usize) -> usize { _builtin() }
    pub fun checked_mul(this, o: usize) -> usize? { _builtin() }
}

impl i8 {
    pub fun wrapping_add(this, o: i8) -> i8 { _builtin() }
    pub fun saturating_add(this, o: i8) -> i8 { _builtin() }
    pub fun checked_add(this, o: i8) -> i8? { _builtin() }
    pub fun wrapping_sub(this, o: i8) -> i8 { _builtin() }
    pub fun saturating_sub(this, o: i8) -> i8 { _builtin() }
    pub fun checked_sub(this, o: i8) -> i8? { _builtin() }
    pub fun wrapping_mul(this, o: i8) -> i8 { _builtin() }
    pub fun saturating_mul(this, o: i8) -> i8 { _builtin() }
    pub fun checked_mul(this, o: i8) -> i8? { _builtin() }
}

impl i16 {
    pub fun wrapping_add(this, o: i16) -> i16 { _builtin() }
    pub fun saturating_add(this, o: i16) -> i16 { _builtin() }
    pub fun checked_add(this, o: i16) -> i16? { _builtin() }
    pub fun wrapping_sub(this, o: i16) -> i16 { _builtin() }
    pub fun saturating_sub(this, o: i16) -> i16 { _builtin() }
    pub fun checked_sub(this, o: i16) -> i16? { _builtin() }
    pub fun wrapping_mul(this, o: i16) -> i16 { _builtin() }
    pub fun saturating_mul(this, o: i16) -> i16 { _builtin() }
    pub fun checked_mul(this, o: i16) -> i16? { _builtin() }
}

impl i32 {
    pub fun wrapping_add(this, o: i32) -> i32 { _builtin() }
    pub fun saturating_add(this, o: i32) -> i32 { _builtin() }
    pub fun checked_add(this, o: i32) -> i32? { _builtin() }
    pub fun wrapping_sub(this, o: i32) -> i32 { _builtin() }
    pub fun saturating_sub(this, o: i32) -> i32 { _builtin() }
    pub fun checked_sub(this, o: i32) -> i32? { _builtin() }
    pub fun wrapping_mul(this, o: i32) -> i32 { _builtin() }
    pub fun saturating_mul(this, o: i32) -> i32 { _builtin() }
    pub fun checked_mul(this, o: i32) -> i32? { _builtin() }
}

impl i64 {
    pub fun wrapping_add(this, o: i64) -> i64 { _builtin() }
    pub fun saturating_add(this, o: i64) -> i64 { _builtin() }
    pub fun checked_add(this, o: i64) -> i64? { _builtin() }
    pub fun wrapping_sub(this, o: i64) -> i64 { _builtin() }
    pub fun saturating_sub(this, o: i64) -> i64 { _builtin() }
    pub fun checked_sub(this, o: i64) -> i64? { _builtin() }
    pub fun wrapping_mul(this, o: i64) -> i64 { _builtin() }
    pub fun saturating_mul(this, o: i64) -> i64 { _builtin() }
    pub fun checked_mul(this, o: i64) -> i64? { _builtin() }
}

impl u8 {
    pub fun wrapping_add(this, o: u8) -> u8 { _builtin() }
    pub fun saturating_add(this, o: u8) -> u8 { _builtin() }
    pub fun checked_add(this, o: u8) -> u8? { _builtin() }
    pub fun wrapping_sub(this, o: u8) -> u8 { _builtin() }
    pub fun saturating_sub(this, o: u8) -> u8 { _builtin() }
    pub fun checked_sub(this, o: u8) -> u8? { _builtin() }
    pub fun wrapping_mul(this, o: u8) -> u8 { _builtin() }
    pub fun saturating_mul(this, o: u8) -> u8 { _builtin() }
    pub fun checked_mul(this, o: u8) -> u8? { _builtin() }
}

impl u16 {
    pub fun wrapping_add(this, o: u16) -> u16 { _builtin() }
    pub fun saturating_add(this, o: u16) -> u16 { _builtin() }
    pub fun checked_add(this, o: u16) -> u16? { _builtin() }
    pub fun wrapping_sub(this, o: u16) -> u16 { _builtin() }
    pub fun saturating_sub(this, o: u16) -> u16 { _builtin() }
    pub fun checked_sub(this, o: u16) -> u16? { _builtin() }
    pub fun wrapping_mul(this, o: u16) -> u16 { _builtin() }
    pub fun saturating_mul(this, o: u16) -> u16 { _builtin() }
    pub fun checked_mul(this, o: u16) -> u16? { _builtin() }
}

impl u32 {
    pub fun wrapping_add(this, o: u32) -> u32 { _builtin() }
    pub fun saturating_add(this, o: u32) -> u32 { _builtin() }
    pub fun checked_add(this, o: u32) -> u32? { _builtin() }
    pub fun wrapping_sub(this, o: u32) -> u32 { _builtin() }
    pub fun saturating_sub(this, o: u32) -> u32 { _builtin() }
    pub fun checked_sub(this, o: u32) -> u32? { _builtin() }
    pub fun wrapping_mul(this, o: u32) -> u32 { _builtin() }
    pub fun saturating_mul(this, o: u32) -> u32 { _builtin() }
    pub fun checked_mul(this, o: u32) -> u32? { _builtin() }
}

impl u64 {
    pub fun wrapping_add(this, o: u64) -> u64 { _builtin() }
    pub fun saturating_add(this, o: u64) -> u64 { _builtin() }
    pub fun checked_add(this, o: u64) -> u64? { _builtin() }
    pub fun wrapping_sub(this, o: u64) -> u64 { _builtin() }
    pub fun saturating_sub(this, o: u64) -> u64 { _builtin() }
    pub fun checked_sub(this, o: u64) -> u64? { _builtin() }
    pub fun wrapping_mul(this, o: u64) -> u64 { _builtin() }
    pub fun saturating_mul(this, o: u64) -> u64 { _builtin() }
    pub fun checked_mul(this, o: u64) -> u64? { _builtin() }
}
// ---- strings (implemented once on &str, spec §10.3) -------------------------------------------

impl string {
    // core: offsets (UTF-8 bytes), Unicode tables, float parsing
    /// The length in bytes (UTF-8).
    pub fun len(&this) -> int { _builtin() }
    /// The bytes from `start` to `end` (clamped to the string); an offset inside a character panics.
    pub fun substring(&this, start: int, end: int) -> &str { _builtin() }
    /// The byte at offset `i` (panics out of bounds).
    pub fun byte_at(&this, i: int) -> u8 { _builtin() }
    /// The offset of the first `needle` at or after `from`.
    pub fun find(&this, needle: &str, from: int) -> int? { _builtin() }
    pub fun to_lower(&this) -> string { _builtin() }
    pub fun to_upper(&this) -> string { _builtin() }
    pub fun to_float(&this) -> Result[f64, string] { _builtin() }
    pub fun bytes(&this) -> Vec[u8] { _builtin() }
    pub fun chars(&this) -> Vec[char] { _builtin() }
    pub fun as_ptr(&this) -> *u8 { _builtin() }

    pub fun is_empty(&this) -> bool { this.len() == 0 }
    pub fun contains(&this, s: &str) -> bool { this.find(s, 0).is_some() }
    pub fun starts_with(&this, s: &str) -> bool {
        this.len() >= s.len() && this.substring(0, s.len()) == s
    }
    pub fun ends_with(&this, s: &str) -> bool {
        this.len() >= s.len() && this.substring(this.len() - s.len(), this.len()) == s
    }
    /// Without leading and trailing spaces, tabs and line breaks.
    pub fun trim(&this) -> &str {
        var start = 0
        var end = this.len()
        for start < end && is_space(this.byte_at(start)) {
            start += 1
        }
        for end > start && is_space(this.byte_at(end - 1)) {
            end -= 1
        }
        this.substring(start, end)
    }
    pub fun strip_prefix(&this, p: &str) -> &str { this.try_strip_prefix(p) ?? this }
    pub fun strip_suffix(&this, s: &str) -> &str { this.try_strip_suffix(s) ?? this }
    pub fun try_strip_prefix(&this, p: &str) -> &str? {
        if this.starts_with(p) { Some(this.substring(p.len(), this.len())) } else { None }
    }
    pub fun try_strip_suffix(&this, s: &str) -> &str? {
        if s.len() > 0 && this.ends_with(s) { Some(this.substring(0, this.len() - s.len())) } else { None }
    }
    /// The parts between each `sep` (an empty `sep` splits into characters).
    pub fun split(&this, sep: &str) -> Vec[&str] {
        var parts = [] as Vec[&str]
        if sep.is_empty() {
            var at = 0
            for c in this.chars() {
                let n = c.to_str().len()
                parts.push(this.substring(at, at + n))
                at += n
            }
            return parts
        }
        var start = 0
        for let Some(at) = this.find(sep, start) {
            parts.push(this.substring(start, at))
            start = at + sep.len()
        }
        parts.push(this.substring(start, this.len()))
        parts
    }
    /// The lines, without their `\n` or `\r\n`.
    pub fun lines(&this) -> Vec[&str] {
        this.split("\n").map(#{ line => line.strip_suffix("\r") })
    }
    pub fun replace(&this, from: &str, to: &str) -> string { this.split(from).join(to) }
    pub fun to_int(&this) -> Result[int, string] {
        let s = this.trim()
        var i = 0
        var negative = false
        if s.starts_with("-") || s.starts_with("+") {
            negative = s.starts_with("-")
            i = 1
        }
        if i >= s.len() {
            return Err("not an integer: \"${this}\"")
        }
        var n = 0
        for i < s.len() {
            let b = s.byte_at(i) as int
            if b < 48 || b > 57 {
                return Err("not an integer: \"${this}\"")
            }
            n = n * 10 + (b - 48)          // overflow panics (spec §9.5)
            i += 1
        }
        Ok(if negative { -n } else { n })
    }
}

fun is_space(b: u8) -> bool { b == 32 || b == 9 || b == 10 || b == 13 }

// ---- async ------------------------------------------------------------------------------------

pub type Timeout = {}

pub type Promise[T] = {
    pub fun new() -> t(Promise[T], Resolver[T]) { _builtin() }
    pub fun all(promises: Vec[Promise[T]]) -> Promise[Vec[T]] { _builtin() }
    pub fun then(this, f: (T) -> void) -> Promise[T] { _builtin() }
    pub fun catch(this, f: (Panic) -> void) -> Promise[T] { _builtin() }
    pub fun ignore(this) { _builtin() }
    pub fun timeout(this, ms: int) -> Promise[Result[T, Timeout]] { _builtin() }
    pub fun cancel(&this) { _builtin() }
    pub fun is_done(&this) -> bool { _builtin() }
}

pub type Resolver[T] = {
    pub fun resolve(this, v: T) { _builtin() }
}

// ---- shared state and inter-task communication (spec §9.9, §9.10) ------------------------------

pub type Ref[T] = {
    pub fun new(v: T) -> Ref[T] { _builtin() }
    pub fun get(&this) -> T { _builtin() }
    pub fun set(&this, v: T) { _builtin() }
    pub fun read[R](&this, f: &(&T) -> R) -> R { _builtin() }
    pub fun update[R](&this, f: &(&mut T) -> R) -> R { _builtin() }
    pub fun reset(&this, v: T) { _builtin() }
    pub fun weak(&this) -> Weak[T] { _builtin() }
}

pub type Weak[T] = {
    pub fun upgrade(&this) -> Ref[T]? { _builtin() }
}

pub type Box[T] = {
    pub fun new(v: T) -> Box[T] { _builtin() }
    pub fun get(&this) -> &T { _builtin() }
    pub fun set(&mut this, v: T) { _builtin() }
}

pub type TopicOptions = { buffer: int = 64, replay: int = 0 }
pub type QueueOptions = { capacity: int = 1024 }

pub union PublishError[T] = { Full(T)  Closed(T) }

pub type Topic[T] = {
    pub fun new() -> Topic[T] { _builtin() }
    pub fun with(opts: TopicOptions) -> Topic[T] { _builtin() }
    pub fun publish(&this, v: T) -> int { _builtin() }
    pub fun subscribe(&this) -> Sub[T] { _builtin() }
    pub fun subscribers(&this) -> int { _builtin() }
    pub fun close(&this) { _builtin() }
}

pub type Queue[T] = {
    pub fun new() -> Queue[T] { _builtin() }
    pub fun with(opts: QueueOptions) -> Queue[T] { _builtin() }
    pub async fun publish(&this, v: T) -> Result[void, PublishError[T]] { _builtin() }
    pub fun try_publish(&this, v: T) -> Result[void, PublishError[T]] { _builtin() }
    pub async fun publish_timeout(&this, v: T, ms: int) -> Result[void, PublishError[T]] { _builtin() }
    pub fun subscribe(&this) -> Sub[T] { _builtin() }
    pub fun len(&this) -> int { _builtin() }
    pub fun close(&this) { _builtin() }
}

pub type Sub[T] = {
    pub async fun next(&mut this) -> T? { _builtin() }
    pub fun try_next(&mut this) -> T? { _builtin() }
    pub fun missed(&mut this) -> int { _builtin() }
}

pub type Signal[T] = {
    pub fun new(v: T) -> Signal[T] { _builtin() }
    pub fun get(&this) -> T { _builtin() }
    pub fun read[R](&this, f: &(&T) -> R) -> R { _builtin() }
    pub fun set(&this, v: T) { _builtin() }
    pub fun update[R](&this, f: &(&mut T) -> R) -> R { _builtin() }
    pub fun watch(&this) -> Watcher[T] { _builtin() }
}

pub type Watcher[T] = {
    pub async fun next(&mut this) -> T? { _builtin() }
}

// ---- panics -----------------------------------------------------------------------------------

pub union PanicKind = { User  Overflow  OutOfBounds  MissingKey  Unwrap  Deadlock  Cancelled  ResolverDropped  SelectExhausted }

pub type Panic = {
    pub message: string
    pub file: string
    pub line: int
    pub trace: string
    pub kind: PanicKind
}

// ---- log (spec §10.1) -------------------------------------------------------------------------

pub type Log = {
    pub fun println(&this, ...args: &Stringer) { _builtin() }
    pub fun print(&this, ...args: &Stringer) { _builtin() }
    pub fun info(&this, ...args: &Stringer) { _builtin() }
    pub fun warn(&this, ...args: &Stringer) { _builtin() }
    pub fun error(&this, ...args: &Stringer) { _builtin() }
    pub fun debug(&this, ...args: &Stringer) { _builtin() }
}

pub let log = Log {}

// ---- core interfaces (spec §10.2) -------------------------------------------------------------

pub inter Copy = {}
pub inter Handle = {}
pub inter Clone = { fun clone(&this) -> Self }
pub inter Drop = { fun drop(mut this) }
pub inter Default = { fun default() -> Self }
pub inter Stringer = { fun to_str(&this) -> string }
pub inter PartialEq[T] = { fun eq(&this, o: &T) -> bool }
pub inter PartialOrd[T]: PartialEq[T] = { fun partial_cmp(&this, o: &T) -> Ordering? }
pub inter Hash = { fun hash(&this) -> u64 }

pub inter Plus[R, O] = { fun plus(&this, rhs: R) -> O }
pub inter Minus[R, O] = { fun minus(&this, rhs: R) -> O }
pub inter Times[R, O] = { fun times(&this, rhs: R) -> O }
pub inter Divide[R, O] = { fun divide(&this, rhs: R) -> O }
pub inter Remainder[R, O] = { fun remainder(&this, rhs: R) -> O }
pub inter PlusAssign[R] = { fun plus_assign(&mut this, rhs: R) }
pub inter MinusAssign[R] = { fun minus_assign(&mut this, rhs: R) }
pub inter TimesAssign[R] = { fun times_assign(&mut this, rhs: R) }
pub inter DivideAssign[R] = { fun divide_assign(&mut this, rhs: R) }
pub inter RemainderAssign[R] = { fun remainder_assign(&mut this, rhs: R) }

pub inter Index[I, T] = { fun index(&this, i: I) -> &T }
pub inter IndexMut[I, T] = { fun index_mut(&mut this, i: I) -> &mut T }
pub inter Iterator[T] = {
    fun next(&mut this) -> T?
    fun map[U](&mut this, f: &(T) -> U) -> Iterator[U] { _builtin() }
    fun filter(&mut this, f: &(&T) -> bool) -> Iterator[T] { _builtin() }
    fun collect(&mut this) -> Vec[T] { _builtin() }
}
pub inter AsyncIterator[T] = { async fun next(&mut this) -> T? }
pub inter Iterable[T] = {
    fun iter(&this) -> Iterator[&T]
    fun iter_mut(&mut this) -> Iterator[&mut T]
    fun into_iter(this) -> Iterator[T]
}
