
import type { Lexer } from "../lexer/lexer"
import type { Token, TokenType } from "../lexer/lexer_types"
import type { Parser } from "./parser"
import type { BlockDecl, FuncType } from "./parser_types"

export function SyntaxError(mes: string, lex?: Lexer) {
    const info = lex ? `[${lex.peek(-1).val} (${lex.peek().val}),${lex.peek(1).val}]` : ''
    return Error(`Syntax Error:${mes}${info}`)
}
export type Capture = { name: string, mode: 'val' | 'ref' | 'mut' }

type FieldsResult = { spread?: TExpr, fields: { name: string, val: TExpr }[] }
export type MatchArm = { pattern: TExpr, body: BlockDecl | TExpr }

export type TExpr =
    | { type: 'Literal', value: string }
    | { type: 'Var', name: string }
    | { type: 'Unary', op: '-' | '!', right: TExpr }
    | { type: 'Binary', op: string, left: TExpr, right: TExpr }
    | { type: 'Call', callee: TExpr, generics?: FuncType[], args: TExpr[] }
    | { type: 'StrExpr', parts: (string | TExpr)[] }
    | { type: 'Vec', items: TExpr[] }
    | { type: 'If', condition: TExpr, thenBranch: BlockDecl, elseBranch?: BlockDecl | TExpr }
    | { type: 'Index', object: TExpr, index: TExpr }
    | { type: 'Array', items: TExpr[] }
    | { type: 'Tuple', items: TExpr[] }
    | { type: 'Map', entries: { key: TExpr, value: TExpr }[] }
    | { type: 'Set', items: TExpr[] }
    | { type: 'Closure', implicit: boolean, captures: Capture[], params: { name: string, type?: FuncType }[], body: BlockDecl }
    | { type: 'StructInit', name?: string, spread?: TExpr, fields: { name: string, val: TExpr }[] }
    | { type: 'Record', spread?: TExpr, fields: { name: string, val: TExpr }[] }
    | { type: 'Range', start?: TExpr, end?: TExpr, inclusive: boolean }
    | { type: 'Match', scrutinee: TExpr, arms: MatchArm[] }
    | { type: 'For', kind: 'loop', body: BlockDecl }                                   // for { }
    | { type: 'For', kind: 'cond', cond: TExpr, body: BlockDecl }                      // for x == y { }
    | { type: 'For', kind: 'in', vars: string[], iter: TExpr, body: BlockDecl }        // for a, b in xs { }
    | { type: 'Break', value?: TExpr }
    | { type: 'Continue' }

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

    private noBrace = false
    private with<T>(noBrace: boolean, f: () => T): T {
        const prev = this.noBrace
        this.noBrace = noBrace
        try { return f() } finally { this.noBrace = prev }
    }

    parse_expr(min_bp = 0): TExpr {          // note: stopAtBrace parameter removed
        const token = this.lex.next()
        let left = this.parse_nul(token)

        while (true) {
            const next = this.lex.peek()
            if (next.type === 'EOF' || [')', ']', '}', ',', ';', '=>'].includes(next.type)) break
            if (this.noBrace && next.type === '{') break
            // a `(` or `[` at the start of a new line is a new statement, not a call/index
            if (next.nl_before && (next.type === '(' || next.type === '[')) break

            const bp = this.get_infix_bp(next)
            if (bp == null || bp.left < min_bp) break

            this.lex.next()
            left = this.parse_infix(next, left, bp.right)
        }
        return left
    }

    parse_nul(token: Token): TExpr {
        const delimited = ['(', '"', 'v[', 'a[', 'm{', 's{', 't(', 'r{', '#{', '#[']
        if (this.noBrace && delimited.includes(token.type)) {
            return this.with(false, () => this.parse_nul(token))
        }
        if (token.type === 'NUM' || token.type === 'true' || token.type === 'false') {
            return { type: 'Literal', value: token.val }
        }

        if (token.type === 'ID') {
            if ((token.val === '_' || token.val === 'r') && this.lex.peek().type === '{') {
                this.lex.next()
                const { spread, fields } = this.parse_fields()
                return token.val === '_'
                    ? { type: 'StructInit', spread, fields }
                    : { type: 'Record', spread, fields }
            }
            return { type: 'Var', name: token.val }
        }
        if (token.type === '#{') return this.parse_closure(true)
        if (token.type === '#[') return this.parse_closure(true, true)
        if (token.type === 'r{') return this.parse_record(true)

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

        if (token.type === 'a[') return this.parse_array(true)
        if (token.type === 'm{') return this.parse_map(true)
        if (token.type === 's{') return this.parse_set(true)
        if (token.type === 't(') return this.parse_tuple(true)

        if (token.type === 'if') return this.parse_if()
        if (token.type === 'match') return this.parse_match()
        if (token.type === 'for') return this.parse_for()
        if (token.type === 'continue') return { type: 'Continue' }
        if (token.type === 'break') {
            const t = this.lex.peek()
            if (t.nl_before || ['EOF', ')', ']', '}', ',', ';'].includes(t.type)) return { type: 'Break' }
            return { type: 'Break', value: this.parse_expr(0) }
        }
        if (token.type === '..' || token.type === '..=') {          // `..5`, `..=5`, `..`
            return this.parse_range(undefined, token.type === '..=', 0.6)
        }

        throw SyntaxError(`Unexpected token ${token.val}`)
    }

    parse_infix(token: Token, left: TExpr, right_bp: number): TExpr {
        if (this.noBrace && (token.type === '(' || token.type === '[')) {
            return this.with(false, () => this.parse_infix(token, left, right_bp))
        }

        if (token.type === '..' || token.type === '..=') {
            if (left.type === 'Range') throw SyntaxError(`Ranges cannot be chained`, this.lex)
            return this.parse_range(left, token.type === '..=', right_bp)
        }

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
            const { spread, fields } = this.parse_fields()
            return { type: 'StructInit', name: left.name, spread, fields }
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
        if (token.type === '..' || token.type === '..=') return { left: 0.5, right: 0.6 }

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

    parse_if(): TExpr {
        const condition = this.with(true, () => this.parse_expr(0))
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

    /** Returns how many tokens make up `...` (1 if lexed as one token, 3 if as three dots), or 0. */
    private spreadLen(): number {
        if (this.lex.peek().type === '...') return 1
        if (
            this.lex.peek().type === '.' &&
            this.lex.peek(1).type === '.' &&
            this.lex.peek(2).type === '.'
        ) return 3
        return 0
    }

    parse_record(skip_start = false): TExpr {
        if (!skip_start) this.expect('r{')
        const { spread, fields } = this.parse_fields()
        return { type: 'Record', spread, fields }
    }

    parse_fields(): FieldsResult {
        const fields: { name: string, val: TExpr }[] = []
        let spread: TExpr | undefined

        // `...base` is only allowed as the very first entry
        const n = this.spreadLen()
        if (n) {
            this.lex.skip(n)
            spread = this.parse_expr(0)
            if (this.lex.peek().type === ',') {
                this.lex.next()
            } else if (this.lex.peek().type !== '}') {
                throw SyntaxError(`Expected ',' or '}' after spread`, this.lex)
            }
        }

        while (this.lex.peek().type !== '}') {
            if (this.spreadLen()) {
                throw SyntaxError(`Spread '...' is only allowed at the start of an initializer`, this.lex)
            }
            const name = this.expect('ID')
            this.expect(':')
            const val = this.parse_expr(0)
            fields.push({ name: name.val, val })
            if (this.lex.peek().type === ',') {
                this.lex.next()
            } else if (this.lex.peek().type !== '}') {
                throw SyntaxError(`Expected ',' or '}' in initializer`, this.lex)
            }
        }
        this.expect('}')
        return { spread, fields }
    }

    parse_captures(): Capture[] {
        const captures: Capture[] = []
        while (this.lex.peek().type !== ']') {
            let mode: Capture['mode'] = 'val'
            if (this.lex.peek().val === '&') {
                this.lex.next()
                mode = 'ref'
                if (this.lex.peek().type === 'mut') {
                    this.lex.next()
                    mode = 'mut'
                }
            }
            const name = this.expect('ID')
            captures.push({ name: name.val, mode })
            if (this.lex.peek().type === ',') {
                this.lex.next()
            } else if (this.lex.peek().type !== ']') {
                throw SyntaxError(`Expected ',' or ']' in capture list`, this.lex)
            }
        }
        this.expect(']')
        return captures
    }

    parse_block_like(): TExpr {
        return this.parse_nul(this.lex.next())
    }

    parse_closure(skip_start = false, with_captures = false): TExpr {
        let captures: Capture[] = []
        if (with_captures) {
            if (!skip_start) this.expect('#[')
            captures = this.parse_captures()
            this.expect('{')            // `#[...]` must be followed by `{`
        } else if (!skip_start) {
            this.expect('#{')
        }

        // ---- unchanged below, only `captures` added to the result ----
        let implicit = false
        let depth = 0
        for (let idx = 0; ; idx++) {
            const t = this.lex.peek(idx)
            if (t.type === 'EOF') throw SyntaxError('Unterminated closure')
            if (['{', '#{', 'm{', 's{', 'r{'].includes(t.type)) depth++
            else if (t.type === '}') { if (depth === 0) break; depth-- }
            else if (t.type === '=>' && depth === 0) { implicit = true; break }
        }

        const params: { name: string, type?: FuncType }[] = []
        if (implicit) {
            while (this.lex.peek().type !== '=>') {
                const name = this.expect('ID')
                if (this.lex.peek().type === ':') {
                    this.expect(':')
                    params.push({ name: name.val, type: this.parser.parseType() })
                } else {
                    params.push({ name: name.val })
                }
                if (this.lex.peek().type === ',') this.lex.next()
                else if (this.lex.peek().type !== '=>')
                    throw SyntaxError(`Expected ',' or '=>' in closure parameters`)
            }
            this.expect('=>')
        }
        const body = this.parser.parserBlock(true)
        return { type: 'Closure', implicit, captures, params, body }
    }

    private range_end_follows(): boolean {
        const t = this.lex.peek()
        if (t.type === 'EOF' || [')', ']', '}', ',', ';', '=>'].includes(t.type)) return false
        if (this.noBrace && t.type === '{') return false   // `for i in 1.. {`
        if (t.nl_before) return false
        return true
    }

    parse_range(start: TExpr | undefined, inclusive: boolean, right_bp: number): TExpr {
        const end = this.range_end_follows() ? this.parse_expr(right_bp) : undefined
        if (inclusive && !end) throw SyntaxError(`'..=' needs an end`, this.lex)
        return { type: 'Range', start, end, inclusive }
    }
    parse_match(): TExpr {
        const scrutinee = this.with(true, () => this.parse_expr(0))
        this.expect('{')
        const arms = this.with(false, () => this.parse_match_arms())
        this.expect('}')
        return { type: 'Match', scrutinee, arms }
    }

    private parse_match_arms(): MatchArm[] {
        const arms: MatchArm[] = []
        while (this.lex.peek().type !== '}') {
            if (this.lex.peek().type === 'EOF') throw SyntaxError('Unterminated match', this.lex)
            const pattern = this.parse_expr(0)
            this.expect('=>')
            const body = this.lex.peek().type === '{'
                ? this.parser.parserBlock()
                : this.parse_expr(0)
            arms.push({ pattern, body })
            if (this.lex.peek().type === ',') this.lex.next()
        }
        return arms
    }

    parse_for(): TExpr {
        const p0 = this.lex.peek()

        // for { }
        if (p0.type === '{') {
            return { type: 'For', kind: 'loop', body: this.parser.parserBlock() }
        }

        // for a in xs / for a, b in xs
        if (p0.type === 'ID') {
            let i = 1
            while (this.lex.peek(i).type === ',' && this.lex.peek(i + 1).type === 'ID') i += 2
            if (this.lex.peek(i).val === 'in') {
                const vars: string[] = []
                for (let k = 0; k < i; k += 2) vars.push(this.lex.peek(k).val)
                this.lex.skip(i + 1)
                const iter = this.with(true, () => this.parse_expr(0))
                return { type: 'For', kind: 'in', vars, iter, body: this.parser.parserBlock() }
            }
        }

        // for cond { }
        const cond = this.with(true, () => this.parse_expr(0))
        return { type: 'For', kind: 'cond', cond, body: this.parser.parserBlock() }
    }

}
