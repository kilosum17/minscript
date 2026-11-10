// Access check diagnostics (pass 7, spec §18.3): one failing case and one passing case per error.
package main

type User {
    name: str
    age: int
    tags: Vec[str]
}

fn birthday(u: *User) { u.age += 1 }
fn rename(u: *User, n: str) { u.name = n }
fn swap(a: *int, b: *int) { t := a; a = b; b = t }

// ---- writability ---------------------------------------------------------------------------

fn assign_immutable(u: User) {
    n := 1
    n = 2                                     //~ E_ASSIGN_IMMUTABLE
    var m = 1
    m = 2
    u.age = 3                                 //~ E_ASSIGN_IMMUTABLE
}

fn write_to_immutable() {
    ann := User { name: "Ann", age: 30, tags: [] }
    birthday(ann)                             //~ E_WRITE_TO_IMMUTABLE
    var bo = User { name: "Bo", age: 20, tags: [] }
    birthday(bo)
    xs := [1, 2]
    xs.push(3)                                //~ E_WRITE_TO_IMMUTABLE
}

fn read_mode_closure_param(xs: Vec[int]) {
    xs.for_each(#{ n => n += 1 })             //~ E_WRITE_TO_IMMUTABLE
}

type Counter { shared hits: int = 0 }

fn shared_through_read(c: Counter) { c.hits += 1 }   // a shared field: writable through `this` / `T`

// ---- overlapping arguments (§9.4) ------------------------------------------------------------

type Pair { x: int, y: int }

fn overlapping() {
    var p = Pair { x: 1, y: 2 }
    swap(p.x, p.x)                            //~ E_OVERLAPPING_ACCESS
    swap(p.x, p.y)
    var u = User { name: "a", age: 1, tags: [] }
    rename(u, u.name)                         //~ E_OVERLAPPING_ACCESS
}

fn rename_age(u: *User, n: str) { u.age = 1 }

fn disjoint_by_summary() {
    var u = User { name: "a", age: 1, tags: [] }
    rename_age(u, u.name)                     // only u.age is written: no overlap with u.name
}

// ---- write views (§9.7) --------------------------------------------------------------------

type Inventory {
    items: Vec[int] = []

    fn at_mut(*this, i: int) -> *int { this.items[i] }
}

fn write_view(inv: *Inventory) {
    n := inv.at_mut(0)
    log.println(inv.items.len())              //~ E_ACCESS_DURING_WRITE_VIEW
    n = 5
    m := inv.at_mut(1)
    m = 6
    log.println(inv.items.len())              // the view is dead after its last use
}

// ---- Unique values (§9.2) ------------------------------------------------------------------

async fn worker(sub: Sub[int]) { for await n in sub { log.println(n) } }

async fn moves(q: Queue[int]) {
    extra := q.subscribe()
    worker(extra).ignore()
    worker(extra).ignore()                    //~ E_USE_AFTER_MOVE
    var own = q.subscribe()
    n := await own.next()                     // `next(*this)` lends it: still ours
    m := await own.next()
}

async fn moves_in_branches(q: Queue[int], c: bool) {
    s := q.subscribe()
    if c { worker(s).ignore() }
    worker(s).ignore()                        //~ E_USE_AFTER_MOVE
    t := q.subscribe()
    if c {
        worker(t).ignore()
        return
    }
    worker(t).ignore()                        // the branch that moved `t` returned
}

async fn moves_in_loops(q: Queue[int]) {
    s := q.subscribe()
    for i in 0..3 {
        worker(s).ignore()                    //~ E_USE_AFTER_MOVE
    }
}

// ---- tasks (§11.2) -------------------------------------------------------------------------

async fn task_rename(u: *User, n: str) { u.name = n }
async fn task_retag(u: *User, t: str) { u.tags.push(t) }

async fn concurrent() {
    var user = User { name: "a", age: 1, tags: [] }
    await all(task_rename(user, "Ann"), task_retag(user, "admin"))
    await all(task_rename(user, "Ann"), task_rename(user, "Bo"))     //~ E_CONCURRENT_OVERLAP
}

async fn selects(q: Queue[int]) {
    var sub = q.subscribe()
    select {
        a = sub.next() => log.println(a)
        b = sub.next() => log.println(b)      //~ E_CONCURRENT_OVERLAP
    }
}

async fn ticker(n: *int) { n += 1 }

async fn view_across_task() {
    var user = User { name: "a", age: 1, tags: [] }
    p := task_rename(user, "x")               //~ E_VIEW_ACROSS_TASK
    await task_rename(user, "y")
    shared var count = 0
    t := ticker(count)                        // a shared cell: the task aliases it
    await t
}

// ---- locks (§10.1) --------------------------------------------------------------------------

shared var tokens = [] as Vec[str]

async fn locks() {
    lock tokens {
        tokens.push("a")
        await waits()                         //~ E_AWAIT_IN_LOCK
    }
    lock tokens { tokens.push("b") }
    await waits()
}

async fn waits() {}

// ---- captured copies (§10.3) ---------------------------------------------------------------

fn make_counter() -> () -> int {
    var n = 0
    #{ n += 1; n }                            //~ E_WRITE_TO_CAPTURED_COPY
}

fn make_shared_counter() -> () -> int {
    shared var n = 0
    #{ n += 1; n }
}

fn local_closure(xs: Vec[int]) -> int {
    var total = 0
    xs.for_each(#{ total += it })             // doesn't escape: writes `total` in place
    total
}

// ---- poisoning (§13.3) ---------------------------------------------------------------------

fn poisoned() {
    var v = [1, 2]
    r := recover { v.push(3) }
    log.println(v.len())                      //~ E_USE_OF_POISONED
    var w = [1]
    r2 := recover { w.push(2) }
    w = []
    log.println(w.len())                      // assigned again: fine
}

fn main() {}
