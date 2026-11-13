// A `path:` dependency of examples/projects/basic: imported as `shared`, which stays a valid name
// because `shared` is a contextual keyword (spec §1.4).
package shared

pub fn money(cents: int) -> str {
    let frac = cents % 100
    "$${cents / 100}.${if frac < 10 { "0" } else { "" }}${frac}"
}

pub fn banner() -> str { "[shared]" }
