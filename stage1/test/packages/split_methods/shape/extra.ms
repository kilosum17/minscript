package shape

impl Counter {
    pub fun total(&this) -> int { this.count * 10 }
    pub fun describe(&this) -> string { "step ${this.step}" }
}
