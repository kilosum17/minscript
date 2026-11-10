// A day at the shop: load the catalog, start three workers, feed them the day's orders, collect
// the outcomes with a deadline, then close the day.
package main

import "std.json"
import "std.time"
import "app.catalog"
import "app.catalog.{Money}"
import "app.orders.*"
import "app.store.*"

let CATALOG = """
    sku,name,price,qty,tags
    UNGA-2KG,Maize flour 2kg,21000,40,staple flour
    MILK-500,Fresh milk 500ml,6500,6,dairy fresh
    BREAD-400,Bread 400g,6000,10,bakery fresh
    TEA-250,Tea leaves 250g,18000,4,drink
    """

let ORDERS = """
    [
      {"id": 1, "customer": 1, "channel": "web", "pay": "mpesa:0712345678",
       "lines": [{"sku": "UNGA-2KG", "qty": 2}, {"sku": "MILK-500", "qty": 2}]},
      {"id": 2, "customer": 2, "channel": "shop", "pay": "cash",
       "lines": [{"sku": "TEA-250", "qty": 3}]},
      {"id": 3, "customer": 3, "channel": "phone", "pay": "mpesa:0700000000",
       "lines": [{"sku": "BREAD-400", "qty": 1}]},
      {"id": 4, "customer": 2, "channel": "web", "pay": "card:4242:12/27",
       "lines": [{"sku": "TEA-250", "qty": 3}]},
      {"id": 5, "customer": 1, "channel": "web", "pay": "card:1111:01/25",
       "lines": [{"sku": "MILK-500", "qty": 1}]},
      {"id": 6, "customer": 9, "channel": "web", "pay": "cash",
       "lines": [{"sku": "UNGA-2KG", "qty": 1}]},
      {"id": 7, "customer": 3, "channel": "shop", "pay": "cash",
       "lines": [{"sku": "UNGA-2KG", "qty": 45}]}
    ]
    """

type OrderIn = r{ id: int, customer: int, channel: Channel, pay: str, lines: Vec[Line] }

/// "mpesa:07…", "card:4242:12/27" or "cash". The parts are views into `spec`; stored in the
/// Payment they become shares of its buffer (§9.6).
fn payment(spec: str) -> Payment {
    parts := spec.split(":")
    match parts[0] {
        "mpesa" if parts.len() == 2 => Mpesa(parts[1])
        "card" if parts.len() == 3 => Card { last4: parts[1], exp: parts[2] }
        _ => Cash
    }
}

async fn main() {
    let stock = catalog.load_csv(CATALOG) or e => {
        log.error("bad catalog: ${e}")
        return
    }
    store := Store.new(stock)                        // `stock`'s last use: it moves into the cell
    opening := store.snapshot()

    // Customers are identity objects. Akinyi was referred by Otieno: a Weak back-reference.
    otieno := Customer { id: 1, name: "Otieno" }
    wanjiru := Customer { id: 2, name: "Wanjiru" }
    akinyi := Customer { id: 3, name: "Akinyi", referred_by: Some(otieno.weak()) }
    people := m{ 1: otieno, 2: wanjiru, 3: akinyi } as Map[int, Customer]

    // Background tasks. Each subscription is Unique and moves into its task.
    report(store.events.subscribe()).ignore()
    shared var alerts = [] as Vec[str]              // written by an escaping closure: must be shared
    watcher := watch(store.low.watch(), #{ n => alerts.push("${n} low at ${time.now()}") })
    // With a plain `var alerts`, the push above is E_WRITE_TO_CAPTURED_COPY (fix-it: shared var).

    // Three workers, each with its own subscription to the job queue.
    jobs := Queue.new.[Order]()
    done := Queue.new.[Outcome]()
    var subs = [jobs.subscribe(), jobs.subscribe(), jobs.subscribe()]
    var started = 0
    each_owned(subs, #{ sub =>
        started += 1                                 // `each_owned` doesn't keep `f`: written in place
        worker(started, sub, store, done).ignore()   // `sub` moves into the task
    })
    // extra := jobs.subscribe()
    // worker(4, extra, store, done).ignore()
    // worker(5, extra, store, done).ignore()   // E_USE_AFTER_MOVE: a Sub is Unique

    // Feed the day's orders.
    let incoming = json.parse.[Vec[OrderIn]](ORDERS) or e => {
        log.error("bad orders: ${e}")
        return
    }
    var sent = 0
    for o in incoming {
        let Some(who) = people.get(o.customer) else {
            log.warn("order ${o.id}: unknown customer ${o.customer}")
            continue
        }
        order := Order { id: o.id, customer: who, channel: o.channel, lines: o.lines, payment: payment(o.pay) }
        // screen(order)   // E_WRITE_TO_IMMUTABLE: `order` is `:=`; a `*Order` needs `:==` / `var`
        await jobs.publish(order) or break
        sent += 1
    }

    // Collect the outcomes, giving up after two seconds.
    var results = done.subscribe()
    var outcomes = [] as Vec[Outcome]
    collecting: for outcomes.len() < sent {
        select {
            Some(r) = results.next() => outcomes.push(r)
            time.after(2_000) => {
                log.warn("gave up waiting for ${sent - outcomes.len()} order(s)")
                break collecting
            }
        }
    }
    for o in incoming {
        let Some(r) = outcomes.find(#{ it.order == o.id }) else { continue }
        flags := if r.flags.is_empty() { "" } else { " [${r.flags.join(", ")}]" }
        log.println("order ${r.order} (worker ${r.worker}): ${r.status}${flags}")
    }

    // Restock through a `(*Item) -> R` closure: the write lands in the shared stock.
    store.adjust("MILK-500", #{ it.qty += 24 })

    // Value semantics: `opening` was taken before any sale and still shows the morning's stock.
    if let Some(var milk) = opening.items.get("MILK-500") {
        milk.price = Money { cents: 5900 }           // changes this local copy only
        log.println("promo milk ${milk.price}; catalog still says ${opening.items["MILK-500"].price}")
    }
    log.println("stock value: morning ${opening.value()}, now ${store.snapshot().value()}")

    // Close the day: tiers are written once.
    customers := people.values()
    assign_tiers(store, customers)
    let again = recover { assign_tiers(store, customers) }
    if let Err(p) = again { log.println("tiers are write-once: ${p.kind}") }
    for c in customers {
        referrer := match c.referred_by {
            Some(w) => match w.upgrade() {
                Some(r) => ", referred by ${r.name}"
                None => ""
            }
            None => ""
        }
        log.println("${c.name}: ${c.tier ?? Bronze}, spent ${store.spend_of(c)}${referrer}")
    }

    log.println("takings ${store.till()}; ${orders_seen} seen, ${orders_refused} refused")
    log.println("alerts: ${alerts.len()}")
    watcher.cancel()
    store.events.close()
}
