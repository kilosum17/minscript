
export type TokenType = 'ID' | 'KWD' | 'OPER' | 'NUM' | 'STR' | 'COMMENT' | 'EOF';

export interface Token {
    type: TokenType;
    value: string;
    position: number;
}

