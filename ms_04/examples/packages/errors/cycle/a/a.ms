package a

import "app.b"

pub fn one() -> int { 1 }
pub fn two() -> int { b.two() }
