package orders

import "app.catalog.{Money, Sku}"

pub type Channel = "web" | "shop" | "phone"        // a literal union
pub type Line = r{ sku: Sku, qty: int }             // a structural record

pub union Payment {
    Cash
    Mpesa(str)                                      // phone number
    Card { last4: str, exp: str }

    pub fn label(this) -> str {
        match this {
            Cash => "cash"
            Mpesa(phone) => "M-Pesa ${phone}"
            Card { last4, .. } => "card ending ${last4}"
        }
    }
}

pub union Status {
    New
    Priced(Money)
    Refused(str)
    Paid { total: Money, receipt: str }
}

pub union Tier { Bronze  Silver  Gold }

/// One object per real customer (spec §11.1). Every order for Wanjiru holds the same object, maps
/// key by its pointer, and passing it around is a refcount increment, never a copy.
pub type Customer: Identity {
    pub id: int
    pub name: str
    pub referred_by: Weak[Customer]? = None        // must not keep the referrer alive (§5.3)
    pub once tier: Tier                             // decided once, at the end of the day (§11.2)
}

// `once` needs an identity type: on `Order` (a value type) it would be E_ONCE_OUTSIDE_IDENTITY,
// because two copies of an order could disagree about whether it was set.

/// An order is an ordinary value. Workers own one at a time, and its fields are separate paths,
/// so two tasks can fill different fields of the same order at once (§7).
pub type Order {
    pub id: int
    pub customer: Customer
    pub channel: Channel = "web"
    pub lines: Vec[Line]
    pub payment: Payment = Cash
    pub total: Money = Money.zero()
    pub flags: Vec[str] = []
    pub status: Status = New
}
