import type { Lexer } from "../lexer/lexer";
import type { Token } from "../lexer/lexer_types";
import type { BlockDecl, Expr, MapInitField, MatchArm, SelectArm, StmtDecl, StructInitField } from "./ast_types";
import type { Parser } from "./parser";

type ParseOps = {
    avoidBrace: boolean,
    avoidAssign?: boolean,
}

export class Pratt {
    private avoidBrace = false
    private avoidAssign = false

    constructor(
        private pa: Parser,
        private le: Lexer
    ) {

    }

    parseExpr(minBp: number, ops: ParseOps | null): Expr {
        if (ops) {
            this.avoidBrace = ops.avoidBrace ?? false
            this.avoidAssign = ops.avoidAssign ?? false
        }
        let left = this.parseNull()
        let next = this.getBp(this.le.peek().val)
        while (next && minBp < next.lbp) {
            const tok = this.le.next()
            // console.log('Next', next.lbp, tok.val, this.avoidAssign)
            left = this.parserInfixExp(tok, next.rbp, left)
            next = this.getBp(this.le.peek().val)
        }
        return left
    }

    private conds = new Set(['>', '<', '>=', '<=', '==', '!=',])
    private assigns = new Set(['=', '+=', '-=', '*=', '/=',])
    getBp(oper: string) {
        if (this.avoidAssign && oper == '=') return null
        if (this.assigns.has(oper)) return { lbp: 10, rbp: 9 }   // right-assoc
        if (oper == 'or') return { lbp: 12, rbp: 12 }
        if (oper == '..' || oper == '..=') return { lbp: 20, rbp: 20 }
        if (oper == '??') return { lbp: 30, rbp: 30 }
        if (oper == '||') return { lbp: 33, rbp: 33 }
        if (oper == '&&') return { lbp: 36, rbp: 36 }
        if (this.conds.has(oper)) return { lbp: 40, rbp: 40 }
        if (oper == '<<' || oper == '>>') return { lbp: 45, rbp: 45 }
        if (oper == '+' || oper == '-') return { lbp: 50, rbp: 50 }
        if (oper == '*' || oper == '/' || oper == '%') return { lbp: 60, rbp: 60 }
        if (oper == 'as') return { lbp: 65, rbp: 65 }
        // prefix - and !  → 70   (in parseNull)
        if (oper == '?') return { lbp: 72, rbp: 72 }             // postfix
        // prefix await    → 75   (in parseNull)
        if (oper == '.' || oper == '?.' || oper == '[' || oper == '(')
            return { lbp: 80, rbp: 80 }
        return null
    }

    parseNull(): Expr {
        this.pa.saveStart()
        const p1 = this.le.peek()
        const p2 = this.le.peek(1)
        // console.log('p1', p1.kwd(), p1.type)
        if (p1.val_('-') || p1.val_('!')) {
            const oper = this.le.next().val
            const expr = this.parseExpr(70, null)
            return { kind: 'Unary', oper, expr, span: this.pa.getSpan() }
        }
        if (p1.kwd_('await')) {
            this.le.expect('await')
            const expr = this.parseExpr(75, null)
            return { kind: 'Await', expr, span: this.pa.getSpan() }
        }
        if (p1.kwd_('match')) {
            return this.parseMatchExpr()
        }
        if (p1.kwd_('select')) {
            return this.parseSelect()
        }
        if (p1.kwd_('if')) {
            return this.parseIfExpr()
        }
        if (p1.type_('STR_START')) {
            return this.parseString()
        }
        if (p1.symb_('[')) {
            return this.parseVec()
        }
        if (p1.val_('#{')) {
            return this.parseClosure()
        }
        if (p1.val_('s{')) {
            return this.parseSet()
        }
        if (p1.val_('m{')) {
            return this.parseMap()
        }
        if (p1.val_('r{')) {
            return this.parseRecord()
        }
        if (p1.val_('t(')) {
            return this.parseTuple()
        }
        if (p1.kwd_('recover')) {
            return this.parseRecover()
        }
        if (p1.kwd_('lock')) {
            return this.parseLock()
        }
        if (p1.val_('(')) {
            this.le.expect_('(')
            const expr = this.parseExpr(0, null)
            this.le.expect_(')')
            return { kind: 'Bracket', expr }
        }
        if (p1.val_('{')) {
            const block = this.pa.parseBlockDecl()
            return { kind: 'Block', block, span: this.pa.getSpan() }
        }
        if (p1.type_('ID')) {
            if (!this.avoidBrace && p2.val_('{')) {
                return this.parseStructInit()
            }
            const name = this.le.expect('ID').val
            return { kind: 'Var', name, span: this.pa.getSpan() }
        }
        if (p1.type_('NUM')) {
            const val = this.le.expect('NUM').val
            return { kind: 'Literal', val, span: this.pa.getSpan() }
        }
        throw new Error(`Unkowr NULL-EXP ${this.le.info()}`)
    }

