package main

import "std.log"

pub fun calculateArea(width: f32, height: f32) -> f32 {
    return width * height
}

pub fun logMessage(msg: string) {  // returns void
    log.println("LOG: ${msg}")
}

pub type Counter = {
    value: int32,
}

impl Counter {
    pub fun new(initialValue: i32) -> Counter { // static no this
        return Counter { value: initialValue }
    }

    pub fun increment(&mut this, amount: i32) -> i32 {
        this.value += amount
        return  this.value
    }

    pub fun printValue(&this) {
        log.println("Current Counter Value: ${this.value}")
    }
}

async fun main() {
    let numbers = [10, 25, 40, 5, 90, 110]
    let scores = [85.5, 92.0, 78.5, 95.0]

    let doubledNumbers = numbers.map(#{it * 2})
    let highNumbers = numbers.filter(#{n,idx => n > 50}) //n==it==it1,idx=it2
    let hasHonorRoll = scores.any((score) => score >= 90.0) // () in arrow function always required
    let allPassing = scores.all((score) => score >= 50.0)
    // these return elements as &T what if we want &mut T? 
    let processedValues = numbers.map((n) => {
        let squared = n * n
        let offset = squared + 5
        return offset
    }) // function returns must always be marked uisng return  

    log.println("Processed complex values: ${processedValues}")


    var myCounter = Counter.new(10) // var so .increment(mut) can be called
    myCounter.printValue()

    let newTotal = myCounter.increment(15)
    log.println("Incremented result: ${newTotal}")
}

