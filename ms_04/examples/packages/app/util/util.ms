package util

pub fn sum(xs: Vec[int]) -> int {
    var total = 0
    for x in xs { total += x }
    total
}

pub fn shout(s: str) -> str { "${s.to_upper()}!" }
