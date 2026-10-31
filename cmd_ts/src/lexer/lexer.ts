import { isAlphaNumeric, isNewLine, isSpace, isSpaceAndNl, isSpecial } from "../utils/char_helpers";
import type { Token } from "./lexer_types";

class Lexer {
    tokens: Token[] = []
    source = ""
    pos = 0
    endPos = 0

    tokenize(source: string) {
        this.source = source
        this.pos = 0
        this.endPos = source.length

        console.log(source)

        while (true) {
            const lex = this.getNext()
            const text = this.source.slice(lex.startPos, lex.endPos)

            if (!text) {
                if (lex.endPos != this.endPos) console.warn('Failed')
                else console.log("Done <EOF>")
                break
            }
            this.pos = lex.endPos
            console.log(text, " ", lex.startPos, lex.endPos)
        }

    }

    private getNext(): {
        startPos: number, endPos: number, ws_before: boolean, nl_before: boolean,
    } {
        let cur = this.pos
        let ws_before = false
        let nl_before = false
        const isNotEnd = (cur: number) => cur < this.endPos

        // skip spaces
        while (isNotEnd(cur) && isSpace(this.source[cur]) || isNewLine(this.source[cur])) {
            ws_before = true
            if (isNewLine(this.source[cur])) nl_before = true
            cur++
        }
        let startPos = cur

        if (isSpecial(this.source[cur])) {
            // get-symbol
            let endPos = cur + 1
            return { startPos, endPos, ws_before, nl_before }
        } else {
            // get-word
            while (isNotEnd(cur) && isAlphaNumeric(this.source[cur])) {
                cur++
            }
            let endPos = cur
            return { startPos, endPos, ws_before, nl_before }
        }
    }

}

export const lexer = new Lexer()