
const DEF_SPAN = {
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 0,
}
export type Span = typeof DEF_SPAN

export const KWS = [
    "package", "import", "pub", "type", "inter", "impl", "fun", "async", "let", "var", "mut", "extern",
    "if", "else", "match", "for", "in", "while", "loop", "break", "continue", "return",
    "await", "or", "as", "unsafe", "recover", "true", "false", "nil", "this", "Self", "TypeOf",
] as const
export const kwsSet = new Set(KWS)

export const SIG = [
    "r{", "m{", "s{", "t(", "v[", 'a[',
    "#{", '${',
] as const
export const sigSet = new Set(SIG)

export const OPERATORS = [
    ">>=", "<<=", "...", "..=", "?.", "??", ":==", ":=", "->", "=>", "==", "!=", "<=", ">=", "&&", "||",
    "<<", ">>", "+=", "-=", "*=", "/=", "%=", "..", "++", "--",
    "=", "+", "-", "*", "/", "%", "<", ">", "!", "&", "|", "^", "~", "?", ".", ":", ";", ",", "@",
    "(", ")", "[", "]", "{", "}",
] as const;
export const operSet = new Set(OPERATORS)

export type TokenKind =
    | 'KWD' | "SIG" | 'OPER' | 'ID'
    | '"' | '//' | '///'
    | 'INT' | 'FLOAT' | '<ERR>'

export class Token {
    kind: TokenKind = '<ERR>'
    span: Span = { ...DEF_SPAN }
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
    getKwd() {
        return this.lexeme as (typeof KWS)[number]
    }
}
