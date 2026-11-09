package shape

impl Counter {
    pub fn total(this) -> int { this.count * 10 }
    pub fn describe(this) -> str { "step ${this.step}" }
}
