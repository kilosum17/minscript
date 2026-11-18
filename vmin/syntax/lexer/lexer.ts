import { Token, type Span, type TokenType } from "./lexer_types";
import { isDigit, isIdentPart, isIdentStart, isNewline, isSigil, isSymbol, isWhitespace, KEYWORDS, LexLog, mergeMap } from "./lexer_utils";

export class Lexer {
    private source: string;
    private pos = 0
    private line = 1
    private col = 1
    toks = [] as Token[]
    trivia = [] as Token[]

    constructor(source: string) {
        this.source = source;
        LexLog.info(`Lexer initialized with source of length ${source.length}`);
        LexLog.info(source.substring(0, 100)); // Log the first 100 characters of the source for debugging
    }

    tokenize() {
        this.pos = 0;
        this.line = 1
        this.col = 1
        this.toks = []
        this.tok_pos = 0

        while (true) {
            let part = this.getNext()
            LexLog.info(this.printPart(part))

            const span: Span = {
                start: part?.start_pos || this.pos,
                end: this.pos,
                start_line: part?.start_line || this.line,
                start_col: part?.start_col || this.col,
                end_line: this.line,
                end_col: this.col,
            }

            if (!part) {
                this.toks.push(this.getEofTok())
                break
            } else {
                const tok = new Token(
                    part.type,
                    part.text,
                    part.ws_before,
                    part.nl_before,
                    span,
                )
                if (tok.type === 'COMMENT') this.trivia.push(tok)
                else this.toks.push(tok)
            }
        }
    }

    private tok_pos = 0
    peek(no = 0) {
        const tok = this.toks[this.tok_pos + no]
        return tok || this.getEofTok()
    }

    expect(val: typeof KEYWORDS[number] | TokenType, _tok?: Token, msg?: string, not_nl?: boolean) {
        const tok = _tok ?? this.toks[this.tok_pos]
        if (!tok ||
            (tok.val != val && tok.type != val) ||
            (not_nl != undefined && not_nl && tok.nl_before)
        ) {
            const _msg = msg ? `[${msg}]` : ''
            throw new Error(`Expected--${val}--${_msg} got: ${this.info()}`)
        }
        if (!_tok) this.tok_pos++
        return tok
    }
    expect_(val: string, _tok?: Token, msg?: string, not_nl?: boolean) {
        return this.expect(val as any, _tok, msg, not_nl)
    }
    getTokPos() {
        return this.tok_pos
    }
    info() {
        return `[${this.peek(-1).val}_${this.peek().val}_${this.peek(1).val}_${this.peek(2).val}] (${this.peek().span.start_line},${this.peek().span.start_col})`
    }

    next() {
        const tok = this.toks[this.tok_pos]
        this.tok_pos++
        return tok || this.getEofTok()
    }

    private getEofTok() {
        const span: Span = {
            start: this.pos, end: this.pos,
            start_line: this.line, start_col: this.col,
            end_line: this.col, end_col: this.col
        }
        return new Token('EOF', "<eof>", false, false, span)
    }

    private cur(offset = 0) {
        return this.source[this.pos + offset] || ''
    }

    private get(n = 1) {
        let text = ''
        for (let i = 0; i < n; i++) {
            let c = this.source[this.pos]
            if (isNewline(c || '')) {
                this.line++
                this.col = 1
                // LexLog.info("NEWLINE", this.pos)
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

    private mode = 'expr' as 'raw' | 'expr'
    private str_stack = [] as boolean[]
    private wait_for_brace = false
    private getNext() {
        let ws_before = false
        let nl_before = false
        let is_comment = false
        let type: TokenType = 'UNK'

        // skip spaces
        while (this.mode == 'expr' && isWhitespace(this.cur())) {
            if (isNewline(this.cur())) nl_before = true
            this.get()
            ws_before = true
        }

        let start_line = this.line
        let start_col = this.col
        let start_pos = this.pos

        function getRet(text: string) {
            return {
                text, ws_before, nl_before, is_comment,
                start_line, start_col, type, start_pos,
            }
        }

        // reached EOF
        if (this.pos >= this.source.length) return null

        // handle string parts
        if (this.mode == 'raw') {
            if (this.cur() == '$' && this.cur(1) === '{') {
                this.get()
                this.get()
                this.mode = 'expr'
                this.wait_for_brace = true
                type = 'STR_EXP_OPEN'
                return getRet('${')
            } else if (this.cur() == '"') {
                let is_multiline = false
                if (this.cur(1) == '"' && this.cur(2) == '"') is_multiline = true
                let saved_is_multiline = this.str_stack.at(-1)
                if (is_multiline != saved_is_multiline) throw new Error('UNEXPECTED state ' + is_multiline + '=' + saved_is_multiline)
                let text = ""
                if (!is_multiline) text += this.get()
                if (is_multiline) text += this.get(3)
                this.mode = 'expr'
                this.str_stack.pop()
                // LexLog.info('Got \\', text, this.cur(), this.str_exp_mode)
                type = 'STR_END'
                return getRet(text)
            } else {
                let text = ""
                let saved_is_multiline = this.str_stack.at(-1)
                if (saved_is_multiline == undefined) throw new Error('UNEXPECTED state')
                while (
                    (!saved_is_multiline && this.cur() !== '"') ||
                    (saved_is_multiline && this.cur() != '"' && this.cur(1) != '"' && this.cur(2) != '"')
                ) {
                    if (!saved_is_multiline && isNewline(this.cur())) {
                        throw new Error('Unterminated string')
                    }
                    let escapes = ['\\', '"', "n", 't']
                    if (this.cur() == '\\') {
                        if (escapes.includes(this.cur(1))) {
                            this.get()
                        }
                    }
                    if (this.cur() === '$' && this.cur(1) == '{') {
                        break
                    }
                    text += this.get()
                }
                // LexLog.info('Got s',text, this.cur(), saved_is_multiline, this.str_exp_mode)
                type = 'STR_PART'
                return getRet(text)
            }
        }

        if (this.mode === 'expr' && this.wait_for_brace) {
            if (this.cur() === '}') {
                this.get()
                this.wait_for_brace = false
                this.mode = 'raw'
                type = 'STR_EXP_CLOSE'
                LexLog.info('Got close')
                return getRet('}')
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
            let has_dot = false
            let has_e = false
            while (true) {
                if (isTupleIndex) {
                    if (isDigit(this.cur()) || this.cur() == '_') {
                        text += this.get()
                    } else {
                        break
                    }
                } else {
                    if (isDigit(this.cur()) || this.cur() == '_'
                        || (this.cur() == '.' && this.cur(1) != '.')
                        || (this.cur() === 'e')
                    ) {
                        if (this.cur() == '.') {
                            if (has_dot) break
                            has_dot = true
                        }
                        if (this.cur() === 'e') {
                            if (has_e) break
                            has_e = true
                        }
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
            this.mode = 'raw'
            this.str_stack.push(is_multiline)
            let text = ''
            if (!is_multiline) text += this.get()
            if (is_multiline) text += this.get(3)
            type = 'STR_START'
            return getRet(text)

        } else {
            // unkowns error
            throw new Error("Unkown token: " + this.cur())
        }

    }

    private tryMerge(text: string) {
        while (true) {
            const m = mergeMap[text]
            if (m && m.has(this.cur())) {
                text += this.get()
            } else {
                break
            }
        }
        return text
    }

    private printPart(p: ReturnType<typeof this.getNext>) {
        if (!p) return 'EOF'
        return `${p.start_line}:${p.start_col} ${p.ws_before ? ' ws ' : '  '}${p.nl_before ? ' nl ' : '   '}${p.text}`
    }

}