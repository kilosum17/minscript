// MinScript lexer (spec §1). Hand-written, deterministic, single pass over UTF-8 bytes.
//
// - Newlines are not tokens: each token carries `nl_before` / `ws_before`, and the parser applies
//   the statement rules of spec §5.4.
// - Comments go to a side list (`trivia`).
// - Openers record the index of their matching closer (`match`), and mismatched delimiters are
//   recovered here, so the parser always sees balanced brackets.
// - String interpolation uses a mode stack: `"a${x}b"` lexes as TemplateHead("a"), Ident(x),
//   TemplateTail("b"). Templates are always balanced: an unterminated one gets a zero-width tail.

import type { Diagnostic } from "./diagnostic.ts"
import {
    CLOSER_OF, ENDS_EXPRESSION, KEYWORDS, PUNCTUATORS,
    type Span, type Token, type TokenKind, type Trivia, type TriviaKind,
} from "./token.ts"

export type LexResult = {
    tokens: Token[]         // always ends with an EOF token
    trivia: Trivia[]
    diagnostics: Diagnostic[]
}

export function lex(source: string | Uint8Array): LexResult {
    const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source
    return new Lexer(bytes).run()
}

// ---------------------------------------------------------------------------------------------
// character classes (bytes)

const C = {
    TAB: 0x09, LF: 0x0a, CR: 0x0d, SPACE: 0x20,
    BANG: 0x21, DQUOTE: 0x22, HASH: 0x23, DOLLAR: 0x24, SQUOTE: 0x27,
    LPAREN: 0x28, RPAREN: 0x29, STAR: 0x2a, PLUS: 0x2b, MINUS: 0x2d, DOT: 0x2e, SLASH: 0x2f,
    ZERO: 0x30, NINE: 0x39,
    LBRACKET: 0x5b, BACKSLASH: 0x5c, RBRACKET: 0x5d, UNDERSCORE: 0x5f,
    LBRACE: 0x7b, RBRACE: 0x7d,
} as const

const isDigit = (c: number) => c >= 0x30 && c <= 0x39
const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
const isOct = (c: number) => c >= 0x30 && c <= 0x37
const isBin = (c: number) => c === 0x30 || c === 0x31
const isIdentStart = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === C.UNDERSCORE
const isIdentChar = (c: number) => isIdentStart(c) || isDigit(c)

/** Tokens after which a single letter is a name, never a sigil (spec §1.6). */
const NO_GLUE: ReadonlySet<TokenKind> = new Set<TokenKind>([".", "?.", "fun", "type", "union", "inter"])

/** Punctuators grouped by first byte, longest first (maximal munch). Brackets are handled separately. */
const PUNCT_BY_FIRST: Map<number, string[]> = (() => {
    const map = new Map<number, string[]>()
    for (const p of PUNCTUATORS) {
        if ("()[]{}".includes(p)) continue
        const first = p.charCodeAt(0)
        const list = map.get(first) ?? []
        list.push(p)
        map.set(first, list)
    }
    for (const list of map.values()) list.sort((a, b) => b.length - a.length)
    return map
})()

const utf8 = new TextDecoder("utf-8")

/** Keywords bucketed by (length, first byte), so they're matched on bytes before any string is built. */
const KEYWORD_BUCKETS: Map<number, string[]> = (() => {
    const map = new Map<number, string[]>()
    for (const kw of KEYWORDS) {
        const key = kw.length * 256 + kw.charCodeAt(0)
        const list = map.get(key) ?? []
        list.push(kw)
        map.set(key, list)
    }
    return map
})()

function matchKeyword(s: Uint8Array, start: number, end: number): TokenKind | undefined {
    const bucket = KEYWORD_BUCKETS.get((end - start) * 256 + s[start]!)
    if (bucket === undefined) return undefined
    outer: for (const kw of bucket) {
        for (let i = 1; i < kw.length; i++) {
            if (s[start + i] !== kw.charCodeAt(i)) continue outer
        }
        return kw as TokenKind
    }
    return undefined
}

/** Decodes an ASCII-only byte range (identifiers, numbers) without TextDecoder overhead. */
function ascii(s: Uint8Array, start: number, end: number): string {
    let out = ""
    for (let i = start; i < end; i++) out += String.fromCharCode(s[i]!)
    return out
}

