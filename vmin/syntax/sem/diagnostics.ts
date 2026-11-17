import type { AstSpan } from "../parser/ast_types"

const codes = [
    'NOT_VALID_IN_TOP_LEVEL', 'BREAK_OUTSIDE_LOOP', 'CONTINUE_OUTSIDE_LOOP',
    'PUB_ONLY_TOP_LEVEL', 'THIS_MUST_COME_FIRST', 'THIS_ONLY_IN_METHODS'
] as const

export type DiagnosticCode = typeof codes[number]

export class Diagnostic {

    constructor(
        public code: DiagnosticCode,
        public span: AstSpan,
        public info: string,
    ) {

    }

    severity(): 'error' | 'lint' {
        return 'lint'
    }
    message() {
        return `Error: ${this.code}`
    }
}