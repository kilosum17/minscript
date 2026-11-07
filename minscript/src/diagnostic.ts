import type { Span } from "./token.ts"

export type Severity = "error" | "warning"

export type Diagnostic = {
    code: string        // e.g. "E_UNTERMINATED_STRING" (spec §11)
    message: string
    span: Span
    severity: Severity
}

/** Codes the lexer can report (spec §11, "Lexer and parser diagnostics"). */
export const LEXER_CODES: ReadonlySet<string> = new Set([
    "E_UNTERMINATED_STRING",
    "E_UNTERMINATED_COMMENT",
    "E_INVALID_ESCAPE",
    "E_INVALID_NUMBER",
    "E_INVALID_CHAR",
    "E_UNMATCHED_DELIMITER",
    "E_TAGGED_RECORD_REMOVED",
    "E_UNKNOWN_CHARACTER",
])
