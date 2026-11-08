// A `pkg(…)` script (`ms run gen`): an ordinary program of the project.
package main

import "std.env"

fun main() {
    log.println("gen ran with ${env.args().len()} args")
}
