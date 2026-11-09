package resolve_globs

// A glob import's names aren't known until packages are loaded, so in this file unknown
// names are deferred to later passes instead of being reported. Zero diagnostics.

import "std.collections.*"

fun main() {
    let d = Deque.new()
    let h = heap_from(d)
    log.println(h)
}
