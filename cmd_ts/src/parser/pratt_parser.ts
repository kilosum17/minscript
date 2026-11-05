
import type { Lexer } from "../lexer/lexer"
import type { Token, TokenType } from "../lexer/lexer_types"
import type { Parser } from "./parser"
import type { BlockDecl, FuncType } from "./parser_types"

export function SyntaxError(mes: string) {
    return Error(`Syntax Error:${mes}`)
}

export type TExpr =
    | { type: 'Literal', value: string }
    | { type: 'Var', name: string }
    | { type: 'Unary', op: '-' | '!', right: TExpr }
    | { type: 'Binary', op: string, left: TExpr, right: TExpr }
    | { type: 'Call', callee: TExpr, args: TExpr[] }
    | { type: 'StrExpr', parts: (string | TExpr)[] }
    | { type: 'StructInit', fields: { name: string, val: TExpr }[] }
    | { type: 'Vec', items: TExpr[] }
    | { type: 'Closure', implicit: boolean, params: { name: string, type?: FuncType }[], body: BlockDecl }
    | { type: 'If', condition: TExpr, thenBranch: BlockDecl, elseBranch?: BlockDecl | TExpr }
    | { type: 'Index', object: TExpr, index: TExpr }
    | { type: 'Array', items: TExpr[] }
    | { type: 'Tuple', items: TExpr[] }
    | { type: 'Map', entries: { key: TExpr, value: TExpr }[] }
    | { type: 'Set', items: TExpr[] }

export class PrattParser {

    constructor(
        private lex: Lexer,
        private parser: Parser,
    ) { }

    expect(kind: TokenType, tok?: Token): Token {
        const n = tok || this.lex.next()
        if (n.type !== kind) {
            this.lex.expect(kind)
        }
        return n
    }

    parse_expr(min_bp = 0, stopAtBrace = false): TExpr {
        const token = this.lex.next()
        let left = this.parse_nul(token)

        while (true) {
            const next = this.lex.peek()

            if (
                next.type === 'EOF' ||
                [')', ']', '}', ',', ';'].includes(next.type)
            ) break

            if (stopAtBrace && next.type === '{') break

            const bp = this.get_infix_bp(next)
            if (bp == null || bp.left < min_bp) break

            this.lex.next()
            left = this.parse_infix(next, left, bp.right)
        }

        return left
    }

    parse_nul(token: Token): TExpr {
        if (token.type === 'NUM') {
            return { type: 'Literal', value: token.val }
        }

        if (token.type === 'ID') {
            return { type: 'Var', name: token.val }
        }
        if (token.type === 'if') return this.parse_if()

        if (token.type === '-') {
            const right = this.parse_expr(13)
            return { type: 'Unary', op: '-', right }
        }

        if (token.type === '!') {
            const right = this.parse_expr(13)
            return { type: 'Unary', op: '!', right }
        }

        if (token.type === '(') {
            const expr = this.parse_expr(0)
            this.expect(')')
            return expr
        }

        if (token.type === '"') {
            return this.parse_string_expr(true)
        }

        if (token.type === 'v[') {
            return this.parse_vec(true)
        }

        if (token.type === '#{') {
            return this.parse_closure(true)
        }
        if (token.type === 'a[') return this.parse_array(true)
        if (token.type === 'm{') return this.parse_map(true)
        if (token.type === 's{') return this.parse_set(true)
        if (token.type === 't(') return this.parse_tuple(true)
        throw SyntaxError(`Unexpected token ${token.val}`)
    }