    private bins = new Set([
        '+', '-', '*', '/', '%',
        '>', '<', '>=', '<=', '==', '!=',
        '??', 'or', '..', '..=', '<<', '>>',
        "&&", '||',
        ...this.assigns,
    ])
    parserInfixExp(tok: Token, minBp: number, lhs: Expr): Expr {
        this.pa.saveStart()
        const oper = tok.symb()
        if (this.bins.has(oper) || this.conds.has(oper)) {
            const rhs = this.parseExpr(minBp, null)
            return { kind: 'Binary', oper, lhs, rhs, span: this.pa.getSpan() }
        }
        if (tok.kwd_('as')) {
            const type = this.pa.parseType()
            return { kind: 'Cast', oper, lhs, type, span: this.pa.getSpan() }
        }
        if (oper == '.' || tok.val == '?.') {
            let next = this.le.next()
            let rhs: Expr
            if (next.type_('ID')) {
                rhs = { kind: 'Var', name: next.val, span: this.pa.getSpan() }
            } else if (next.type_('NUM')) {
                rhs = { kind: 'Literal', val: next.val, span: this.pa.getSpan() }
            } else if (next.val_('[')) {
                const type = this.pa.parseType()
                this.le.expect_(']')
                return { kind: 'GenericExpr', type }
            } else {
                throw new Error(`Unexpected member value ${this.le.info()}`)
            }
            const is_optional = tok.val_('?.')
            return { kind: 'Member', is_optional, lhs, rhs, span: this.pa.getSpan() }
        }
        if (oper == '(') {
            return this.parseFuncCall(lhs, true)
        }
        if (oper == '[') {
            const key = this.parseExpr(0, null)
            this.le.expect_(']')
            return { kind: 'Index', lhs, key, }
        }
        if (oper == '?') {
            return { kind: 'ErrorProp', lhs }
        }
        throw new Error(`UNKOWn infix operator: ${oper}, ${this.le.info()}`)
    }

    parseMatchExpr(): Expr {
        this.le.expect('match')
        let cond = undefined as undefined | Expr
        if (!this.le.peek().val_('{')) {
            cond = this.parseExpr(0, { avoidBrace: true })
        }
        this.le.expect_('{')

        const arms = [] as MatchArm[]
        while (!this.le.peek().val_('}')) {
            const p1 = this.le.peek()
            const p2 = this.le.peek(1)
            const p3 = this.le.peek(2)
            const p4 = this.le.peek(3)
            if (p1.type_('ID') && p2.val_('{')) {
                // struct
                const name = this.le.expect('ID').val
                this.le.expect_('{')
                const fields = [] as string[]
                while (!this.le.peek().val_('}')) {
                    fields.push(this.le.expect('ID').val)
                    if (!this.le.peek().val_('}')) {
                        this.le.expect_(',')
                        if (this.le.peek().val_('}')) break
                    }
                }
                this.le.expect_('}')
                this.le.expect_('=>')
                const block = this.pa.parseBlockDecl({ bracesOptional: true })
                arms.push({ mode: 'Struct', name, fields, block })

            } else if (p1.type_('ID') && p2.val_('(')) {
                //tuple
                const name = this.le.expect('ID').val
                this.le.expect_('(')
                const fields = [] as string[]
                while (!this.le.peek().val_(')')) {
                    fields.push(this.le.expect('ID').val)
                    if (!this.le.peek().val_(')')) {
                        this.le.expect_(',')
                        if (this.le.peek().val_(')')) break
                    }
                }
                this.le.expect_(')')
                this.le.expect_('=>')
                const block = this.pa.parseBlockDecl({ bracesOptional: true })
                arms.push({ mode: 'Tuple', name, fields, block })

            } else if (p1.type_('ID') && p2.val_('=>')) {
                const name = this.le.expect('ID').val
                this.le.expect_('=>')
                const block = this.pa.parseBlockDecl({ bracesOptional: true })
                arms.push({ mode: 'Bare', name, block })

            } else if (p1.type_('NUM') && p2.val_('=>')) {
                const val = this.le.expect('NUM').val
                this.le.expect_('=>')
                const block = this.pa.parseBlockDecl({ bracesOptional: true })
                arms.push({ mode: 'Literal', val, block })

            } else if ((p2.val_('..') || p2.val_('..=')) && p4.val_('=>')) {
                const range = this.parseExpr(0, { avoidBrace: true })
                this.le.expect_('=>')
                const block = this.pa.parseBlockDecl({ bracesOptional: true })
                arms.push({ mode: 'Range', range, block })

            } else if (p1.type_('ID') && p2.kwd_('if')) {
                const var_name = this.le.expect('ID').val
                this.le.expect('if')
                const cond = this.parseExpr(0, { avoidBrace: true })
                this.le.expect_('=>')
                const block = this.pa.parseBlockDecl({ bracesOptional: true })
                arms.push({ mode: 'IfCond', var_name, cond, block })

            } else {
                console.log('arms', arms)
                throw new Error(`Unkowm match arm${this.le.info()} `)
            }
            if (this.le.peek().val_(',')) this.le.expect_(',')
        }
        this.le.expect_('}')
        return { kind: 'Match', cond, arms }
    }

