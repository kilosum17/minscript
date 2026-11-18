import type { Lexer } from "../lexer/lexer";
import { Diagnostic } from "../utils/diagnostics";
import type { Parser } from "./parser";

export class Recover {
    msg: string = ''

    constructor(
        public pa: Parser,
        public lex: Lexer,
    ) {

    }

    rec<T>(safePoints: string[], def: T | 0, fn: () => T): T | 0 {
        if (safePoints.length == 0) throw new Error('No safepoints')
        let closure = safePoints.find(s => ['}', ')'].includes(s)) || ''
        const openner = {
            '}': '{',
            ')': '('
        }[closure]

        try {
            return fn()
        } catch (e) {
            console.warn(e)
            const message = Error.isError(e) ? e.message : ''
            const isExpect = message.startsWith('Expected')
            if (isExpect) {
                const p1 = this.lex.peek()
                // const expected = message.split('--')[1]
                this.msg = message
                this.pa.diags.push(new Diagnostic(
                    'EXPECTED',
                    p1.span,
                    this.msg
                ))
            }

            const hasNl = safePoints.includes('\n')
            let depth = 0
            let skips = 0
            while (!this.lex.peek().type_('EOF')) {
                const p1 = this.lex.peek()
                if (hasNl && p1.nl_before) {
                    break
                }
                if (p1.val.includes(closure)) {
                    if (depth == 0) {
                        this.lex.next()
                        break
                    } else {
                        depth--
                    }
                }
                if (p1.val.includes(openner!)) {
                    depth++
                }
                this.lex.next()
                skips++
            }

            if (this.lex.peek().type_('EOF')) console.warn(`Skip to end ${skips}`)
            else console.log(`Skips: ${skips}`)
            return def
        }
    }

}