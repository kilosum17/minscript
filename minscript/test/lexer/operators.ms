package lexer_operators

fun main() {
    var x = 1

    // arithmetic
    x = a + b - c * d / e % f

    // bitwise (generics never use < >, so maximal munch is always right)
    x = a & b | c ^ d << 1 >> 2
    x = a>>b                            // SHR, no splitting needed anywhere
    let shifted = Vec[Vec[int]]         // RBRACKET RBRACKET (not an operator)

    // comparison and logic
    let c1 = a == b
    let c2 = a != b
    let c3 = a<b                        // LT: always comparison
    let c4 = a <= b
    let c5 = a>b
    let c6 = a >= b
    let l1 = !a && b || c

    // assignment family
    x = 1
    x += 1
    x -= 1
    x *= 2
    x /= 2
    x %= 3
    x &= 1
    x |= 2
    x ^= 3
    x <<= 1
    x >>= 1
    opt ??= 5                           // NULLISH_ASSIGN

    // bindings
    y := 1                              // COLON_EQ
    z :== 2                             // COLON_EQ_EQ

    // ranges and spread
    let r1 = 0..10                      // DOTDOT
    let r2 = 0..=10                     // DOTDOTEQ
    let r3 = r{ ...base, a: 1 }         // ELLIPSIS

    // option family
    let o1 = user?.name                 // QUESTION_DOT
    let o2 = get()?                     // QUESTION
    let o3 = a ?? b                     // NULLISH
    let o4 = a?.b ?? c?.d ?? e

    // arrows
    let f = #{ a: int -> int => a }     // ARROW, FAT_ARROW
}

fun arrow() -> int { 1 }                // ARROW in a declaration