    parse_infix(token: Token, left: TExpr, right_bp: number): TExpr {
        const op = token.val

        if ([
            '.', '+', '-', '*', '/', '%',
            '==', '!=', '>', '<', '>=', '<=',
            'and', 'or'
        ].includes(op)) {
            const right = this.parse_expr(right_bp)
            return { type: 'Binary', op, left, right }
        }

        if (token.type === '(') {
            const args: TExpr[] = []

            if (this.lex.peek().type !== ')') {
                while (true) {
                    args.push(this.parse_expr(0))

                    if (this.lex.peek().type === ',') {
                        this.lex.next()
                        if (this.lex.peek().type === ')') break
                    } else {
                        break
                    }
                }
            }

            this.expect(')')
            return { type: 'Call', callee: left, args }
        }

        if (token.type === '{') {
            const fields: { name: string, val: TExpr }[] = []

            if (this.lex.peek().type !== '}') {
                while (true) {
                    const n1 = this.expect('ID')
                    this.expect(':')

                    const expr = this.parse_expr(0)
                    fields.push({ name: n1.val, val: expr })

                    if (this.lex.peek().type === '}') break

                    if (this.lex.peek().type === ',') {
                        this.lex.next()
                        if (this.lex.peek().type === '}') break
                    } else {
                        throw SyntaxError(`Expected ',' or '}' in struct initializer`)
                    }
                }
            }

            this.expect('}')
            return { type: 'StructInit', fields }
        }

        if (token.type === '[') {
            const index = this.parse_expr(0)
            this.expect(']')
            return { type: 'Index', object: left, index }
        }

        throw SyntaxError(`Unexpected infix token ${token.val}`)
    }

    get_infix_bp(token: Token): { left: number, right: number } | null {
        const op = token.val

        if (op === 'or') return { left: 1, right: 2 }
        if (op === 'and') return { left: 3, right: 4 }

        if (['==', '!='].includes(op))
            return { left: 5, right: 6 }

        if (['>', '<', '>=', '<='].includes(op))
            return { left: 7, right: 8 }

        if (['+', '-'].includes(op))
            return { left: 9, right: 10 }

        if (['*', '/', '%'].includes(op))
            return { left: 11, right: 12 }

        if (op === '.') return { left: 14, right: 0 }
        if (token.type === '{') return { left: 15, right: 0 }
        if (token.type === '(') return { left: 16, right: 0 }
        if (token.type === 'v[') return { left: 16, right: 0 }
        if (token.type === '[') return { left: 16, right: 0 }
        return null
    }

    parse_string_expr(skip_start = false): TExpr {
        if (!skip_start) this.expect('"')
        let is_multiline = this.lex.peek().type == '"' && this.lex.peek(1).type == '"'
        if (is_multiline) this.lex.skip(2)
        const parts: (string | TExpr)[] = []

        while (
            is_multiline ? (
                this.lex.peek().type == '"' && this.lex.peek(1).type == '"' &&
                this.lex.peek(2).type == '"'
            ) : this.lex.peek().type !== '"'
        ) {
            if (this.lex.peek().type === 'EOF') {
                throw SyntaxError('Unterminated string expression')
            }

            const p1 = this.lex.peek(1)

            if (
                this.lex.peek().val === '$' &&
                p1.val === '{' &&
                !p1.ws_before
            ) {
                this.lex.skip(2)
                parts.push(this.parse_expr(0))
                this.expect('}')
            } else {
                parts.push(this.lex.next().val)
            }
        }
        this.expect('"')
        if (is_multiline) {
            this.expect('"')
            this.expect('"')
        }
        return { type: 'StrExpr', parts }
    }

    parse_vec(skip_start = false): TExpr {
        if (!skip_start) this.expect('v[')

        const items: TExpr[] = []

        if (this.lex.peek().type !== ']') {
            while (true) {
                items.push(this.parse_expr(0))

                if (this.lex.peek().type === ']') break

                if (this.lex.peek().type === ',') {
                    this.lex.next()
                    if (this.lex.peek().type === ']') break
                } else {
                    throw SyntaxError(`Expected ',' or ']' in vector`)
                }
            }
        }

        this.expect(']')
        return { type: 'Vec', items }
    }

