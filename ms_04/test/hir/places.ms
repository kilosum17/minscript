// Lowering (the `.hir` snapshot): access paths of reads, writes and `*` arguments, desugaring,
// and the witness parameters each generic function needs (§15.4).
package hir

type User {
    name: str
    age: int
    tags: Vec[str]
}

fn birthday(u: *User) { u.age += 1 }

fn tag(u: *User, t: str) { u.tags.push(t) }

fn paths(users: *Vec[User], i: int) -> int {
    users[0].age += 1                         // a literal index: users[0].age
    users[i].tags.push("x")                   // any element: *users[*].tags
    birthday(users[i])                        // *users[*]
    n := users[i].name.len()
    n
}

fn sugar(o: int?, r: Result[int, str]) -> Result[int, str] {
    a := o ?? 0
    b := r?
    if o { log.println("set") }
    let Some(c) = o else { return Err("none") }
    Ok(a + b + c)
}

// js: T (compared); native: T
fn contains[T](xs: Vec[T], x: T) -> bool {
    for y in xs {
        if y == x { return true }
    }
    false
}

// js: none (only held); native: T
fn first_or[T](xs: Vec[T], d: T) -> T { xs.first() ?? d }

// js: T (a bound method); native: T
fn names[T: Stringer](xs: Vec[T]) -> Vec[str] { xs.map(#{ it.to_str() }) }

// js: K, through Map.get (a hashed lookup)
fn count[K](m: Map[K, int], k: K) -> int { m.get(k) ?? 0 }

fn uses(xs: Vec[str]) -> bool { contains(xs, "a") }

fn closures(xs: Vec[int]) -> int {
    var total = 0
    xs.for_each(#{ total += it })            // captures `total`, written
    limit := 3
    xs.filter(#{ it > limit }).len() + total // captures `limit`, read
}
