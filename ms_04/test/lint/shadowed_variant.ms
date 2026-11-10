// L_SHADOWED_VARIANT (§7.7): a function of this package has the name of a variant of the expected union.
package main

union Shape {
    Empty
    Square(int)
}

fn Empty() -> int { 0 }

type Square { side: int }

fn area(s: Shape) -> int {
    match s {
        Empty => 0                               //~ L_SHADOWED_VARIANT
        Square(n) => n * n
    }
}

fn main() {
    // fires: `Empty` is the variant here, not the function
    let s: Shape = Empty                         //~ L_SHADOWED_VARIANT
    // quiet: a type of the same name is never ambiguous
    let q: Shape = Square(3)
    log.println(area(s), area(q), Empty())
}
