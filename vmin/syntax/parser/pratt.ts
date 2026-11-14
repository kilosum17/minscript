import type { Lexer } from "../lexer/lexer";
import type { Token } from "../lexer/lexer_types";
import type { Expr } from "./ast_types";
import type { Parser } from "./parser";

export class Pratt {

    constructor(
        private pa: Parser,
        private le: Lexer
    ) {

    }

    parserExp(minBp: number): Expr {
        let left = this.parseNull()
        let next = this.getBp(this.le.peek().val)
        while (next && minBp < next.lbp) {
            const tok = this.le.next()
            left = this.parserInfixExp(tok, next.rbp, left)
            next = this.getBp(this.le.peek().val)
        }
        return left
    }

    getBp(oper: string) {
        if (oper == '+' || oper == '-') return { lbp: 10, rbp: 10 }
        if (oper == '*' || oper == '/') return { lbp: 40, rbp: 40 }

        if (oper == '.') return { lbp: 60, rbp: 0 }
        return null
    }

    parseNull(): Expr {
        this.pa.saveStart()
        const n1 = this.le.next()
        if (n1.type_('ID')) {
            return { kind: 'Var', name: n1.val, span: this.pa.getSpan() }
        }
        throw new Error('Unkowr NULL-EXP')
    }

    parserInfixExp(tok: Token, minBp: number, lhs: Expr): Expr {
        const oper = tok.symb()
        const binary = ['+', '-', '*', '/', '.']
        if (binary.includes(oper)) {
            const rhs = this.parserExp(minBp)
            return { kind: 'Binary', oper, lhs, rhs }
        }
        throw new Error(`UNKOWn infix operator: ${oper}, ${this.le.info()}`)
    }

}