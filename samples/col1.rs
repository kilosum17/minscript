package main

import "std.io"

// ==========================================
// 1. PRELUDE TYPES (Built-in Everywhere)
// ==========================================
// Result<T, E>  -> Ok(T) | Err(E)
// Option<T>     -> T? (Shorthand for optional values)
// Ref<T>        -> Reference-counted heap handle with interior mutability

pub type Config = {
    pub host: string,
    pub port: int,
}

async fun main() {
    // ==========================================
    // 2. REF<T> (Shared Heap Allocations & State)
    // ==========================================
    // Allocated on the heap with reference counter = 1
    const app_config = Ref(Config { host: "127.0.0.1", port: 8080 })

    // Assigning/cloning passes a shared handle; counter increments automatically
    const worker_config = app_config

    // In-place interior mutability using closure updates
    app_config.update(fun(mut cfg) {
        cfg.port = 9090 // Mutates the underlying shared heap value directly
    })

    // Reflected automatically in worker_config without copying or lifetime annotations
    println("Worker Port: ${worker_config.get().port}") // 9090
    // When both `app_config` and `worker_config` go out of scope, counter hits 0 and frees memory.

    // ==========================================
    // 3. IN-PLACE CONTAINER MUTATIONS
    // ==========================================
    // --- MAP UPDATES ---
    let metrics: Map<string, int> = { "requests": 100, "errors": 0 }

    // `.update(key, closure)` mutates values in-place without releasing references
    metrics.update("requests", fun(mut val) {
        val = val + 1
    })

    if metrics.has("requests") {
        println("Requests: ${metrics.get("requests").or(0)}") // 101
    }

    // --- LIST UPDATES ---
    let ports = [8080, 8081, 8082]

    // `.update_at(index, closure)` safely modifies an element in-place by index
    ports.update_at(0, fun(mut p) {
        p = 9000
    })

    println("Port 0: ${ports[0].or(0)}") // 9000

    // ==========================================
    // 4. STRINGS, LISTS, SETS & MAPS SUMMARY
    // ==========================================
    // Standard size() & has() across all collections
    const text = "MinScript"
    let tags: Set<string> = { "fast", "safe" }

    println("Text size: ${text.size()}")   // 9
    println("Set size: ${tags.size()}")     // 2

    if tags.has("fast") {
        tags.add("concise")
    }

    // Built-in .toString() auto-called by .join()
    const tag_list = tags.values().join(", ")
    println("Tags: ${tag_list}")
}