// ---------------------------------------------------------------------------------------------
// string state

/** One source line of a string chunk. `ws` is the raw leading whitespace, kept apart for dedent. */
type Segment = {
    strip: boolean      // starts after a source newline, so indentation may be stripped
    emitNl: boolean     // render a "\n" before it
    ws: string
    text: string        // cooked text after the leading whitespace
    wsMode: boolean     // still collecting leading whitespace
}

type Chunk = { tok: number, segs: Segment[] }

type StringState = {
    span: Span          // span of the opening quote(s), for diagnostics
    multiline: boolean
    chunks: Chunk[]
}

type StackEntry =
    | { kind: "delim", opener: number, closer: ")" | "]" | "}" }
    | { kind: "interp", str: StringState }

// ---------------------------------------------------------------------------------------------

class Lexer {
    private readonly src: Uint8Array
    private pos = 0
    private line = 1
    private lineStart = 0
    private wsBefore = false
    private nlBefore = false
    private readonly tokens: Token[] = []
    private readonly trivia: Trivia[] = []
    private readonly diagnostics: Diagnostic[] = []
    private readonly stack: StackEntry[] = []
    // column cache for the current line
    private colLine = -1
    private colPos = 0
    private colVal = 1

    constructor(src: Uint8Array) {
        this.src = src
    }

    run(): LexResult {
        const s = this.src
        if (s.length >= 3 && s[0] === 0xef && s[1] === 0xbb && s[2] === 0xbf) {
            this.pos = 3
            this.lineStart = 3
        }
        for (;;) {
            this.skipTrivia()
            if (this.pos >= s.length) break
            this.lexToken()
        }
        this.unwindAtEof()
        this.push("EOF", this.pos, this.pos, this.spanAt(this.pos))
        return { tokens: this.tokens, trivia: this.trivia, diagnostics: this.diagnostics }
    }

    // ---- positions and output -----------------------------------------------------------------

    private col(pos: number): number {
        if (this.colLine !== this.lineStart || pos < this.colPos) {
            this.colLine = this.lineStart
            this.colPos = this.lineStart
            this.colVal = 1
        }
        const s = this.src
        for (let i = this.colPos; i < pos; i++) {
            if ((s[i]! & 0xc0) !== 0x80) this.colVal++
        }
        this.colPos = pos
        return this.colVal
    }

    /** Span starting at `pos`, which must be on the current line. `end` is filled in by the caller. */
    private spanAt(pos: number): Span {
        return { start: pos, end: pos, line: this.line, col: this.col(pos) }
    }

    /** Appends a token. Takes ownership of `at` (a fresh span from `spanAt`) as the token's span. */
    private push(kind: TokenKind, start: number, end: number, at: Span, value?: Token["value"]): number {
        at.start = start
        at.end = end
        // every token has the same shape (fast property access in the parser)
        const tok: Token = {
            kind,
            span: at,
            ws_before: this.wsBefore,
            nl_before: this.nlBefore,
            match: undefined,
            value,
            multiline: undefined,
        }
        this.tokens.push(tok)
        this.wsBefore = false
        this.nlBefore = false
        return this.tokens.length - 1
    }

    private error(code: string, message: string, at: Span, end: number): void {
        this.diagnostics.push({ code, message, span: { ...at, end }, severity: "error" })
    }

    private prevKind(): TokenKind | undefined {
        return this.tokens.length > 0 ? this.tokens[this.tokens.length - 1]!.kind : undefined
    }

    /** Consumes a LF or CRLF at `pos`. */
    private consumeNewline(): void {
        if (this.src[this.pos] === C.CR) this.pos++
        this.pos++
        this.line++
        this.lineStart = this.pos
    }

    private atNewline(): boolean {
        const c = this.src[this.pos]
        return c === C.LF || (c === C.CR && this.src[this.pos + 1] === C.LF)
    }

    // ---- trivia -------------------------------------------------------------------------------

