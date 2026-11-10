// L_DIVERGED_COPIES (§10.3): a field written after the value was stored in two places.
package main

type Item {
    name: str
    qty: int
}

type Order { items: Vec[Item] }

fn main() {
    // fires: `tea` is in both orders; the write changes neither
    var tea = Item { name: "tea", qty: 1 }
    var a = Order { items: [] }
    var b = Order { items: [] }
    a.items.push(tea)
    b.items.push(tea)
    tea.qty = 5                                  //~ L_DIVERGED_COPIES
    log.println(a.items[0].qty, b.items[0].qty, tea.qty)

    // quiet: stored once
    var one = Item { name: "milk", qty: 1 }
    var c = Order { items: [] }
    c.items.push(one)
    one.qty = 2
    log.println(c.items.len(), one.qty)

    // quiet: written before it is stored
    var early = Item { name: "salt", qty: 1 }
    early.qty = 3
    a.items.push(early)
    b.items.push(early)
    log.println(a.items.len(), b.items.len())
}
