import type { Lexer } from "../lexer/lexer"
import type { Token, TokenType } from "../lexer/lexer_types"

export function SyntaxError(mes: string) {
    return Error(`Syntax Error:${mes}`)
}

export type TExpr =
    | { type: 'Literal', value: string }
    | { type: 'Var', name: string }
    | { type: 'Unary', op: '-', right: TExpr }
    | { type: 'Binary', op: string, left: TExpr, right: TExpr }
    | { type: 'Call', callee: TExpr, 'args': TExpr[] }
    | { type: 'StrExpr', parts: (string | TExpr)[] }

export class PrattParser {

    constructor(private lex: Lexer) {

    }

    expect(kind: TokenType, tok?: Token): Token {
        const n = tok || this.lex.next()
        if (n.type !== kind) {
            this.lex.expect(kind)
        }
        return n
    }

    parse_expr(min_bp = 0): TExpr {
        let token = this.lex.next()
        let left = this.parse_nul(token)

        while (true) {
            let next_tok = this.lex.peek()
            if (next_tok.type == 'EOF' || next_tok.type == ')') {
                break
            }
            let bp = this.get_infix_bp(next_tok)
            if (bp == null || bp.left < min_bp) {
                break
            }
            this.lex.next() //# Consume the operator
            left = this.parse_infix(next_tok, left, bp.right)
        }
        return left
    }

    parse_nul(token: Token): TExpr {
        if (token.type == 'NUM') {
            return { 'type': 'Literal', 'value': token.val }
        }
        if (token.type == 'ID') {
            return { 'type': 'Var', 'name': token.val }
        }
        if (token.type == '-') {
            let right = this.parse_expr(5) // Prefix binding power
            return { 'type': 'Unary', 'op': '-', 'right': right }
        }
        if (token.type == '(') {
            let expr = this.parse_expr(0)
            this.expect(')')
            return expr
        }
        throw SyntaxError(`Unexpected token ${token}`)
    }

    parse_infix(token: Token, left: TExpr, right_bp: number): TExpr {
        // console.warn('##pinfix', token.type, left, right_bp)
        if (['+', '-', '*', '/'].includes(token.type)) {
            let right = this.parse_expr(right_bp)
            return { 'type': 'Binary', 'op': token.val, 'left': left, 'right': right }
        }
        if (token.type == '(') { //# Function call: f(args)
            let args = []
            if (this.lex.peek().type != ')') {
                while (true) {
                    args.push(this.parse_expr(0))
                    if (this.lex.peek().type == ',') {
                        this.lex.next()
                        if (this.lex.peek().type == ')') {
                            break
                        }
                    } else {
                        break
                    }
                }
            }
            this.expect(')')
            return { type: 'Call', 'callee': left, 'args': args }
        }
        throw SyntaxError(`Unexpected infix token ${token}`)
    }

    get_infix_bp(token: Token): { left: number, right: number } | null {
        //# Returns (left_binding_power, right_binding_power)
        if (['+', '-'].includes(token.type)) return { left: 1, right: 2 }
        if (['*', '/'].includes(token.type)) return { left: 3, right: 4 }
        if (token.type == '(') return { left: 7, right: 0 } //# Function call binding power
        return null
    }

    parse_string_expr(): TExpr {
        const n1 = this.expect('"')
        let parts = [] as (string | TExpr)[]
        while (this.lex.peek().val != '"') {
            const p1 = this.lex.peek(1)
            if (this.lex.peek().val === '$' && p1.val === '{' && !p1.ws_before) {
                this.lex.skip(2)
                parts.push(this.parse_expr(0))
                const n2 = this.expect('}')
            } else {
                const n3 = this.lex.next()
                console.log({ n3: n3.val, p1: p1.val })
                parts.push(n3.val)
            }
        }
        const n4 = this.expect('"')
        console.log('Afters', { n4: n4.val })
        return { type: 'StrExpr', parts }
    }

}