    private skipTrivia(): void {
        const s = this.src
        while (this.pos < s.length) {
            const c = s[this.pos]!
            if (c === C.SPACE || c === C.TAB || (c === C.CR && s[this.pos + 1] !== C.LF)) {
                this.pos++
                this.wsBefore = true
            } else if (this.atNewline()) {
                this.endSingleLineInterpolation()
                this.consumeNewline()
                this.wsBefore = true
                this.nlBefore = true
            } else if (c === C.SLASH && s[this.pos + 1] === C.SLASH) {
                this.lineComment()
            } else if (c === C.SLASH && s[this.pos + 1] === C.STAR) {
                this.blockComment()
            } else {
                return
            }
        }
    }

    private lineComment(): void {
        const s = this.src
        const start = this.pos
        const at = this.spanAt(start)
        let end = start
        while (end < s.length && s[end] !== C.LF && !(s[end] === C.CR && s[end + 1] === C.LF)) end++
        const isDoc = s[start + 2] === C.SLASH && s[start + 3] !== C.SLASH
        this.addTrivia(isDoc ? "doc" : "line", start, end, at)
        this.pos = end
        this.wsBefore = true
    }

    private blockComment(): void {
        const s = this.src
        const start = this.pos
        const at = this.spanAt(start)
        this.pos += 2
        let depth = 1
        while (this.pos < s.length && depth > 0) {
            const c = s[this.pos]!
            if (c === C.SLASH && s[this.pos + 1] === C.STAR) {
                depth++
                this.pos += 2
            } else if (c === C.STAR && s[this.pos + 1] === C.SLASH) {
                depth--
                this.pos += 2
            } else if (this.atNewline()) {
                this.consumeNewline()
                this.nlBefore = true
            } else {
                this.pos++
            }
        }
        if (depth > 0) {
            this.error("E_UNTERMINATED_COMMENT", "block comment is never closed (`/*` needs a matching `*/`; block comments nest)", at, start + 2)
        }
        this.addTrivia("block", start, this.pos, at)
        this.wsBefore = true
    }

    private addTrivia(kind: TriviaKind, start: number, end: number, at: Span): void {
        this.trivia.push({ kind, span: { ...at, end }, text: utf8.decode(this.src.subarray(start, end)) })
    }

    // ---- tokens -------------------------------------------------------------------------------

    private lexToken(): void {
        const s = this.src
        const start = this.pos
        const c = s[start]!
        const next = s[start + 1]

        if (isIdentStart(c)) return this.identOrSigil(start)
        if (isDigit(c)) return this.number(start)

        switch (c) {
            case C.DQUOTE: return this.string(start)
            case C.SQUOTE: return this.char(start)
            case C.HASH:
                if (next === C.LBRACE) return this.opener("#{", start, 2)
                if (next === C.LBRACKET) return this.opener("#[", start, 2)
                break
            case C.LPAREN: return this.opener("(", start, 1)
            case C.LBRACKET: return this.opener("[", start, 1)
            case C.LBRACE: return this.opener("{", start, 1)
            case C.RPAREN: return this.closer(")", start)
            case C.RBRACKET: return this.closer("]", start)
            case C.RBRACE: return this.closer("}", start)
            case C.DOT:
                if (next !== undefined && isDigit(next) && !ENDS_EXPRESSION.has(this.prevKind() ?? "EOF")) {
                    return this.leadingDotFloat(start)
                }
                break
        }

        const candidates = PUNCT_BY_FIRST.get(c)
        if (candidates) {
            for (const p of candidates) {
                if (this.startsWith(start, p)) {
                    if (p === ".[") return this.opener(".[", start, 2)
                    this.pos = start + p.length
                    this.push(p as TokenKind, start, this.pos, this.spanAt(start))
                    return
                }
            }
        }
        this.unknownCharacter(start)
    }

    private startsWith(pos: number, text: string): boolean {
        for (let i = 0; i < text.length; i++) {
            if (this.src[pos + i] !== text.charCodeAt(i)) return false
        }
        return true
    }

    private unknownCharacter(start: number): void {
        const at = this.spanAt(start)
        const c = this.src[start]!
        const len = c < 0x80 ? 1 : utf8Length(c)
        const end = Math.min(start + len, this.src.length)
        const text = utf8.decode(this.src.subarray(start, end))
        const hint = c >= 0x80 ? " (identifiers are ASCII; non-ASCII text belongs in strings and comments)" : ""
        this.error("E_UNKNOWN_CHARACTER", `unexpected character \`${text}\`${hint}`, at, end)
        this.pos = end
        this.wsBefore = true
    }

