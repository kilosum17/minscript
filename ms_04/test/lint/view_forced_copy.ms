// L_VIEW_FORCED_COPY (§9.6): a write while a view of the same path is still used.
package main

// fires: `first` is a view of `items[0]`, used after the push
fn view_then_write() {
    var items = ["a", "b"]
    let first = items.get(0) ?? ""
    items.push("c")                              //~ L_VIEW_FORCED_COPY
    log.println(first, items.len())
}

// fires: the loop iterates `items` while its body writes it
fn loop_writes_itself() {
    var items = [1, 2]
    for x in items {
        items.push(x)                            //~ L_VIEW_FORCED_COPY
    }
    log.println(items.len())
}

type Parser {
    tokens: Vec[str]
    pos: int
}

// quiet: the view is of `this.tokens`, the write is to `this.pos` (disjoint paths)
fn disjoint(p: *Parser) -> str {
    tok := p.tokens.get(p.pos) ?? ""
    p.pos += 1
    tok
}

// quiet: the view is no longer used after the write
fn view_done_first() {
    var items = ["a"]
    let first = items.get(0) ?? ""
    log.println(first)
    items.push("b")
    log.println(items.len())
}

fn main() {
    view_then_write()
    loop_writes_itself()
    var p = Parser { tokens: ["x", "y"], pos: 0 }
    log.println(disjoint(p))
    view_done_first()
}
