// Exercises features together: json.parse.[T], ??, truthiness, structural records,
// field defaults, inline methods, unions with methods, dynamic dispatch, shared var, recover.
// v0.4 port: getters return views, no `T: Clone` bound, `Ref` → `shared var`.
package main

import "std.json"
import "std.env"
import "std.io.println"

pub type Role = "Admin" | "Operator" | "Guest"

pub type User {
    pub id: u64
    pub name: str
    pub email: str?
    pub role: Role = "Guest"
    pub tags: Vec[str] = []

    pub fn display_email(this) -> str {             // returns_view [this.email], or a literal
        this.email ?? "no-email@minscript.dev"
    }

    pub fn is_admin(this) -> bool {
        this.role == "Admin"
    }
}

pub union Event {
    Login { user_id: u64, at: i64 }
    Logout(u64)
    Ping

    pub fn describe(this) -> str {
        match this {
            Login { user_id, .. } => "login ${user_id}"
            Logout(id) => "logout ${id}"
            Ping => "ping"
        }
    }
}

pub inter Shape {
    fn area(this) -> f64
    fn name(this) -> str { "shape" }       // default body
}

type Circle { r: f64 }
type Square { side: f64 }

impl Shape for Circle {
    fn area(this) -> f64 { 3.14159 * this.r * this.r }
    fn name(this) -> str { "circle" }
}

impl Shape for Square {
    fn area(this) -> f64 { this.side * this.side }
}

fn total_area(shapes: Vec[Shape]) -> f64 {            // dynamic dispatch
    shapes.map(#{ it.area() }).sum()
}

// v0.2 needed `T: Clone`. Every non-Unique type can be copied now, and `T` is non-Unique by
// default, so `first_or.[Sub[int]]` is E_UNIQUE_TYPE_ARG (spec §9.2).
fn first_or[T](items: Vec[T], fallback: T) -> T {
    items.get(0) ?? fallback                     // a view of items[0], or the fallback
}

fn env_port() -> int? {
    let raw = env.get("PORT")?
    raw.to_int().ok()
}

fn main() {
    let raw = """
        {"id": 1, "name": "Ted", "email": null, "role": "Admin"}
        """

    let res = json.parse.[User](raw)                     // Result[User, json.Error]
    if res {
        println("parsed ok",res)
    }
    let user = res or e => {
        println("bad json: ${e}")
        return
    }
    println("${user.name} <${user.display_email()}> admin=${user.is_admin()}")

    // structural record → named struct: role and tags take their defaults
    let guest: User = r{ id: 2, name: "Shem", email: nil }
    let users = [user, guest]
    let admins = users.filter(#{ it.is_admin() }).map(#{ it.name })
    println("admins: ${admins}")

    // records with the same shape are the same type
    let routes = [
        r{ name: "TRM, Thika Road", lat: -1.2194756, lon: 36.8879763, volume: 80 },
        r{ name: "Kasarani, Thika Road", lat: -1.22889, lon: 36.90444, volume: 100 },
        r{ name: "Kasarani-Mwiki Road", lat: -1.225805, lon: 36.915674, volume: 120 },
    ]
    let total_volume = routes.reduce(0, #{ acc, r => acc + r.volume })   // `r` is fine as a name: `r.` is not a sigil
    println("total volume: ${total_volume}")

    let shapes: Vec[Shape] = [Circle { r: 1.0 }, Square { side: 2.0 }]
    println("total area: ${total_area(shapes)}")
    for s in shapes {
        println("${s.name()}: ${s.area()}")
    }

    let events = [Event.Login { user_id: 1, at: 1700000000 }, Event.Logout(1), Event.Ping]
    for e, i in events {
        println("${i}: ${e.describe()}")
    }

    let port = env_port() ?? 8080
    println("port ${port}, first id ${first_or([3, 1, 2], 0)}")

    shared var stats = m{ "requests": 0 }
    stats["requests"] += 1                          // one statement = one write lock (§10.1)
    println("requests: ${stats["requests"]}")

    let caught = recover {
        let items = [1, 3, 5]
        items[10]                                        // panics: out of bounds
    }
    if let Err(p) = caught {
        println("recovered: ${p.message} at ${p.file}:${p.line}")
    }
}
