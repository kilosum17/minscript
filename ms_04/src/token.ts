// Tokens (spec §1). Keywords, punctuators and sigils use their own text as `kind`; every other
// token is one of the named kinds below.

export type TokenValue = string | bigint | number;

export interface Token {
    kind: string;
    /** byte offsets into the UTF-8 source */
    start: number;
    end: number;
    /** whitespace or a comment directly before */
    wsBefore: boolean;
    /** a newline since the previous token (a newline inside a block comment counts) */
    nlBefore: boolean;
    /** openers (and template heads / middles): index of the matching closer */
    match?: number;
    /** Ident name, Int (bigint), Float (number), cooked String / Char / Template text, Byte (number) */
    value?: TokenValue;
    /** String / Template parts written with """ */
    multiline?: boolean;
    /** a closer the lexer inserted to keep delimiters balanced (§1.1) */
    synthetic?: boolean;
}

export const NAMED_KINDS = [
    "Ident", "Int", "Float", "String", "RawString", "Char", "Byte",
    "TemplateHead", "TemplateMiddle", "TemplateTail", "_", "EOF",
] as const;

/** §1.4: keywords proper, plus the removed and reserved ones (lexed as keywords so the parser can report them). */
export const KEYWORDS: ReadonlySet<string> = new Set([
    // declarations
    "package", "import", "pub", "type", "union", "inter", "impl", "fn", "async", "let", "var", "extern",
    // control
    "if", "else", "match", "select", "for", "in", "break", "continue", "return", "lock",
    // expressions
    "await", "or", "as", "unsafe", "recover", "true", "false", "nil", "this", "Self",
    // type-level
    "TypeOf",
    // removed
    "fun", "mut",
    // reserved
    "while", "loop", "yield", "macro", "where", "dyn", "thread", "atomic",
]);

export const REMOVED_KEYWORDS: ReadonlySet<string> = new Set(["fun", "mut"]);
export const RESERVED_KEYWORDS: ReadonlySet<string> = new Set([
    "while", "loop", "yield", "macro", "where", "dyn", "thread", "atomic",
]);

/** Openers and the closer each expects. Template heads are handled by the lexer separately. */
export const OPENERS: Readonly<Record<string, string>> = {
    "(": ")", "[": "]", "{": "}",
    "r{": "}", "m{": "}", "s{": "}", "_{": "}", "#{": "}",
    "t(": ")", "a[": "]", "#[": "]", ".[": "]",
};

export const CLOSERS: ReadonlySet<string> = new Set([")", "]", "}"]);

/** Punctuators, longest first (maximal munch, §1.8). */
export const PUNCTUATORS: readonly string[] = [
    "...", "..=", "??=", ":==", "<<=", ">>=",
    "..", "?.", "??", ":=", "->", "=>", "==", "!=", "<<", "<=", ">>", ">=",
    "+=", "++", "-=", "--", "*=", "/=", "%=", "&&", "&=", "||", "|=", "^=",
    ".", "?", ":", "=", "!", "<", ">", "+", "-", "*", "/", "%", "&", "|", "^", "~", ",", ";",
    "(", ")", "[", "]", "{", "}",
];

/** Tokens after which a newline or a `.digit` can't continue a value (spec §1.5 rule 3, §5.4). */
export function endsExpression(kind: string): boolean {
    switch (kind) {
        case "Ident": case "_": case "Int": case "Float": case "String": case "RawString": case "Char":
        case "Byte": case "TemplateTail": case ")": case "]": case "}": case "this": case "Self":
        case "true": case "false": case "nil": case "?":
            return true;
        default:
            return false;
    }
}
