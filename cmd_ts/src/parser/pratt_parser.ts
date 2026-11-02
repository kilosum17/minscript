import type { Lexer } from "../lexer/lexer"
import type { Token } from "../lexer/lexer_types"

export function SyntaxError(mes: string) {
    return Error(`Syntax Error:${mes}`)
}

export type TExpr =
    | { type: 'Literal', value: string }
    | { type: 'Var', name: string }
    | { type: 'Unary', op: '-', right: TExpr }
    | { type: 'Binary', op: string, left: TExpr, right: TExpr }
    | { type: 'Call', callee: TExpr, 'args': TExpr[] }

export class PrattParser {

    constructor(private lexer: Lexer) {
        
    }

    expect(tok: any) {
        this.lexer.expect(tok)
    }

    parse_expr(min_bp = 0): TExpr {
        let token = this.lexer.next()
        let left = this.parse_nul(token)

        while (true) {
            let next_tok = this.lexer.peek()
            if (next_tok.type == 'EOF' || next_tok.type == ')') {
                break
            }
            let bp = this.get_infix_bp(next_tok)
            if (bp == null || bp.left < min_bp) {
                break
            }
            this.lexer.next() //# Consume the operator
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
            this.expect('RPAREN')
            return expr
        }
        throw SyntaxError(`Unexpected token ${token}`)
    }

    parse_infix(token: Token, left: TExpr, right_bp: number): TExpr {
        if (['PLUS', 'MINUS', 'MUL', 'DIV'].includes(token.type)) {
            let right = this.parse_expr(right_bp)
            return { 'type': 'Binary', 'op': token.val, 'left': left, 'right': right }
        }
        if (token.type == '(') { //# Function call: f(args)
            let args = []
            if (this.lexer.peek().type != ')') {
                while (true) {
                    args.push(this.parse_expr(0))
                    if (this.lexer.peek().type == ',') {
                        this.lexer.next()
                        if (this.lexer.peek().type == ')') {
                            break
                        }
                    } else {
                        break
                    }
                }
            }
            this.expect('RPAREN')
            return { type: 'Call', 'callee': left, 'args': args }
        }
        throw SyntaxError(`Unexpected infix token ${token}`)
    }

    get_infix_bp(token: Token): { left: number, right: number } | null {
        //# Returns (left_binding_power, right_binding_power)
        if (['PLUS', 'MINUS'].includes(token.type)) return { left: 1, right: 2 }
        if (['MUL', 'DIV'].includes(token.type)) return { left: 3, right: 4 }
        if (token.type == '(') return { left: 7, right: 0 } //# Function call binding power
        return null
    }

}