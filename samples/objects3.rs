package main

import "std.io"
import "std.json"
import "std.runtime"

// ==========================================
// MINSCRIPT LANGUAGE SPECIFICATION & DESIGN CHEAT SHEET
// ==========================================
// DESIGN CHOICES SUMMARY:
// 1. NO LIFETIME ANNOTATIONS: Closures cannot capture environment variables, eliminating 
//    hidden references and lifetime tracking overhead. All closure inputs must be passed explicitly.
// 2. MEMORY SAFETY: Heap types (Vec, String, anonymous records `r{}`) enforce exclusive ownership 
//    and move semantics. Stack types (Array `a[...]`, Tuple `t[...]`, primitives) are copied by value.
// 3. THREAD SAFETY & GLOBALS: Raw mutable global variables are banned at compile-time to prevent 
//    data races. Globals are strictly either immutable constants (`let`) or thread-safe atomic 
//    reference-counted handles (`Ref<T>`). No thread-local storage is used.
// 4. EXPLICIT MUTABILITY: Variables use `let` (immutable) or `var` (mutable). Parameters and 
//    receivers modifying data must explicitly declare `mut`.
// ==========================================

// Global Constants (Thread-safe read-only sharing)
pub let MAX_CONNECTIONS: int32 = 10_000
pub let SYSTEM_NAME: string = "MinScript-Engine"

// Global Mutable State (Strictly forced to use Ref<T> for thread safety)
pub let active_sessions: Ref<Map<string, int32>> = Ref(m{})

// Named Struct Definition
pub type ServerConfig = {
    pub host: string,
    pub port: int32,
    secret_token: string, // Private field: excluded from external introspection
}

// Generic Type Definition
pub type Box<T> = {
    pub value: T,
}

// Tagged Union (Algebraic Data Type with zero-cost discriminant jump tables)
pub type NetworkResponse = 
    | Success(string)
    | Error(int32)

// ==========================================
// IMPLEMENTATION & METHODS (`->` for Return Types)
// ==========================================
impl ServerConfig {
    pub fun get_address(this) -> string {
        return "${this.host}:${this.port}"
    }

    pub fun update_port(mut this, new_port: int32) {
        this.port = new_port
    }
}

impl<T> Box<T> {
    pub fun get(this) -> T {
        return this.value
    }

    pub fun set(mut this, val: T) {
        this.value = val
    }
}

pub fun start_server(cfg: ServerConfig) {
    println("Configuring server at ${cfg.get_address()}")
}

// ==========================================
// MAIN ENTRY POINT
// ==========================================
async fun main() {
    // ------------------------------------------
    // A. BINDINGS & COLLECTIONS
    // ------------------------------------------
    let app_version = "1.0.0"     // Immutable binding
    var connection_count = 5      // Mutable binding
    connection_count += 1

    // 1. Vector (`[]` - dynamic heap collection with lazy iterator fusion)
    var ports = [80, 443, 8080]
    ports.push(9090)

    // 2. Set (`s{...}` - unique collection)
    var permissions = s{"read", "write"}
    permissions.add("execute")

    // 3. Map (`m{...}` - key-value dictionary)
    var roles = m{
        "alice": "admin",
        "bob": "user",
    }
    roles.set("charlie", "tester")

    // 4. Tuple (`t[...]` - heterogeneous stack record)
    let endpoint = t["127.0.0.1", 8080, true]
    let host_ip = endpoint.0

    // 5. Array (`a[...]` - fixed-size stack buffer)
    let raw_buffer: Array<u8, 4> = a[0x00, 0xFF, 0x10, 0x20]
    let first_byte = raw_buffer[0]

    // ------------------------------------------
    // B. ANONYMOUS RECORDS (`r{...}`)
    // ------------------------------------------
    // Strongly typed inline record without requiring a prior global `type` declaration.
    let user_profile = r{
        name: "Teddy",
        age: 25,
        skills: t["Rust", "TypeScript", "Systems"],
    }
    println("Anonymous Record User: ${user_profile.name}, Age: ${user_profile.age}")

    // ------------------------------------------
    // C. CONTEXT-INFERRED OBJECT LITERALS
    // ------------------------------------------
    let host = "localhost"
    let port = 3000
    let secret_token = "secure_key_123"

    // Inferred from `start_server` parameter type (ServerConfig)
    start_server({ host, port, secret_token })

    // ------------------------------------------
    // D. THREAD-SAFE SHARED STATE VIA `Ref<T>`
    // ------------------------------------------
    let config_ref = Ref(ServerConfig { host: "127.0.0.1", port: 8080, secret_token: "abc" })
    let worker_config = config_ref

    // Safe interior mutability update block
    config_ref.update(fun(cfg) {
        cfg.port = 9090
    })
    println("Updated Ref Port: ${worker_config.get().port}")

    // Updating global thread-safe state
    active_sessions.update(fun(sessions) {
        sessions.set("admin_session", 1)
    })

    // ------------------------------------------
    // E. RESULT & GUARD-ELSE ERROR HANDLING
    // ------------------------------------------
    let db_res: Result<string, string> = Result.Ok("Connected")
    let Result.Ok(db_msg) = db_res else {
        println("Database connection failed")
        return
    }
    println(db_msg)

    // ------------------------------------------
    // F. CLOSURES: BLOCK SYNTAX (`->`) VS SHORTHAND (`=>`)
    // ------------------------------------------
    // Non-capturing block closure with explicit return type (`->`)
    let compute_sum = fun(a: int32, b: int32) -> int32 {
        let total = a + b
        return total
    }
    println("Sum via block closure: ${compute_sum(10, 20)}")

    // Non-capturing shorthand closure with implicit return (`=>`)
    let multiply = fun(a: int32, b: int32) => a * b
    println("Product via shorthand closure: ${multiply(5, 4)}")

    // Higher-order zero-allocation lazy iterator fusion
    let processed_ports = ports
        .filter(fun(p) => p > 100)
        .map(fun(p) => p * 2)
        .join(", ")
    println("Processed Ports: ${processed_ports}")

    // ------------------------------------------
    // G. COOPERATIVE PREEMPTION YIELD
    // ------------------------------------------
    var counter = 0
    while counter < 10_000 {
        counter += 1
        if counter % 5_000 == 0 {
            await runtime.yield()
        }
    }
    println("Main execution loop completed successfully.")
}