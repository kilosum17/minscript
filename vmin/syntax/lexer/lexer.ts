import type { Span, Token, TokenType } from "./lexer_types";
import { isDigit, isIdentPart, isIdentStart, isNewline, isSigil, isSymbol, isWhitespace, mergeMap } from "./lexer_utils";

export class Lexer {
    private source: string;
    private pos = 0
    private line = 1
    private col = 1
    toks = [] as Token[]

    constructor(source: string) {
        this.source = source;
        console.log(`Lexer initialized with source of length ${source.length}`);
        console.log(source.substring(0, 100)); // Log the first 100 characters of the source for debugging
    }

    tokenize() {
        this.pos = 0;
        this.line = 1
        this.col = 1
        this.toks = []

        while (true) {
            let part = this.getNext()
            console.log(this.printPart(part))

            const span: Span = {
                start_line: part?.start_line || this.line,
                start_col: part?.start_col || this.col,
                end_line: this.line,
                end_col: this.col,
            }

            if (!part) {
                this.toks.push({
                    type: 'EOF',
                    value: '<eof>',
                    span,
                } satisfies Token)
                break
            } else {
                this.toks.push({
                    type: part.type,
                    value: part.text,
                    span,
                } satisfies Token)
            }
        }
    }

    cur(offset = 0) {
        return this.source[this.pos + offset] || ''
    }

    get(n = 1) {
        let text = ''
        for (let i = 0; i < n; i++) {
            let c = this.source[this.pos]
            if (isNewline(c || '')) {
                this.line++
                this.col = 1
                // console.log("NEWLINE", this.pos)
            } else {
                this.col++
            }
            if (c != undefined) {
                this.pos++
                text += c
            }
        }
        return text
    }

    private in_str_exp = false
    private str_exp_mode = 'expr' as 'raw' | 'expr'
    private str_exp_depth = 0
    private str_multiline_stack = [] as boolean[]
    getNext() {
        let ws_before = false
        let nl_before = false
        let is_comment = false
        let type: TokenType = 'UNK'

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
                start_line, start_col, type,
            }
        }

        // reached EOF
        if (this.pos >= this.source.length) return null

        // handle string parts
        if (this.str_exp_mode == 'raw') {
            if (this.cur() == '"') {
                let is_multiline = false
                if (this.cur(1) == '"' && this.cur(2) == '"') is_multiline = true
                let saved_is_multiline = this.str_multiline_stack.at(-1)
                if (is_multiline != saved_is_multiline) throw new Error('UNEXPECTED state ' + is_multiline + '=' + saved_is_multiline)
                let text = ""
                if (!is_multiline) text += this.get()
                if (is_multiline) text += this.get(3)
                this.str_exp_mode = 'expr'
                this.str_multiline_stack.pop()
                // console.log('Got \\', text, this.cur(), this.str_exp_mode)
                type = 'STR_END'
                return getRet(text)
            } else {
                let text = ""
                let saved_is_multiline = this.str_multiline_stack.at(-1)
                if (saved_is_multiline == undefined) throw new Error('UNEXPECTED state')
                while (
                    (!saved_is_multiline && this.cur() !== '"') ||
                    (saved_is_multiline && this.cur() != '"' && this.cur(1) != '"' && this.cur(2) != '"')
                ) {
                    if (!saved_is_multiline && isNewline(this.cur())) {
                        throw new Error('Unterminated string')
                    }
                    text += this.get()
                }
                // console.log('Got s',text, this.cur(), saved_is_multiline, this.str_exp_mode)
                type = 'STR_PART'
                return getRet(text)
            }
        }

        // try comment
        if (this.cur() === '/' && this.cur(1) === '/') {
            let text = ''
            is_comment = true
            while (!isNewline(this.cur())) {
                text += this.get()
            }
            type = 'COMMENT'
            return getRet(text)
        }

        if (isIdentStart(this.cur())) {
            // handle identifiers
            let text = ''
            while (isIdentPart(this.cur())) {
                text += this.get()
            }
            text = this.tryMerge(text)
            type = isSigil(text) ? 'SIGIL' : 'ID'
            return getRet(text)

        } else if (isSymbol(this.cur())) {
            // handle symbols 
            let text = this.get()
            text = this.tryMerge(text)
            type = 'OPER'
            return getRet(text)

        } else if (isDigit(this.cur())) {
            // handle numbers
            let before1 = this.cur(-1)
            let before2 = this.cur(-2)
            let isTupleIndex = false
            let text = ''
            if (before1 == '.' && before2 != '.') isTupleIndex = true
            while (true) {
                if (isTupleIndex) {
                    if (isDigit(this.cur()) || this.cur() == '_') {
                        text += this.get()
                    } else {
                        break
                    }
                } else {
                    if (isDigit(this.cur()) || this.cur() == '_' || (this.cur() == '.' && this.cur(1) != '.')) {
                        text += this.get()
                    } else {
                        break
                    }
                }
            }
            type = 'NUM'
            return getRet(text)

        } else if (this.cur() == '"') {
            // handle string start
            let is_multiline = false
            if (this.cur(1) == '"' && this.cur(2) === '"') is_multiline = true
            this.str_exp_mode = 'raw'
            this.str_multiline_stack.push(is_multiline)
            let text = ''
            if (!is_multiline) text += this.get()
            if (is_multiline) text += this.get(3)
            type = 'STR_START'
            return getRet(text)

        } else {
            // unkowns error
            throw new Error("Unkown token")
        }

    }

    private tryMerge(text: string) {
        const m = mergeMap[text]
        if (m) {
            if (typeof m === 'string') {
                if (this.cur() === m) {
                    text += this.get()
                }
            } else {
                if (m.has(this.cur())) {
                    text += this.get()
                }
            }
        }
        return text
    }

    private printPart(p: ReturnType<typeof this.getNext>) {
        if (!p) return 'EOF'
        return `${p.start_line}:${p.start_col} ${p.ws_before ? ' ws ' : '  '}${p.nl_before ? ' nl ' : '   '}${p.text}`
    }

}