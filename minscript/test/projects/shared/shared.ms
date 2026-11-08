// A `path:` dependency of test/projects/basic: imported as `shared`.
package shared

pub fun money(cents: int) -> string {
    let frac = cents % 100
    "$${cents / 100}.${if frac < 10 { "0" } else { "" }}${frac}"
}

pub fun banner() -> string { "[shared]" }
