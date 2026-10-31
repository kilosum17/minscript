
export const KWS = [
    "package", "import", "pub", "type", "inter", "impl", "fun", "async", "let", "var", "mut", "extern",
    "if", "else", "match", "for", "in", "while", "loop", "break", "continue", "return",
    "await", "or", "as", "unsafe", "recover", "true", "false", "nil", "this", "Self", "TypeOf",
] as const

export type TKeyword = (typeof KWS)[number]

export const KWS_SET = new Set(KWS);

export const OPERATORS = [
    ">>=", "<<=", "...", "..=", "?.", "??", ":==", ":=", "->", "=>", "==", "!=", "<=", ">=", "&&", "||",
    "<<", ">>", "+=", "-=", "*=", "/=", "%=", "..", "++", "--",
    "=", "+", "-", "*", "/", "%", "<", ">", "!", "&", "|", "^", "~", "?", ".", ":", ";", ",", "@",
    "(", ")", "[", "]", "{", "}",
];

export const OPEN_TO_CLOSE: Record<string, string> = {
    "LPAREN": "RPAREN",
    "LBRACKET": "RBRACKET",
    "LBRACE": "RBRACE",
    "RECORD_OPEN": "RBRACE",
    "MAP_OPEN": "RBRACE",
    "SET_OPEN": "RBRACE",
    "INFERRED_OPEN": "RBRACE",
    "TAGGED_RECORD_OPEN": "RBRACE",
    "CLOSURE_OPEN": "RBRACE",
    "TUPLE_OPEN": "RPAREN",
    "ARRAY_OPEN": "RBRACKET",
    "VEC_OPEN": "RBRACKET",
    "CAPTURE_OPEN": "RBRACKET",
    "INTERP_START": "INTERP_END",
};

export const CLOSERS = new Set(["RPAREN", "RBRACKET", "RBRACE", "INTERP_END"]);

