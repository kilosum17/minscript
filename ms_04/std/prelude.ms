package prelude

// The MinScript prelude (spec §14.1, §14.2): every `pub` name here is visible in every package
// without an import. Functions whose body is `_builtin()` are the core, implemented by each back
// end; `#[effects]` states their summary where they keep, consume or return a view (§9.5).
// Everything else is MinScript on top of the core. Generated methods (`to_str`, `eq`, `hash`,
// `default`, `same_fields`, §13.2) exist on every type that supports them and are not declared here.

pub fn _builtin() -> never { _builtin() }

pub fn assert(cond: bool, msg: str) {
    if !cond { panic(msg) }
}

pub fn panic(msg: str) -> never { _builtin() }

/// A panic of a given kind (`Unwrap`, `OutOfBounds`…), for the prelude's own checks.
fn _panic_kind(kind: PanicKind, msg: str) -> never { _builtin() }

// ---- Option, Result, Ordering ------------------------------------------------------------------

pub union Option[T: Unique] {
    Some(T)
    None

    pub fn is_some(this) -> bool {
        match this {
            Some(_) => true
            None => false
        }
    }
    pub fn is_none(this) -> bool { !this.is_some() }
    pub fn unwrap(this) -> T {
        match this {
            Some(v) => v
            None => _panic_kind(Unwrap, "unwrap of None")
        }
    }
    pub fn expect(this, msg: str) -> T {
        match this {
            Some(v) => v
            None => _panic_kind(Unwrap, msg)
        }
    }
    /// A value, or `#{…}` for a lazy fallback (spec §22 #20).
    pub fn or[F](this, fallback: F) -> T { _builtin() }
    pub fn map[U](this, f: (T) -> U) -> U? {
        match this {
            Some(v) => Some(f(v))
            None => None
        }
    }
    pub fn and_then[U](this, f: (T) -> U?) -> U? {
        match this {
            Some(v) => f(v)
            None => None
        }
    }
    pub fn ok_or[E](this, err: E) -> Result[T, E] {
        match this {
            Some(v) => Ok(v)
            None => Err(err)
        }
    }
    pub fn filter(this, f: (T) -> bool) -> T? {
        match this {
            Some(v) => if f(v) { Some(v) } else { None }
            None => None
        }
    }
}

pub union Result[T: Unique, E: Unique] {
    Ok(T)
    Err(E)

    pub fn is_ok(this) -> bool {
        match this {
            Ok(_) => true
            Err(_) => false
        }
    }
    pub fn is_err(this) -> bool { !this.is_ok() }
    pub fn unwrap(this) -> T {
        match this {
            Ok(v) => v
            Err(e) => _panic_kind(Unwrap, "unwrap of Err(${e})")
        }
    }
    pub fn expect(this, msg: str) -> T {
        match this {
            Ok(v) => v
            Err(_) => _panic_kind(Unwrap, msg)
        }
    }
    pub fn unwrap_err(this) -> E {
        match this {
            Ok(_) => _panic_kind(Unwrap, "unwrap_err of Ok")
            Err(e) => e
        }
    }
    pub fn ok(this) -> T? {
        match this {
            Ok(v) => Some(v)
            Err(_) => None
        }
    }
    pub fn err(this) -> E? {
        match this {
            Ok(_) => None
            Err(e) => Some(e)
        }
    }
    pub fn or[F](this, fallback: F) -> T { _builtin() }
    pub fn map[U](this, f: (T) -> U) -> Result[U, E] {
        match this {
            Ok(v) => Ok(f(v))
            Err(e) => Err(e)
        }
    }
    pub fn map_err[F](this, f: (E) -> F) -> Result[T, F] {
        match this {
            Ok(v) => Ok(v)
            Err(e) => Err(f(e))
        }
    }
    pub fn and_then[U](this, f: (T) -> Result[U, E]) -> Result[U, E] {
        match this {
            Ok(v) => f(v)
            Err(e) => Err(e)
        }
    }
}

pub union Ordering { Less  Equal  Greater }

// ---- collections -------------------------------------------------------------------------------

// Containers that may hold `Unique` values (a Vec of subscriptions, a job carrying a Resolver)
// declare `[T: Unique]` (§9.2): the bound admits Unique and non-Unique types alike.

