package store

import "app.catalog.*"
import "app.orders.*"

/// What a worker reports for each order.
pub type Outcome = r{ order: int, worker: int, status: Status, flags: Vec[str] }

// ---- two checks on one order, in parallel (spec §7) --------------------------------------------

/// Summary: reads [o.lines] writes [o.total, o.status]. `store` is read-only; its shared stock
/// takes care of itself.
async fn price(o: *Order, store: Store) {
    match store.reserve(o.lines) {
        Ok(total) => {
            o.total = total
            o.status = Priced(total)
        }
        Err(why) => o.status = Refused(why)
    }
}

/// Summary: reads [o.lines, o.payment, o.channel] writes [o.flags].
async fn screen(o: *Order) {
    units := o.lines.fold(0, #{ n, l => n + l.qty })
    if units > 20 { o.flags.push("bulk") }
    if let Mpesa(phone) = o.payment {
        if !phone.starts_with("07") && !phone.starts_with("01") { o.flags.push("odd phone") }
    }
    if o.channel == "phone" && o.lines.len() > 3 { o.flags.push("call back") }
}

// ---- the worker --------------------------------------------------------------------------------

/// One worker task.
/// - `jobs` is `Unique` and `for await` advances it, so the summary says `consumes [jobs]`: the
///   caller must move its subscription in (spec §2.1). No `mut`, no extra syntax.
/// - `store` is a copy of the caller's Store; its shared fields alias the real ones (§6.1).
/// - `done` is a std handle, so the same rule applies.
pub async fn worker(id: int, jobs: Sub[Order], store: Store, done: Queue[Outcome]) {
    var gateway = FakeGateway.new(id)
    for await var o in jobs {                        // `var` pattern: we own the order and change it
        orders_seen += 1

        // Both calls get `o` as `*Order` in one statement. Their writes are disjoint
        // ([o.total, o.status] vs [o.flags]), so they run in parallel without a lock.
        await all(price(o, store), screen(o))
        // await all(price(o, store), price(o, store))   // E_CONCURRENT_OVERLAP: both write o.total
        // p := screen(o)                                  // E_VIEW_ACROSS_TASK: `*` argument not awaited

        if let Priced(total) = o.status {
            match await gateway.charge(total, o.payment) {
                Ok(receipt) => {
                    store.book(o.customer, total)
                    o.status = Paid { total, receipt }
                }
                Err(why) => {
                    store.release(o.lines)
                    o.status = Refused(why)
                }
            }
        }

        let event: Event = match o.status {           // variants inferred from `Event`
            Paid { total, .. } => Sold { order: o.id, total }
            Refused(why) => {
                orders_refused += 1
                Refused { order: o.id, why }
            }
            _ => continue
        }
        store.events.publish(event)
        store.check_low(3)
        // The record takes `o.status` and `o.flags`: their last use, so they move, no copy.
        await done.publish(r{ order: o.id, worker: id, status: o.status, flags: o.flags }) or return
    }
}

/// Hands each element of `items` to `f`, moving it out. `[T: Unique]` lets `T` be a `Sub`, a
/// socket or a `Resolver`: the body is checked with move rules for `T` (spec §2.1), so using `x`
/// twice would be E_USE_AFTER_MOVE. Without the bound, `each_owned(subs, …)` would be
/// E_UNIQUE_TYPE_ARG.
pub fn each_owned[T: Unique](items: *Vec[T], f: (T) -> void) {
    for {
        let Some(x) = items.pop() else { break }
        f(x)
    }
}

/// Prints every event until the topic closes. Consumes its subscription, like `worker`.
pub async fn report(feed: Sub[Event]) {
    for await ev in feed {
        match ev {
            Sold { order, total } => log.println("  #${order} sold for ${total}")
            Refused { order, why } => log.println("  #${order} refused: ${why}")
            LowStock(n) => log.println("  ${n} item(s) running low")
        }
    }
}

/// Calls `on` for every change of a signal. `on` escapes into this task (`keeps [on]`), so a
/// closure passed here that writes a captured `var` must make it `shared` (§6.3).
pub async fn watch(w: Watcher[int], on: (int) -> void) {
    for await n in w { on(n) }
}
