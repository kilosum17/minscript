package main

import "std.io"
import "std.json"
import "std.runtime"

// ==========================================
// 1. PRELUDE TYPES & DATA STRUCTURES
// ==========================================
pub type Status = "Active" | "Inactive"

pub type ServerConfig = {
    pub host: string,
    pub port: int32,
}

impl ServerConfig {
    pub fun toString(this) -> string {
        return "${this.host}:${this.port}"
    }
}

// ==========================================
// 2. MAIN ENTRY & COMPREHENSIVE DEMO
// ==========================================
async fun main() {
    // ------------------------------------------
    // A. BINDINGS: `let` (Immutable) vs `var` (Mutable)
    // ------------------------------------------
    let app_version = "1.0.0"
    var active_connections = 42
    active_connections += 1

    // ------------------------------------------
    // B. COLLECTIONS & PREFIXED LITERALS
    // ------------------------------------------
    // Vec<T>: Dynamic Heap-Allocated Vector (using standard brackets `[]`)
    var numbers = [10, 20, 30]
    numbers.push(40)
    let popped: int32? = numbers.pop()

    // Set<T>: Unique Collection (using brace syntax `{"..."}`)
    var permissions = {"read", "write"}
    permissions.add("execute")

    // Map<K, V>: Key-Value Dictionary (using brace syntax with key-value pairs `{"k": v}`)
    var user_roles = {
        "alice": "admin",
        "bob": "developer",
    }
    user_roles.set("charlie", "tester")

    // Tuple<T1, T2, ...>: Heterogeneous Stack Record (using `t[...]` prefix)
    let user_record = t[777, "Teddy", true]
    let uid = user_record.0
    let uname = user_record.1

    // Array<T, N>: Fixed-Size Stack Buffer (using `a[...]` prefix)
    let fixed_buffer = a[100, 200, 300, 400]
    let first_val = fixed_buffer[0]

    // ------------------------------------------
    // C. REF<T> (Shared Heap State & Interior Mutability)
    // ------------------------------------------
    let config_ref = Ref(ServerConfig { host: "127.0.0.1", port: 8080 })
    let worker_config = config_ref

    // Clean closure updates without explicit `mut` parameters
    config_ref.update(fun(cfg) {
        cfg.port = 9090
    })

    println("Updated Port via Ref: ${worker_config.get().port}") // 9090

    // ------------------------------------------
    // D. RESULT<T, E> & GUARD-ELSE
    // ------------------------------------------
    let res: Result<string, string> = Result.Ok("System online")
    
    let Result.Ok(message) = res else {
        println("Error occurred")
        return
    }
    println(message)

    // ------------------------------------------
    // E. STRINGS & VEC FUNCTIONAL METHODS
    // ------------------------------------------
    let title = "  MinScript Systems Language  "

    println("Size: ${title.size()}")                 // 30
    println("Trimmed: ${title.trim()}")             // "MinScript Systems Language"

    // Lazy iterator fusion on Vec collections (zero intermediate heap allocations)
    let formatted = numbers
        .filter(fun(n) => n > 15)
        .map(fun(n) => n * 2)
        .join(", ")

    println("Processed numbers: ${formatted}")

    // In-place map value update via clean closure
    user_roles.update("alice", fun(role) {
        role = "super_admin"
    })

    if user_roles.has("alice") {
        let role: string? = user_roles.get("alice")
        println("Alice role: ${role.or("guest")}")
    }

    // ------------------------------------------
    // F. COMPILE-TIME INTROSPECTION & JSON
    // ------------------------------------------
    let server_cfg = ServerConfig { host: "localhost", port: 443 }
    let type_info = ServerConfig._get_info()
    
    println("Intpected Type: ${type_info.name}")
    let auto_json = json.stringify(server_cfg)
    println("Serialized JSON: ${auto_json}")

    // ------------------------------------------
    // G. COOPERATIVE PREEMPTION YIELD
    // ------------------------------------------
    var counter = 0
    while counter < 50_000 {
        counter += 1
        if counter % 10_000 == 0 {
            await runtime.yield()
        }
    }
    println("Task loop finished successfully.")
}
