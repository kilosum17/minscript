package main

import "std.io"

// ==========================================
// MINSCRIPT FUNCTIONS & CLOSURES CHEAT SHEET
// ==========================================

// 1. REGULAR FUNCTIONS
// Standard top-level functions use `pub fun`, explicit parameters, and return types.
pub fun calculateArea(width: f32, height: f32) -> f32 {
    return width * height
}

// Functions with no return type omit the `->` clause (implicitly returns unit/void).
pub fun logMessage(msg: string) {
    println("LOG: ${msg}")
}


// 2. STRUCTS & METHODS (Impl Blocks)
// Nominal types define the data schema.
pub type Counter = {
    value: int32,
}

impl Counter {
    // Static method (Constructor): No `this` parameter.
    pub fun new(initialValue: int32) -> Counter {
        return Counter { value: initialValue }
    }

    // Instance method: `this` is explicitly the first parameter.
    pub fun increment(this, amount: int32) -> int32 {
        return this.value + amount
    }

    // Instance method modifying or reading state.
    pub fun printValue(this) {
        println("Current Counter Value: ${this.value}")
    }
}


// 3. ANONYMOUS FUNCTIONS & CLOSURES
// Mandatory parentheses `()` are required around parameter lists for parser simplicity.


// ==========================================
// 4. USAGE WITH HIGHER-ORDER FUNCTIONS (HOFs)
// ==========================================

async fun main() {
    // --- Setup Data ---
    let numbers = [10, 25, 40, 5, 90, 110]
    let scores = [85.5, 92.0, 78.5, 95.0]

    // --- A. MAP HOF ---
    // Transforms each element using a single-expression closure `(n) => ...`
    let doubledNumbers = numbers.map((n) => n * 2)
    println("Doubled: ${doubledNumbers}")

    // --- B. FILTER HOF ---
    // Filters elements based on a boolean expression closure
    let highNumbers = numbers.filter((n) => n > 50)
    println("Numbers > 50: ${highNumbers}")

    // --- C. ANY HOF ---
    // Checks if at least one element satisfies the condition
    let hasHonorRoll = scores.any((score) => score >= 90.0)
    println("Has honor roll score: ${hasHonorRoll}")

    // --- D. ALL HOF ---
    // Checks if every element satisfies the condition
    let allPassing = scores.all((score) => score >= 50.0)
    println("All scores passing: ${allPassing}")


    // --- E. MULTI-STATEMENT BLOCK CLOSURES (`->`) ---
    // Used when complex logic or local variables are needed inside a closure.
    let processedValues = numbers.map((n) => {
        let squared = n * n
        let offset = squared + 5
        return offset
    })
    println("Processed complex values: ${processedValues}")


    // --- F. USING STRUCTS & METHODS ---
    let myCounter = Counter.new(10)
    myCounter.printValue()

    let newTotal = myCounter.increment(15)
    println("Incremented result: ${newTotal}")
}