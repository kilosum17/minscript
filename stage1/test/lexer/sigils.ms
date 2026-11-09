package lexer_sigils

// no-glue contexts: a letter after `fun`, `type`, `union`, `inter` is a name, not a sigil
fun t[T](value: T) -> T { value }       // IDENT(t) LBRACKET … (not TUPLE_OPEN, not ARRAY_OPEN)
fun a(x: int) -> int { x }              // IDENT(a) LPAREN
type m = { v: int }                     // IDENT(m) (lowercase type: lint warning, lexes fine)
union s = { One  Two }
inter r = { fun f(&this) }

fun main() {
    // glued sigils: one token each
    let rec = r{ a: 1 }                 // RECORD_OPEN
    let map = m{ "a": 1 }               // MAP_OPEN
    let set = s{ 1, 2 }                 // SET_OPEN
    let tup = t(1, 2)                   // TUPLE_OPEN
    let arr = a[1, 2]                   // ARRAY_OPEN (the resolver would also report E_SIGIL_SHADOWS_BINDING because of `fun a` above; lexer tests ignore that)
    let inf: Point = _{ x: 1, y: 2 }    // INFERRED_OPEN
    let clo = #{ it }                   // CLOSURE_OPEN
    let cap = #[x]{ it + x }            // CAPTURE_OPEN IDENT(x) RBRACKET LBRACE(glued)
    let gen = f.[i32](1)                // IDENT(f) GENERIC_OPEN IDENT(i32) RBRACKET …
    let raw = r"x\y"                    // RAW_STRING
    let unit = t()                      // TUPLE_OPEN RPAREN
    let vec = [1, 2]                    // LBRACKET (plain Vec literal, no sigil)

    // not glued: ordinary identifiers
    let idx = a [0]                     // IDENT(a) LBRACKET INT RBRACKET  (index)
    let call = t (1)                    // IDENT(t) LPAREN INT RPAREN      (call)

    // the letter is the tail of a longer identifier: no sigil
    let x1 = data[0]                    // IDENT(data) LBRACKET
    let x2 = cat(1)                     // IDENT(cat) LPAREN
    let x3 = items.len()

    // after `.`: a member name, never a sigil
    let x4 = obj.a[0]                   // IDENT DOT IDENT(a) LBRACKET
    let x5 = obj.t(1)                   // IDENT DOT IDENT(t) LPAREN
    let x6 = obj.r                      // IDENT DOT IDENT(r)

    // underscore forms
    let _unused = 1                     // IDENT(_unused)
    let t(_, second) = pair             // `_` alone is the wildcard
    let w = __x                         // IDENT(__x)

    // generic args in type position use a glued `[`, not `.[`
    let v: Vec[Map[string, int]] = []   // IDENT LBRACKET IDENT LBRACKET … RBRACKET RBRACKET
    let nested = Vec.[Vec[u8]].new()    // GENERIC_OPEN IDENT LBRACKET IDENT RBRACKET RBRACKET
}
