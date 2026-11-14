import type { KEYWORDS, SYMBOLS } from "./lexer_utils";

export type TokenType = 'UNK' | 'ID' | 'KWD' | 'OPER' | 'NUM' |
    'STR_PART' | 'STR_START' | 'STR_END' | 'STR_EXP_OPEN' | 'STR_EXP_CLOSE'
    | 'COMMENT' | 'EOF' | 'SIGIL';

export type Span = {
    start: number,
    end: number,
    start_line: number
    start_col: number
    end_line: number
    end_col: number
}

export class Token {
    constructor(
        public type: TokenType,
        public val: string,
        public ws_before: boolean,
        public nl_before: boolean,
        public span: Span,
    ) { }

    kwd(): typeof KEYWORDS[number] {
        return this.val as typeof KEYWORDS[number]
    }

    symb(): typeof SYMBOLS[number] {
        return this.val as typeof SYMBOLS[number]
    }

    kwd_(expc: typeof KEYWORDS[number]) {
        return this.kwd() === expc
    }
    symb_(expc: typeof SYMBOLS[number]) {
        return this.symb() === expc
    }
    val_(expc: string) {
        return this.val == expc
    }
    type_(expc: string) {
        return this.type == expc
    }

}


