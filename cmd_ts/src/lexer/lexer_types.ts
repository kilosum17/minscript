
export class Span {
    startLine: number = 0
    endLine: number = 0
    startCol: number = 0
    endCol: number = 0
}

export const KWS = [
    "package", "import", "pub", "type", "inter", "impl", "fun", "async", "let", "var", "mut", "extern",
    "if", "else", "match", "for", "in", "while", "loop", "break", "continue", "return",
    "await", "or", "as", "unsafe", "recover", "true", "false", "nil", "this", "Self", "TypeOf",
] as const

export const SIG = [
    "r{", "m{", "s{", "t(", "v[", 'a[',
    "#{", '${',
] as const

export const OTHER = [
    '"', "."
]

export const OPERATORS = [
    ">>=", "<<=", "...", "..=", "?.", "??", ":==", ":=", "->", "=>", "==", "!=", "<=", ">=", "&&", "||",
    "<<", ">>", "+=", "-=", "*=", "/=", "%=", "..", "++", "--",
    "=", "+", "-", "*", "/", "%", "<", ">", "!", "&", "|", "^", "~", "?", ".", ":", ";", ",", "@",
    "(", ")", "[", "]", "{", "}",
];

export type TokenKind =
    | 'KWD' | "SIG" | "STR" | 'OPER'
    | '"' | '"""' | '//' | '///'
    | 'INT' | 'FLOAT' | '<ERR>'

export class Token {
    kind: TokenKind = '<ERR>'
    span: Span = new Span()
    lexeme: string = ''
    nl_before = false
    ws_before = false

    print(): string {
        const pref = this.nl_before ? '\n ' : ' '
        if (this.kind == 'KWD') {
            return `${pref}_${this.kind}_`
        }
        return `${pref}_${this.kind}:${this.lexeme}_`
    }

}
