
package main

import "std.log"

// returns void
pub fun logMessage(msg: string) {  
    log.println("LOGs: ${msg}")
}

pub fun calculateArea(width: f32, height: f32) -> f32 {
    width * height
}

pub type Counter = {
    value: int32,
    pub test_field: f32, 
}

impl Counter {
    // static no this
    pub fun new(initialValue: i32) -> Counter { 
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
    let numbers = v[10, 25, 40, 5, 90, 110]
    scores := v[85.5, 92.0, 78.5, 95.0]

    let doubledNumbers = numbers.map(#{it * 2})
    //n==it==it1,idx=it2
    let highNumbers = numbers.filter(#{n,idx => n > 50}) 
    // () in arrow function always required
    let hasHonorRoll = scores.any((score) => score >= 90.0) 
    let allPassing = scores.all((score) => score >= 50.0)
    // these return elements as &T what if we want &mut T? 
    let processedValues = numbers.map((n) => {
        let squared = n * n
        let offset = squared + 5
        return offset
    }) 
    // function returns must always be marked uisng return  

    log.println("Processed complex values: ${processedValues}")


    // var so .increment(mut) can be called
    var myCounter = Counter.new(10) 
    myCounter.printValue()

    let newTotal = myCounter.increment(15)
    log.println("Incremented result: ${newTotal}")
}

