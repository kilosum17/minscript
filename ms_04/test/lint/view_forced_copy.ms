// L_VIEW_FORCED_COPY (§9.6): a write while a view of the same path is still used.
package main

type Cell { n: int }

// fires: `first` is a view of `items[0]`, used after the push
fn view_then_write() {
    var items = [Cell { n: 1 }, Cell { n: 2 }]
    let first = items.get(0) ?? Cell { n: 0 }
    items.push(Cell { n: 3 })                    //~ L_VIEW_FORCED_COPY
    log.println(first.n, items.len())
}

// quiet: a str is immutable, so a view of one never forces a copy
fn str_view_then_write() {
    var names = ["a", "b"]
    let first = names.get(0) ?? ""
    names.push("c")
    log.println(first, names.len())
}

// quiet: the view is used only in the other branch
fn other_branch(flag: bool) {
    var items = [Cell { n: 1 }]
    let first = items.get(0) ?? Cell { n: 0 }
    if flag {
        items.push(Cell { n: 2 })
    } else {
        log.println(first.n)
    }
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
    str_view_then_write()
    other_branch(true)
    loop_writes_itself()
    var p = Parser { tokens: ["x", "y"], pos: 0 }
    log.println(disjoint(p))
    view_done_first()
}
