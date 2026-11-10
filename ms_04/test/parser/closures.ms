package corpus

fn closures() {
    a := xs.map(#{ it * 2 })
    b := #{ it1 + it2 }
    c := #{ x, y => x + y }
    d := #{ x: i32 -> i32 => x * 2 }
    e := #{ var acc, x => acc += x; acc }
    f := store.adjust("MILK", #{ it.qty += 24 })
    g := #{ f() or e => log(e) }
    h := #{ n =>
        sq := n * n
        sq + 5
    }
    i := #{ item: *Item => item.qty = 0 }
    j := #{ _ => 0 }
    k := #{ compute() }
}
