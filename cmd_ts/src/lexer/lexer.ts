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
                if (lex.endIdx !== this.endPos) {
                    throw new Error(`Lexer failed at position ${this.pos}`)
                }
                if (this.is_str) {
                    throw new Error(`Unterminated ${this.is_multiline ? "multiline " : ""}string`)
                }
                break
            }

            while (tryMerge(lex.text)) {
                const lex2 = this.getNext()

                if (!lex2.text) break

                if (!lex2.ws_before && canMerge(lex.text, lex2.text)) {
                    lex = merge_parts(lex, lex2)
                    this.pos = lex.endIdx
                } else {
                    this.pendingPart = lex2
                    break
                }
            }

            const tok = new Token()
            tok.type = getTokenType(lex.text)
            tok.val = lex.text
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

        // Skip whitespace.
        while (
            isNotEnd(cur) &&
            (isSpace(this.source[cur]) || isNewLine(this.source[cur]))
        ) {
            ws_before = true

            if (isNewLine(this.source[cur])) {
                nl_before = true
            }

            advance()
        }

        const startPos = cur
        const startLine = this.line
        const startCol = this.col

        const ret = (): Part => ({
            startIdx: startPos,
            endIdx: cur,
            ws_before,
            nl_before,
            startLine,
            startCol,
            endLine: this.line,
            endCol: this.col,
            text: this.source.slice(startPos, cur),
        })

        // Currently scanning string contents.
        if (this.is_str && !this.is_expr) {
            let chars = 0

            while (isNotEnd(cur)) {
                // Interpolation starts with ${
                if (
                    this.brace_depth <= 0 &&
                    this.source[cur] === '$' &&
                    this.source[cur + 1] === '{'
                ) {
                    // Return preceding text first.
                    if (chars > 0) break

                    advance(2)
                    this.brace_depth = 1
                    this.is_expr = true
                    return ret()
                }

                // Single-line closing quote.
                if (!this.is_multiline && this.source[cur] === '"') {
                    // Return preceding text first.
                    if (chars > 0) break

                    advance()
                    this.is_str = false
                    this.is_expr = false
                    return ret()
                }

                // Multiline closing quotes.
                if (
                    this.is_multiline &&
                    this.source[cur] === '"' &&
                    this.source[cur + 1] === '"' &&
                    this.source[cur + 2] === '"'
                ) {
                    // Return preceding text first.
                    if (chars > 0) break

                    advance(3)
                    this.is_str = false
                    this.is_expr = false
                    this.is_multiline = false
                    return ret()
                }

                // Escaped character: keep both characters in the string.
                if (this.source[cur] === '\\' && isNotEnd(cur + 1)) {
                    advance(2)
                } else {
                    advance()
                }

                chars++
            }

            return ret()
        }

        // Opening string delimiter.
        if (this.source[cur] === '"' && !this.is_str) {
            const multiline =
                this.source[cur + 1] === '"' &&
                this.source[cur + 2] === '"'

            advance(multiline ? 3 : 1)

            this.is_str = true
            this.is_multiline = multiline
            this.is_expr = false
            this.brace_depth = 0

            return ret()
        }

        // Scanning an interpolation expression.
        if (this.is_str && this.is_expr) {
            if (this.source[cur] === '}') {
                this.brace_depth--

                if (this.brace_depth <= 0) {
                    advance()
                    this.is_expr = false
                    return ret()
                }
            }

            if (this.source[cur] === '{') {
                this.brace_depth++
            }
        }

        // Special characters.
        if (isSpecial(this.source[cur])) {
            advance()
            return ret()
        }

        // Identifiers and numbers.
        while (
            isNotEnd(cur) &&
            (isAlphaNumeric(this.source[cur]) || this.source[cur] === '_')
        ) {
            advance()
        }

        return ret()
    }

    private _getPos = 0

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