// A type whose methods are split over two files of its package (`impl` in another file): each method's
// `this` is its own (stage 0 once mixed them up when the files had methods at the same byte offsets).
package main

import "app.shape"

fn main() {
    var c = shape.Counter.new(2)
    c.bump()
    c.bump()
    log.println("${c.total()} ${c.describe()}")
}
