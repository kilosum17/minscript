// L_SHARED_CYCLE (§9.8): a type that can reach itself through a `shared` or `once` field.
package main

// fires: a node's parent is set after construction and leads back to a node
type Node: Identity {
    name: str
    children: Vec[Node]
    once parent: Node                            //~ L_SHARED_CYCLE
}

// fires: a shared field holding values that can hold the same cell again
type Room {
    shared guests: Vec[Room]                     //~ L_SHARED_CYCLE
}

// quiet: a back-reference held as Weak
type Leaf: Identity {
    name: str
    once owner: Weak[Leaf]
}

// quiet: plain fields of an identity type are fixed at construction, so they can't close a cycle
type Expr: Identity {
    left: Vec[Expr]
}

// quiet: a shared field of a type that can't lead back
type Counter {
    shared hits: int
}

fn main() {
    n := Node { name: "root", children: [] }
    r := Room { guests: [] }
    l := Leaf { name: "x" }
    e := Expr { left: [] }
    c := Counter { hits: 0 }
    log.println(n.name, r.guests.len(), l.name, e.left.len(), c.hits)
}
