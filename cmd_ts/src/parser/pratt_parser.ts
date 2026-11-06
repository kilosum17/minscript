
import type { Lexer } from "../lexer/lexer"
import type { Token, TokenType } from "../lexer/lexer_types"
import type { Parser } from "./parser"
import type { BlockDecl, FuncType } from "./parser_types"

export function SyntaxError(mes: string, lex?: Lexer) {
    const info = lex ? `[${lex.peek(-1).val} (${lex.peek().val}),${lex.peek(1).val}]` : ''
    return Error(`Syntax Error:${mes}${info}`)
}

export type TExpr =
    | { type: 'Literal', value: string }
    | { type: 'Var', name: string }
    | { type: 'Unary', op: '-' | '!', right: TExpr }
    | { type: 'Binary', op: string, left: TExpr, right: TExpr }
    | { type: 'Call', callee: TExpr, generics?: FuncType[], args: TExpr[] }
    | { type: 'StrExpr', parts: (string | TExpr)[] }
    | { type: 'Vec', items: TExpr[] }
    | { type: 'Closure', implicit: boolean, params: { name: string, type?: FuncType }[], body: BlockDecl }
    | { type: 'If', condition: TExpr, thenBranch: BlockDecl, elseBranch?: BlockDecl | TExpr }
    | { type: 'Index', object: TExpr, index: TExpr }
    | { type: 'Array', items: TExpr[] }
    | { type: 'Tuple', items: TExpr[] }
    | { type: 'Map', entries: { key: TExpr, value: TExpr }[] }
    | { type: 'Set', items: TExpr[] }
    | { type: 'StructInit', name?: string, fields: { name: string, val: TExpr }[] }
    | { type: 'Record', fields: { name: string, val: TExpr }[] }

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
        if (token.type === 'NUM' || token.type === 'true' || token.type === 'false') {
            return { type: 'Literal', value: token.val }
        }

        if (token.type === 'ID') {
            if ((token.val === '_' || token.val === 'r') && this.lex.peek().type === '{') {
                this.lex.next()
                const fields = this.parse_fields()

                if (token.val === '_') {
                    return { type: 'StructInit', fields }
                }

                return { type: 'Record', fields }
            }

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
        if (token.type === 'r{') {
            return this.parse_record(true)
        }
        throw SyntaxError(`Unexpected token ${token.val}`)
    }

    parse_infix(token: Token, left: TExpr, right_bp: number): TExpr {
        const op = token.val

        if ([
            '.', '+', '-', '*', '/', '%',
            '==', '!=', '>', '<', '>=', '<=',
            '&&', '||'
        ].includes(op)) {
            const right = this.parse_expr(right_bp)
            return { type: 'Binary', op, left, right }
        }

        if (token.type === '(') {
            return { type: 'Call', callee: left, args: this.parse_call_args() }
        }

        if (token.type === '{') {
            if (left.type !== 'Var') {
                throw SyntaxError(`Expected a struct name before '{'`)
            }

            const fields = this.parse_fields()
            return { type: 'StructInit', name: left.name, fields }
        }

        if (token.type === '[') {
            if (this.isGenericCallAhead()) {
                const generics = this.parse_generic_args()
                this.expect('(')
                const args = this.parse_call_args()
                return { type: 'Call', callee: left, generics, args }
            }

            const index = this.parse_expr(0)
            this.expect(']')
            return { type: 'Index', object: left, index }
        }

        throw SyntaxError(`Unexpected infix token ${token.val}`)
    }

    get_infix_bp(token: Token): { left: number, right: number } | null {
        const op = token.val

        if (op === '||') return { left: 1, right: 2 }
        if (op === '&&') return { left: 3, right: 4 }

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
        // console.log('ClosuRebody', body)
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

    parse_record(skip_start = false): TExpr {
        if (!skip_start) this.expect('r{')
        return { type: 'Record', fields: this.parse_fields() }
    }

    parse_fields(): { name: string, val: TExpr }[] {
        const fields: { name: string, val: TExpr }[] = []

        if (this.lex.peek().type !== '}') {
            while (true) {
                const name = this.expect('ID')
                this.expect(':')

                const val = this.parse_expr(0)
                fields.push({ name: name.val, val })

                if (this.lex.peek().type === '}') break

                if (this.lex.peek().type === ',') {
                    this.lex.next()
                    if (this.lex.peek().type === '}') break
                } else {
                    throw SyntaxError(`Expected ',' or '}' in initializer`)
                }
            }
        }

        this.expect('}')
        return fields
    }
    isGenericCallAhead(): boolean {
        let square = 1
        let paren = 0
        let comma = false
        let closeIndex = -1

        const first = this.lex.peek(0)

        for (let i = 0; ; i++) {
            const token = this.lex.peek(i)

            if (token.type === 'EOF') return false

            if (token.type === '[') {
                square++
            } else if (token.type === ']') {
                square--

                if (square === 0) {
                    closeIndex = i
                    break
                }
            } else if (token.type === '(' || token.type === 't(') {
                paren++
            } else if (token.type === ')') {
                paren--
            } else if (token.type === ',' && square === 1 && paren === 0) {
                comma = true
            }
        }

        // Generic application must be followed by a function call.
        if (this.lex.peek(closeIndex + 1).type !== '(') return false

        // A top-level comma cannot represent an index.
        if (comma) return true

        // Single generic arguments must look like types.
        if (first.type !== 'ID') return first.type === 't('

        const builtins = new Set([
            'bool', 'char', 'string', 'str', 'void', 'int',
            'i8', 'i16', 'i32', 'i64', 'i128',
            'u8', 'u16', 'u32', 'u64', 'u128',
            'f32', 'f64', 'usize', 'isize'
        ])

        return /^[A-Z]/.test(first.val) || builtins.has(first.val)
    }
    parse_generic_args(): FuncType[] {
        const generics: FuncType[] = []

        if (this.lex.peek().type !== ']') {
            while (true) {
                generics.push(this.parser.parseType())

                if (this.lex.peek().type === ']') break

                if (this.lex.peek().type === ',') {
                    this.lex.next()
                    if (this.lex.peek().type === ']') break
                } else {
                    throw SyntaxError(`Expected ',' or ']' in generic arguments`)
                }
            }
        }

        this.expect(']')
        return generics
    }

    parse_call_args(): TExpr[] {
        const args: TExpr[] = []

        if (this.lex.peek().type !== ')') {
            while (true) {
                args.push(this.parse_expr(0))

                if (this.lex.peek().type === ')') break

                if (this.lex.peek().type === ',') {
                    this.lex.next()
                    if (this.lex.peek().type === ')') break
                } else {
                    throw SyntaxError(`Expected ',' or ')' in function call`, this.lex)
                }
            }
        }

        this.expect(')')
        return args
    }
}