    // ---- identifiers, keywords, sigils --------------------------------------------------------

    private identOrSigil(start: number): void {
        const s = this.src
        let end = start + 1
        while (end < s.length && isIdentChar(s[end]!)) end++
        const at = this.spanAt(start)
        const prev = this.prevKind()

        if (end === start + 1 && !(prev !== undefined && NO_GLUE.has(prev))) {
            const letter = s[start]!
            const glue = s[end]
            if (glue === C.LBRACE && (letter === 0x72 /* r */ || letter === 0x6d /* m */ || letter === 0x73 /* s */ || letter === C.UNDERSCORE)) {
                return this.opener(`${String.fromCharCode(letter)}{` as TokenKind, start, 2)
            }
            if (glue === C.LPAREN && letter === 0x74 /* t */) return this.opener("t(", start, 2)
            if (glue === C.LBRACKET && letter === 0x61 /* a */) return this.opener("a[", start, 2)
            if (glue === C.DQUOTE && letter === 0x72 /* r */) return this.rawString(start)
        }

        this.pos = end
        const member = prev === "." || prev === "?."
        if (!member) {
            if (end === start + 1 && s[start] === C.UNDERSCORE) {
                this.push("_", start, end, at)
                return
            }
            const kw = matchKeyword(s, start, end)
            if (kw !== undefined) {
                this.push(kw, start, end, at)
                return
            }
        }
        this.push("Ident", start, end, at, ascii(s, start, end))
    }

    // ---- delimiters ---------------------------------------------------------------------------

    private opener(kind: TokenKind, start: number, len: number): void {
        const at = this.spanAt(start)
        this.pos = start + len
        const idx = this.push(kind, start, this.pos, at)
        this.stack.push({ kind: "delim", opener: idx, closer: CLOSER_OF[kind]! })
    }

    private closer(ch: ")" | "]" | "}", start: number): void {
        const at = this.spanAt(start)
        const stack = this.stack
        const top = stack[stack.length - 1]

        const matches = (e: StackEntry) => e.kind === "delim" ? e.closer === ch : ch === "}"

        // Look for the opener this closer belongs to. An interpolation is a barrier for `)` and `]`.
        let found = -1
        for (let i = stack.length - 1; i >= 0; i--) {
            const e = stack[i]!
            if (matches(e)) { found = i; break }
            if (e.kind === "interp") break
        }

        if (found >= 0) {
            // close everything opened after it
            while (stack.length - 1 > found) {
                const e = stack.pop()!
                if (e.kind === "delim") this.unclosed(e.opener)
            }
            const e = stack.pop()!
            if (e.kind === "interp") {
                this.stringChunk(e.str, start, at, false, 1)
                return
            }
            this.pos = start + 1
            const idx = this.push(ch, start, this.pos, at)
            this.tokens[e.opener]!.match = idx
            return
        }

        // A stray closer. If a delimiter is open, treat this as its closer (with the expected kind),
        // so the parser sees balanced brackets. Otherwise drop it.
        this.pos = start + 1
        if (top !== undefined && top.kind === "delim") {
            const open = this.tokens[top.opener]!
            this.error("E_UNMATCHED_DELIMITER",
                `expected \`${top.closer}\` to close \`${open.kind}\` at ${open.span.line}:${open.span.col}, found \`${ch}\``, at, this.pos)
            stack.pop()
            const idx = this.push(top.closer, start, this.pos, at)
            open.match = idx
        } else {
            this.error("E_UNMATCHED_DELIMITER", `unexpected \`${ch}\` with nothing open to close`, at, this.pos)
            this.wsBefore = true
        }
    }

    private unclosed(openerIdx: number): void {
        const open = this.tokens[openerIdx]!
        const expected = CLOSER_OF[open.kind]!
        this.error("E_UNMATCHED_DELIMITER", `\`${open.kind}\` is never closed (expected \`${expected}\`)`, open.span, open.span.end)
    }

    private unwindAtEof(): void {
        while (this.stack.length > 0) {
            const e = this.stack.pop()!
            if (e.kind === "delim") {
                this.unclosed(e.opener)
            } else {
                this.error("E_UNTERMINATED_STRING", "string is never closed", e.str.span, e.str.span.end)
                this.syntheticTail(e.str)
            }
        }
    }

