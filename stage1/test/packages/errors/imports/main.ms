// Import errors: missing packages and items, private items, and a name two globs both export.
package main

import "app.nope" //~ E_UNKNOWN_IMPORT
import "std.nothing" //~ E_UNKNOWN_IMPORT
import "app.lib"
import "app.lib.{ghost}" //~ E_UNKNOWN_IMPORT
import "app.lib.{hidden}" //~ E_PRIVATE_ITEM
import "app.lib.*"
import "app.other.*"

fun main() {
    log.println(lib.visible())
    log.println(lib.secret()) //~ E_PRIVATE_ITEM
    log.println(visible())
    log.println(shared()) //~ E_AMBIGUOUS_IMPORT
}