    parseIfExpr(): Expr {
        this.le.expect('if')
        let is_let = false
        if (this.le.peek().kwd_('let')) {
            is_let = true
            this.le.expect('let')
        }
        // console.log('then', is_let)
        const cond = this.parseExpr(0, { avoidBrace: !is_let, avoidAssign: true })
        // console.log('then', cond)
        let variant = undefined as undefined | Expr
        if (is_let) {
            this.le.expect_('=')
            variant = this.parseExpr(0, { avoidBrace: true })
        }
        const then = this.pa.parseBlockDecl()
        let else_ = undefined as undefined | Expr | BlockDecl
        if (this.le.peek().kwd_('else')) {
            this.le.expect('else')
            if (this.le.peek().kwd_('if')) {
                else_ = this.parseIfExpr()
            } else {
                else_ = this.pa.parseBlockDecl()
            }
        }
        return { kind: 'If', is_let, cond, variant, then, else: else_ }
    }

    parseFuncCall(lhs: Expr, skip_bracket = false): Expr {
        if (!skip_bracket) this.le.expect_('(')
        const args = [] as Expr[]
        while (!this.le.peek().val_(')')) {
            args.push(this.parseExpr(0, { avoidBrace: false, avoidAssign: this.avoidAssign }))
            if (!this.le.peek().val_(')')) {
                this.le.expect_(',')
            }
        }
        this.le.expect_(')')
        return { kind: 'Call', lhs, args }
    }

    parseString(): Expr {
        this.le.expect('STR_START')
        const parts = [] as (string | Expr)[]
        while (!this.le.peek().type_('STR_END')) {
            const p1 = this.le.peek()
            if (p1.type_('STR_PART')) {
                const part = this.le.expect('STR_PART')
                parts.push(part.val)
            } else if (p1.type_('STR_EXP_OPEN')) {
                this.le.expect_('STR_EXP_OPEN')
                const exp = this.parseExpr(0, null)
                parts.push(exp)
                this.le.expect('STR_EXP_CLOSE')
            } else {
                new Error(`Unkown string part ${this.le.info()}`)
            }
        }
        this.le.expect_('STR_END')
        return { kind: 'String', parts }
    }

    parseStructInit(): Expr {
        const name = this.le.expect('ID').val
        const fields = this.parseStructFields()
        return { kind: 'StructInit', name, fields }
    }

    parseStructFields(skip_brace = false) {
        if (!skip_brace) this.le.expect_('{')

        const fields = [] as StructInitField[]
        while (!this.le.peek().val_('}')) {
            if (this.le.peek().val_('...')) {
                this.le.expect_('...')
                const expr = this.parseExpr(0, { avoidBrace: false })
                fields.push({ mode: 'spread', expr })
            } else {
                const name = this.le.expect('ID').val
                this.le.expect_(':')
                const expr = this.parseExpr(0, { avoidBrace: false })
                fields.push({ mode: 'field', name, expr })
            }
            if (!this.le.peek().val_('}')) {
                if (this.le.peek().val_(',')) this.le.expect_(',')
            }
        }

        this.le.expect_('}')

        return fields

    }

