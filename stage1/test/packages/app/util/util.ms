package util

pub fun sum(xs: Vec[int]) -> int {
    var total = 0
    for x in xs { total += x }
    total
}

pub fun shout(s: &str) -> string { "${s.to_upper()}!" }
