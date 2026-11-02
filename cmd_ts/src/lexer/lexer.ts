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

    tokenize(source: string) {
        this.source = source
        this.pos = 0
        this.line = 0
        this.endPos = source.length

        // console.log(source)

        while (true) {
            let lex = this.getNext()
            this.pos = lex.endIdx

            if (!lex.text) {
                if (lex.endIdx != this.endPos) console.warn('Failed')
                else console.log("Done <EOF>")
                break
            }
            if (tryMerge(lex.text)) {
                let lex2 = this.getNext()
                // console.log('can-merge', lex, lex2)
                if (!lex2.ws_before && canMerge(lex.text, part_to_str(source, lex2))) {
                    lex = merge_parts(lex, lex2)
                    this.pos = lex.endIdx
                    // console.log('merged', lex, lex2)
                }
            }
            if (lex.nl_before) {
                // process.stdout.write(` \n`)
            }
            // process.stdout.write(` ${lex.text}`)

            const tok = new Token()
            tok.type =  getTokenType(lex.text)
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

        if (isSpecial(this.source[cur])) {
            // get-symbol
            this.col += 1
            let endPos = cur + 1
            let endLine = this.line
            let endCol = this.col
            let text = this.source.slice(startPos, endPos)
            return {
                startIdx: startPos, endIdx: endPos, ws_before, nl_before, startLine,
                endLine, text, startCol, endCol
            }
        } else {
            // get-word
            while (isNotEnd(cur) && isAlphaNumeric(this.source[cur]) || this.source[cur] == '_') {
                this.col += 1
                cur++
            }
            let endPos = cur
            let endLine = this.line
            let endCol = this.col
            let text = this.source.slice(startPos, endPos)
            return {
                startIdx: startPos, endIdx: endPos, ws_before, nl_before, startLine,
                endLine, text, startCol, endCol
            }
        }
    }

    private _getPos = 0
    next(): Token {
        const tok = this.tokens[0] || new Token()
        this.pos += 1
        return tok
    }

    peek(n = 0): Token {
        return this.tokens[this._getPos + n] || new Token()
    }

    expect(mes: any) {
        const info = mes?.val || mes
        return new Error(`Expected: ${info}, got: [${this.peek(-1).val} (${this.peek().val}),${this.peek(1).val}]`)
    }

}

export const lexer = new Lexer()

