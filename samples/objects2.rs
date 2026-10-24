package main

import "std.io"

// ==========================================
// 1. STRUCTS, VISIBILITY & GENERICS
// ==========================================
pub type ServerConfig = {
    pub host: string,
    pub port: int32,
    secret_key: string,
}

pub type Box<T> = {
    pub value: T,
}

// ==========================================
// 2. IMPLEMENTATION BLOCKS & METHODS (`->`)
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
}

// ==========================================
// 3. FUNCTIONS & CONTEXT INFERENCE
// ==========================================
pub fun configure_server(cfg: ServerConfig) {
    println("Configuring server: ${cfg.get_address()}")
}

// ==========================================
// 4. MAIN ENTRY POINT (OBJECTS, ANONYMOUS RECORDS & CLOSURES)
// ==========================================
async fun main() {
    // ------------------------------------------
    // A. ANONYMOUS RECORDS (`r{...}`)
    // ------------------------------------------
    // When you need a strongly typed object once without declaring a global `type` 
    // beforehand, use the `r{...}` anonymous record literal. 
    // The compiler infers the exact structural type, providing full type safety 
    // and zero-cost dot-notation property access.
    
    let user_profile = r{
        name: "Kilo",
        age: 32,
        active: true,
        skills: t["running", "football"], // Using tuple prefix inside record
    }

    // Fully typed dot-notation access (resolved statically at compile-time)
    println("User Profile Name: ${user_profile.name}")
    println("User Profile Age: ${user_profile.age}")

    // ------------------------------------------
    // B. NAMED OBJECT INSTANTIATION STYLES
    // ------------------------------------------
    let explicit_cfg = ServerConfig { 
        host: "127.0.0.1", 
        port: 8080, 
        secret_key: "abc_123" 
    }

    let positional_cfg = ServerConfig("0.0.0.0", 3000, "xyz_789")

    // Context-Inferred Shorthand
    let host = "localhost"
    let port = 9000
    let secret_key = "default_secret"
    
    configure_server({ host, port, secret_key })

    // ------------------------------------------
    // C. METHOD CALLS & MUTABILITY
    // ------------------------------------------
    var mutable_cfg = ServerConfig { host: "127.0.0.1", port: 8080, secret_key: "key" }
    mutable_cfg.update_port(5000)
    println("Updated address: ${mutable_cfg.get_address()}")

    let int_box = Box { value: 42 }
    println("Box value: ${int_box.get()}")

    // ------------------------------------------
    // D. CLOSURES: BLOCK SYNTAX (`->`) VS SHORTHAND (`=>`)
    // ------------------------------------------
    // Rule: Closures are pure and non-capturing. All external dependencies 
    // must be passed explicitly as arguments.

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
    // E. HIGHER-ORDER METHODS WITH CLOSURES
    // ------------------------------------------
    let numbers = [1, 2, 3, 4, 5]

    let processed = numbers
        .filter(fun(n) => n > 2)
        .map(fun(n) => n * 10)

    println("Processed vector size: ${processed.size()}")
}