package main

import "std.io"

// ==========================================
// 1. STRUCTS, VISIBILITY & GENERICS
// ==========================================
pub type ServerConfig = {
    pub host: string,
    pub port: int32,
    secret_key: string, // Private field: restricted from external package access & introspection
}

pub type Box<T> = {
    pub value: T,
}

// ==========================================
// 2. IMPLEMENTATION BLOCKS & METHODS (`->`)
// ==========================================
impl ServerConfig {
    // Immutable receiver (`this`): borrows struct read-only
    pub fun get_address(this) -> string {
        return "${this.host}:${this.port}"
    }

    // Mutable receiver (`mut this`): allows modifying fields in place
    pub fun update_port(mut this, new_port: int32) {
        this.port = new_port
    }
}

impl<T> Box<T> {
    pub fun get(this) -> T {
        return this.value
    }
}

// ==========================================
// 3. FUNCTIONS & CONTEXT INFERENCE
// ==========================================
pub fun configure_server(cfg: ServerConfig) {
    println("Configuring server: ${cfg.get_address()}")
}

// ==========================================
// 4. MAIN ENTRY POINT (OBJECTS & CLOSURES)
// ==========================================
async fun main() {
    // ------------------------------------------
    // A. OBJECT INSTANTIATION STYLES
    // ------------------------------------------
    // 1. Standard explicit field initialization
    let explicit_cfg = ServerConfig { 
        host: "127.0.0.1", 
        port: 8080, 
        secret_key: "abc_123" 
    }

    // 2. Positional initialization (matches field declaration order)
    let positional_cfg = ServerConfig("0.0.0.0", 3000, "xyz_789")

    // 3. Context-Inferred Shorthand (infers type from target expression)
    let host = "localhost"
    let port = 9000
    let secret_key = "default_secret"
    
    configure_server({ host, port, secret_key })

    // ------------------------------------------
    // B. METHOD CALLS & MUTABILITY
    // ------------------------------------------
    var mutable_cfg = ServerConfig { host: "127.0.0.1", port: 8080, secret_key: "key" }
    mutable_cfg.update_port(5000)
    println("Updated address: ${mutable_cfg.get_address()}")

    // Generic box instantiation
    let int_box = Box { value: 42 }
    println("Box value: ${int_box.get()}")

    // ------------------------------------------
    // C. CLOSURES: BLOCK SYNTAX (`->`) VS SHORTHAND (`=>`)
    // ------------------------------------------
    // Rule: Closures are pure and non-capturing. All external dependencies 
    // must be passed explicitly as arguments (no hidden captures or heap bloat).

    // 1. Block closure with explicit return type (`->` and curly braces)
    let compute_sum = fun(a: int32, b: int32) -> int32 {
        let total = a + b
        return total
    }
    println("Sum via block closure: ${compute_sum(15, 25)}")

    // 2. Single-expression shorthand closure (`=>` with implicit return)
    let multiply = fun(a: int32, b: int32) => a * b
    println("Product via shorthand closure: ${multiply(6, 7)}")

    // ------------------------------------------
    // D. HIGHER-ORDER METHODS WITH CLOSURES
    // ------------------------------------------
    let numbers = [1, 2, 3, 4, 5]

    // Chaining zero-allocation lazy iterator methods using shorthand closures
    let processed = numbers
        .filter(fun(n) => n > 2)
        .map(fun(n) => n * 10)

    println("Processed vector size: ${processed.size()}")
}
