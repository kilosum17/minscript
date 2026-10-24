package main

import "std.io"

// ==========================================
// 1. PRELUDE TYPES (Built-in Everywhere)
// ==========================================
// Result<T, E> -> Ok(T) | Err(E)
// Ref<T>       -> Thread-safe reference-counted heap handle with interior mutability

pub type Status = "Active" | "Inactive"

pub type ServerConfig = {
    pub host: string,
    pub port: int,
}

impl ServerConfig {
    // Auto-generated or custom toString() method called implicitly by formatting
    pub fun toString(this) -> string {
        return "${this.host}:${this.port}"
    }
}

async fun main() {
    // ==========================================
    // 2. REF<T> (Shared State & Heap Allocations)
    // ==========================================
    // Allocated on the heap with reference counter = 1
    const config_ref = Ref(ServerConfig { host: "127.0.0.1", port: 8080 })

    // Sharing handle increments reference count automatically (thread-safe ARC)
    const worker_config = config_ref

// Clean and concise: no explicit `mut` keyword needed in closure params
    config_ref.update(fun(cfg) {
        cfg.port = 9090 // Handled safely under the hood by the compiler/runtime
    })

    metrics.update("requests", fun(val) {
        val = val + 1
    })

    ports.update_at(0, fun(p) {
        p = 9000
    })
    
    println("Updated Port via Ref: ${worker_config.get().port}") // 9090

    // ==========================================
    // 3. RESULT<T, E> (Error Handling)
    // ==========================================
    const res: Result<string, string> = Result.Ok("System online")
    
    let Result.Ok(message) = res else {
        println("Error occurred")
        return
    }
    println(message)

    // ==========================================
    // 4. STRINGS (Immutable Value Types)
    // ==========================================
    const title = "  MinScript Systems Language  "

    println("Size: ${title.size()}")                 // 30
    println("Trimmed: ${title.trim()}")             // "MinScript Systems Language"
    println("Lower: ${title.trim().to_lower()}")    // "minscript systems language"
    
    if title.has("Systems") {                       // `has()` checks substring existence
        const clean = title.trim().strip_suffix(" Language").or(title)
        println(clean)                              // "MinScript Systems"
    }

    const words = title.trim().split(" ")           // ["MinScript", "Systems", "Language"]
    const sub = title.substring(2, 11)              // "MinScript"

    // ==========================================
    // 5. LIST<T> (Ordered Collections)
    // ==========================================
    // Bound with `let` to allow mutating method calls (`mut this`)
    let numbers = [10, 20, 30]

    println("List size: ${numbers.size()}")          // 3
    numbers.push(40)                                // Appends to list
    const popped: int? = numbers.pop()              // Removes and returns last item (40)

    // In-place update by index
    numbers.update_at(0, fun(mut n) {
        n = 99
    })
    println("Index 0 after update: ${numbers[0].or(0)}") // 99

    // Functional Map, Filter & Auto toString() on .join()
    const formatted = numbers
        .filter(fun(n) => n > 15)
        .map(fun(n) => n * 2)
        .join(", ")                                 // Calls .toString() implicitly

    println("Processed numbers: ${formatted}")

    // ==========================================
    // 6. SET<T> (Unique Collections)
    // ==========================================
    let permissions: Set<string> = { "read", "write" }

    println("Set size: ${permissions.size()}")        // 2
    permissions.add("execute")

    if permissions.has("write") {                   // `has()` checks set membership
        permissions.remove("write")
    }

    const default_perms: Set<string> = { "read", "execute" }
    const shared_perms = permissions.intersection(default_perms)

    // ==========================================
    // 7. MAP<K, V> (Key-Value Dictionaries)
    // ==========================================
    let user_roles: Map<string, string> = {
        "alice": "admin",
        "bob": "developer",
    }

    println("Map size: ${user_roles.size()}")         // 2
    user_roles.set("charlie", "tester")

    // Key lookup & `has()` checks
    if user_roles.has("alice") {                    // `has()` checks key presence
        const role: string? = user_roles.get("alice")
        println("Alice role: ${role.or("guest")}")
    }

    // In-place value update for a specific key
    user_roles.update("alice", fun(mut role) {
        role = "super_admin"
    })

    user_roles.remove("bob")

    // Extracting keys and values as lists
    const keys: List<string> = user_roles.keys()
    const values: List<string> = user_roles.values()
}

