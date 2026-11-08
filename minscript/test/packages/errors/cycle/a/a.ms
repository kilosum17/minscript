package a

import "app.b"

pub fun one() -> int { 1 }
pub fun two() -> int { b.two() }