    /**
     * Single-line strings stay on one line, interpolations included: a newline inside `"…${…`
     * ends the string with an error and a zero-width TemplateTail.
     */
    private endSingleLineInterpolation(): void {
        let i = this.stack.length - 1
        while (i >= 0 && this.stack[i]!.kind !== "interp") i--
        if (i < 0) return
        const e = this.stack[i] as { kind: "interp", str: StringState }
        if (e.str.multiline) return
        this.stack.length = i
        this.error("E_UNTERMINATED_STRING", "string is never closed (a `\"…\"` string, interpolations included, must end on the line it starts; use `\"\"\"…\"\"\"` for multi-line text)", e.str.span, e.str.span.end)
        this.syntheticTail(e.str)
    }

    private syntheticTail(st: StringState): void {
        const idx = this.push("TemplateTail", this.pos, this.pos, this.spanAt(this.pos), "")
        if (st.multiline) this.tokens[idx]!.multiline = true
        st.chunks.push({ tok: idx, segs: [] })
        this.finishString(st, false)
    }

    // ---- numbers ------------------------------------------------------------------------------

    private number(start: number): void {
        const s = this.src
        const at = this.spanAt(start)
        const prev = this.prevKind()
        let pos = start
        let invalid: string | null = null
        let isFloat = false

        // tuple indexing: after a member `.`, only digits (`t.0.1` is t . 0 . 1)
        if (prev === "." || prev === "?.") {
            while (pos < s.length && isDigit(s[pos]!)) pos++
            this.pos = pos
            const text = ascii(s, start, pos)
            this.push("Int", start, pos, at, BigInt(text))
            return
        }

        const scanRun = (test: (c: number) => boolean): string => {
            const from = pos
            while (pos < s.length && (test(s[pos]!) || s[pos] === C.UNDERSCORE)) pos++
            return ascii(s, from, pos)
        }
        const checkRun = (run: string, what: string) => {
            if (run.length === 0) invalid ??= `${what} has no digits`
            else if (run.startsWith("_") || run.endsWith("_")) invalid ??= "`_` must sit between digits"
        }

        let radixPrefix = ""
        const p1 = s[start + 1]
        if (s[start] === C.ZERO && (p1 === 0x78 /* x */ || p1 === 0x6f /* o */ || p1 === 0x62 /* b */)) {
            radixPrefix = String.fromCharCode(0x30, p1)
            pos = start + 2
            const test = p1 === 0x78 ? isHex : p1 === 0x6f ? isOct : isBin
            const name = p1 === 0x78 ? "hex literal" : p1 === 0x6f ? "octal literal" : "binary literal"
            checkRun(scanRun(test), name)
        } else {
            checkRun(scanRun(isDigit), "number")
            // fraction: `.` belongs to the number only when a digit follows
            if (s[pos] === C.DOT && pos + 1 < s.length && isDigit(s[pos + 1]!)) {
                isFloat = true
                pos++
                checkRun(scanRun(isDigit), "fraction")
            }
            // exponent: e9, e-3, E+23
            const e = s[pos]
            if (e === 0x65 || e === 0x45) {
                const sign = s[pos + 1]
                const digitAt = sign === C.PLUS || sign === C.MINUS ? pos + 2 : pos + 1
                if (digitAt < s.length && isDigit(s[digitAt]!)) {
                    isFloat = true
                    pos = digitAt
                    checkRun(scanRun(isDigit), "exponent")
                }
            }
        }

        // anything identifier-like glued to the number makes it invalid: `0b102`, `12px`, `1e`
        if (pos < s.length && isIdentChar(s[pos]!)) {
            const from = pos
            while (pos < s.length && isIdentChar(s[pos]!)) pos++
            const tail = utf8.decode(s.subarray(from, pos))
            invalid ??= radixPrefix
                ? `invalid digit or suffix \`${tail}\` in a ${radixPrefix} literal`
                : `invalid suffix \`${tail}\` (numbers have no suffixes; use \`x as T\`)`
        }

        this.pos = pos
        const text = ascii(s, start, pos).replaceAll("_", "")
        if (invalid !== null) {
            this.error("E_INVALID_NUMBER", `invalid number literal: ${invalid}`, at, pos)
            if (isFloat) this.push("Float", start, pos, at, 0)
            else this.push("Int", start, pos, at, 0n)
            return
        }
        if (isFloat) this.push("Float", start, pos, at, Number(text))
        else this.push("Int", start, pos, at, BigInt(text))
    }

