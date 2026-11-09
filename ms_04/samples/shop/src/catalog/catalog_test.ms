package catalog

import "std.testing.*"

let CSV = """
    sku,name,price,qty,tags
    TEA-250,Tea leaves 250g,18000,10,drink drink staple
    SUGAR-1KG,Sugar 1kg,16500,2,
    """

fn test_load_and_value() {
    let inv = load_csv(CSV) or e => fail(e)
    assert_eq(inv.items.len(), 2)
    assert_eq(inv.items["TEA-250"].tags.join(","), "drink,staple")
    assert_eq(inv.value().cents, 18000 * 10 + 16500 * 2)
    assert_eq("${Money { cents: 123405 }}", "KSh 1234.05")
}

fn test_bad_line_names_the_line() {
    let r = load_csv("sku,name,price,qty,tags\nA,B,cheap,1,x")
    assert_eq(r.unwrap_err(), "line 2: bad price `cheap`")
}

fn test_write_view_changes_the_stored_item() {
    var inv = load_csv(CSV) or e => fail(e)
    inv.at_mut("SUGAR-1KG").qty += 8                 // in place, through the write view
    assert_eq(inv.items["SUGAR-1KG"].qty, 10)
}

fn test_copies_are_independent() {
    let inv = load_csv(CSV) or e => fail(e)
    var other = inv                                  // a share…
    other.at_mut("TEA-250").qty = 0                  // …copied at this write (L_IMPLICIT_COPY)
    assert_eq(inv.items["TEA-250"].qty, 10)
    assert_eq(other.items["TEA-250"].qty, 0)
}

fn test_low_stock_returns_views() {
    let inv = load_csv(CSV) or e => fail(e)
    var low = inv.low_stock(5)
    assert_eq(low.len(), 1)
    low[0].qty = 99                                  // writes a copy of that one element
    assert_eq(inv.items["SUGAR-1KG"].qty, 2)
}