    parse_closure(skip_start = false): TExpr {
        if (!skip_start) this.expect('#{')

        let implicit = false
        let idx = 0

        while (this.lex.peek(idx).type !== '}') {
            if (this.lex.peek(idx).type === 'EOF') {
                throw SyntaxError('Unterminated closure')
            }

            if (this.lex.peek(idx).type === '=>') {
                implicit = true
                break
            }

            idx++
        }

        const params: { name: string, type?: FuncType }[] = []

        if (implicit) {
            while (this.lex.peek().type !== '=>') {
                const name = this.expect('ID')

                if (this.lex.peek().type === ':') {
                    this.expect(':')
                    const type = this.parser.parseType()
                    params.push({ name: name.val, type })
                } else {
                    params.push({ name: name.val })
                }

                if (this.lex.peek().type === ',') {
                    this.lex.next()
                } else if (this.lex.peek().type !== '=>') {
                    throw SyntaxError(`Expected ',' or '=>' in closure parameters`)
                }
            }

            this.expect('=>')
        }

        const body = this.parser.parserBlock(true)
        console.log('ClosuRebody', body)
        return { type: 'Closure', implicit, params, body }
    }

    parse_if(): TExpr {
        const condition = this.parse_expr(0, true)
        const thenBranch = this.parser.parserBlock()

        let elseBranch: BlockDecl | TExpr | undefined

        if (this.lex.peek().val === 'else') {
            this.lex.next()

            if (this.lex.peek().val === 'if') {
                this.lex.next()
                elseBranch = this.parse_if()
            } else {
                elseBranch = this.parser.parserBlock()
            }
        }

        return { type: 'If', condition, thenBranch, elseBranch }
    }

    parse_array(skip_start = false): TExpr {
        if (!skip_start) this.expect('a[')

        const items: TExpr[] = []

        if (this.lex.peek().type !== ']') {
            while (true) {
                items.push(this.parse_expr(0))

                if (this.lex.peek().type === ']') break

                if (this.lex.peek().type === ',') {
                    this.lex.next()
                    if (this.lex.peek().type === ']') break
                } else {
                    throw SyntaxError("Expected ',' or ']' in array")
                }
            }
        }

        this.expect(']')
        return { type: 'Array', items }
    }

    parse_tuple(skip_start = false): TExpr {
        if (!skip_start) this.expect('t(')

        const items: TExpr[] = []

        if (this.lex.peek().type !== ')') {
            while (true) {
                items.push(this.parse_expr(0))

                if (this.lex.peek().type === ')') break

                if (this.lex.peek().type === ',') {
                    this.lex.next()
                    if (this.lex.peek().type === ')') break
                } else {
                    throw SyntaxError("Expected ',' or ')' in tuple")
                }
            }
        }

        this.expect(')')
        return { type: 'Tuple', items }
    }
    parse_map(skip_start = false): TExpr {
        if (!skip_start) this.expect('m{')

        const entries: { key: TExpr, value: TExpr }[] = []

        if (this.lex.peek().type !== '}') {
            while (true) {
                const key = this.parse_expr(0)
                this.expect(':')
                const value = this.parse_expr(0)

                entries.push({ key, value })

                if (this.lex.peek().type === '}') break

                if (this.lex.peek().type === ',') {
                    this.lex.next()
                    if (this.lex.peek().type === '}') break
                } else {
                    throw SyntaxError("Expected ',' or '}' in map")
                }
            }
        }

        this.expect('}')
        return { type: 'Map', entries }
    }
    parse_set(skip_start = false): TExpr {
        if (!skip_start) this.expect('s{')

        const items: TExpr[] = []

        if (this.lex.peek().type !== '}') {
            while (true) {
                items.push(this.parse_expr(0))

                if (this.lex.peek().type === '}') break

                if (this.lex.peek().type === ',') {
                    this.lex.next()
                    if (this.lex.peek().type === '}') break
                } else {
                    throw SyntaxError("Expected ',' or '}' in set")
                }
            }
        }

        this.expect('}')
        return { type: 'Set', items }
    }
    
}