    /** `.5`: not valid MinScript, lexed as a Float for recovery. */
    private leadingDotFloat(start: number): void {
        const s = this.src
        const at = this.spanAt(start)
        let pos = start + 1
        while (pos < s.length && (isDigit(s[pos]!) || s[pos] === C.UNDERSCORE)) pos++
        this.pos = pos
        const text = "0" + utf8.decode(s.subarray(start, pos)).replaceAll("_", "")
        this.error("E_INVALID_NUMBER", `a float needs a digit before the \`.\`: write \`${text}\``, at, pos)
        this.push("Float", start, pos, at, Number(text))
    }

    // ---- escapes ------------------------------------------------------------------------------

    /** Reads an escape at `pos` (on the backslash). Returns the cooked text, or the raw char on error. */
    private escape(): string {
        const s = this.src
        const start = this.pos
        const e = s[start + 1]
        const simple: Record<number, string> = {
            0x6e: "\n", 0x72: "\r", 0x74: "\t", 0x30: "\0",
            0x5c: "\\", 0x22: "\"", 0x27: "'", 0x24: "$",
        }
        if (e !== undefined && simple[e] !== undefined) {
            this.pos = start + 2
            return simple[e]!
        }
        if (e === 0x78 /* x */) {
            const h1 = s[start + 2], h2 = s[start + 3]
            if (h1 !== undefined && h2 !== undefined && isHex(h1) && isHex(h2)) {
                const v = parseInt(String.fromCharCode(h1, h2), 16)
                this.pos = start + 4
                if (v > 0x7f) {
                    this.error("E_INVALID_ESCAPE", `\`\\x\` escapes are ASCII only (00–7F); use \`\\u{${v.toString(16).toUpperCase()}}\``, this.spanAt(start), this.pos)
                    return "�"
                }
                return String.fromCharCode(v)
            }
            this.pos = start + 2
            this.error("E_INVALID_ESCAPE", "`\\x` needs exactly two hex digits", this.spanAt(start), this.pos)
            return "�"
        }
        if (e === 0x75 /* u */) {
            if (s[start + 2] === C.LBRACE) {
                let p = start + 3
                while (p < s.length && isHex(s[p]!) && p - (start + 3) < 7) p++
                const digits = utf8.decode(s.subarray(start + 3, p))
                if (s[p] === C.RBRACE && digits.length >= 1 && digits.length <= 6) {
                    const v = parseInt(digits, 16)
                    this.pos = p + 1
                    if (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) {
                        this.error("E_INVALID_ESCAPE", `\`\\u{${digits}}\` is not a Unicode scalar value`, this.spanAt(start), this.pos)
                        return "�"
                    }
                    return String.fromCodePoint(v)
                }
            }
            this.pos = start + 2
            this.error("E_INVALID_ESCAPE", "`\\u` must be written `\\u{…}` with 1–6 hex digits", this.spanAt(start), this.pos)
            return "�"
        }
        // unknown escape: keep the character literally
        if (e === undefined || e === C.LF || e === C.CR) {
            this.pos = start + 1
            this.error("E_INVALID_ESCAPE", "`\\` at the end of a line", this.spanAt(start), this.pos)
            return ""
        }
        const len = e < 0x80 ? 1 : utf8Length(e)
        this.pos = Math.min(start + 1 + len, s.length)
        const ch = utf8.decode(s.subarray(start + 1, this.pos))
        this.error("E_INVALID_ESCAPE", `unknown escape \`\\${ch}\` (valid: \\n \\r \\t \\0 \\\\ \\" \\' \\$ \\xNN \\u{…})`, this.spanAt(start), this.pos)
        return ch
    }

    // ---- strings ------------------------------------------------------------------------------

