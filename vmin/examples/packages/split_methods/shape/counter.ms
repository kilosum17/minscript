package shape

pub type Counter {
    pub step: int
    pub count: int = 0

    pub fn new(step: int) -> Counter { Counter { step } }
    pub fn bump(*this) { this.count += this.step }
}
