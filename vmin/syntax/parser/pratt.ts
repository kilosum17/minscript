import type { Lexer } from "../lexer/lexer";
import type { Token } from "../lexer/lexer_types";
import type { BlockDecl, Expr, MatchArm, StmtDecl } from "./ast_types";
import type { Parser } from "./parser";

export class Pratt {

    constructor(
        private pa: Parser,
        private le: Lexer
    ) {

    }

    parseExpr(minBp: number): Expr {
        let left = this.parseNull()
        let next = this.getBp(this.le.peek().val)
        while (next && minBp < next.lbp) {
            const tok = this.le.next()
            left = this.parserInfixExp(tok, next.rbp, left)
            next = this.getBp(this.le.peek().val)
        }
        return left
    }

    private conds = new Set(['>', '<', '>=', '<=', '==', '!=',])
    getBp(oper: string) {
        if (this.conds.has(oper)) return { lbp: 5, rbp: 5 }
        if (oper == '+' || oper == '-') return { lbp: 10, rbp: 10 }
        if (oper == '*' || oper == '/') return { lbp: 40, rbp: 40 }
        if (oper == '.') return { lbp: 60, rbp: 60 }
        if (oper == '(') return { lbp: 80, rbp: 80 }
        return null
    }

    parseNull(): Expr {
        this.pa.saveStart()
        const p1 = this.le.peek()
        console.log('p1', p1.kwd(), p1.type)
        if (p1.kwd_('match')) {
            return this.parseMatchExpr()
        }
        if (p1.kwd_('if')) {
            return this.parseIfExpr()
        }
        if (p1.type_('STR_START')) {
            return this.parseString()
        }
        if (p1.type_('ID')) {
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
        '+', '-', '*', '/',
        '>', '<', '>=', '<=', '==', '!=',
    ])
    parserInfixExp(tok: Token, minBp: number, lhs: Expr): Expr {
        this.pa.saveStart()
        const oper = tok.symb()
        if (this.bins.has(oper)) {
            const rhs = this.parseExpr(minBp)
            return { kind: 'Binary', oper, lhs, rhs, span: this.pa.getSpan() }
        }
        if (oper == '.') {
            let next = this.le.next()
            let rhs: Expr
            if (next.type_('ID')) {
                rhs = { kind: 'Var', name: next.val, span: this.pa.getSpan() }
            } else if (next.type_('NUM')) {
                rhs = { kind: 'Literal', val: next.val, span: this.pa.getSpan() }
            } else {
                throw new Error(`Unexpected member value ${this.le.info()}`)
            }
            return { kind: 'Member', lhs, rhs, span: this.pa.getSpan() }
        }
        if (oper == '(') {
            return this.parseFuncCall(lhs, true)
        }
        throw new Error(`UNKOWn infix operator: ${oper}, ${this.le.info()}`)
    }

    parseMatchExpr(): Expr {
        this.le.expect('match')
        let cond = undefined as undefined | Expr
        if (!this.le.peek().val_('{')) {
            cond = this.parseExpr(0)
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
                const block = this.pa.parseBlockDecl(true)
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
                const block = this.pa.parseBlockDecl(true)
                arms.push({ mode: 'Tuple', name, fields, block })
            } else if (p1.type_('ID') && p2.val_('=>')) {
                const name = this.le.expect('ID').val
                this.le.expect_('=>')
                const block = this.pa.parseBlockDecl(true)
                arms.push({ mode: 'Bare', name, block })
            } else if (p1.type_('NUM') && p2.val_('=>')) {
                const val = this.le.expect('NUM').val
                this.le.expect_('=>')
                const block = this.pa.parseBlockDecl(true)
                arms.push({ mode: 'Literal', val, block })
            } else if ((p2.val_('..') || p2.val_('..=')) && p4.val_('=>')) {
                const start = this.parseExpr(0)
                const oper = this.le.next().val
                const end = this.parseExpr(0)
                this.le.expect_('=>')
                const block = this.pa.parseBlockDecl(true)
                arms.push({ mode: 'Range', oper, start, end, block })
            } else if (p1.type_('ID') && p2.kwd_('if')) {
                const var_name = this.le.expect('ID').val
                this.le.expect('if')
                const cond = this.parseExpr(0)
                this.le.expect_('=>')
                const block = this.pa.parseBlockDecl(true)
                arms.push({ mode: 'IfCond', var_name, cond, block })
            } else {
                console.log('arms', arms)
                throw new Error('Unkowm match arm')
            }
        }
        this.le.expect_('}')
        return { kind: 'Match', cond, arms }
    }

    parseIfExpr(): Expr {
        this.le.expect('if')
        const cond = this.parseExpr(0)
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
        return { kind: 'If', cond, then, else: else_ }
    }

    parseFuncCall(lhs: Expr, skip_bracket = false): Expr {
        if (!skip_bracket) this.le.expect_('(')
        const args = [] as Expr[]
        while (!this.le.peek().val_(')')) {
            args.push(this.parseExpr(0))
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
                const exp = this.parseExpr(0)
                parts.push(exp)
                this.le.expect('STR_EXP_CLOSE')
            } else {
                new Error(`Unkown string part ${this.le.info()}`)
            }
        }
        this.le.expect_('STR_END')
        return { kind: 'String', parts }
    }
}