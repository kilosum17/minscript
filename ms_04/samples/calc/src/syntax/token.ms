package syntax

/// Byte offsets into one source text. A small value type: copying it is a bit copy (spec §2).
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

/// A token is an identity value (spec §11.1): built once, never changed, compared and hashed by
/// pointer. Two tokens with the same text are still two tokens; their `name`s are the same Symbol.
pub type Token: Identity {
    pub kind: TokenKind
    pub text: str                  // a view into the source: storing it shares the buffer (§5.1)
    pub span: Span
    pub name: Symbol? = None       // interned by the lexer for Name tokens (§11.3)
}
