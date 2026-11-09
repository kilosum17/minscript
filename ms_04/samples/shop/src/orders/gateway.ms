package orders

import "std.time"
import "app.catalog.Money"

pub inter Charger {
    async fn charge(*this, amount: Money, how: Payment) -> Result[str, str]
}

pub inter Refunder {
    async fn refund(*this, receipt: str) -> Result[void, str]

    fn can_refund(this, receipt: str) -> bool { receipt.starts_with("RCPT-") }   // default body
}

pub inter Gateway = Charger & Refunder              // composition is an alias: keeps `=`

/// A fake gateway: one per worker, like one connection per worker, so it needs no `shared`.
pub type FakeGateway: Gateway {
    worker: int
    calls: int = 0
    declined: str = "0700000000"

    pub fn new(worker: int) -> FakeGateway { FakeGateway { worker } }

    async fn charge(*this, amount: Money, how: Payment) -> Result[str, str] {
        this.calls += 1
        await time.sleep(1)                          // a `*this` method may await: `this` is ours
        match how {
            Mpesa(phone) if phone == this.declined => Err("M-Pesa declined for ${phone}")
            Card { last4, .. } if last4 == "1111" => Err("card ending 1111 declined")
            _ => Ok("RCPT-${this.worker}-${this.calls}-${amount.cents}")
        }
    }

    async fn refund(*this, receipt: str) -> Result[void, str] {
        this.calls += 1
        if this.can_refund(receipt) { Ok() } else { Err("unknown receipt ${receipt}") }
    }
}
