package time

/// A Promise that resolves after `ms` milliseconds. Cancel-safe: use it in `select` for timeouts.
pub fun after(ms: int) -> Promise[void] { _builtin() }

/// Waits `ms` milliseconds.
pub async fun sleep(ms: int) { _builtin() }

/// Milliseconds since the Unix epoch.
pub fun now() -> i64 { _builtin() }

pub type Duration = {
    pub ms: i64

    pub fun seconds(&this) -> f64 { this.ms as f64 / 1000.0 }
}

pub type Instant = {
    pub at: i64

    /// The current time.
    pub fun now() -> Instant { Instant { at: now() } }
    /// How long ago this instant was.
    pub fun elapsed(&this) -> Duration { Duration { ms: now() - this.at } }
}
