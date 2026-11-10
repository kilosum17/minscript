package syntax

/// Byte offsets into one source text. A small value type: copying it is a bit copy (spec §9.1).
pub type Span {
    pub start: int
    pub end: int

    pub fn to(this, other: Span) -> Span { Span { start: this.start, end: other.end } }
}

/// The punctuation calc knows: a literal union, so `match` over it is checked for exhaustiveness.
pub type Punct = "+" | "-" | "*" | "/" | "(" | ")" | "," | "="

pub union TokenKind {
    Num
    Name
    Let
    Fn
    Print
    Punct(Punct)
    Newline
    Eof
}

/// A token is a small value type (spec §12.1, "Choosing a representation"): no allocation per
/// token. It compares and hashes by its fields, and the span is unique within one source, so two
/// tokens with the same text are still two different keys; their `name`s are the same Symbol.
pub type Token {
    pub kind: TokenKind
    pub text: str                  // a view into the source: storing it shares the buffer (§9.6)
    pub span: Span
    pub name: Symbol? = None       // interned by the lexer for Name tokens (§12.3)
}