    private string(start: number): void {
        const s = this.src
        const multiline = s[start + 1] === C.DQUOTE && s[start + 2] === C.DQUOTE
        const at = this.spanAt(start)
        const quoteLen = multiline ? 3 : 1
        const st: StringState = { span: { ...at, end: start + quoteLen }, multiline, chunks: [] }
        this.stringChunk(st, start, at, true, quoteLen)
    }

    /**
     * Lexes one chunk of a string: from its opening (the quote(s), or the `}` that ends an
     * interpolation) up to `${`, the closing quote(s), or an error.
     */
    private stringChunk(st: StringState, start: number, at: Span, first: boolean, openLen: number): void {
        const s = this.src
        this.pos = start + openLen
        const segs: Segment[] = [{ strip: false, emitNl: false, ws: "", text: "", wsMode: true }]
        let seg = segs[0]!

        const emit = (kind: TokenKind): number => {
            const idx = this.push(kind, start, this.pos, at)
            if (st.multiline) this.tokens[idx]!.multiline = true
            st.chunks.push({ tok: idx, segs })
            return idx
        }

        for (;;) {
            if (this.pos >= s.length) {
                this.error("E_UNTERMINATED_STRING", "string is never closed", st.span, st.span.end)
                emit(first ? "String" : "TemplateTail")
                this.finishString(st, false)
                return
            }
            const c = s[this.pos]!

            if (c === C.DQUOTE) {
                if (!st.multiline) {
                    this.pos++
                    emit(first ? "String" : "TemplateTail")
                    this.finishString(st, true)
                    return
                }
                if (s[this.pos + 1] === C.DQUOTE && s[this.pos + 2] === C.DQUOTE) {
                    this.pos += 3
                    emit(first ? "String" : "TemplateTail")
                    this.finishString(st, true)
                    return
                }
                this.pos++
                seg.wsMode = false
                seg.text += "\""
                continue
            }

            if (c === C.DOLLAR && s[this.pos + 1] === C.LBRACE) {
                this.pos += 2
                emit(first ? "TemplateHead" : "TemplateMiddle")
                this.stack.push({ kind: "interp", str: st })
                return
            }

            if (c === C.BACKSLASH) {
                seg.wsMode = false
                seg.text += this.escape()
                continue
            }

            if (this.atNewline()) {
                if (!st.multiline) {
                    this.error("E_UNTERMINATED_STRING", "string is never closed (a `\"…\"` string must end on the line it starts; use `\"\"\"…\"\"\"` for multi-line text)", st.span, this.pos)
                    emit(first ? "String" : "TemplateTail")
                    this.finishString(st, false)
                    return
                }
                this.consumeNewline()
                seg = { strip: true, emitNl: true, ws: "", text: "", wsMode: true }
                segs.push(seg)
                continue
            }

            if (seg.wsMode && (c === C.SPACE || c === C.TAB)) {
                seg.ws += c === C.SPACE ? " " : "\t"
                this.pos++
                continue
            }

            // a run of literal bytes
            seg.wsMode = false
            const from = this.pos
            while (this.pos < s.length) {
                const d = s[this.pos]!
                if (d === C.DQUOTE || d === C.BACKSLASH || d === C.LF || d === C.CR) break
                if (d === C.DOLLAR && s[this.pos + 1] === C.LBRACE) break
                this.pos++
            }
            if (this.pos === from) {
                // a lone CR (not part of CRLF)
                this.pos++
                seg.text += "\r"
            } else {
                seg.text += utf8.decode(s.subarray(from, this.pos))
            }
        }
    }

    /** Computes the cooked value of every chunk once the string has ended (dedent for `"""`). */
    private finishString(st: StringState, closed: boolean): void {
        if (st.multiline) dedent(st, closed)
        for (const ch of st.chunks) {
            let out = ""
            for (const seg of ch.segs) {
                if (seg.emitNl) out += "\n"
                out += seg.ws + seg.text
            }
            this.tokens[ch.tok]!.value = out
        }
    }

    private rawString(start: number): void {
        const s = this.src
        const at = this.spanAt(start)
        this.pos = start + 2
        const from = this.pos
        while (this.pos < s.length && s[this.pos] !== C.DQUOTE) {
            if (this.atNewline()) this.consumeNewline()
            else this.pos++
        }
        const body = utf8.decode(s.subarray(from, this.pos)).replaceAll("\r\n", "\n")
        if (this.pos >= s.length) {
            this.error("E_UNTERMINATED_STRING", "raw string is never closed (raw strings can't contain `\"`)", at, start + 2)
        } else {
            this.pos++
        }
        this.push("RawString", start, this.pos, at, body)
    }

