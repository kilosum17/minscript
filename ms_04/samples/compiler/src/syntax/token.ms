package syntax

// Tokens (spec §1). Keywords, punctuators and sigils use their own text as `kind`; every other
// token is one of the named kinds: Ident, Int, Float, String, RawString, Char, Byte, TemplateHead,
// TemplateMiddle, TemplateTail, `_`, EOF.

/// What a literal or a name holds. `Int` is decimal digits: an integer literal may exceed i64
/// (`0xffff_ffff_ffff_ffff`), and the lexer doesn't know its type yet.
pub union Value {
    NoValue
    Name(str)
    Int(str)
    Float(f64)
    Text(str)
    Byte(int)
}

/// A token: a value type, small and hashed by its span (spec §12.1's table).
pub type Token {
    pub kind: str
    /// byte offsets into the UTF-8 source
    pub start: int
    pub end: int
    /// whitespace or a comment directly before
    pub ws: bool = false
    /// a newline since the previous token (one inside a block comment counts)
    pub nl: bool = false
    /// openers (and template heads / middles): the index of the matching closer; -1 for none.
    /// (`match` would be the natural name, but keywords can't be field names.)
    pub closer: int = -1
    pub value: Value = NoValue
    /// a String or template part written with `"""`
    pub multiline: bool = false
    /// a closer the lexer inserted to keep delimiters balanced (§1.1)
    pub synthetic: bool = false
}

/// A diagnostic (spec §18): a code, a message, a byte span and maybe a fix.
pub type Diag {
    pub code: str
    pub message: str
    pub start: int
    pub end: int
    pub fix: str? = None
}

/// §1.4: keywords proper, plus the removed and reserved ones (lexed as keywords so the parser can
/// report them).
pub let KEYWORDS = s{
    "package", "import", "pub", "type", "union", "inter", "impl", "fn", "async", "let", "var", "extern",
    "if", "else", "match", "select", "for", "in", "break", "continue", "return", "lock",
    "await", "or", "as", "unsafe", "recover", "true", "false", "nil", "this", "Self",
    "TypeOf",
    "fun", "mut",
    "while", "loop", "yield", "macro", "where", "dyn", "thread", "atomic",
} as Set[str]

pub let REMOVED_KEYWORDS = s{ "fun", "mut" } as Set[str]
pub let RESERVED_KEYWORDS = s{ "while", "loop", "yield", "macro", "where", "dyn", "thread", "atomic" } as Set[str]

/// Openers and the closer each expects. Template heads are handled by the lexer separately.
pub let OPENERS = m{
    "(": ")", "[": "]", "{": "}",
    "r{": "}", "m{": "}", "s{": "}", "_{": "}", "#{": "}",
    "t(": ")", "a[": "]", "#[": "]", ".[": "]",
} as Map[str, str]

/// Punctuators, longest first (maximal munch, §1.8).
pub let PUNCTUATORS = [
    "...", "..=", "??=", ":==", "<<=", ">>=",
    "..", "?.", "??", ":=", "->", "=>", "==", "!=", "<<", "<=", ">>", ">=",
    "+=", "++", "-=", "--", "*=", "/=", "%=", "&&", "&=", "||", "|=", "^=",
    ".", "?", ":", "=", "!", "<", ">", "+", "-", "*", "/", "%", "&", "|", "^", "~", ",", ";",
    "(", ")", "[", "]", "{", "}",
] as Vec[str]

/// Tokens after which a newline or a `.digit` can't continue a value (spec §1.5 rule 3, §5.4).
pub fn ends_expression(kind: str) -> bool {
    match kind {
        "Ident" | "_" | "Int" | "Float" | "String" | "RawString" | "Char" | "Byte" | "TemplateTail" => true
        ")" | "]" | "}" | "this" | "Self" | "true" | "false" | "nil" | "?" => true
        _ => false
    }
}