    parseVec(): Expr {
        this.le.expect_('[')
        const items = [] as Expr[]
        while (!this.le.peek().val_(']')) {
            items.push(this.parseExpr(0, { avoidBrace: false }))
            if (!this.le.peek().val_(']')) this.le.expect_(',')
        }
        this.le.expect_(']')
        return { kind: 'VecInit', items }
    }

    parseClosure(): Expr {
        this.le.expect_('#{')
        let has_args = false
        let offset = 0
        while (true) {
            const p1 = this.le.peek(offset)
            if (p1.nl_before) break
            if (p1.val_('}')) break
            if (p1.val_('=>')) {
                has_args = true
                break
            }
            offset++
        }

        let args = undefined as undefined | string[]
        if (has_args) {
            args = []
            while (!this.le.peek().val_('=>')) {
                const name = this.le.expect('ID').val
                args.push(name)
                if (!this.le.peek().val_('=>')) this.le.expect_(',')
            }
            this.le.expect_('=>')
        }
        const block = this.pa.parseBlockDecl({ openBraceOptional: true, hasClosingBrace: true })
        return { kind: 'Closure', args, block }
    }

    parseMap(): Expr {
        const fields = this.parseMapFields()
        return { kind: 'MapInit', fields }
    }

    parseMapFields(): MapInitField[] {
        this.le.expect_('m{')

        const fields = [] as MapInitField[]
        while (!this.le.peek().val_('}')) {
            if (this.le.peek().val_('...')) {
                this.le.expect_('...')
                const expr = this.parseExpr(0, { avoidBrace: false })
                fields.push({ mode: 'spread', expr })
            } else {
                const key = this.parseExpr(0, { avoidBrace: true })
                this.le.expect_(':')
                const val = this.parseExpr(0, { avoidBrace: false })
                fields.push({ mode: 'field', key, val })
            }
            if (!this.le.peek().val_('}')) this.le.expect_(',')
        }

        this.le.expect_('}')

        return fields
    }

    parseSet(): Expr {
        this.le.expect_('s{')
        const items = [] as Expr[]
        while (!this.le.peek().val_('}')) {
            items.push(this.parseExpr(0, null))
            if (!this.le.peek().val_('}')) this.le.expect_(',')
        }
        this.le.expect_('}')
        return { kind: 'SetInit', items }
    }

    parseRecover(): Expr {
        this.le.expect('recover')
        const block = this.pa.parseBlockDecl()
        return { kind: 'Recover', block }
    }

    parseRecord(): Expr {
        this.le.expect_('r{')
        const fields = this.parseStructFields(true)
        return { kind: 'RecordInit', fields }
    }

    parseLock(): Expr {
        this.le.expect('lock')
        const vars = [] as Expr[]
        while (!this.le.peek().val_('{')) {
            vars.push(this.parseExpr(0, { avoidBrace: true }))
            if (!this.le.peek().val_('{')) this.le.expect_(',')
        }
        const block = this.pa.parseBlockDecl()
        return { kind: "Lock", vars, block }
    }

    parseSelect(): Expr {
        this.le.expect('select')
        this.le.expect_('{')
        const arms = [] as SelectArm[]
        while (!this.le.peek().val_('}')) {
            const p1 = this.le.peek()
            const p2 = this.le.peek(1)
            let var_name = undefined as undefined | string
            if (p1.type_('ID') && p2.val_(':')) {
                var_name = this.le.expect('ID').val
                this.le.expect_(':')
            }
            const expr = this.parseExpr(0, null)
            this.le.expect_('=>')
            const block = this.pa.parseBlockDecl({ bracesOptional: true })
            arms.push({ var_name, expr, block })
            if (this.le.peek().val_(',')) this.le.expect_(',')
        }
        this.le.expect_('}')
        return { kind: 'Select', arms }
    }

    parseTuple(): Expr {
        this.le.expect_('t(')
        const items = [] as Expr[]
        while (!this.le.peek().val_(')')) {
            items.push(this.parseExpr(0, null))
            if (!this.le.peek().val_(')')) this.le.expect_(',')
        }
        this.le.expect_(')')
        return { kind: 'TupleInit', items }
    }

}