package prelude

// The MinScript prelude (spec §10.1, §10.2, §9.9, §9.10): every name here is visible in every
// package without an import. Bodies are `_builtin()`, implemented by each back end; the type
// checker only reads the signatures. Auto-generated methods (`to_str`, `clone`, `eq`, `hash`,
// spec §9.7) exist on every type and are not declared here.

pub fun _builtin() -> never { _builtin() }

pub fun assert(cond: bool, msg: string) { _builtin() }
pub fun panic(msg: string) -> never { _builtin() }

// ---- Option, Result, Ordering ------------------------------------------------------------------

pub union Option[T] = {
    Some(T)
    None

    pub fun is_some(&this) -> bool { _builtin() }
    pub fun is_none(&this) -> bool { _builtin() }
    pub fun unwrap(this) -> T { _builtin() }
    pub fun expect(this, msg: &str) -> T { _builtin() }
    pub fun or[F](this, fallback: F) -> T { _builtin() }          // a value, or `#{…}` (lazy)
    pub fun map[U](this, f: &(T) -> U) -> U? { _builtin() }
    pub fun and_then[U](this, f: &(T) -> U?) -> U? { _builtin() }
    pub fun ok_or[E](this, err: E) -> Result[T, E] { _builtin() }
    pub fun filter(this, f: &(&T) -> bool) -> T? { _builtin() }
}

pub union Result[T, E] = {
    Ok(T)
    Err(E)

    pub fun is_ok(&this) -> bool { _builtin() }
    pub fun is_err(&this) -> bool { _builtin() }
    pub fun unwrap(this) -> T { _builtin() }
    pub fun expect(this, msg: &str) -> T { _builtin() }
    pub fun unwrap_err(this) -> E { _builtin() }
    pub fun ok(this) -> T? { _builtin() }
    pub fun err(this) -> E? { _builtin() }
    pub fun or[F](this, fallback: F) -> T { _builtin() }
    pub fun map[U](this, f: &(T) -> U) -> Result[U, E] { _builtin() }
    pub fun map_err[F](this, f: &(E) -> F) -> Result[T, F] { _builtin() }
    pub fun and_then[U](this, f: &(T) -> Result[U, E]) -> Result[U, E] { _builtin() }
}

pub union Ordering = { Less  Equal  Greater }

// ---- collections ------------------------------------------------------------------------------

pub type Range[T] = {
    pub fun contains(&this, v: &T) -> bool { _builtin() }
    pub fun len(&this) -> int { _builtin() }
    pub fun rev(&this) -> Iterator[T] { _builtin() }
    pub fun iter(&this) -> Iterator[T] { _builtin() }
}

pub type Vec[T] = {
    pub fun new() -> Vec[T] { _builtin() }
    pub fun with_capacity(n: int) -> Vec[T] { _builtin() }

    pub fun len(&this) -> int { _builtin() }
    pub fun is_empty(&this) -> bool { _builtin() }
    pub fun get(&this, i: int) -> T? { _builtin() }
    pub fun at(&this, i: int) -> T? { _builtin() }
    pub fun first(&this) -> T? { _builtin() }
    pub fun last(&this) -> T? { _builtin() }
    pub fun contains(&this, v: &T) -> bool { _builtin() }
    pub fun index_of(&this, v: &T) -> int? { _builtin() }

    pub fun push(&mut this, v: T) { _builtin() }
    pub fun pop(&mut this) -> T? { _builtin() }
    pub fun insert(&mut this, i: int, v: T) { _builtin() }
    pub fun remove(&mut this, i: int) -> T { _builtin() }
    pub fun clear(&mut this) { _builtin() }
    pub fun extend(&mut this, other: Vec[T]) { _builtin() }
    pub fun sort(&mut this) { _builtin() }
    pub fun sort_by(&mut this, f: &(&T, &T) -> Ordering) { _builtin() }
    pub fun reverse(&mut this) { _builtin() }

    pub fun iter(&this) -> Iterator[T] { _builtin() }
    pub fun iter_mut(&mut this) -> Iterator[T] { _builtin() }
    // pipeline callbacks receive (item, index); a callback may take fewer parameters (spec §4.4)
    pub fun map[U](&this, f: &(T, int) -> U) -> Vec[U] { _builtin() }
    pub fun filter(&this, f: &(T, int) -> bool) -> Vec[T] { _builtin() }
    pub fun find(&this, f: &(T, int) -> bool) -> T? { _builtin() }
    pub fun any(&this, f: &(T, int) -> bool) -> bool { _builtin() }
    pub fun all(&this, f: &(T, int) -> bool) -> bool { _builtin() }
    pub fun count(&this, f: &(T, int) -> bool) -> int { _builtin() }
    pub fun for_each(&this, f: &(T, int) -> void) { _builtin() }
    pub fun fold[A](&this, init: A, f: &(A, T) -> A) -> A { _builtin() }
    pub fun reduce[A](&this, init: A, f: &(A, T) -> A) -> A { _builtin() }
    pub fun sum(&this) -> T { _builtin() }
    pub fun join(&this, sep: &str) -> string { _builtin() }
    pub fun max(&this) -> T? { _builtin() }
    pub fun min(&this) -> T? { _builtin() }
    pub fun take(&this, n: int) -> Vec[T] { _builtin() }
    pub fun skip(&this, n: int) -> Vec[T] { _builtin() }
    pub fun to_vec(&this) -> Vec[T] { _builtin() }
}

