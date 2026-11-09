// `package main` is every file of ./src that declares it: this one and greet.ms.
package main

import "app.models"
import "shared"

fun main() {
    var cart = [] as Vec[models.Item]
    cart.push(models.Item { name: "pen", cents: 150 })
    cart.push(models.Item { name: "book", cents: 1299 })

    log.println(greet("basic"))
    total := cart.fold(0, #{ sum, item => sum + item.cents })
    log.println("${cart.len()} items, ${shared.money(total)}")
}
