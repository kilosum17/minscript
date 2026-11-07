// Token definitions for the MinScript lexer (spec §1).

/** Keywords (spec §1.4). A keyword's token kind is its own text. */
export const KEYWORDS = [
    // declarations
    "package", "import", "pub", "type", "union", "inter", "impl", "fun", "async", "let", "var", "mut", "extern",
    // control
    "if", "else", "match", "select", "for", "in", "break", "continue", "return",
    // expressions
    "await", "or", "as", "unsafe", "recover", "true", "false", "nil", "this", "Self",
    // type-level
    "TypeOf",
    // reserved: lexed as keywords so the parser can report E_RESERVED_KEYWORD with a hint
    "while", "loop", "yield", "macro", "where", "dyn",
] as const

export type Keyword = (typeof KEYWORDS)[number]

export const RESERVED_KEYWORDS: ReadonlySet<string> = new Set(["while", "loop", "yield", "macro", "where", "dyn"])

const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS)
export function isKeyword(s: string): s is Keyword {
    return KEYWORD_SET.has(s)
}

/** Operators and punctuation (spec §1.7). A punctuator's token kind is its own text. */
export const PUNCTUATORS = [
    // longest first within each family, so a table-driven matcher would also be maximal munch
    "...", "..=", "..", ".[", ".",
    "??=", "??", "?.", "?",
    ":==", ":=", ":",
    "<<=", "<<", "<=", "<",
    ">>=", ">>", ">=", ">",
    "==", "=>", "=",
    "!=", "!",
    "->", "-=", "--", "-",
    "+=", "++", "+",
    "*=", "*", "/=", "/", "%=", "%",
    "&&", "&=", "&",
    "||", "|=", "|",
    "^=", "^",
    "~", ",", ";", "@",
    "(", ")", "[", "]", "{", "}",
] as const

export type Punctuator = (typeof PUNCTUATORS)[number]

/** Glued sigil openers (spec §1.6). `r"` raw strings produce a `RawString` token instead. */
export const SIGILS = ["r{", "m{", "s{", "t(", "a[", "_{", "#{", "#["] as const
export type Sigil = (typeof SIGILS)[number]

export type LiteralKind =
    | "Ident"           // value: the name
    | "_"               // a lone underscore (wildcard)
    | "Int"             // value: bigint
    | "Float"           // value: number
    | "String"          // "…" or """…""" without interpolation; value: cooked text
    | "RawString"       // r"…"; value: the raw text (CRLF normalized)
    | "Char"            // value: one Unicode scalar value, as a string
    | "TemplateHead"    // `"text${`        value: cooked text before the first `${`
    | "TemplateMiddle"  // `}text${`        value: cooked text between two interpolations
    | "TemplateTail"    // `}text"`         value: cooked text after the last interpolation
    | "EOF"

export type TokenKind = LiteralKind | Keyword | Punctuator | Sigil

export type Span = {
    start: number   // byte offset into the original UTF-8 source (inclusive)
    end: number     // byte offset (exclusive)
    line: number    // 1-based line of `start`
    col: number     // 1-based column of `start`, counted in Unicode code points
}

export type Token = {
    kind: TokenKind
    span: Span
    ws_before: boolean          // whitespace or a comment directly before
    nl_before: boolean          // a newline (possibly inside a block comment) since the previous token
    match?: number              // openers: index of the matching closer in the token array
    value?: string | bigint | number
    multiline?: boolean         // String / Template*: written as """…"""
}

export type TriviaKind = "line" | "doc" | "block"

export type Trivia = {
    kind: TriviaKind
    span: Span
    text: string                // full source text of the comment, delimiters included
}

/** Openers and the closer each one expects. Sigils open like their bracket. */
export const CLOSER_OF: Readonly<Record<string, ")" | "]" | "}">> = {
    "(": ")", "t(": ")",
    "[": "]", "a[": "]", "#[": "]", ".[": "]",
    "{": "}", "r{": "}", "m{": "}", "s{": "}", "_{": "}", "#{": "}",
}

/**
 * Tokens after which an expression may have ended. Used to tell `.5` (an invalid leading-dot float)
 * from tuple indexing after a value.
 */
export const ENDS_EXPRESSION: ReadonlySet<TokenKind> = new Set<TokenKind>([
    "Ident", "_", "Int", "Float", "String", "RawString", "Char", "TemplateTail",
    ")", "]", "}", "?",
    "true", "false", "nil", "this", "Self",
])
