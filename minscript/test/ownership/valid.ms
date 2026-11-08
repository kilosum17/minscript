package ownership_valid

// Valid ownership: must pass with zero diagnostics.

type User = { name: string, age: int }
type Point = { x: int, y: int }

fun take(u: User) {}
fun inspect(u: &User) {}
fun grow(v: &mut Vec[int]) { v.push(1) }
fun apply(n: int, f: &(int) -> int) -> int { f(n) }
fun make_adder(n: int) -> (int) -> int { #[n]{ it + n } }
fun first_word(s: &str) -> &str { s.trim() }
async fun upload(data: &Vec[int]) -> int { 0 }
async fun send_owned(data: Vec[int]) -> int { 0 }

fun copies() {
    let a = 1
    let b = a                       // ints are Copy
    let c = a + b
    let s = "hi"
    let s2 = s                      // strings are values (spec §9.1)
    log.println(s, s2, a)
    let p = t(1, 2)
    let q = p                       // tuples of Copy are Copy
    log.println(p.0)
}

fun borrows_are_implicit() {
    let u = User { name: "a", age: 1 }
    inspect(u)                      // `&User`: borrowed, not moved
    inspect(u)
    take(u)                         // moved here, last use
}

fun var_and_mut() {
    var v = [1]
    v.push(2)
    grow(v)
    var n = 0
    n += 1
    x :== 5
    x = 6
}

fun mut_params(mut n: int, v: &mut Vec[int]) {
    n = 1
    v.push(n)
}

fun reinitialized() {
    var v = [1]
    let a = v
    v = [2]                         // assigned again: valid from here
    log.println(v.len(), a.len())
}

fun branches(c: bool) {
    let v = [1]
    if c {
        let a = v
    } else {
        let b = v                   // moved on each branch, never used after
    }
}

fun fresh_binding_per_iteration(items: Vec[int]) {
    for i in 0..3 {
        let v = [i]
        let moved = v               // a new `v` on every iteration
    }
}

fun loop_items_are_borrowed(users: Vec[User]) {
    var names = [] as Vec[string]
    for u in users {
        names.push(u.name)          // string: a value
        inspect(u)
    }
    var kept = [] as Vec[User]
    for u in users {
        kept.push(u.clone())        // an owned copy
    }
}

fun closures(items: Vec[int]) {
    let factor = 3
    let scaled = items.map(#{ it * factor })      // borrowed by a non-escaping callback
    var total = 0
    items.for_each(#[&mut total]{ total += it })
    let adder = make_adder(2)
    let r = apply(5, #{ it + factor })
    let handle = Ref(0)
    let later = #{ handle.get() }                  // handles are cloned into closures
}

fun handles() {
    let room = Topic.new.[string]()
    let a = room
    let b = room                    // handles are cloned, never moved
    a.publish("x")
}

fun scoped_values() {
    let raw = " a b "
    let words = raw.split(" ")      // borrows `raw`
    log.println(words.len())
    var text = "x"
    let view = text.trim()
    log.println(view)
    text = "y"                      // fine: `view` isn't used any more
}

type Stack = {
    items: Vec[int]
    fun push(&mut this, v: int) { this.items.push(v) }
    fun top(&this) -> int? { this.items.last() }
    fun into_items(this) -> Vec[int] { this.items }
    fun reset(mut this) -> Stack { this.items = []; this }
}

fun methods() {
    var s = Stack { items: [] }
    s.push(1)
    let t = s.top()
    let items = s.into_items()      // consumes `s`
}

async fun async_calls() -> int {
    let data = [1, 2, 3]
    let a = await upload(data)      // borrowed, but awaited right away
    let p = send_owned(data)        // owned argument: may run as a task
    a + await p
}

// ---- Copy types, handles in closures, borrows inside a loop -----------------------------------

type Pt: Copy = { x: int }
union Dir: Copy = { Up  Down }
type Cell2 = { v: int }
impl Copy for Cell2 {}

fun take_pt(p: Pt) {}
fun take_dir(d: Dir) {}
fun take_cell(c: Cell2) {}
fun take_ord(o: Ordering) {}

fun copy_types_dont_move() {
    let p = Pt { x: 1 }
    take_pt(p)
    take_pt(p)
    let d: Dir = Up
    take_dir(d)
    take_dir(d)
    let c = Cell2 { v: 1 }
    take_cell(c)
    take_cell(c)
    let o: Ordering = Less
    take_ord(o)
    take_ord(o)
}

/// A closure capturing only handles holds no borrow, so it may escape.
fun shared_counter() -> () -> int {
    let count = Ref(0)
    #{ count.get() }
}

/// A borrow made inside a loop body lives only for that iteration.
fun borrow_inside_loop() {
    var names = ["a"]
    for i in 0..2 {
        let view = names.iter()
        log.println(view)
        names.push("b")
    }
}
