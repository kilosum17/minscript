package shape

pub type Counter = {
    pub step: int
    pub count: int = 0

    pub fun new(step: int) -> Counter { Counter { step } }
    pub fun bump(&mut this) { this.count += this.step }
}
