// Port of docs/history/samples/{lib,main,expr}.ms to v0.2 syntax.
package main

import "std.math"

pub fun log_message(msg: string) {
    log.println("LOG: ${msg}")
}

pub fun calculate_area(width: f32, height: f32) -> f32 {
    width * height
}

pub type Counter: Stringer = {
    value: i32
    pub step: i32 = 1

    pub fun new(initial: i32) -> Counter {      // static: no receiver
        Counter { value: initial }
    }

    pub fun increment(&mut this, amount: i32) -> i32 {
        this.value += amount
        this.value
    }

    pub fun tick(&mut this) {
        this.value += this.step
    }

    pub fun print_value(&this) {
        log.println("Current Counter Value: ${this.value}")
    }

    pub fun to_str(&this) -> string {
        "Counter(${this.value})"
    }
}

fun expressions() {
    let a = 10
    b := 20
    var c = 30;
    d :== 45;
    d = 40
    sum := a + b
    sum2 := a + b + c
    prod := a + b * c
    prod2 := b * c + a
    com1 := (a + b) * c
    com2 := math.abs(-10) / 5
    c += 1
    log.println(sum, sum2, prod, prod2, com1, com2, c, d)
}

async fun main() {
    let numbers = [10, 25, 40, 5, 90, 110]
    scores := [85.5, 92.0, 78.5, 95.0]

    let doubled = numbers.map(#{ it * 2 })
    let high = numbers.filter(#{ n, idx => n > 50 && idx > 0 })
    let has_honor_roll = scores.any(#{ it >= 90.0 })
    let all_passing = scores.all(#{ score => score >= 50.0 })
    let processed = numbers.map(#{ n =>
        let squared = n * n
        squared + 5
    })

    log.println("Doubled: ${doubled}, high: ${high}")
    log.println("Honor roll: ${has_honor_roll}, all passing: ${all_passing}")
    log.println("Processed complex values: ${processed}")

    var total = 0
    numbers.for_each(#[&mut total]{ total += it })
    log.println("Total: ${total}")

    var counter = Counter.new(10)               // `var`, so &mut this methods can be called
    counter.print_value()
    let new_total = counter.increment(15)
    counter.tick()
    log.println("Incremented result: ${new_total}, now ${counter}")

    log_message("area = ${calculate_area(2.0, 3.5)}")
    expressions()
}
