// The worked samples of spec Appendix A, as golden tests for effect summaries (§9.5, §21 step 5).
package appendix

// A.1 / §9.5: `T` and `*T`, paths
type User {
    name: str
    age: int
    tags: Vec[str]

    fn get_name(this) -> str { this.name }
    fn birthday(*this) { this.age += 1 }
    fn tag(*this, t: str) { this.tags.push(t) }
}

fn greet(u: User) -> str { "Hi ${u.name}" }
fn birthday(u: *User) { u.age += 1 }

// A.2: a local copy is written, not the parameter
type Config { tags: Vec[str] = [] }

fn with_tag(base: Config, t: str) -> Config {
    var c = base
    c.tags.push(t)
    c
}

// A.3: views of the source kept by the tokens
type Token { text: str, start: int }

fn lex(src: str) -> Vec[Token] {
    var out = [] as Vec[Token]
    var i = 0
    for i < src.len() {
        start := i
        i += 1
        out.push(Token { text: src.substring(start, i), start })
    }
    out
}

// A.4: a once field written through a read-only view
type Ident: Identity {
    name: str
    once ty: str
}

fn check_ident(id: Ident, scope: Map[str, str]) -> str {
    t := scope.get(id.name) ?? "unknown"
    id.ty = t
    t
}

// A.5: disjoint writes
async fn rename(u: *User, n: str) { u.name = n }
async fn retag(u: *User, t: str) { u.tags.push(t) }

// shared state written through `this` (§10.1)
type Counter { shared hits: int = 0 }

fn hit(c: Counter) { c.hits += 1 }

// a write view (§9.7) and writes through it
type Inventory {
    items: Map[str, int] = m{}

    fn at_mut(*this, sku: str) -> *int { this.items.entry(sku, 0) }
}

fn restock(inv: *Inventory, sku: str) {
    n := inv.at_mut(sku)
    n = 5
}

// a Unique parameter advanced by `for await`: consumed (§9.2)
async fn drain(sub: Sub[int]) -> int {
    var total = 0
    for await n in sub { total += n }
    total
}

// escaping: a closure capturing a parameter, returned
fn adder(n: Vec[int]) -> () -> int { #{ n.len() } }

// a function parameter invoked with a path (§9.5 closures passed to known functions)
fn each_name(users: Vec[User], f: (str) -> void) {
    for u in users { f(u.name) }
}

// recursion: a component of two functions
fn even(xs: *Vec[int], n: int) -> bool { if n == 0 { xs.push(0); true } else { odd(xs, n - 1) } }
fn odd(xs: *Vec[int], n: int) -> bool { if n == 0 { false } else { even(xs, n - 1) } }
