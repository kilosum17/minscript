package store

import "app.catalog.*"
import "app.orders.*"

pub union Event {
    Sold { order: int, total: Money }
    Refused { order: int, why: str }
    LowStock(int)                                   // how many SKUs are below the threshold
}

/// Process-wide counters. A top-level `var` is implicitly shared (spec §10.4); each `+= 1` is one
/// atomic add.
pub var orders_seen = 0
pub var orders_refused = 0

/// The store's state. `shared` fields are cells: every copy of a `Store` points at the same cells
/// (§10.1), so `Store` can be passed to tasks by value, and they all see one stock and one till.
pub type Store {
    shared stock: Inventory
    shared takings: Money = Money.zero()
    shared spend: Map[Customer, Money] = m{}        // keyed by customer identity
    pub events: Topic[Event] = Topic.new.[Event]()  // std handle: a struct with a shared field
    pub low: Signal[int] = Signal(0)

    pub fn new(stock: Inventory) -> Store { Store { stock } }

    /// Takes every line or none. `this` is read-only, but `stock` is shared, so this method may
    /// write it (§10.1). The check and the take sit in one `lock`, so no other worker sees the
    /// half-done state; leaving the block, `return` included, releases it.
    pub fn reserve(this, lines: Vec[Line]) -> Result[Money, str] {
        lock this.stock {
            for l in lines {
                let Some(item) = this.stock.items.get(l.sku) else { return Err("no such item ${l.sku}") }
                if item.qty < l.qty { return Err("only ${item.qty} of ${item.name} left") }
            }
            var total = Money.zero()
            for l in lines {
                item := this.stock.at_mut(l.sku)      // a write view: the stock changes in place
                item.qty -= l.qty
                total = total + item.price * l.qty
            }
            Ok(total)                                 // `lock` is an expression: this is its value
        }
        // An `await` anywhere in that block would be E_AWAIT_IN_LOCK.
    }

    /// Puts the stock back after a failed payment.
    pub fn release(this, lines: Vec[Line]) {
        lock this.stock {
            for l in lines { this.stock.at_mut(l.sku).qty += l.qty }
        }
    }

    /// Two cells change together, so one `lock` takes both, in a fixed order (by address), and
    /// two workers booking at once can't deadlock.
    pub fn book(this, who: Customer, amount: Money) {
        lock this.takings, this.spend {
            this.takings = this.takings + amount
            this.spend[who] = (this.spend.get(who) ?? Money.zero()) + amount
        }
    }

    /// Runs `f` on one item under the stock lock. `f` gets a write view: `(*Item) -> R` (§9.4), so
    /// callers write `store.adjust(sku, #{ it.qty += 24 })`.
    pub fn adjust[R](this, sku: Sku, f: (*Item) -> R) -> R {
        lock this.stock { f(this.stock.at_mut(sku)) }
    }

    /// A snapshot (§10.1): later sales don't change it. It costs one refcount until somebody
    /// writes the stock, and then the writer copies, not the snapshot.
    pub fn snapshot(this) -> Inventory { this.stock }

    pub fn till(this) -> Money { this.takings }

    pub fn spend_of(this, who: Customer) -> Money { this.spend.get(who) ?? Money.zero() }

    /// One statement reads the stock (a read lock), the next sets the signal.
    pub fn check_low(this, below: int) {
        n := this.stock.low_stock(below).len()
        if n != this.low.get() {
            this.low.set(n)
            this.events.publish(LowStock(n))
        }
    }
}

/// End of day: every customer gets a tier, written once. Calling this again panics with
/// PanicKind.AlreadySet (§18.5).
pub fn assign_tiers(store: Store, customers: Vec[Customer]) {
    for c in customers {
        c.tier = match store.spend_of(c).cents {    // a once write through a read-only view
            n if n >= 100_000 => Gold
            n if n >= 30_000 => Silver
            _ => Bronze
        }
    }
}
