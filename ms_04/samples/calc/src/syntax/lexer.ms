package syntax

/// Keywords by Symbol. A top-level `let` may have any initializer; it runs once, on first use,
/// thread-safely (spec §10.4). Lookups hash a pointer, never characters (§12.3).
let KEYWORDS = m{ sym("let"): Let, sym("fn"): Fn, sym("print"): Print } as Map[Symbol, TokenKind]

pub type LexError {
    pub msg: str
    pub span: Span
}

type Lexer {
    src: str                       // a view of the caller's text; stored, so it is a counted share
    bytes: Slice[u8]
    pos: int = 0
    out: Vec[Token] = []
    errors: Vec[LexError] = []

    fn peek(this) -> u8 {
        if this.pos < this.bytes.len() { this.bytes[this.pos] } else { 0 }
    }

    /// `*this`: the caller's lexer changes. Writes [this.out]; keeps [this.src] through `text`.
    fn push(*this, kind: TokenKind, start: int) {
        text := this.src.substring(start, this.pos)        // a free local view…
        name := if kind == Name { Some(sym(text)) } else { None }
        // …that becomes a share of the source buffer once it is stored in a Token. No copy.
        this.out.push(Token { kind, text, span: Span { start, end: this.pos }, name })
    }

    fn error(*this, msg: str, start: int) {
        this.errors.push(LexError { msg, span: Span { start, end: this.pos } })
    }
}

fn is_digit(c: u8) -> bool { c >= b'0' && c <= b'9' }

fn is_alpha(c: u8) -> bool {
    (c >= b'a' && c <= b'z') || (c >= b'A' && c <= b'Z') || c == b'_'
}

/// Summary: reads [src] keeps [src]. The tokens hold views of `src`, so its buffer lives exactly as
/// long as they do, and the caller's `src` may go out of scope first.
pub fn lex(src: str) -> t(Vec[Token], Vec[LexError]) {
    var lx = Lexer { src, bytes: src.bytes() }
    for lx.pos < lx.bytes.len() {
        start := lx.pos
        c := lx.peek()
        lx.pos += 1
        if c == b' ' || c == b'\t' || c == b'\r' { continue }
        if c == b'\n' { lx.push(Newline, start); continue }
        if c == b'#' {                                        // a comment runs to the end of the line
            for lx.pos < lx.bytes.len() && lx.peek() != b'\n' { lx.pos += 1 }
            continue
        }
        if is_digit(c) {
            for is_digit(lx.peek()) || lx.peek() == b'.' { lx.pos += 1 }
            lx.push(Num, start)
            continue
        }
        if is_alpha(c) {
            for is_alpha(lx.peek()) || is_digit(lx.peek()) { lx.pos += 1 }
            kind := KEYWORDS.get(sym(src.substring(start, lx.pos))) ?? Name
            lx.push(kind, start)
            continue
        }
        let p: Punct = match src.substring(start, lx.pos) {
            "+" => "+"
            "-" => "-"
            "*" => "*"
            "/" => "/"
            "(" => "("
            ")" => ")"
            "," => ","
            "=" => "="
            other => {
                lx.error("unexpected character `${other}`", start)
                continue
            }
        }
        lx.push(Punct(p), start)
    }
    lx.push(Eof, lx.pos)
    t(lx.out, lx.errors)              // last use of `lx`: both vectors move out, no copy
}