// The core is storage and hashing (`len`, `push`, `pop`, `insert`, `remove`, `truncate`, `swap`,
// `sort_by`, `iter`, Map / Set access). Getters return views, never copies (§9.6).

pub type Range[T] {
    pub fn contains(this, v: T) -> bool { _builtin() }
    pub fn len(this) -> int { _builtin() }
    pub fn rev(this) -> Iterator[T] { _builtin() }
    pub fn iter(this) -> Iterator[T] { _builtin() }
}

pub type Vec[T: Unique] {
    pub fn new() -> Vec[T] { [] }
    pub fn with_capacity(n: int) -> Vec[T] { _builtin() }

    pub fn len(this) -> int { _builtin() }
    pub fn is_empty(this) -> bool { this.len() == 0 }
    #[effects(returns_view: [this])]
    pub fn get(this, i: int) -> T? { _builtin() }
    /// Like `get`, and a negative index counts from the end (`at(-1)` is the last item).
    pub fn at(this, i: int) -> T? {
        this.get(if i < 0 { this.len() + i } else { i })
    }
    pub fn first(this) -> T? { this.get(0) }
    pub fn last(this) -> T? { this.get(this.len() - 1) }
    pub fn contains(this, v: T) -> bool { this.index_of(v).is_some() }
    pub fn index_of(this, v: T) -> int? {
        for x, i in this {
            if x == v { return Some(i) }
        }
        None
    }

    #[effects(keeps: [v])]
    pub fn push(*this, v: T) { _builtin() }
    pub fn pop(*this) -> T? { _builtin() }
    #[effects(keeps: [v])]
    pub fn insert(*this, i: int, v: T) { _builtin() }
    pub fn remove(*this, i: int) -> T { _builtin() }
    /// Keeps the first `n` items.
    pub fn truncate(*this, n: int) { _builtin() }
    pub fn swap(*this, i: int, j: int) { _builtin() }
    pub fn clear(*this) { this.truncate(0) }
    /// Moves every item out and leaves this Vec empty.
    pub fn drain(*this) -> Vec[T] { _builtin() }
    pub fn extend(*this, other: Vec[T]) {
        for x in other { this.push(x) }
    }
    pub fn sort_by(*this, f: (T, T) -> Ordering) { _builtin() }
    pub fn reverse(*this) {
        var i = 0
        var j = this.len() - 1
        for i < j {
            this.swap(i, j)
            i += 1
            j -= 1
        }
    }
    /// A write view of item `i` (§9.7).
    pub fn at_mut(*this, i: int) -> *T { _builtin() }

    #[effects(returns_view: [this])]
    pub fn iter(this) -> Iterator[T] { _builtin() }

    // pipeline callbacks receive (item, index); a callback may take fewer parameters (§13.5)
    pub fn map[U](this, f: (T, int) -> U) -> Vec[U] {
        var out = Vec.with_capacity.[U](this.len())
        for x, i in this { out.push(f(x, i)) }
        out
    }
    /// A new Vec whose items share the originals' buffers (copy-on-write, §9.1).
    pub fn filter(this, f: (T, int) -> bool) -> Vec[T] {
        out :== [] as Vec[T]
        for x, i in this {
            if f(x, i) { out.push(x) }
        }
        out
    }
    pub fn find(this, f: (T, int) -> bool) -> T? {
        for x, i in this {
            if f(x, i) { return Some(x) }
        }
        None
    }
    pub fn any(this, f: (T, int) -> bool) -> bool {
        for x, i in this {
            if f(x, i) { return true }
        }
        false
    }
    pub fn all(this, f: (T, int) -> bool) -> bool {
        for x, i in this {
            if !f(x, i) { return false }
        }
        true
    }
    pub fn count(this, f: (T, int) -> bool) -> int {
        var n = 0
        for x, i in this {
            if f(x, i) { n += 1 }
        }
        n
    }
    pub fn for_each(this, f: (T, int) -> void) {
        for x, i in this { f(x, i) }
    }
    pub fn fold[A](this, init: A, f: (A, T) -> A) -> A {
        var acc = init
        for x in this { acc = f(acc, x) }
        acc
    }
    pub fn reduce[A](this, init: A, f: (A, T) -> A) -> A { this.fold(init, f) }
    pub fn take(this, n: int) -> Vec[T] { this.filter(#{ _, i => i < n }) }
    pub fn skip(this, n: int) -> Vec[T] { this.filter(#{ _, i => i >= n }) }
    pub fn to_vec(this) -> Vec[T] { this.filter(#{ true }) }
}

// methods that need something of the items: only on Vecs whose items have it
impl[T: PartialOrd[T]] Vec[T] {
    pub fn max(this) -> T? {
        var b: T? = None
        for x in this {
            b = match b {
                Some(m) => Some(if x > m { x } else { m })
                None => Some(x)
            }
        }
        b
    }
    pub fn min(this) -> T? {
        var b: T? = None
        for x in this {
            b = match b {
                Some(m) => Some(if x < m { x } else { m })
                None => Some(x)
            }
        }
        b
    }
    pub fn sort(*this) {
        this.sort_by(#{ a, b => if a < b { Less } else if a > b { Greater } else { Equal } })
    }
}

impl[T: Stringer] Vec[T] {
    pub fn join(this, sep: str) -> str {
        var out = ""
        for x, i in this {
            if i > 0 { out += sep }
            out += x.to_str()
        }
        out
    }
}

impl[T: Plus[T, T] & Default] Vec[T] {
    pub fn sum(this) -> T {
        var total = T.default()             // through T's type witness (§15.3)
        for x in this { total = total + x }
        total
    }
}

pub type Array[T: Unique, N] {
    pub fn len(this) -> int { _builtin() }
    #[effects(returns_view: [this])]
    pub fn get(this, i: int) -> T? { _builtin() }
    #[effects(returns_view: [this])]
    pub fn iter(this) -> Iterator[T] { _builtin() }
    pub fn to_vec(this) -> Vec[T] {
        out :== [] as Vec[T]
        for x in this { out.push(x) }
        out
    }
}

pub type Slice[T: Unique] {
    pub fn len(this) -> int { _builtin() }
    pub fn is_empty(this) -> bool { this.len() == 0 }
    #[effects(returns_view: [this])]
    pub fn get(this, i: int) -> T? { _builtin() }
    #[effects(returns_view: [this])]
    pub fn iter(this) -> Iterator[T] { _builtin() }
    pub fn to_vec(this) -> Vec[T] {
        out :== [] as Vec[T]
        for x in this { out.push(x) }
        out
    }
}

pub type Map[K, V: Unique] {
    pub fn new() -> Map[K, V] { _builtin() }
    pub fn len(this) -> int { _builtin() }
    pub fn is_empty(this) -> bool { this.len() == 0 }
    #[effects(returns_view: [this])]
    pub fn get(this, k: K) -> V? { _builtin() }
    pub fn has(this, k: K) -> bool { _builtin() }
    #[effects(keeps: [k, v])]
    pub fn insert(*this, k: K, v: V) -> V? { _builtin() }
    pub fn remove(*this, k: K) -> V? { _builtin() }
    pub fn clear(*this) { _builtin() }
    /// Moves every entry out into a new Map and leaves this one empty.
    pub fn drain(*this) -> Map[K, V] { _builtin() }
    /// A write view of the entry for `k`, inserting `v` first if it is missing (§9.7).
    #[effects(keeps: [k, v])]
    pub fn entry(*this, k: K, v: V) -> *V { _builtin() }
    pub fn keys(this) -> Vec[K] {
        out :== [] as Vec[K]
        for k, _ in this { out.push(k) }
        out
    }
    pub fn values(this) -> Vec[V] {
        out :== [] as Vec[V]
        for _, v in this { out.push(v) }
        out
    }
    #[effects(returns_view: [this])]
    pub fn iter(this) -> Iterator[t(K, V)] { _builtin() }
}

pub type Set[T] {
    pub fn new() -> Set[T] { _builtin() }
    pub fn len(this) -> int { _builtin() }
    pub fn is_empty(this) -> bool { this.len() == 0 }
    pub fn has(this, v: T) -> bool { _builtin() }
    #[effects(keeps: [v])]
    pub fn insert(*this, v: T) -> bool { _builtin() }
    pub fn remove(*this, v: T) -> bool { _builtin() }
    #[effects(returns_view: [this])]
    pub fn iter(this) -> Iterator[T] { _builtin() }
}

/// A persistent map (§12.5): `with` returns a new version in O(log n); older versions stay valid.
pub type PMap[K, V] {
    pub fn new() -> PMap[K, V] { _builtin() }
    #[effects(keeps: [this, k, v])]
    pub fn with(this, k: K, v: V) -> PMap[K, V] { _builtin() }
    #[effects(keeps: [this])]
    pub fn without(this, k: K) -> PMap[K, V] { _builtin() }
    #[effects(returns_view: [this])]
    pub fn get(this, k: K) -> V? { _builtin() }
    pub fn has(this, k: K) -> bool { _builtin() }
    pub fn len(this) -> int { _builtin() }
    #[effects(returns_view: [this])]
    pub fn iter(this) -> Iterator[t(K, V)] { _builtin() }
}

/// A persistent vector (§12.5): each change returns a new version.
pub type PVec[T] {
    pub fn new() -> PVec[T] { _builtin() }
    #[effects(keeps: [this, v])]
    pub fn push(this, v: T) -> PVec[T] { _builtin() }
    #[effects(keeps: [this, v])]
    pub fn set(this, i: int, v: T) -> PVec[T] { _builtin() }
    #[effects(keeps: [this])]
    pub fn pop(this) -> PVec[T] { _builtin() }
    #[effects(returns_view: [this])]
    pub fn get(this, i: int) -> T? { _builtin() }
    pub fn len(this) -> int { _builtin() }
    #[effects(returns_view: [this])]
    pub fn iter(this) -> Iterator[T] { _builtin() }
}

// ---- integers: explicit overflow behaviour (§13.1: `+`, `-`, `*` always panic on overflow) -------
// `wrapping_*` wraps around (two's complement), `saturating_*` stops at the type's bounds, and
// `checked_*` is `None` on overflow.

impl int {
    pub fn wrapping_add(this, o: int) -> int { _builtin() }
    pub fn saturating_add(this, o: int) -> int { _builtin() }
    pub fn checked_add(this, o: int) -> int? { _builtin() }
    pub fn wrapping_sub(this, o: int) -> int { _builtin() }
    pub fn saturating_sub(this, o: int) -> int { _builtin() }
    pub fn checked_sub(this, o: int) -> int? { _builtin() }
    pub fn wrapping_mul(this, o: int) -> int { _builtin() }
    pub fn saturating_mul(this, o: int) -> int { _builtin() }
    pub fn checked_mul(this, o: int) -> int? { _builtin() }
}

impl i64 {
    pub fn wrapping_add(this, o: i64) -> i64 { _builtin() }
    pub fn saturating_add(this, o: i64) -> i64 { _builtin() }
    pub fn checked_add(this, o: i64) -> i64? { _builtin() }
    pub fn wrapping_sub(this, o: i64) -> i64 { _builtin() }
    pub fn saturating_sub(this, o: i64) -> i64 { _builtin() }
    pub fn checked_sub(this, o: i64) -> i64? { _builtin() }
    pub fn wrapping_mul(this, o: i64) -> i64 { _builtin() }
    pub fn saturating_mul(this, o: i64) -> i64 { _builtin() }
    pub fn checked_mul(this, o: i64) -> i64? { _builtin() }
}

impl u8 {
    pub fn wrapping_add(this, o: u8) -> u8 { _builtin() }
    pub fn saturating_add(this, o: u8) -> u8 { _builtin() }
    pub fn checked_add(this, o: u8) -> u8? { _builtin() }
    pub fn wrapping_sub(this, o: u8) -> u8 { _builtin() }
    pub fn saturating_sub(this, o: u8) -> u8 { _builtin() }
    pub fn checked_sub(this, o: u8) -> u8? { _builtin() }
    pub fn wrapping_mul(this, o: u8) -> u8 { _builtin() }
    pub fn saturating_mul(this, o: u8) -> u8 { _builtin() }
    pub fn checked_mul(this, o: u8) -> u8? { _builtin() }
}

impl u32 {
    pub fn wrapping_add(this, o: u32) -> u32 { _builtin() }
    pub fn saturating_add(this, o: u32) -> u32 { _builtin() }
    pub fn checked_add(this, o: u32) -> u32? { _builtin() }
    pub fn wrapping_sub(this, o: u32) -> u32 { _builtin() }
    pub fn saturating_sub(this, o: u32) -> u32 { _builtin() }
    pub fn checked_sub(this, o: u32) -> u32? { _builtin() }
    pub fn wrapping_mul(this, o: u32) -> u32 { _builtin() }
    pub fn saturating_mul(this, o: u32) -> u32 { _builtin() }
    pub fn checked_mul(this, o: u32) -> u32? { _builtin() }
}

impl u64 {
    pub fn wrapping_add(this, o: u64) -> u64 { _builtin() }
    pub fn saturating_add(this, o: u64) -> u64 { _builtin() }
    pub fn checked_add(this, o: u64) -> u64? { _builtin() }
    pub fn wrapping_sub(this, o: u64) -> u64 { _builtin() }
    pub fn saturating_sub(this, o: u64) -> u64 { _builtin() }
    pub fn checked_sub(this, o: u64) -> u64? { _builtin() }
    pub fn wrapping_mul(this, o: u64) -> u64 { _builtin() }
    pub fn saturating_mul(this, o: u64) -> u64 { _builtin() }
    pub fn checked_mul(this, o: u64) -> u64? { _builtin() }
}

// ---- strings (§7.3, §14.3): one type, `str`; offsets are UTF-8 bytes --------------------------

impl str {
    /// The length in bytes (UTF-8).
    pub fn len(this) -> int { _builtin() }
    /// The bytes from `start` to `end` (clamped); an offset inside a character panics.
    #[effects(returns_view: [this])]
    pub fn substring(this, start: int, end: int) -> str { _builtin() }
    /// The byte at offset `i` (panics out of bounds).
    pub fn byte_at(this, i: int) -> u8 { _builtin() }
    /// The offset of the first `needle` at or after `from`.
    pub fn find(this, needle: str, from: int) -> int? { _builtin() }
    pub fn to_lower(this) -> str { _builtin() }
    pub fn to_upper(this) -> str { _builtin() }
    pub fn to_float(this) -> Result[f64, str] { _builtin() }
    #[effects(returns_view: [this])]
    pub fn bytes(this) -> Slice[u8] { _builtin() }
    pub fn chars(this) -> Vec[char] { _builtin() }
    /// A copy in its own exact-size buffer, so a slice stops keeping its source alive (§7.3).
    pub fn detach(this) -> str { _builtin() }

    pub fn is_empty(this) -> bool { this.len() == 0 }
    pub fn contains(this, s: str) -> bool { this.find(s, 0).is_some() }
    pub fn starts_with(this, s: str) -> bool {
        this.len() >= s.len() && this.substring(0, s.len()) == s
    }
    pub fn ends_with(this, s: str) -> bool {
        this.len() >= s.len() && this.substring(this.len() - s.len(), this.len()) == s
    }
    /// Without leading and trailing spaces, tabs and line breaks.
    pub fn trim(this) -> str {
        var start = 0
        var end = this.len()
        for start < end && is_space(this.byte_at(start)) { start += 1 }
        for end > start && is_space(this.byte_at(end - 1)) { end -= 1 }
        this.substring(start, end)
    }
    pub fn strip_prefix(this, p: str) -> str { this.try_strip_prefix(p) ?? this }
    pub fn strip_suffix(this, s: str) -> str { this.try_strip_suffix(s) ?? this }
    pub fn try_strip_prefix(this, p: str) -> str? {
        if this.starts_with(p) { Some(this.substring(p.len(), this.len())) } else { None }
    }
    pub fn try_strip_suffix(this, s: str) -> str? {
        if s.len() > 0 && this.ends_with(s) { Some(this.substring(0, this.len() - s.len())) } else { None }
    }
    /// The parts between each `sep` (an empty `sep` splits into characters).
    pub fn split(this, sep: str) -> Vec[str] {
        var parts = [] as Vec[str]
        if sep.is_empty() {
            var at = 0
            for c in this.chars() {
                n := c.to_str().len()
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
    pub fn lines(this) -> Vec[str] {
        this.split("\n").map(#{ line => line.strip_suffix("\r") })
    }
    pub fn replace(this, from: str, to: str) -> str { this.split(from).join(to) }
    pub fn to_int(this) -> Result[int, str] {
        s := this.trim()
        var i = 0
        var negative = false
        if s.starts_with("-") || s.starts_with("+") {
            negative = s.starts_with("-")
            i = 1
        }
        if i >= s.len() { return Err("not an integer: \"${this}\"") }
        var n = 0
        for i < s.len() {
            let b = s.byte_at(i)
            if b < b'0' || b > b'9' { return Err("not an integer: \"${this}\"") }
            n = n * 10 + (b - b'0') as int          // overflow panics (§13.1)
            i += 1
        }
        Ok(if negative { -n } else { n })
    }
}

fn is_space(b: u8) -> bool { b == b' ' || b == b'\t' || b == b'\n' || b == b'\r' }

// ---- identity and symbols (§12) ----------------------------------------------------------------

/// An interned string (§12.3): one object per distinct text, so `==` and `hash` are O(1).
pub type Symbol: Identity {
    #[effects(returns_view: [this])]
    pub fn text(this) -> str { _builtin() }
}

/// The Symbol for `text`, created on first use (§12.3).
pub fn sym(text: str) -> Symbol { _builtin() }

/// A non-owning reference to an identity value (§12.4).
pub type Weak[T] {
    pub fn upgrade(this) -> T? { _builtin() }
}

/// A typed, generation-checked pool (§12.5).
pub type Pool[T] {
    pub fn new() -> Pool[T] { _builtin() }
    #[effects(keeps: [v])]
    pub fn add(*this, v: T) -> Id[T] { _builtin() }
    #[effects(returns_view: [this])]
    pub fn get(this, id: Id[T]) -> T? { _builtin() }
    pub fn remove(*this, id: Id[T]) -> T? { _builtin() }
}

pub type Id[T] {
    index: int
    generation: int
}

// ---- async (§11.1) -----------------------------------------------------------------------------

pub type Timeout {}

pub type Promise[T: Unique] {
    pub fn new() -> t(Promise[T], Resolver[T]) { _builtin() }
    pub fn all(promises: Vec[Promise[T]]) -> Promise[Vec[T]] { _builtin() }
    #[effects(keeps: [this, f])]
    pub fn then(this, f: (T) -> void) -> Promise[T] { _builtin() }
    #[effects(keeps: [this, f])]
    pub fn catch(this, f: (Panic) -> void) -> Promise[T] { _builtin() }
    pub fn ignore(this) { _builtin() }
    pub fn timeout(this, ms: int) -> Promise[Result[T, Timeout]] { _builtin() }
    pub fn cancel(this) { _builtin() }
    pub fn is_done(this) -> bool { _builtin() }
}

/// Completes its promise once (§11.1). Dropping it unresolved panics the awaiter (`ResolverDropped`).
pub type Resolver[T: Unique]: Unique {
    #[effects(consumes: [this])]
    pub fn resolve(this, v: T) { _builtin() }
}

/// `all(p1, …, pn)` and `race(p1, …, pn)` take a fixed set of promises of any types; the checker
/// types them as `Promise[t(T1, …, Tn)]` and `Promise[…]` of the winner (§11.1). The signatures
/// below are only what the resolver needs.
pub fn all[T](...promises: Promise[T]) -> Promise[Vec[T]] { _builtin() }
pub fn race[T](...promises: Promise[T]) -> Promise[T] { _builtin() }

// ---- inter-task communication (§11.3) ----------------------------------------------------------
// Each type is a struct with a `shared` field: copies alias the same state (§10.1).

pub type TopicOptions { buffer: int = 64, replay: int = 0 }
pub type QueueOptions { capacity: int = 1024 }

pub union PublishError[T: Unique] { Full(T)  Closed(T) }

type ChannelState[T: Unique] {
    open: bool = true
}

pub type Topic[T] {
    shared state: ChannelState[T] = ChannelState {}

    pub fn new() -> Topic[T] { _builtin() }
    pub fn with(opts: TopicOptions) -> Topic[T] { _builtin() }
    #[effects(keeps: [v])]
    pub fn publish(this, v: T) -> int { _builtin() }
    pub fn subscribe(this) -> Sub[T] { _builtin() }
    pub fn subscribers(this) -> int { _builtin() }
    pub fn close(this) { _builtin() }
}

pub type Queue[T: Unique] {
    shared state: ChannelState[T] = ChannelState {}

    pub fn new() -> Queue[T] { _builtin() }
    pub fn with(opts: QueueOptions) -> Queue[T] { _builtin() }
    #[effects(keeps: [v])]
    pub async fn publish(this, v: T) -> Result[void, PublishError[T]] { _builtin() }
    #[effects(keeps: [v])]
    pub fn try_publish(this, v: T) -> Result[void, PublishError[T]] { _builtin() }
    #[effects(keeps: [v])]
    pub async fn publish_timeout(this, v: T, ms: int) -> Result[void, PublishError[T]] { _builtin() }
    pub fn subscribe(this) -> Sub[T] { _builtin() }
    pub fn len(this) -> int { _builtin() }
    pub fn close(this) { _builtin() }
}

/// A subscription to a Topic or Queue: one owner (§9.2). Dropping it unsubscribes.
pub type Sub[T: Unique]: Unique {
    pub async fn next(*this) -> T? { _builtin() }
    pub fn try_next(*this) -> T? { _builtin() }
    pub fn missed(*this) -> int { _builtin() }
}

pub type Signal[T] {
    shared state: ChannelState[T] = ChannelState {}

    pub fn new(v: T) -> Signal[T] { _builtin() }
    #[effects(returns_view: [this])]
    pub fn get(this) -> T { _builtin() }
    #[effects(keeps: [v])]
    pub fn set(this, v: T) { _builtin() }
    pub fn update[R](this, f: (*T) -> R) -> R { _builtin() }
    pub fn watch(this) -> Watcher[T] { _builtin() }
}

pub type Watcher[T]: Unique {
    pub async fn next(*this) -> T? { _builtin() }
}

// ---- panics (§13.3, §18.5) ---------------------------------------------------------------------

pub union PanicKind {
    User  Overflow  OutOfBounds  MissingKey  Unwrap  AlreadySet
    SelectExhausted  Cancelled  ResolverDropped  Deadlock
}

pub type Panic {
    pub message: str
    pub file: str
    pub line: int
    pub trace: str
    pub kind: PanicKind
}

// ---- log ---------------------------------------------------------------------------------------

pub type Log {
    pub fn println(this, ...args: Stringer) { _builtin() }
    pub fn print(this, ...args: Stringer) { _builtin() }
    pub fn info(this, ...args: Stringer) { _builtin() }
    pub fn warn(this, ...args: Stringer) { _builtin() }
    pub fn error(this, ...args: Stringer) { _builtin() }
    pub fn debug(this, ...args: Stringer) { _builtin() }
}

pub let log = Log {}

// ---- core interfaces (§14.2) -------------------------------------------------------------------

pub inter Copy {}
pub inter Identity {}
pub inter Unique {}
pub inter Drop { fn drop(*this) }
pub inter Default { fn default() -> Self }
pub inter Stringer { fn to_str(this) -> str }
pub inter PartialEq[T] { fn eq(this, o: T) -> bool }
pub inter PartialOrd[T]: PartialEq[T] { fn partial_cmp(this, o: T) -> Ordering? }
pub inter Hash { fn hash(this) -> u64 }

pub inter Plus[R, O] { fn plus(this, rhs: R) -> O }
pub inter Minus[R, O] { fn minus(this, rhs: R) -> O }
pub inter Times[R, O] { fn times(this, rhs: R) -> O }
pub inter Divide[R, O] { fn divide(this, rhs: R) -> O }
pub inter Remainder[R, O] { fn remainder(this, rhs: R) -> O }
pub inter PlusAssign[R] { fn plus_assign(*this, rhs: R) }
pub inter MinusAssign[R] { fn minus_assign(*this, rhs: R) }
pub inter TimesAssign[R] { fn times_assign(*this, rhs: R) }
pub inter DivideAssign[R] { fn divide_assign(*this, rhs: R) }
pub inter RemainderAssign[R] { fn remainder_assign(*this, rhs: R) }

pub inter Index[I, T] { fn index(this, i: I) -> T }
pub inter IndexMut[I, T] { fn index_mut(*this, i: I) -> *T }
pub inter Iterator[T: Unique] {
    fn next(*this) -> T?
    fn map[U](*this, f: (T) -> U) -> Iterator[U] { _builtin() }
    fn filter(*this, f: (T) -> bool) -> Iterator[T] { _builtin() }
    fn collect(*this) -> Vec[T] { _builtin() }
}
pub inter AsyncIterator[T: Unique] { async fn next(*this) -> T? }
pub inter Iterable[T: Unique] { fn iter(this) -> Iterator[T] }
