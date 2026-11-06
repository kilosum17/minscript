
import { canMerge, isAlphaNumeric, isNewLine, isSpace, isSpecial, tryMerge } from "../utils/char_helpers";
import { getTokenType, Token } from "./lexer_types";

type Part = {
    startIdx: number
    endIdx: number
    ws_before: boolean
    nl_before: boolean
    startLine: number
    startCol: number
    endLine: number
    endCol: number
    text: string
    forceUnknown?: boolean
}

function merge_parts(p1: Part, p2: Part): Part {
    return {
        startIdx: p1.startIdx,
        endIdx: p2.endIdx,
        ws_before: p1.ws_before,
        nl_before: p1.nl_before,
        startLine: p1.startLine,
        startCol: p1.startCol,
        endLine: p2.endLine,
        endCol: p2.endCol,
        text: p1.text + p2.text,
    }
}

export class Lexer {
    words: Part[] = []
    tokens: Token[] = []
    source = ""
    pos = 0
    endPos = 0
    line = 0
    col = 0
    is_str = false
    is_multiline = false
    brace_depth = 0
    is_expr = false

    private _getPos = 0
    private pendingPart?: Part

    tokenize(source: string) {
        this.source = source
        this.pos = 0
        this.endPos = source.length
        this.line = 0
        this.col = 0
        this.tokens = []
        this.words = []
        this._getPos = 0
        this.pendingPart = undefined

        this.is_str = false
        this.is_multiline = false
        this.brace_depth = 0
        this.is_expr = false

        while (true) {
            let lex = this.pendingPart || this.getNext()
            this.pendingPart = undefined
            this.pos = lex.endIdx

            if (!lex.text) {
                if (this.pos !== this.endPos) {
                    throw new Error(`Lexer failed at position ${this.pos}`)
                }
                if (this.is_str) {
                    throw new Error(`Unterminated ${this.is_multiline ? "multiline " : ""}string`)
                }
                break
            }

            // Merge operators, but never merge string content.
            while (!lex.forceUnknown && tryMerge(lex.text)) {
                const lex2 = this.getNext()

                if (!lex2.text) break

                if (!lex2.forceUnknown && !lex2.ws_before && canMerge(lex.text, lex2.text)) {
                    lex = merge_parts(lex, lex2)
                    this.pos = lex.endIdx
                } else {
                    this.pendingPart = lex2
                    break
                }
            }

            let text = lex.text
            // if (text == '\\"') text = '"'
            const tok = new Token()
            tok.type = lex.forceUnknown ? "UNK" : getTokenType(text)
            tok.val = text
            tok.span = {
                startCol: lex.startCol,
                endCol: lex.endCol,
                startLine: lex.startLine,
                endLine: lex.endLine,
            }
            tok.nl_before = lex.nl_before
            tok.ws_before = lex.ws_before
            this.tokens.push(tok)
        }
    }

    private getNext(): Part {
        let cur = this.pos
        let ws_before = false
        let nl_before = false

        const isNotEnd = (i: number) => i < this.endPos

        const advance = (count = 1) => {
            for (let i = 0; i < count && isNotEnd(cur); i++) {
                if (isNewLine(this.source[cur])) {
                    this.line++
                    this.col = 0
                } else {
                    this.col++
                }
                cur++
            }
        }

        // Whitespace is skipped only outside string contents.
        if (!this.is_str || this.is_expr) {
            while (
                isNotEnd(cur) &&
                (isSpace(this.source[cur]) || isNewLine(this.source[cur]))
            ) {
                ws_before = true
                if (isNewLine(this.source[cur])) nl_before = true
                advance()
            }
        }

        const startPos = cur
        const startLine = this.line
        const startCol = this.col

        const ret = (forceUnknown = false, textOverride?: string): Part => ({
            startIdx: startPos,
            endIdx: cur,
            ws_before,
            nl_before,
            startLine,
            startCol,
            endLine: this.line,
            endCol: this.col,
            text: textOverride ?? this.source.slice(startPos, cur),
            forceUnknown,
        })

        // String content.
        if (this.is_str && !this.is_expr) {
            let chars = 0

            while (isNotEnd(cur)) {
                // Escapes must be checked before quotes and interpolation.
                if (this.source[cur] === "\\" && isNotEnd(cur + 1)) {
                    advance(2)
                    chars += 2
                    continue
                }

                // Interpolation: ${...}
                if (
                    this.brace_depth <= 0 &&
                    this.source[cur] === "$" &&
                    this.source[cur + 1] === "{"
                ) {
                    if (chars > 0) break

                    advance(2)
                    this.brace_depth = 1
                    this.is_expr = true
                    return ret(false, "${")
                }

                // Single-line closing quote.
                if (!this.is_multiline && this.source[cur] === '"') {
                    if (chars > 0) break

                    advance()
                    this.is_str = false
                    return ret(false, '"')
                }

                // Multiline closing delimiter.
                if (
                    this.is_multiline &&
                    this.source[cur] === '"' &&
                    this.source[cur + 1] === '"' &&
                    this.source[cur + 2] === '"'
                ) {
                    if (chars > 0) break

                    advance(3)
                    this.is_str = false
                    this.is_multiline = false
                    return ret(false, '"')
                }

                advance()
                chars++
            }

            return ret(true)
        }

        // Opening string delimiter.
        if (this.source[cur] === '"') {
            const multiline =
                this.source[cur + 1] === '"' &&
                this.source[cur + 2] === '"'

            advance(multiline ? 3 : 1)

            this.is_str = true
            this.is_multiline = multiline
            this.is_expr = false
            this.brace_depth = 0

            // Keep the same quote token for both string forms.
            return ret(false, '"')
        }

        // Interpolation expression brace tracking.
        if (this.is_str && this.is_expr) {
            if (this.source[cur] === "}") {
                this.brace_depth--

                if (this.brace_depth <= 0) {
                    advance()
                    this.is_expr = false
                    return ret()
                }
            } else if (this.source[cur] === "{") {
                this.brace_depth++
            }
        }

        // Special characters and operators.
        if (isSpecial(this.source[cur])) {
            advance()
            return ret()
        }

        // Identifiers and numbers.
        while (
            isNotEnd(cur) &&
            (isAlphaNumeric(this.source[cur]) || this.source[cur] === "_")
        ) {
            advance()
        }

        return ret()
    }

    next(): Token {
        const tok = this.tokens[this._getPos] || new Token()
        this._getPos++
        return tok
    }

    peek(n = 0): Token {
        return this.tokens[this._getPos + n] || new Token()
    }

    skip(n = 1) {
        this._getPos += n
    }

    expect(mes: any): never {
        const info = mes?.val || mes
        throw new Error(
            `Expected: ${info}, got: [${this.peek(-1).val} (${this.peek().val}) ${this.peek(1).val}]`
        )
    }
}

export const lexer = new Lexer()
