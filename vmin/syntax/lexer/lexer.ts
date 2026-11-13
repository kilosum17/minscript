import { isDigit, isIdentPart, isIdentStart, isNewline, isSymbol, isWhitespace } from "./lexer_utils";

export class Lexer {
    private source: string;
    private pos = 0
    private line = 1
    private col = 1

    constructor(source: string) {
        this.source = source;
        console.log(`Lexer initialized with source of length ${source.length}`);
        console.log(source.substring(0, 100)); // Log the first 100 characters of the source for debugging
    }

    tokenize() {
        this.pos = 0;
        this.line = 1
        this.col = 1

        while (true) {
            let part = this.getNext()
            console.log(this.printPart(part))
            if (!part) break
        }
    }

    cur(offset = 0) {
        return this.source[this.pos + offset] || ''
    }

    get() {
        let c = this.source[this.pos]
        if (isNewline(c || '')) {
            this.line++
            this.col = 1
            console.log("NEWLINE", this.pos)
        } else {
            this.col++
        }
        if (c != undefined) this.pos++
        return c || ''
    }

    getNext() {

        let ws_before = false
        let nl_before = false
        let is_comment = false

        // skip spaces
        while (isWhitespace(this.cur())) {
            if (isNewline(this.cur())) nl_before = true
            this.get()
            ws_before = true
        }

        let start_line = this.line
        let start_col = this.col

        function getRet(text: string) {
            return {
                text, ws_before, nl_before, is_comment,
                start_line, start_col
            }
        }

        // try comment
        if (this.cur() === '/' && this.cur(1) === '/') {
            let text = ''
            is_comment = true
            while (!isNewline(this.cur())) {
                text += this.get()
            }
            return getRet(text)
        }

        if (isIdentStart(this.cur())) {
            // handle identifiers
            let text = ''
            while (isIdentPart(this.cur())) {
                text += this.get()
            }
            return getRet(text)
        } else if (isSymbol(this.cur())) {
            // handle symbols 
            return getRet(this.get())
        } else if (isDigit(this.cur())) {
            // handle numbers
            let before1 = this.cur(-1)
            let isTupleIndex = false
            let text = ''
            if (before1 == '.') isTupleIndex = true
            while (true) {
                if (isTupleIndex) {
                    if (isDigit(this.cur()) || this.cur() == '_') {
                        text += this.get()
                    } else {
                        break
                    }
                } else {
                    if (isDigit(this.cur()) || this.cur() == '_' || this.cur() == '.') {
                        text += this.get()
                    } else {
                        break
                    }
                }
            }
            return getRet(text)
        } else {
            throw new Error("Unkown token")
        }

    }

    printPart(p: ReturnType<typeof this.getNext>) {
        return `${p.start_line}:${p.start_col} ${p.ws_before ? ' ws ' : '  '}${p.nl_before ? ' nl ' : '   '}${p.text}`
    }
}