    // ---- characters ---------------------------------------------------------------------------

    private char(start: number): void {
        const s = this.src
        const at = this.spanAt(start)

        // removed tagged records: '1{ … }
        if (start + 1 < s.length && isDigit(s[start + 1]!)) {
            let j = start + 1
            while (j < s.length && isDigit(s[j]!)) j++
            if (s[j] === C.LBRACE) {
                this.error("E_TAGGED_RECORD_REMOVED", "tagged records were removed: write `r{ … }`", at, j + 1)
                this.pos = j + 1
                const idx = this.push("r{", start, this.pos, at)
                this.stack.push({ kind: "delim", opener: idx, closer: "}" })
                return
            }
        }

        this.pos = start + 1
        const c = s[this.pos]
        if (c === C.SQUOTE) {
            this.pos++
            this.error("E_INVALID_CHAR", "empty character literal", at, this.pos)
            this.push("Char", start, this.pos, at, "")
            return
        }
        if (c === undefined || this.atNewline()) {
            this.error("E_INVALID_CHAR", "character literal is never closed", at, this.pos)
            this.push("Char", start, this.pos, at, "")
            return
        }

        let value: string
        if (c === C.BACKSLASH) {
            value = this.escape()
        } else {
            const len = c < 0x80 ? 1 : utf8Length(c)
            const end = Math.min(this.pos + len, s.length)
            value = utf8.decode(s.subarray(this.pos, end))
            this.pos = end
        }

        if (s[this.pos] === C.SQUOTE) {
            this.pos++
            this.push("Char", start, this.pos, at, value)
            return
        }

        // 'ab': look a short way ahead for the closing quote, without crossing whitespace
        let k = this.pos
        while (k < s.length && k - this.pos < 32) {
            const d = s[k]!
            if (d === C.SQUOTE || d === C.SPACE || d === C.TAB || d === C.LF || d === C.CR) break
            k++
        }
        if (s[k] === C.SQUOTE) {
            this.pos = k + 1
            this.error("E_INVALID_CHAR", "a character literal holds exactly one character; use a string (`\"…\"`) for text", at, this.pos)
        } else {
            this.error("E_INVALID_CHAR", "character literal is never closed", at, this.pos)
        }
        this.push("Char", start, this.pos, at, value)
    }
}

// ---------------------------------------------------------------------------------------------

function utf8Length(lead: number): number {
    if (lead >= 0xf0) return 4
    if (lead >= 0xe0) return 3
    if (lead >= 0xc0) return 2
    return 1
}

/**
 * `"""` rules (spec §1.5):
 * - a first line that is empty (only whitespace after the opening quotes) is dropped;
 * - if the closing quotes sit on a line of their own, that line's whitespace is the indentation
 *   stripped from every line, and the line itself is dropped.
 * Lines indented less than the closing line lose only the whitespace they share with it.
 */
function dedent(st: StringState, closed: boolean): void {
    const chunks = st.chunks
    if (chunks.length === 0) return

    const firstSegs = chunks[0]!.segs
    if (firstSegs.length > 1 && firstSegs[0]!.text === "") {
        firstSegs.shift()
        firstSegs[0]!.emitNl = false
    }

    let indent = ""
    const lastSegs = chunks[chunks.length - 1]!.segs
    const last = lastSegs[lastSegs.length - 1]
    if (closed && last !== undefined && last.strip && last.text === "") {
        indent = last.ws
        lastSegs.pop()
    }

    for (const ch of chunks) {
        for (const seg of ch.segs) {
            if (!seg.strip) continue
            if (seg.ws.startsWith(indent)) {
                seg.ws = seg.ws.slice(indent.length)
            } else if (seg.text === "") {
                seg.ws = ""
            } else {
                let i = 0
                while (i < seg.ws.length && i < indent.length && seg.ws[i] === indent[i]) i++
                seg.ws = seg.ws.slice(i)
            }
        }
    }
}
