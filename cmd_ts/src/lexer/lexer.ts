import { canMerge, isAlphaNumeric, isNewLine, isSpace, isSpecial, tryMerge } from "../utils/char_helpers";
import { getTokenType, kwsSet, operSet, sigSet, Token } from "./lexer_types";

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

function part_to_str(source: string, p: Part) {
    return source.slice(p.startIdx, p.endIdx)
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

    tokenize(source: string) {
        this.source = source
        this.pos = 0
        this.line = 0
        this.endPos = source.length

        // console.log(source)

        while (true) {
            let lex = this.getNext()
            this.pos = lex.endIdx
            // console.log('lexer', lex.text, 'brss', this.brace_depth)

            if (!lex.text) {
                if (lex.endIdx != this.endPos) {
                    console.warn(`*** Failed ***=${source[this.pos]}`)
                    console.log('..' + source.substring(Math.max(0, this.pos - 20), this.pos + 10))
                    throw new Error(`lexer failed: str ${this.is_str} expr ${this.is_expr}`)
                }
                else console.log("Done <EOF>")
                break
            }

            while (tryMerge(lex.text)) {
                let lex2 = this.getNext()
                console.log('can-merge', lex.text, lex2.text)
                if (!lex2.ws_before && canMerge(lex.text, lex2.text)) {
                    lex = merge_parts(lex, lex2)
                    this.pos = lex.endIdx
                    console.log('merged', lex.text, lex2.text)
                } else {
                    break
                }
            }
            if (lex.nl_before) {
                // process.stdout.write(` \n`)
            }
            // process.stdout.write(` ${lex.text}`)

            const tok = new Token()
            tok.type = getTokenType(lex.text)
            tok.val = lex.text
            tok.span = {
                startCol: lex.startCol, endCol: lex.endCol,
                startLine: lex.startLine, endLine: lex.endLine,
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
        let startLine = this.line
        const isNotEnd = (cur: number) => cur < this.endPos

        // skip spaces
        while (isNotEnd(cur) && (isSpace(this.source[cur]) || isNewLine(this.source[cur]))) {
            ws_before = true
            if (isNewLine(this.source[cur])) {
                this.line++
                this.col = 0
                nl_before = true
            }
            cur++
        }
        let startPos = cur
        let startCol = this.col

        const text = () => {
            let endPos = cur
            return this.source.slice(startPos, endPos)
        }

        const ret = () => {
            let endPos = cur
            let endLine = this.line
            let endCol = this.col
            let text = this.source.slice(startPos, endPos)
            return {
                startIdx: startPos, endIdx: endPos, ws_before, nl_before, startLine,
                endLine, text, startCol, endCol
            }
        }

        if (this.is_str && !this.is_expr) {
            let chars = 0
            while (true) {
                if (this.brace_depth <= 0 && this.source[cur] === '$' && this.source[cur + 1] == '{') {
                    this.brace_depth = 1
                    this.is_expr = true
                    cur++
                    break
                }
                if (!this.is_multiline && this.source[cur] === '"') {
                    if (chars === 0) {
                        cur += 1
                        this.is_str = false
                        this.is_expr = false
                    }
                    break
                }
                if (this.is_multiline && (
                    this.source[cur] == '"' && this.source[cur + 1] === '"' && this.source[cur + 1] === '"'
                )) {
                    if (chars === 0) {
                        cur += 3
                        this.is_str = false
                        this.is_expr = false
                        console.log(ret())
                        throw new Error('Done')
                    }
                    break
                }
                chars++
                cur++
            }
            console.log("STR_part", text())
            return ret()
        } else if (this.source[cur] === '"' && !this.is_str) {
            let multiline = false
            if (this.source[cur + 1] == '"' && this.source[cur + 2] === '"') {
                multiline = true
                cur += 3
            } else {
                cur += 1
            }
            this.is_str = true
            this.is_multiline = multiline
            console.log("STR_start", text(), 'multi', multiline)
            return ret()
        } else {
            if (this.is_str && this.is_expr) {
                if (this.source[cur] === '}') {
                    this.brace_depth--
                    if (this.brace_depth <= 0) {
                        cur += 1
                        this.is_expr = false
                        return ret()
                    }
                }
                if (this.source[cur] === '{') {
                    this.brace_depth++
                }
            }
            if (isSpecial(this.source[cur])) {
                // get-symbol
                this.col += 1
                cur += 1
                console.log("Special", this.source[cur])
                return ret()
            } else {
                while (isNotEnd(cur) && isAlphaNumeric(this.source[cur]) || this.source[cur] == '_') {
                    this.col += 1
                    cur++
                }
                // get-word
                console.log("Dwe", text())
                return ret()
            }
        }
    }

    private _getPos = 0
    next(): Token {
        const tok = this.tokens[this._getPos] || new Token()
        this._getPos += 1
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
        throw new Error(`Expected: ${info}, got: [${this.peek(-1).val} (${this.peek().val}) ${this.peek(1).val}]`)
    }

}

export const lexer = new Lexer()

