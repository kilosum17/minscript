import type { Lexer } from "../lexer/lexer"
import type { Token, TokenType } from "../lexer/lexer_types"
import type { Parser } from "./parser"

export function SyntaxError(mes: string) {
    return Error(`Syntax Error:${mes}`)
}

export type TExpr =
    | { type: 'Literal', value: string }
    | { type: 'Var', name: string }
    | { type: 'Unary', op: '-', right: TExpr }
    | { type: 'Binary', op: string, left: TExpr, right: TExpr }
    | { type: 'Call', callee: TExpr, args: TExpr[] }
    | { type: 'StrExpr', parts: (string | TExpr)[] }
    | { type: 'StructInit', fields: { name: string, val: TExpr }[] }
    | { type: 'Vec', items: TExpr[] }

export class PrattParser {

    constructor(
        private lex: Lexer,
        private parser: Parser,
    ) {

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
        if (token.type === '"') {
            console.log("desa", this.lex.peek(0).val)
            let expr = this.parse_string_expr(true)
            return expr
        }
        if (token.type === 'v[') {
            return this.parse_vec(true)
        }
        console.log('Des', token.val, this.lex.peek(0).val, this.lex.peek(1).val)
        throw SyntaxError(`Unexpected token ${token.val}`)
    }

    parse_infix(token: Token, left: TExpr, right_bp: number): TExpr {
        // console.warn('##pinfix', token.type, left, right_bp)
        if (['.', '+', '-', '*', '/'].includes(token.type)) {
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
        if (token.type == '{') {
            let fields = [] as { name: string, val: TExpr }[]
            if (this.lex.peek().type != '}') {
                while (true) {
                    const n1 = this.expect('ID')
                    this.expect(':')
                    const expr = this.parse_expr(0)
                    const p1 = this.lex.peek()
                    const p2 = this.lex.peek(1)
                    fields.push({ name: n1.val, val: expr })
                    if (p1.type == '}' || (p1.type === ',' && p2.type === '}')) {
                        break
                    } else if (this.lex.peek().type == ',') {
                        this.expect(',')
                    }
                }
                this.expect('}')
            }
            console.log('fields', fields)
            return { type: 'StructInit', fields }
        }
        throw SyntaxError(`Unexpected infix token ${token.val}`)
    }

    get_infix_bp(token: Token): { left: number, right: number } | null {
        //# Returns (left_binding_power, right_binding_power)
        if (['+', '-'].includes(token.type)) return { left: 1, right: 2 }
        if (['*', '/'].includes(token.type)) return { left: 3, right: 4 }
        if (token.type == '.') return { left: 6, right: 0 }
        if (token.type == '{') return { left: 7, right: 0 }
        if (token.type == '(') return { left: 8, right: 0 }
        if (token.type == 'v[') return { left: 8, right: 0 }
        return null
    }

    parse_string_expr(skip_start = false): TExpr {
        if (!skip_start) this.expect('"')

        let parts = [] as (string | TExpr)[]
        while (this.lex.peek().val != '"') {
            const p1 = this.lex.peek(1)
            if (this.lex.peek().val === '$' && p1.val === '{' && !p1.ws_before) {
                this.lex.skip(2)
                parts.push(this.parse_expr(0))
                console.log('parts', parts.at(-1))
                this.expect('}')
            } else {
                const n3 = this.lex.next()
                console.log({ n3: n3.val, p1: p1.val })
                parts.push(n3.val)
                //  this.expect('STOP')
            }
        }
        const n4 = this.expect('"')
        console.log('Afters', { n4: n4.val })
        return { type: 'StrExpr', parts }
    }

    parse_vec(skip_start = false): TExpr {
        if (!skip_start) this.lex.expect('v[')
        const items = [] as TExpr[]
        if (this.lex.peek().type != '}') {
            while (true) {
                const expr = this.parse_expr(0)
                items.push(expr)
                if (this.lex.peek().type == ']') break
                if (this.lex.peek().type === ',') {
                    this.expect(',')
                    if (this.lex.peek().type == ']') break
                }
            }
            this.expect(']')
        }
        return { type: 'Vec', items }
    }

}