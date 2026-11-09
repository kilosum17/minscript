package catalog

/// Money in cents. A small record of primitives, so copying it is a bit copy (spec §2).
pub type Money: Stringer {
    pub cents: int

    pub fn zero() -> Money { Money { cents: 0 } }
    fn to_str(this) -> str { "KSh ${this.cents / 100}.${pad2(this.cents % 100)}" }
}

impl Plus[Money, Money] for Money {
    fn plus(this, rhs: Money) -> Money { Money { cents: this.cents + rhs.cents } }
}

impl Times[int, Money] for Money {
    fn times(this, n: int) -> Money { Money { cents: this.cents * n } }
}

fn pad2(n: int) -> str { if n < 10 { "0${n}" } else { "${n}" } }

pub type Sku = str                                  // an alias, not a new type

pub type Item {
    pub sku: Sku
    pub name: str
    pub price: Money
    pub qty: int = 0
    pub tags: Vec[str] = []
}

pub type Inventory {
    pub items: Map[Sku, Item] = m{}

    pub fn has(this, sku: Sku) -> bool { this.items.has(sku) }

    /// Keeps [item]: the item is stored, so the caller's value moves in, or is shared if the
    /// caller still uses it (§2). Either way no deep copy happens here.
    pub fn add(*this, item: Item) { this.items[item.sku] = item }

    /// A write view into the map (§5.2): the caller changes the stored item in place. It can't be
    /// stored, and while it is live nothing else may touch `this.items` (E_ACCESS_DURING_WRITE_VIEW).
    /// Panics with MissingKey for an unknown SKU.
    pub fn at_mut(*this, sku: Sku) -> *Item { this.items[sku] }

    /// Views of the stored items, not copies (collection getters return views, §11.4).
    pub fn low_stock(this, below: int) -> Vec[Item] {
        this.items.values().filter(#{ it.qty < below })
    }

    pub fn value(this) -> Money {
        this.items.values().fold(Money.zero(), #{ acc, i => acc + i.price * i.qty })
    }
}

/// Parses `sku,name,price_cents,qty,tags` lines. Every field starts as a view into `text`;
/// `detach()` gives the kept ones their own small buffers, so a large catalog file can be freed
/// once it is loaded (spec §5.4). Without it, each item would keep the whole file alive.
pub fn load_csv(text: str) -> Result[Inventory, str] {
    var inv = Inventory {}
    for line, i in text.lines().skip(1) {
        if line.trim().is_empty() { continue }
        cols := line.split(",")
        if cols.len() != 5 { return Err("line ${i + 2}: expected 5 fields, got ${cols.len()}") }
        cents := cols[2].to_int() or Err("line ${i + 2}: bad price `${cols[2]}`")
        qty := cols[3].to_int() or Err("line ${i + 2}: bad quantity `${cols[3]}`")
        // `var acc` is a mutable closure parameter (§8.4): a local copy, unique here, so `push`
        // writes in place and the fold allocates one Vec
        tags := cols[4].split(" ").fold([] as Vec[str], #{ var acc, t =>
            if !t.is_empty() && !acc.contains(t) { acc.push(t.detach()) }
            acc
        })
        inv.add(Item { sku: cols[0].detach(), name: cols[1].detach(), price: Money { cents }, qty, tags })
    }
    Ok(inv)
}
