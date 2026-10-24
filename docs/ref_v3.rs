package main

import "std.time"
import "app.models"

// ==========================================
// 1. STRUCTURAL TYPES, INTERFACES & SUM TYPES
// ==========================================

// Union types define restricted literal string states
pub type Role = "Admin" | "Operator" | "Guest"

// Uniform sum types (Tagged Unions) supporting positional tuple variants, unit variants, and struct variants
pub type Result<T, E> = 
    | Ok(T)
    | Err(E)

pub type PaymentMethod = 
    | CreditCard { number: string, exp: string }
    | MobileMoney { phone: string, provider: string }
    | Cash // Unit variant (no braces/parentheses needed)

// Implicit structural interfaces (Go-style duck typing)
pub type Reader = {
    fun read(mut this, buffer: List<byte>) -> Result<int, string>
}

pub type Writer = {
    fun write(mut this, data: List<byte>) -> Result<int, string>
}

// Composition using `&` (Intersection of interface requirements)
pub type ReadWriter = Reader & Writer

// TypeScript-style structural types; non-nullable by default, `?` enables nil
pub type User = {
    pub id: string,
    pub name: string,
    pub email: string?, 
    pub login_count: int,
    tags: List<string>,
}

// ==========================================
// 2. RECEIVER MUTABILITY & AUTO-CLONING
// ==========================================
impl User {
    pub fun new(id: string, name: string, email: string?) -> User {
        return User {
            id: id,
            name: name,
            email: email,
            login_count: 0,
            tags: ["active"],
        }
    }

    // Read-only receiver (`this`): Enforces immutable reads. Safe for concurrent access.
    pub fun get_email(this) -> string {
        return this.email.or("no-email@minscript.dev")
    }

    // Mutating receiver (`mut this`): Explicitly updates internal state. 
    // Callers don't write `mut`; the method signature manages the borrow check.
    pub fun record_login(mut this) {
        this.login_count = this.login_count + 1
    }
}
// Note: Non-string custom types automatically get a `.clone()` method generated 
// by the compiler on-demand if no custom clone implementation is provided.

// ==========================================
// 3. ASYNC & PROMISES
// ==========================================
// Async functions automatically wrap/unwrap return values in Promise<T>
pub async fun process_payment(method: PaymentMethod) -> Result<string, string> {
    await time.sleep(10) // Non-blocking thread yield
    match method {
        PaymentMethod.CreditCard { number, exp } => {
            return Result.Ok("Charged card ${number}")
        },
        PaymentMethod.MobileMoney { phone, provider } => {
            return Result.Ok("Charged ${provider} (${phone})")
        },
        PaymentMethod.Cash => {
            return Result.Err("Cash not supported")
        },
    }
}

// ==========================================
// 4. MAIN ENTRYPOINT & SYNTAX RULES
// ==========================================
async fun main() {
    // `const` creates immutable bindings; `let` creates mutable bindings.
    const app_name = "MinScript"
    let user = User.new("u_101", "Teddy", nil)

    // Exclusive borrow is active only during method execution, releasing automatically.
    user.record_login()
    println("Login count: ${user.login_count}")

    // Strings are first-class immutable value types (Go/JS style, no .clone() needed)
    const username: string = user.name

    // Collections & Inferred Tagged Maps ('1)
    const names: List<string> = ["Alice", "Bob", "Teddy"]
    const roles: Set<string> = { "Admin", "Operator" }
    const user_map: Map<string, int> = { "Alice": 1, "Bob": 2 }

    const kiosks = Map{
        mega: '1{ id: 1, name: "Mega Moto" },
        nzuri: '1{ id: 2, name: "Moto Nzuri" },
    }

    // Unified For Loops (Lists, Sets, Maps with optional index support)
    for name in names {
        println(name)
    }

    for name, idx in names {
        println("${idx}:${name}")
    }

    for role in roles {
        println("Role: ${role}")
    }

    for key, val in user_map {
        println("${key} =>${val}")
    }

    // Range Loops with break and continue support
    for i in 0..10 {
        if i == 2 {
            continue
        }
        if i == 5 {
            break
        }
        println("Index: ${i}")
    }

    // Conditionals: Parentheses around conditions are optional for cleaner parsing
    if user.login_count > 0 {
        println("User active")
    } else {
        println("Inactive")
    }

    // Null Helpers: `.or()` supports static fallbacks or lazy closures
    const raw_email: string? = nil
    const fallback_1 = raw_email.or("guest@minscript.dev")
    const fallback_2 = raw_email.or(fun() => "computed@minscript.dev")

    const payment = PaymentMethod.MobileMoney {
        phone: "+254700000000",
        provider: "M-Pesa",
    }

    // Async execution inside an `async` function using direct `await`
    const payment_result = await process_payment(payment)
    match payment_result {
        Result.Ok(receipt) => println("Awaited Payment Success: ${receipt}"),
        Result.Err(err) => println("Awaited Payment Error: ${err}"),
    }

    // Async execution from non-async context via `.then()` or `.ignore()`
    process_payment(payment).then(fun(res) {
        // `let ... else` guard for early return pattern matching on tuple variants
        let Result.Ok(receipt) = res else {
            println("Payment failed")
            return
        }
        println("Receipt: ${receipt}")
    })

    process_payment(payment).ignore() // Fire-and-forget background task
}
