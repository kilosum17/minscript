import { isIdent, isNum } from "../utils/char_helpers"

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
export const kwsSet = new Set(KWS as any as string[])

export const SIG = [
    "r{", "m{", "s{", "t(", "v[", 'a[',
    "#{", '${',
] as const
export const sigSet = new Set(SIG)

export const OPERATORS = [
    ">>=", "<<=",
    "...", "..=",
    "?.", "??",
    ":==", ":=", "->", "=>",
    "<<", ">>",
    "+=", "-=", "*=", "/=", "%=",
    "==", "!=", "<=", ">=", "&&", "||",
    "<", ">", "!", "&", "|",
    "..",
    "=", "+", "-", "*", "/", "%",
    "^", "~", "?", ".", ":", ";", ",", "@",
    "(", ")", "[", "]", "{", "}",
] as const;
export const operSet = new Set(OPERATORS as any as string[])

const OTHERS = [
    'UNK', 'EOF', 'ID', 'NUM', '"', 'STOP',
] as const
export const othersSet = new Set(OTHERS)

export type TokenType =
    | (typeof OTHERS)[number]
    | (typeof KWS)[number]
    | (typeof SIG)[number]
    | (typeof OPERATORS)[number]

export function getTokenType(_val: string): TokenType {
    const val = _val as any
    if (othersSet.has(val) || kwsSet.has(val) || sigSet.has(val) || operSet.has(val)) {
        return val as TokenType
    }
    if (isIdent(val)) return 'ID'
    if (isNum(val)) return 'NUM'
    return 'UNK'
}

export class Token {
    type: TokenType = 'UNK'
    span: Span = { ...DEF_SPAN }
    val: string = '_<UNK>_'
    nl_before = false
    ws_before = false

    print(): string {
        const pref = this.nl_before ? '\n ' : ' '
        if (this.isKwd()) {
            return `${pref}_${this.type}_`
        }
        return `${pref}_${this.type}:${this.val}_`
    }

    isKwd() {
        return kwsSet.has(this.type as string)
    }

}
