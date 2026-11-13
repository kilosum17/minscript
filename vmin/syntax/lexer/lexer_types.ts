
export type TokenType = 'UNK' | 'ID' | 'KWD' | 'OPER' | 'NUM' |
    'STR_PART' | 'STR_START' | 'STR_END' | 'STR_EXP_OPEN' | 'STR_EXP_CLOSE'
    | 'COMMENT' | 'EOF' | 'SIGIL';

export type Span = {
    start_line: number
    start_col: number
    end_line: number
    end_col: number
}

export interface Token {
    type: TokenType;
    value: string;
    span: Span,
}

