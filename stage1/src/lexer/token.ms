// Tokens (spec §1), ported from minscript/src/token.ts. A token's kind is its own text for keywords,
// punctuators and sigils ("let", "??=", "r{"), and a name for literals ("Ident", "Int", "String", …).
package lexer

/// Byte offsets into the UTF-8 source (`end` exclusive), 1-based line, and the column of `start`
/// counted in Unicode code points.
pub type Span = r{ start: int, end: int, line: int, col: int }

/// A literal token's value.
pub union Value = {
    Text(string)        // Ident, String, RawString, Char, Template*: the cooked text
    Int(string)         // Int: decimal digits (literals may exceed u64)
    Float(f64)
}

pub type Token = {
    pub kind: string
    pub span: Span
    /// whitespace or a comment directly before
    pub ws_before: bool
    /// a newline (possibly inside a block comment) since the previous token
    pub nl_before: bool
    /// openers: the index of the matching closer
    pub closer: int?
    pub value: Value?
    /// String / Template*: written as `"""…"""`
    pub multiline: bool = false
}

pub type Trivia = {
    /// "line", "doc" or "block"
    pub kind: string
    pub span: Span
    /// the comment's full text, delimiters included
    pub text: string
}

pub type Diagnostic = {
    pub code: string
    pub message: string
    pub span: Span
}

pub type LexResult = {
    /// always ends with an EOF token
    pub tokens: Vec[Token]
    pub trivia: Vec[Trivia]
    pub diagnostics: Vec[Diagnostic]
}

/// Keywords (spec §1.4), including the reserved ones (lexed as keywords so the parser can hint).
pub fun is_keyword(s: &str) -> bool {
    match s {
        "package" | "import" | "pub" | "type" | "union" | "inter" | "impl" | "fun" | "async" | "let" | "var" | "mut" | "extern" => true
        "if" | "else" | "match" | "select" | "for" | "in" | "break" | "continue" | "return" => true
        "await" | "or" | "as" | "unsafe" | "recover" | "true" | "false" | "nil" | "this" | "Self" | "TypeOf" => true
        "while" | "loop" | "yield" | "macro" | "where" | "dyn" => true
        _ => false
    }
}

/// The closer an opener (bracket or sigil) expects.
pub fun closer_of(kind: &str) -> string {
    match kind {
        "(" | "t(" => ")"
        "[" | "a[" | "#[" | ".[" => "]"
        _ => "}"
    }
}

/// Tokens after which an expression may have ended: tells `.5` (an invalid leading-dot float) from
/// tuple indexing after a value.
pub fun ends_expression(kind: &str) -> bool {
    match kind {
        "Ident" | "_" | "Int" | "Float" | "String" | "RawString" | "Char" | "TemplateTail" => true
        ")" | "]" | "}" | "?" | "true" | "false" | "nil" | "this" | "Self" => true
        _ => false
    }
}

/// Tokens after which a single letter is a name, never a sigil (spec §1.6).
pub fun no_glue(kind: &str) -> bool {
    match kind {
        "." | "?." | "fun" | "type" | "union" | "inter" => true
        _ => false
    }
}

/// The punctuators that start with byte `c`, longest first (maximal munch). Brackets aren't here.
pub fun punctuators(c: int) -> Vec[string] {
    match c {
        46 => ["...", "..=", "..", ".[", "."]       // .
        63 => ["??=", "??", "?.", "?"]              // ?
        58 => [":==", ":=", ":"]                    // :
        60 => ["<<=", "<<", "<=", "<"]              // <
        62 => [">>=", ">>", ">=", ">"]              // >
        61 => ["==", "=>", "="]                     // =
        33 => ["!=", "!"]                           // !
        45 => ["->", "-=", "--", "-"]               // -
        43 => ["+=", "++", "+"]                     // +
        42 => ["*=", "*"]                           // *
        47 => ["/=", "/"]                           // /
        37 => ["%=", "%"]                           // %
        38 => ["&&", "&=", "&"]                     // &
        124 => ["||", "|=", "|"]                    // |
        94 => ["^=", "^"]                           // ^
        126 => ["~"]
        44 => [","]
        59 => [";"]
        64 => ["@"]
        _ => []
    }
}
