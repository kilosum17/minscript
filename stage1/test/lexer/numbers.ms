package lexer_numbers

fun main() {
    // integers
    let a = 0
    let b = 123
    let c = 1_000_000
    let d = 0xFF
    let e = 0xdead_BEEF
    let f = 0b1010_1010
    let g = 0o17

    // floats
    let h = 1.5
    let i = 1e9
    let j = 2.5e-3
    let k = 6.02e+23
    let l = 1_000.5

    // a `.` belongs to the number only when a digit follows it
    let r1 = 1..10          // INT(1) DOTDOT INT(10)
    let r2 = 1..=10         // INT(1) DOTDOTEQ INT(10)
    let r3 = 0..n           // INT(0) DOTDOT IDENT(n)
    let s1 = 1.to_str()     // INT(1) DOT IDENT(to_str) LPAREN RPAREN
    let s2 = 1.5.to_str()   // FLOAT(1.5) DOT IDENT(to_str) …

    // after a member `.`, only digits are lexed (tuple indexing)
    let t1 = pair.0         // IDENT DOT INT(0)
    let t2 = nested.0.1     // IDENT DOT INT(0) DOT INT(1), never FLOAT(0.1)
    let t3 = deep.1.0.2     // IDENT DOT INT(1) DOT INT(0) DOT INT(2)

    // unary minus is an operator, not part of the literal
    let neg = -42           // MINUS INT(42)
    let negf = -0.5         // MINUS FLOAT(0.5)
}
