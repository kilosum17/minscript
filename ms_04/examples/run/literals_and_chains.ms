// Bugs found while writing samples/compiler (each would have been silent): struct spreads whose
// later fields read the base, a field named like a JS reserved word, struct-like variants named
// like a type in scope, and optional method calls.
package main

type Token {
    kind: str
    start: int
    end: int
    default: int = 0                              // a JS reserved word as a field name
}

union Kind {
    Range { start: int, end: int }              // named like the prelude's `Range`
    Plain
}

type Node { k: Kind }

type Body { stmts: Vec[int] }
type Decl { body: Body? }

var calls = 0
fn token() -> Token {
    calls += 1
    Token { kind: ">>", start: 4, end: 6 }
}

fn main() {
    // the spread's base is evaluated once, and every field after the first can read it
    t := Token { kind: ">", ...token() }
    log.println(t, calls)
    rr := r{ ...r{ x: 1, y: 2 }, y: 5 }
    log.println(rr)

    // the expected union's variant comes first (§7.7), also in a struct literal
    n := Node { k: Range { start: 1, end: 3 } }
    match n.k {
        Range { start, end } => log.println("variant", start, end)
        Plain => log.println("plain")
    }

    // `o?.m()` calls `m` on the value of a Some
    d := Decl { body: Some(Body { stmts: [1, 2] }) }
    none := Decl { body: None }
    log.println(d.body?.stmts?.len(), none.body?.stmts?.len(), d.body?.stmts?.len() ?? 0)
    let n2: int? = Some(3)
    log.println(n2?.to_str())
}