pub type Array[T, N] = {
    pub fun len(&this) -> int { _builtin() }
    pub fun get(&this, i: int) -> T? { _builtin() }
    pub fun iter(&this) -> Iterator[T] { _builtin() }
    pub fun to_vec(&this) -> Vec[T] { _builtin() }
}

pub type Slice[T] = {
    pub fun len(&this) -> int { _builtin() }
    pub fun is_empty(&this) -> bool { _builtin() }
    pub fun get(&this, i: int) -> T? { _builtin() }
    pub fun iter(&this) -> Iterator[T] { _builtin() }
    pub fun to_vec(&this) -> Vec[T] { _builtin() }
}

pub type Map[K, V] = {
    pub fun new() -> Map[K, V] { _builtin() }
    pub fun len(&this) -> int { _builtin() }
    pub fun is_empty(&this) -> bool { _builtin() }
    pub fun get(&this, k: &K) -> V? { _builtin() }
    pub fun has(&this, k: &K) -> bool { _builtin() }
    pub fun insert(&mut this, k: K, v: V) -> V? { _builtin() }
    pub fun remove(&mut this, k: &K) -> V? { _builtin() }
    pub fun clear(&mut this) { _builtin() }
    pub fun keys(&this) -> Vec[K] { _builtin() }
    pub fun values(&this) -> Vec[V] { _builtin() }
    pub fun iter(&this) -> Iterator[t(K, V)] { _builtin() }
}

pub type Set[T] = {
    pub fun new() -> Set[T] { _builtin() }
    pub fun len(&this) -> int { _builtin() }
    pub fun is_empty(&this) -> bool { _builtin() }
    pub fun has(&this, v: &T) -> bool { _builtin() }
    pub fun insert(&mut this, v: T) -> bool { _builtin() }
    pub fun remove(&mut this, v: &T) -> bool { _builtin() }
    pub fun iter(&this) -> Iterator[T] { _builtin() }
}

// ---- strings (implemented once on &str, spec §10.3) -------------------------------------------

impl string {
    pub fun len(&this) -> int { _builtin() }
    pub fun is_empty(&this) -> bool { _builtin() }
    pub fun trim(&this) -> &str { _builtin() }
    pub fun substring(&this, start: int, end: int) -> &str { _builtin() }
    pub fun strip_prefix(&this, p: &str) -> &str { _builtin() }
    pub fun strip_suffix(&this, s: &str) -> &str { _builtin() }
    pub fun try_strip_prefix(&this, p: &str) -> &str? { _builtin() }
    pub fun try_strip_suffix(&this, s: &str) -> &str? { _builtin() }
    pub fun split(&this, sep: &str) -> Vec[&str] { _builtin() }
    pub fun lines(&this) -> Vec[&str] { _builtin() }
    pub fun contains(&this, s: &str) -> bool { _builtin() }
    pub fun starts_with(&this, s: &str) -> bool { _builtin() }
    pub fun ends_with(&this, s: &str) -> bool { _builtin() }
    pub fun replace(&this, from: &str, to: &str) -> string { _builtin() }
    pub fun to_lower(&this) -> string { _builtin() }
    pub fun to_upper(&this) -> string { _builtin() }
    pub fun to_int(&this) -> Result[int, string] { _builtin() }
    pub fun to_float(&this) -> Result[f64, string] { _builtin() }
    pub fun bytes(&this) -> Vec[u8] { _builtin() }
    pub fun chars(&this) -> Vec[char] { _builtin() }
    pub fun as_ptr(&this) -> *u8 { _builtin() }
}

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
    fun iter(&this) -> Iterator[T]
    fun iter_mut(&mut this) -> Iterator[T]
    fun into_iter(this) -> Iterator[T]
}
