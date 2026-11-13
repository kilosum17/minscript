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
        public value: string,
        public span: Span,
    ) { }

    getKwd(): typeof KEYWORDS[number] {
        return this.value as typeof KEYWORDS[number]
    }

    getSymb(): typeof SYMBOLS[number] {
        return this.value as typeof SYMBOLS[number]
    }

}

