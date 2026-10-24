package main

import "std.io"

pub type UserProfile = {
    firstName: string,
    age: u32,
    accountBalance: f32,
}

pub fun calculateTotalValue(baseAmount: f32, multiplier: int32) -> f32 {
    // Implicit numeric promotion: `multiplier` (int32) is automatically 
    // promoted to f32 to match `baseAmount`, avoiding any manual casting boilerplate.
    return baseAmount * multiplier
}

async fun main() {
    let userProfile = r{
        firstName: "Teddy",
        age: 25 as u32,
        accountBalance: 1250.50 as f32,
    }

    let taxRate = 1.15 // f64 literal
    let quantity = 4   // int32 literal

    // Mixed numeric operation handled cleanly by the compiler
    let finalCost = userProfile.accountBalance * quantity
    println("User: ${userProfile.firstName}, Final Cost: ${finalCost}")

    let total = calculateTotalValue(100.0, 5)
    println("Calculated Total: ${total}")
}
