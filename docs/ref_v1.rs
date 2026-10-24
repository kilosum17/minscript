package main

import std/time
import app/models

// 1. Structural Unions & Sum Types
pub type Role = "Admin" | "Operator" | "Guest"

pub type Result<T, E> = 
    | Ok { value: T }
    | Err { error: E }

pub type PaymentMethod = 
    | CreditCard { number: string, exp: string }
    | MobileMoney { phone: string, provider: string }
    | Cash {}

// 2. TypeScript-style Structural Types & Null Safety
pub type User = {
    pub id: string,
    pub name: string,
    pub email: string?, // Nullable
    tags: List<string>,
}

// 3. Impl Methods
impl User {
    pub fun new(id: string, name: string, email: string?) -> User {
        return User {
            id: id,
            name: name,
            email: email,
            tags: ["active"],
        }
    }

    pub fun get_email(this) -> string {
        return this.email.or("no-email@minscript.dev")
    }
}

// 4. Tuples & Multi-Return
fun get_dimensions() -> (int, int) {
    return (1920, 1080)
}

// 5. Async / Multi-Threaded Execution
pub async fun process_payment(method: PaymentMethod) -> Result<string, string> {
    await time.sleep(10)
    match method {
        PaymentMethod.CreditCard { number, exp } => {
            return Result.Ok("Charged card ${number}")
        },
        PaymentMethod.MobileMoney { phone, provider } => {
            return Result.Ok("Charged ${provider} (${phone})")
        },
        PaymentMethod.Cash {} => {
            return Result.Err("Cash not supported")
        },
    }
}

// 6. Main Entrypoint & Control Flow
async fun main() {
    // Variable Bindings
    const app_name = "MinScript"
    let mut count = 0
    count = count + 1

    // Tuple Destructuring
    const (width, height) = get_dimensions()

    // Collections
    const names: List<string> = ["Alice", "Bob", "Teddy"]
    const roles: Set<string> = { "Admin", "Operator" }
    const user_map: Map<string, int> = { "Alice": 1, "Bob": 2 }

    // Inferred Tagged Maps ('1)
    const kiosks = Map{
        mega: '1{ id: 1, name: "Mega Moto" },
        nzuri: '1{ id: 2, name: "Moto Nzuri" },
    }

    // Functional Combinators
    const active_names = names
        .filter(fun(n) => n != "Bob")
        .map(fun(n) => "User: ${n}")

    // Unified For Loops (Lists, Sets, Maps)
    for name in names {
        println(name)
    }

    for name, idx in names {
        println("${idx}: ${name}")
    }

    for role in roles {
        println("Role: ${role}")
    }

    for key, val in user_map {
        println("${key} => ${val}")
    }

    // Range Loops with break / continue
    for i in 0..10 {
        if i == 2 {
            continue
        }
        if i == 5 {
            break
        }
        println("Index: ${i}")
    }

    // Conditionals (Optional Parentheses)
    if count > 0 {
        println("Count is positive")
    } else {
        println("Zero or negative")
    }

    // Null Helpers (.or static and closure)
    const raw_email: string? = nil
    const fallback_1 = raw_email.or("guest@minscript.dev")
    const fallback_2 = raw_email.or(fun() => "computed@minscript.dev")

    // Result & let...else Guard
    const payment = PaymentMethod.MobileMoney {
        phone: "+254700000000",
        provider: "M-Pesa",
    }

    const res = await process_payment(payment)

    let Result.Ok(receipt) = res else {
        println("Payment failed")
        return
    }

    println("Receipt: ${receipt}")
}
