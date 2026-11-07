// MinScript parser (spec §2–§8, §12). Recursive descent for items, statements, types and patterns;
// Pratt parsing for expressions (precedence: spec §3).
//
// Newlines are not tokens. The rules of spec §5.4 are applied with each token's `nl_before`:
// - `nlSig` is true inside `{…}` and false inside `(…)` / `[…]`. Where it is true, an infix
//   operator on a new line ends the expression, except the continuation tokens in CONTINUE.
// - postfix `(`, `[`, `.[` and `?` never cross a newline; `.` and `?.` always may.
//
// Error handling: `fail()` reports one diagnostic and throws `Sync`, which is caught at the nearest
// statement / item / member / arm boundary, where the parser skips to the next one. `report()`
// records a diagnostic and keeps going: it is used where the intended form is clear (`Vec<int>`,
// `(a) => a`, `let x := 1`, `while`), so each mistake produces exactly one diagnostic.

import type * as A from "./ast.ts"
import type { Diagnostic } from "./diagnostic.ts"
import { lex, type LexResult } from "./lexer.ts"
import { isKeyword, RESERVED_KEYWORDS, type Span, type Token, type TokenKind } from "./token.ts"

export type ParseResult = {
    file: A.File
    diagnostics: Diagnostic[]   // lexer diagnostics first, then parser diagnostics
    lex: LexResult
}

export function parse(source: string | Uint8Array): ParseResult {
    const lexed = lex(source)
    const parser = new Parser(lexed.tokens)
    const file = parser.parseFile()
    return { file, diagnostics: [...lexed.diagnostics, ...parser.diagnostics], lex: lexed }
}

/** Thrown by `fail()` after reporting; caught at a recovery boundary. */
class Sync {
    readonly at: number
    constructor(at: number) { this.at = at }
}

// ---------------------------------------------------------------------------------------------

type Assoc = "left" | "right" | "none"

/** Infix binding powers (higher binds tighter), from spec §3. */
const INFIX: Readonly<Record<string, readonly [number, Assoc]>> = {
    "=": [1, "right"], "+=": [1, "right"], "-=": [1, "right"], "*=": [1, "right"], "/=": [1, "right"],
    "%=": [1, "right"], "&=": [1, "right"], "|=": [1, "right"], "^=": [1, "right"], "<<=": [1, "right"],
    ">>=": [1, "right"], "??=": [1, "right"],
    "or": [2, "left"],
    "..": [4, "none"], "..=": [4, "none"],
    "??": [5, "right"],
    "||": [6, "left"],
    "&&": [7, "left"],
    "==": [8, "none"], "!=": [8, "none"], "<": [8, "none"], "<=": [8, "none"], ">": [8, "none"], ">=": [8, "none"],
    "|": [9, "left"],
    "^": [10, "left"],
    "&": [11, "left"],
    "<<": [12, "left"], ">>": [12, "left"],
    "+": [13, "left"], "-": [13, "left"],
    "*": [14, "left"], "/": [14, "left"], "%": [14, "left"],
    "as": [15, "left"],
}
const BP_RANGE_OPERAND = 5
const BP_OR_RHS = 3

const ASSIGN_OPS: ReadonlySet<string> = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "??="])
const COMPARISON_OPS: ReadonlySet<string> = new Set(["==", "!=", "<", "<=", ">", ">="])

/** An infix/postfix token on a new line continues the expression only if it is one of these (§5.4 rule 2). */
const CONTINUE: ReadonlySet<TokenKind> = new Set<TokenKind>([".", "?.", "&&", "||", "??", "or", "as"])

/** Tokens that may start an expression. */
const EXPR_START: ReadonlySet<TokenKind> = new Set<TokenKind>([
    "Ident", "_", "Int", "Float", "String", "RawString", "Char", "TemplateHead",
    "true", "false", "nil", "this", "Self",
    "(", "[", "{", "a[", "t(", "r{", "m{", "s{", "_{", "#{", "#[",
    "-", "!", "&", "*", "~", "--", "++", "..", "..=",
    "await", "if", "match", "for", "select", "unsafe", "recover", "return", "break", "continue",
    "fun", "while", "loop",
])

const TYPE_START: ReadonlySet<TokenKind> = new Set<TokenKind>([
    "Ident", "Self", "&", "*", "t(", "r{", "(", "TypeOf", "String", "Int", "true", "false",
])

const ITEM_START: ReadonlySet<TokenKind> = new Set<TokenKind>([
    "pub", "fun", "async", "type", "union", "inter", "impl", "let", "var", "extern", "import", "@",
])

const PATTERN_LITERAL: ReadonlySet<TokenKind> = new Set<TokenKind>(["Int", "Float", "String", "RawString", "Char", "true", "false", "nil"])

/** Tokens allowed in a closure parameter header, besides skipped bracket groups (spec §4.4). */
const HEADER_TOKENS: ReadonlySet<TokenKind> = new Set<TokenKind>(["Ident", "_", "mut", ",", ":", "&", "->", "?", ".", "Self", "*"])
const HEADER_GROUPS: ReadonlySet<TokenKind> = new Set<TokenKind>(["(", "[", "t(", "r{", "a["])

const IMPLICIT_PARAM = /^it(?:[1-9][0-9]*)?$/

function isUpper(name: string): boolean {
    const c = name.charCodeAt(0)
    return c >= 0x41 && c <= 0x5a
}

function describe(tok: Token): string {
    switch (tok.kind) {
        case "EOF": return "end of file"
        case "Ident": return `identifier \`${String(tok.value)}\``
        case "Int": case "Float": return `number \`${String(tok.value)}\``
        case "String": case "RawString": case "TemplateHead": return "a string"
        case "Char": return "a character"
        default: return `\`${tok.kind}\``
    }
}

// ---------------------------------------------------------------------------------------------

class Parser {
    readonly diagnostics: Diagnostic[] = []
    private readonly t: Token[]
    private i = 0
    private prevEnd = 0
    private nlSig = true            // newlines end expressions (inside `{…}`)
    private noStruct = false        // in an if/for/match header: `Name {` is not a struct literal
    private gtPending = false       // half of a `>>` already consumed by a nested `<…>` (E_ANGLE_GENERICS recovery)
    private angleDepth = 0
    private labels: string[] = []
    private closures: boolean[] = []   // stack: does the enclosing closure have a parameter header?

    constructor(tokens: Token[]) {
        this.t = tokens
    }

    // ---- token helpers ------------------------------------------------------------------------

    private get cur(): Token { return this.t[this.i]! }
    private peek(k = 1): Token { return this.t[Math.min(this.i + k, this.t.length - 1)]! }
    private at(kind: TokenKind): boolean { return this.t[this.i]!.kind === kind }

    private advance(): Token {
        const tok = this.t[this.i]!
        if (tok.kind !== "EOF") this.i++
        this.prevEnd = tok.span.end
        return tok
    }

    private eat(kind: TokenKind): Token | null {
        return this.at(kind) ? this.advance() : null
    }

    private expect(kind: TokenKind, what?: string): Token {
        if (this.at(kind)) return this.advance()
        return this.fail("E_UNEXPECTED_TOKEN", `expected ${what ?? `\`${kind}\``}, found ${describe(this.cur)}`)
    }

    private jumpTo(index: number): void {
        this.i = Math.min(index, this.t.length - 1)
        this.prevEnd = this.i > 0 ? this.t[this.i - 1]!.span.end : 0
    }

    /** Span from `start` to the end of the last consumed token. */
    private sp(start: Token | Span): Span {
        const s = "span" in start ? start.span : start
        return { start: s.start, end: Math.max(this.prevEnd, s.start), line: s.line, col: s.col }
    }

    private closerIndex(opener: Token): number {
        return opener.match ?? this.t.length - 1
    }

    // ---- diagnostics --------------------------------------------------------------------------

    private report(code: string, message: string, at: Token | Span = this.cur): void {
        const s = "span" in at ? at.span : at
        this.diagnostics.push({ code, message, span: { ...s }, severity: "error" })
    }

    /** E_OPEN_BRACE_NEWLINE, reported at the end of the header (the line the `{` belongs on). */
    private reportBraceNewline(message: string): void {
        this.report("E_OPEN_BRACE_NEWLINE", message, this.t[Math.max(this.i - 1, 0)]!)
    }

    private fail(code: string, message: string, at: Token | Span = this.cur): never {
        this.report(code, message, at)
        throw new Sync(this.i)
    }

    /** Runs `fn` with the newline/struct context of a bracket group, restoring it afterwards. */
    private group<T>(nlSig: boolean, fn: () => T): T {
        const saved = [this.nlSig, this.noStruct] as const
        this.nlSig = nlSig
        this.noStruct = false
        try {
            return fn()
        } finally {
            this.nlSig = saved[0]
            this.noStruct = saved[1]
        }
    }

    /**
     * After a `Sync` at `errAt`, skips from `start` at the same bracket depth to the next boundary:
     * a token on a new line (or one for which `stop` is true) at or after the error, past `;`, or
     * `end` (the container's closer).
     */
    private syncFrom(start: number, end: number, errAt: number, stop?: (tok: Token) => boolean): void {
        let k = start
        while (k < end) {
            const tok = this.t[k]!
            if (k >= errAt && k > start && (tok.nl_before || (stop?.(tok) ?? false))) break
            if (tok.kind === ";" && k >= errAt) { k++; break }
            k = tok.match !== undefined && tok.match > k ? tok.match + 1 : k + 1
        }
        this.jumpTo(Math.min(k, end))
    }

    // ---- file and items -----------------------------------------------------------------------

    parseFile(): A.File {
        const start = this.cur
        let pkg: string[] = []
        if (this.at("package")) {
            this.advance()
            try {
                pkg = this.dottedName("package name")
            } catch (e) {
                if (!(e instanceof Sync)) throw e
            }
        } else {
            this.report("E_UNEXPECTED_TOKEN", `expected \`package\` at the start of the file, found ${describe(this.cur)}`)
        }

        const imports: A.Import[] = []
        const items: A.Item[] = []
        const eof = this.t.length - 1
        while (!this.at("EOF")) {
            const itemStart = this.i
            try {
                if (this.at(";")) { this.advance(); continue }
                if (this.at("import")) {
                    const tok = this.cur
                    const imp = this.parseImport()
                    if (items.length > 0) this.report("E_IMPORT_AFTER_ITEM", "imports must come before the first item", tok)
                    imports.push(imp)
                } else {
                    const item = this.parseItem()
                    if (item === null) continue
                    items.push(item)
                }
                if (!this.at("EOF") && !this.at(";") && !this.cur.nl_before) {
                    this.fail("E_UNEXPECTED_TOKEN", `expected a newline after the declaration, found ${describe(this.cur)}`)
                }
            } catch (e) {
                if (!(e instanceof Sync)) throw e
                this.syncFrom(itemStart, eof, e.at, (tok) => ITEM_START.has(tok.kind))
                this.syncToItemStart()
            }
        }
        return { kind: "File", span: this.sp(start), package: pkg, imports, items }
    }

    /** From a newline boundary, keep skipping lines until one starts with an item keyword. */
    private syncToItemStart(): void {
        while (!this.at("EOF") && !(ITEM_START.has(this.cur.kind) && this.cur.nl_before)) {
            const tok = this.cur
            this.jumpTo(tok.match !== undefined && tok.match > this.i ? tok.match + 1 : this.i + 1)
        }
    }

    private dottedName(what: string): string[] {
        const parts = [this.identName(what)]
        while (this.at(".") && this.peek().kind === "Ident") {
            this.advance()
            parts.push(this.identName(what))
        }
        return parts
    }

    /** An identifier; a keyword in its place is reported (E_KEYWORD_AS_IDENT) and accepted. */
    private identName(what: string): string {
        const tok = this.cur
        if (tok.kind === "Ident") {
            this.advance()
            return tok.value as string
        }
        if (isKeyword(tok.kind)) {
            this.report("E_KEYWORD_AS_IDENT", `\`${tok.kind}\` is a keyword and can't be used as ${what}`)
            this.advance()
            return tok.kind
        }
        return this.fail("E_UNEXPECTED_TOKEN", `expected ${what}, found ${describe(tok)}`)
    }

    private parseImport(): A.Import {
        const start = this.advance()
        const pub = this.eat("pub") !== null
        const pathTok = this.cur
        if (pathTok.kind !== "String" && pathTok.kind !== "RawString") {
            this.fail("E_UNEXPECTED_TOKEN", `expected an import path string, found ${describe(pathTok)}`)
        }
        this.advance()
        let alias: string | null = null
        if (this.eat("as")) alias = this.identName("an import alias")
        return { kind: "Import", span: this.sp(start), path: pathTok.value as string, pub, alias }
    }

    private skipAttribute(): void {
        const at = this.advance()
        this.report("E_ATTRIBUTES_RESERVED", "attributes (`@name`) are reserved for a future version", at)
        if (this.at("Ident") && !this.cur.ws_before) this.advance()
        if (this.at("(") && !this.cur.nl_before) this.jumpTo(this.closerIndex(this.cur) + 1)
    }

    private parseItem(): A.Item | null {
        while (this.at("@")) this.skipAttribute()
        const start = this.cur
        const pub = this.eat("pub") !== null
        switch (this.cur.kind) {
            case "fun": return this.parseFun(start, pub, false, "item")
            case "async": {
                this.advance()
                if (!this.at("fun")) this.fail("E_UNEXPECTED_TOKEN", `expected \`fun\` after \`async\`, found ${describe(this.cur)}`)
                return this.parseFun(start, pub, true, "item")
            }
            case "type": return this.parseTypeDecl(start, pub)
            case "union": return this.parseUnionDecl(start, pub)
            case "inter": return this.parseInterDecl(start, pub)
            case "impl": return this.parseImpl(start)
            case "let": return this.parseLetDecl(start, pub)
            case "var":
                this.report("E_GLOBAL_VAR", "top-level `var` is not allowed: use `let`, or `Ref(…)` for mutable global state")
                return this.parseLetDecl(start, pub)
            case "extern": return this.parseExtern(start)
        }
        if (pub) this.fail("E_UNEXPECTED_TOKEN", `expected a declaration after \`pub\`, found ${describe(this.cur)}`)
        this.report("E_TOP_LEVEL_STATEMENT", "only declarations are allowed at the top level; move this into a function")
        this.syncFrom(this.i, this.t.length - 1, this.i + 1, (tok) => ITEM_START.has(tok.kind))
        this.syncToItemStart()
        return null
    }

    private parseGenericParams(): A.GenericParam[] {
        if (this.at("<")) {
            const lt = this.cur
            this.report("E_ANGLE_GENERICS", "generic parameters use `[…]`: write `name[T]`", lt)
            this.advance()
            const params = this.genericParamList(() => this.gtPending || this.at(">") || this.at(">>"))
            this.closeAngle()
            return params
        }
        if (!this.at("[")) return []
        this.advance()
        const params = this.group(false, () => this.genericParamList(() => this.at("]")))
        this.expect("]")
        return params
    }

    private genericParamList(done: () => boolean): A.GenericParam[] {
        const params: A.GenericParam[] = []
        while (!done()) {
            const start = this.cur
            const name = this.identName("a generic parameter name")
            const bounds: A.Type[] = []
            if (this.eat(":")) {
                bounds.push(this.parseTypePostfix())
                while (this.eat("&")) bounds.push(this.parseTypePostfix())
            }
            params.push({ kind: "GenericParam", span: this.sp(start), name, bounds })
            if (!this.eat(",")) break
        }
        if (params.length === 0) this.report("E_EXPECTED_TYPE_ARGUMENTS", "expected at least one generic parameter")
        return params
    }

    private parseFun(start: Token, pub: boolean, isAsync: boolean, mode: "item" | "sig"): A.FunDecl {
        this.expect("fun")
        const name = this.identName("a function name")
        const generics = this.parseGenericParams()
        const open = this.expect("(")
        const { receiver, params } = this.group(false, () => this.parseParams())
        this.jumpTo(this.closerIndex(open))
        this.expect(")")

        let ret: A.Type | null = null
        if (this.eat("->")) {
            ret = this.parseType()
        } else if (this.at(":")) {
            this.fail("E_UNEXPECTED_TOKEN", "return types are written with `->`: `fun f() -> int`")
        }

        let body: A.Block | null = null
        if (this.at("{")) {
            if (this.cur.nl_before) this.reportBraceNewline("the `{` of a function body goes on the same line as its signature")
            body = this.parseFunctionBody()
        } else if (mode === "item") {
            this.fail("E_UNEXPECTED_TOKEN", `expected \`{\` to start the function body, found ${describe(this.cur)}`)
        }
        return { kind: "FunDecl", span: this.sp(start), pub, async: isAsync, name, generics, receiver, params, ret, body }
    }

    private parseFunctionBody(): A.Block {
        const savedLabels = this.labels
        const savedClosures = this.closures
        this.labels = []
        this.closures = []
        try {
            return this.parseBlock()
        } finally {
            this.labels = savedLabels
            this.closures = savedClosures
        }
    }

    private parseParams(): { receiver: A.Receiver | null, params: A.Param[] } {
        let receiver: A.Receiver | null = null
        const params: A.Param[] = []
        let variadic: Token | null = null
        let first = true
        while (!this.at(")") && !this.at("EOF")) {
            if (first) {
                first = false
                const r = this.tryReceiver()
                if (r !== null) {
                    receiver = r
                    if (!this.eat(",")) break
                    continue
                }
            }
            if (variadic !== null) {
                this.report("E_VARIADIC_NOT_LAST", "a variadic parameter (`...name: T`) must be the last parameter", variadic)
                variadic = null
            }
            const startTok = this.cur
            const p = this.parseParam()
            if (p.variadic) variadic = startTok
            params.push(p)
            if (!this.eat(",")) break
        }
        if (!this.at(")")) this.fail("E_UNEXPECTED_TOKEN", `expected \`,\` or \`)\` in the parameter list, found ${describe(this.cur)}`)
        return { receiver, params }
    }

    private tryReceiver(): A.Receiver | null {
        const k0 = this.cur.kind
        const k1 = this.peek(1).kind
        const k2 = this.peek(2).kind
        if (k0 === "this") { this.advance(); return "this" }
        if (k0 === "&" && k1 === "this") { this.advance(); this.advance(); return "&this" }
        if (k0 === "&" && k1 === "mut" && k2 === "this") { this.advance(); this.advance(); this.advance(); return "&mut this" }
        if (k0 === "mut" && k1 === "this") { this.advance(); this.advance(); return "mut this" }

        // `self` receivers from other languages
        const isSelf = (tok: Token) => tok.kind === "Ident" && tok.value === "self"
        const ends = (tok: Token) => tok.kind === "," || tok.kind === ")"
        let n = -1
        let recv: A.Receiver = "this"
        if (isSelf(this.cur) && ends(this.peek(1))) { n = 1; recv = "this" }
        else if (k0 === "&" && isSelf(this.peek(1)) && ends(this.peek(2))) { n = 2; recv = "&this" }
        else if (k0 === "&" && k1 === "mut" && isSelf(this.peek(2)) && ends(this.peek(3))) { n = 3; recv = "&mut this" }
        else if (k0 === "mut" && isSelf(this.peek(1)) && ends(this.peek(2))) { n = 2; recv = "mut this" }
        if (n < 0) return null
        this.report("E_UNKNOWN_RECEIVER", `the receiver is \`this\`: write \`${recv}\``)
        for (let k = 0; k < n; k++) this.advance()
        return recv
    }

    private parseParam(): A.Param {
        const start = this.cur
        if (this.at("&")) {
            this.report("E_INVALID_PARAM", "`&` belongs on the type: write `name: &T`")
            this.advance()
            this.eat("mut")
        }
        const variadic = this.eat("...") !== null
        const mut = this.eat("mut") !== null
        const name = this.identName("a parameter name")
        this.expectColon("parameter")
        const type = this.parseType()
        return { kind: "Param", span: this.sp(start), name, mut, variadic, type }
    }

    /** `:` before a type. When it is missing but a type follows on the same line, report and continue. */
    private expectColon(what: string): void {
        if (this.eat(":")) return
        if (TYPE_START.has(this.cur.kind) && !this.cur.nl_before) {
            this.report("E_EXPECTED_COLON", `expected \`:\` between the ${what} name and its type`)
            return
        }
        this.fail("E_EXPECTED_COLON", `expected \`:\` and a type after the ${what} name, found ${describe(this.cur)}`)
    }

    private parseImplList(): A.Type[] {
        const impls: A.Type[] = []
        if (!this.eat(":")) return impls
        do impls.push(this.parseTypePostfix())
        while (this.eat(","))
        return impls
    }

    private parseTypeDecl(start: Token, pub: boolean): A.TypeDecl | A.UnionDecl {
        this.advance()
        const name = this.identName("a type name")
        const generics = this.parseGenericParams()
        const impls = this.parseImplList()
        this.expect("=")

        if (this.at("|")) {
            this.report("E_LEADING_PIPE_UNION", "sum types are declared with `union`: `union X = { A  B }`")
            const variants: A.Variant[] = []
            while (this.eat("|")) variants.push(this.parseVariant())
            return { kind: "UnionDecl", span: this.sp(start), pub, name, generics, impls, variants, methods: [] }
        }
        if (this.at("{")) {
            const body = this.parseStructBody()
            return { kind: "TypeDecl", span: this.sp(start), pub, name, generics, impls, body }
        }
        const body = this.parseType({ union: true })
        return { kind: "TypeDecl", span: this.sp(start), pub, name, generics, impls, body }
    }

    /** Parses `{ member* }` with per-member recovery. Members are separated by `,`, `;`, newlines, or nothing. */
    private parseMembers(member: () => void, opener: TokenKind = "{"): void {
        const open = this.expect(opener)
        const end = this.closerIndex(open)
        this.group(true, () => {
            while (this.i < end && !this.at("EOF")) {
                if (this.at(",") || this.at(";")) { this.advance(); continue }
                const memberStart = this.i
                try {
                    member()
                } catch (e) {
                    if (!(e instanceof Sync)) throw e
                    this.syncFrom(memberStart, end, e.at)
                }
            }
        })
        this.jumpTo(end)
        this.expect("}")
    }

    private parseStructBody(): A.StructBody {
        const start = this.cur
        const fields: A.Field[] = []
        const methods: A.FunDecl[] = []
        this.parseMembers(() => {
            while (this.at("@")) this.skipAttribute()
            const mstart = this.cur
            const pub = this.eat("pub") !== null
            if (this.at("fun")) {
                methods.push(this.parseFun(mstart, pub, false, "item"))
            } else if (this.at("async")) {
                this.advance()
                methods.push(this.parseFun(mstart, pub, true, "item"))
            } else {
                fields.push(this.parseField(mstart, pub, true))
            }
        })
        return { kind: "StructBody", span: this.sp(start), fields, methods }
    }

    private parseField(start: Token, pub: boolean, allowDefault: boolean): A.Field {
        const name = this.identName("a field name")
        this.expectColon("field")
        const type = this.parseType()
        let def: A.Expr | null = null
        if (allowDefault && this.eat("=")) def = this.parseExpr()
        return { kind: "Field", span: this.sp(start), pub, name, type, default: def }
    }

    private parseVariant(): A.Variant {
        const start = this.cur
        const name = this.identName("a variant name")
        let tuple: A.Type[] | null = null
        let fields: A.Field[] | null = null
        if (this.at("(") && !this.cur.nl_before) {
            const open = this.advance()
            tuple = this.group(false, () => this.typeList(() => this.at(")")))
            this.jumpTo(this.closerIndex(open))
            this.expect(")")
        } else if (this.at("{") && !this.cur.nl_before) {
            const fs: A.Field[] = []
            this.parseMembers(() => {
                const fstart = this.cur
                const pub = this.eat("pub") !== null
                fs.push(this.parseField(fstart, pub, true))
            })
            fields = fs
        }
        return { kind: "Variant", span: this.sp(start), name, tuple, fields }
    }

    private parseUnionDecl(start: Token, pub: boolean): A.UnionDecl {
        this.advance()
        const name = this.identName("a union name")
        const generics = this.parseGenericParams()
        const impls = this.parseImplList()
        this.expect("=")
        const variants: A.Variant[] = []
        const methods: A.FunDecl[] = []
        this.parseMembers(() => {
            while (this.at("@")) this.skipAttribute()
            const mstart = this.cur
            const mpub = this.eat("pub") !== null
            if (this.at("fun")) methods.push(this.parseFun(mstart, mpub, false, "item"))
            else if (this.at("async")) { this.advance(); methods.push(this.parseFun(mstart, mpub, true, "item")) }
            else variants.push(this.parseVariant())
        })
        return { kind: "UnionDecl", span: this.sp(start), pub, name, generics, impls, variants, methods }
    }

    private parseInterDecl(start: Token, pub: boolean): A.InterDecl {
        this.advance()
        const name = this.identName("an interface name")
        const generics = this.parseGenericParams()
        const supers: A.Type[] = []
        if (this.eat(":")) {
            supers.push(this.parseTypePostfix())
            while (this.eat("&") || this.eat(",")) supers.push(this.parseTypePostfix())
        }
        this.expect("=")
        if (!this.at("{")) {
            const composition = this.parseType()
            return { kind: "InterDecl", span: this.sp(start), pub, name, generics, supers, methods: null, composition }
        }
        const methods: A.FunDecl[] = []
        this.parseMembers(() => {
            const mstart = this.cur
            const mpub = this.eat("pub") !== null
            const isAsync = this.eat("async") !== null
            methods.push(this.parseFun(mstart, mpub, isAsync, "sig"))
        })
        return { kind: "InterDecl", span: this.sp(start), pub, name, generics, supers, methods, composition: null }
    }

    private parseImpl(start: Token): A.ImplDecl {
        this.advance()
        const generics = this.at("[") || this.at("<") ? this.parseGenericParams() : []
        const first = [this.parseTypePostfix()]
        while (this.eat(",")) first.push(this.parseTypePostfix())
        let interfaces: A.Type[] = []
        let target = first[0]!
        if (this.eat("for")) {
            interfaces = first
            target = this.parseTypePostfix()
        } else if (first.length > 1) {
            this.fail("E_UNEXPECTED_TOKEN", "expected `for` after a list of interfaces: `impl A, B for T`")
        }
        if (this.cur.nl_before && this.at("{")) this.reportBraceNewline("the `{` of an `impl` goes on the same line")
        const methods: A.FunDecl[] = []
        this.parseMembers(() => {
            const mstart = this.cur
            const pub = this.eat("pub") !== null
            const isAsync = this.eat("async") !== null
            methods.push(this.parseFun(mstart, pub, isAsync, "item"))
        })
        return { kind: "ImplDecl", span: this.sp(start), generics, interfaces, target, methods }
    }

    private parseLetDecl(start: Token, pub: boolean): A.LetDecl {
        this.advance()
        const name = this.identName("a name")
        let type: A.Type | null = null
        if (this.eat(":")) type = this.parseType()
        this.expect("=")
        const value = this.parseExpr()
        return { kind: "LetDecl", span: this.sp(start), pub, name, type, value }
    }

    private parseExtern(start: Token): A.ExternDecl {
        this.advance()
        const abiTok = this.expect("String", "an ABI string such as `\"C\"`")
        const funs: A.FunDecl[] = []
        this.parseMembers(() => {
            const mstart = this.cur
            const pub = this.eat("pub") !== null
            funs.push(this.parseFun(mstart, pub, false, "sig"))
        })
        return { kind: "ExternDecl", span: this.sp(start), abi: abiTok.value as string, funs }
    }

    // ---- types --------------------------------------------------------------------------------

    /**
     * Type grammar (spec §7.1). `union` allows `A | B` (only on the right of `type X =`).
     * `&` between types is an intersection; a leading `&` is a borrow of the postfix type after it.
     */
    private parseType(opts: { union?: boolean, inter?: boolean } = {}): A.Type {
        const start = this.cur
        let first = this.parseTypeInter(opts.inter ?? true)
        if (opts.union && this.at("|")) {
            const members = [first]
            while (this.eat("|")) members.push(this.parseTypeInter(opts.inter ?? true))
            first = { kind: "TUnion", span: this.sp(start), members }
        }
        return first
    }

    private parseTypeInter(inter: boolean): A.Type {
        const start = this.cur
        const first = this.parseTypePostfix()
        if (!inter || !this.at("&") || this.cur.nl_before) return first
        const members = [first]
        while (this.at("&") && !this.cur.nl_before) {
            this.advance()
            members.push(this.parseTypePostfix())
        }
        return { kind: "TIntersection", span: this.sp(start), members }
    }

    private parseTypePostfix(): A.Type {
        const start = this.cur
        let ty = this.parseTypePrimary()
        while (this.at("?") && !this.cur.nl_before) {
            if (ty.kind === "TOption") this.report("E_UNEXPECTED_TOKEN", "`T??` is not a type: an Option can't be optional again")
            this.advance()
            ty = { kind: "TOption", span: this.sp(start), inner: ty }
        }
        return ty
    }

    private parseTypePrimary(): A.Type {
        const start = this.cur
        switch (start.kind) {
            case "Ident":
            case "Self": {
                const path = [start.kind === "Self" ? "Self" : (start.value as string)]
                this.advance()
                while (this.at(".") && this.peek().kind === "Ident") {
                    this.advance()
                    path.push(this.advance().value as string)
                }
                let args: A.Type[] = []
                if (this.at("[") && !this.cur.ws_before) {
                    args = this.parseTypeArgs()
                } else if (this.at("<") && !this.cur.ws_before) {
                    args = this.parseAngleArgs()
                }
                return { kind: "TName", span: this.sp(start), path, args }
            }
            case "&": {
                this.advance()
                const mut = this.eat("mut") !== null
                const inner = this.parseTypePostfix()
                return { kind: "TRef", span: this.sp(start), mut, inner }
            }
            case "&&": {
                // `&&T`: a borrow of a borrow
                this.advance()
                const inner = this.parseTypePostfix()
                const innerRef: A.Type = { kind: "TRef", span: this.sp(start), mut: false, inner }
                return { kind: "TRef", span: this.sp(start), mut: false, inner: innerRef }
            }
            case "*": {
                this.advance()
                const mut = this.eat("mut") !== null
                const inner = this.parseTypePostfix()
                return { kind: "TPtr", span: this.sp(start), mut, inner }
            }
            case "t(": {
                this.advance()
                const elems = this.group(false, () => this.typeList(() => this.at(")")))
                this.jumpTo(this.closerIndex(start))
                this.expect(")")
                return { kind: "TTuple", span: this.sp(start), elems }
            }
            case "r{": {
                const fields: A.Field[] = []
                this.parseMembers(() => {
                    const fstart = this.cur
                    const pub = this.eat("pub") !== null
                    fields.push(this.parseField(fstart, pub, false))
                }, "r{")
                return { kind: "TRecord", span: this.sp(start), fields }
            }
            case "(": {
                this.advance()
                const elems = this.group(false, () => this.typeList(() => this.at(")")))
                this.jumpTo(this.closerIndex(start))
                this.expect(")")
                if (this.at("->")) {
                    this.advance()
                    const ret = this.parseType()
                    return { kind: "TFn", span: this.sp(start), params: elems, ret }
                }
                if (elems.length === 1) return elems[0]!
                this.report("E_BARE_TUPLE", "tuple types are written `t(A, B)`", start)
                return { kind: "TTuple", span: this.sp(start), elems }
            }
            case "TypeOf": {
                this.advance()
                const open = this.expect("(")
                const path = this.group(false, () => this.dottedName("a value path"))
                this.jumpTo(this.closerIndex(open))
                this.expect(")")
                return { kind: "TTypeOf", span: this.sp(start), path }
            }
            case "String":
                this.advance()
                return { kind: "TLiteral", span: this.sp(start), value: start.value as string }
            case "Int":
                this.advance()
                return { kind: "TLiteral", span: this.sp(start), value: start.value as bigint }
            case "true":
            case "false":
                this.advance()
                return { kind: "TLiteral", span: this.sp(start), value: start.kind === "true" }
        }
        return this.fail("E_UNEXPECTED_TOKEN", `expected a type, found ${describe(start)}`)
    }

    private typeList(done: () => boolean): A.Type[] {
        const types: A.Type[] = []
        while (!done() && !this.at("EOF")) {
            types.push(this.parseType())
            if (!this.eat(",")) break
        }
        return types
    }

    /** `[A, B]` after a type name, or `.[A, B]` in an expression. */
    private parseTypeArgs(): A.Type[] {
        const open = this.advance()
        if (this.at("]")) {
            this.report("E_EXPECTED_TYPE_ARGUMENTS", "expected at least one type argument inside `[ ]`", this.cur)
            this.advance()
            return []
        }
        const args = this.group(false, () => this.typeList(() => this.at("]")))
        this.jumpTo(this.closerIndex(open))
        this.expect("]")
        return args
    }

    /** Recovery for `Name<A, B>`: report once (outermost), then parse the arguments. */
    private parseAngleArgs(): A.Type[] {
        const lt = this.advance()
        if (this.angleDepth === 0) this.report("E_ANGLE_GENERICS", "generic arguments use `[…]` in types and `.[…]` in expressions: `Vec[int]`, `f.[T](x)`", lt)
        this.angleDepth++
        try {
            const args: A.Type[] = []
            while (!this.gtPending && !this.at(">") && !this.at(">>") && !this.at("EOF")) {
                args.push(this.parseType())
                if (!this.eat(",")) break
            }
            if (!this.closeAngle()) this.fail("E_UNEXPECTED_TOKEN", `expected \`>\`, found ${describe(this.cur)}`)
            return args
        } finally {
            this.angleDepth--
        }
    }

    private closeAngle(): boolean {
        if (this.gtPending) { this.gtPending = false; return true }
        if (this.at(">")) { this.advance(); return true }
        if (this.at(">>")) { this.advance(); this.gtPending = true; return true }
        return false
    }

    // ---- statements ---------------------------------------------------------------------------

    private parseBlock(): A.Block {
        const open = this.expect("{")
        const stmts = this.group(true, () => this.parseStmts(this.closerIndex(open)))
        this.jumpTo(this.closerIndex(open))
        this.expect("}")
        return { kind: "Block", span: this.sp(open), stmts }
    }

    /** Statements up to the closer at index `end` (not consumed). */
    private parseStmts(end: number): A.Stmt[] {
        const stmts: A.Stmt[] = []
        while (this.i < end && !this.at("EOF")) {
            if (this.at(";")) { this.advance(); continue }
            const stmtStart = this.i
            try {
                const stmt = this.parseStmt()
                stmts.push(stmt)
                if (this.at(";")) {
                    this.advance()
                    if (stmt.kind === "ExprStmt") stmt.semi = true
                } else if (this.i < end && !this.cur.nl_before) {
                    this.fail("E_UNEXPECTED_TOKEN", `expected a newline or \`;\` after the statement, found ${describe(this.cur)}`)
                }
            } catch (e) {
                if (!(e instanceof Sync)) throw e
                this.syncFrom(stmtStart, end, e.at)
            }
        }
        return stmts
    }

    private parseStmt(): A.Stmt {
        const tok = this.cur
        if (tok.kind === "@") {
            this.skipAttribute()
            return this.parseStmt()
        }
        if (tok.kind === "let" || tok.kind === "var") return this.parseLet()
        if (tok.kind === "Ident" && this.peek().kind === ":" && this.peek(2).kind === "for") {
            this.advance()
            this.advance()
            const expr = this.parseFor(tok)
            return { kind: "ExprStmt", span: this.sp(tok), expr, semi: false }
        }

        const expr = this.parseExpr()
        if (this.at(":=") || this.at(":==")) {
            const op = this.advance()
            let pattern: A.Pattern
            if (expr.kind === "Ident") {
                pattern = { kind: "PBind", span: expr.span, name: expr.name, mut: false }
            } else {
                this.report("E_SHORT_DECL_TARGET", `\`${op.kind}\` declares a plain name; use \`let\` for patterns and \`=\` to assign`, op)
                pattern = { kind: "PWild", span: expr.span }
            }
            const value = this.parseExpr()
            return { kind: "Let", span: this.sp(tok), mutable: op.kind === ":==", short: true, pattern, type: null, value, else: null }
        }
        return { kind: "ExprStmt", span: this.sp(tok), expr, semi: false }
    }

    private parseLet(): A.Stmt {
        const start = this.advance()
        const mutable = start.kind === "var"
        const pattern = this.parsePattern()
        let type: A.Type | null = null
        if (this.eat(":")) type = this.parseType()
        if (this.at(":=") || this.at(":==")) {
            this.report("E_SHORT_DECL_TARGET", `write \`${start.kind} name = value\` or \`name ${mutable ? ":==" : ":="} value\`, not both`)
            this.advance()
        } else {
            this.expect("=")
        }
        const value = this.parseExpr()
        let elseBlock: A.Block | null = null
        if (this.at("else")) {
            this.advance()
            elseBlock = this.parseBlock()
        }
        return { kind: "Let", span: this.sp(start), mutable, short: false, pattern, type, value, else: elseBlock }
    }

    // ---- expressions --------------------------------------------------------------------------

    parseExpr(minBp = 0): A.Expr {
        const start = this.cur
        let left = this.parseUnary()

        for (;;) {
            const tok = this.cur
            if (tok.nl_before && this.nlSig && !CONTINUE.has(tok.kind)) break
            const info = INFIX[tok.kind]
            if (info === undefined) break
            const [bp, assoc] = info
            if (bp < minBp) break

            if (tok.kind === "as") {
                this.advance()
                const type = this.parseType({ inter: false })
                left = { kind: "As", span: this.sp(start), expr: left, type }
                continue
            }

            if (tok.kind === "or") {
                this.advance()
                let name: string | null = null
                let nameSpan: Span | null = null
                if (this.at("Ident") && this.peek().kind === "=>") {
                    const nameTok = this.advance()
                    name = nameTok.value as string
                    nameSpan = nameTok.span
                    this.advance()
                }
                const rhs = this.parseExpr(BP_OR_RHS)
                left = { kind: "Or", span: this.sp(start), expr: left, name, nameSpan, rhs }
                continue
            }

            if (assoc === "none" && this.isNonAssocChain(left, tok.kind)) {
                this.report("E_NON_ASSOCIATIVE_OPERATOR", `\`${tok.kind}\` can't be chained: add parentheses`, tok)
            }

            if (tok.kind === ".." || tok.kind === "..=") {
                this.advance()
                const end = this.canStartOperand() ? this.parseExpr(BP_RANGE_OPERAND) : null
                left = { kind: "Range", span: this.sp(start), op: tok.kind, start: left, end }
                continue
            }

            this.advance()
            const right = this.parseExpr(assoc === "right" ? bp : bp + 1)

            if (ASSIGN_OPS.has(tok.kind)) {
                if (!this.isPlace(left)) {
                    this.report("E_INVALID_ASSIGNMENT_TARGET", "the left side of an assignment must be a variable, field, index or `*pointer`", tok)
                }
                left = { kind: "Assign", span: this.sp(start), op: tok.kind, target: left, value: right }
                continue
            }
            if (tok.kind === "??" && (this.isLogical(left) || this.isLogical(right))) {
                this.report("E_MIXED_NULLISH", "`??` can't be mixed with `&&` / `||` without parentheses", tok)
            }
            left = { kind: "Binary", span: this.sp(start), op: tok.kind, left, right }
        }
        return left
    }

    private isNonAssocChain(left: A.Expr, op: TokenKind): boolean {
        if (COMPARISON_OPS.has(op)) return left.kind === "Binary" && COMPARISON_OPS.has(left.op)
        if (op === ".." || op === "..=") return left.kind === "Range"
        return false
    }

    private isLogical(e: A.Expr): boolean {
        return e.kind === "Binary" && (e.op === "&&" || e.op === "||")
    }

    private isPlace(e: A.Expr): boolean {
        switch (e.kind) {
            case "Ident": case "Member": case "Index": case "This": return true
            case "Unary": return e.op === "*"
            case "Paren": return this.isPlace(e.expr)
            default: return false
        }
    }

    /** Whether the current token can start an operand here (used for open-ended ranges). */
    private canStartOperand(): boolean {
        const tok = this.cur
        if (!EXPR_START.has(tok.kind)) return false
        if (tok.nl_before && this.nlSig) return false
        if (tok.kind === "{" && this.noStruct) return false
        return true
    }

    private parseUnary(): A.Expr {
        const start = this.cur
        switch (start.kind) {
            case "-":
            case "!": {
                this.advance()
                const expr = this.parseUnary()
                return { kind: "Unary", span: this.sp(start), op: start.kind, expr }
            }
            case "&": {
                this.advance()
                const mut = this.eat("mut") !== null
                const expr = this.parseUnary()
                return { kind: "Unary", span: this.sp(start), op: mut ? "&mut" : "&", expr }
            }
            case "*": {
                this.advance()
                const expr = this.parseUnary()
                return { kind: "Unary", span: this.sp(start), op: "*", expr }
            }
            case "~":
            case "--":
            case "++": {
                const hint = start.kind === "~" ? "bitwise not is `!` on integers" : "write `x += 1` / `x -= 1`"
                this.report("E_RESERVED_OPERATOR", `\`${start.kind}\` is reserved: ${hint}`)
                this.advance()
                const expr = this.parseUnary()
                if (start.kind === "++") return expr
                return { kind: "Unary", span: this.sp(start), op: start.kind === "~" ? "!" : "-", expr }
            }
            case "await": {
                // the operand is a postfix chain up to the first `?` / `?.` (spec §3.1)
                this.advance()
                const operand = this.parsePostfix(this.parsePrimary(), true)
                const awaited: A.Expr = { kind: "Await", span: this.sp(start), expr: operand }
                return this.parsePostfix(awaited, false, start)
            }
            case "..":
            case "..=": {
                this.advance()
                const end = this.canStartOperand() ? this.parseExpr(BP_RANGE_OPERAND) : null
                return { kind: "Range", span: this.sp(start), op: start.kind, start: null, end }
            }
        }
        return this.parsePostfix(this.parsePrimary(), false)
    }

    private parsePostfix(expr: A.Expr, stopAtTry: boolean, startTok?: Token): A.Expr {
        const start = startTok ?? expr.span
        for (;;) {
            const tok = this.cur
            switch (tok.kind) {
                case ".": {
                    this.advance()
                    const name = this.memberName()
                    expr = { kind: "Member", span: this.sp(start), object: expr, name }
                    continue
                }
                case "?.": {
                    if (stopAtTry) return expr
                    this.advance()
                    const name = this.memberName()
                    expr = { kind: "OptMember", span: this.sp(start), object: expr, name }
                    continue
                }
                case "(": {
                    if (tok.nl_before) return expr
                    const args = this.parseArgs()
                    expr = { kind: "Call", span: this.sp(start), callee: expr, args }
                    continue
                }
                case "[": {
                    if (tok.nl_before) return expr
                    this.advance()
                    const index = this.group(false, () => this.parseExpr())
                    this.jumpTo(this.closerIndex(tok))
                    this.expect("]")
                    expr = { kind: "Index", span: this.sp(start), object: expr, index }
                    continue
                }
                case ".[": {
                    if (tok.nl_before) this.report("E_GENERIC_ARGS_NEWLINE", "`.[` must be on the same line as the expression it applies to")
                    const args = this.parseTypeArgs()
                    expr = { kind: "GenericApply", span: this.sp(start), target: expr, args }
                    continue
                }
                case "?": {
                    if (tok.nl_before || stopAtTry) return expr
                    this.advance()
                    expr = { kind: "Try", span: this.sp(start), expr }
                    continue
                }
                case "{": {
                    if (tok.nl_before || !this.isTypePath(expr)) return expr
                    if (this.noStruct) {
                        if (!this.looksLikeStructInHeader(tok)) return expr
                        this.report("E_STRUCT_LITERAL_IN_HEADER", "a struct literal can't appear directly in an `if` / `for` / `match` header: wrap it in parentheses")
                    }
                    const fields = this.parseRecordFields("struct")
                    expr = { kind: "StructLit", span: this.sp(start), type: expr, fields }
                    continue
                }
                case "++":
                case "--": {
                    if (tok.nl_before) return expr
                    this.report("E_RESERVED_OPERATOR", `\`${tok.kind}\` is reserved: write \`x ${tok.kind === "++" ? "+=" : "-="} 1\``)
                    this.advance()
                    continue
                }
                case "<": {
                    // `f<T>(x)`: generic arguments written with angle brackets
                    if (tok.ws_before || !this.isPathExpr(expr) || !this.angleCallAhead(this.i)) return expr
                    const args = this.parseAngleArgs()
                    expr = { kind: "GenericApply", span: this.sp(start), target: expr, args }
                    continue
                }
                case ":": {
                    // `f::<T>(x)` (turbofish)
                    const n1 = this.peek(1)
                    const n2 = this.peek(2)
                    if (tok.ws_before || n1.kind !== ":" || n1.ws_before || n2.kind !== "<" || !this.isPathExpr(expr)) return expr
                    this.advance()
                    this.advance()
                    const args = this.parseAngleArgs()
                    expr = { kind: "GenericApply", span: this.sp(start), target: expr, args }
                    continue
                }
                default:
                    return expr
            }
        }
    }

    private memberName(): string | number {
        const tok = this.cur
        if (tok.kind === "Ident") { this.advance(); return tok.value as string }
        if (tok.kind === "Int") { this.advance(); return Number(tok.value) }
        return this.fail("E_UNEXPECTED_TOKEN", `expected a field or method name after \`.\`, found ${describe(tok)}`)
    }

    private isPathExpr(e: A.Expr): boolean {
        if (e.kind === "Ident") return true
        if (e.kind === "Member") return typeof e.name === "string" && this.isPathExpr(e.object)
        return false
    }

    /** `User`, `models.User`, `Box.[i32]`: may be followed by a struct literal body. */
    private isTypePath(e: A.Expr): boolean {
        if (e.kind === "Ident") return isUpper(e.name)
        if (e.kind === "Member") return typeof e.name === "string" && isUpper(e.name) && this.isPathExpr(e.object)
        if (e.kind === "GenericApply") return this.isTypePath(e.target)
        return false
    }

    /** In a header, `P { a: 1 } {` (a struct literal followed by the real block) is a misplaced struct literal. */
    private looksLikeStructInHeader(open: Token): boolean {
        const close = open.match
        if (close === undefined) return false
        const after = this.t[close + 1]
        const first = this.t[this.i + 1]
        const second = this.t[this.i + 2]
        return after !== undefined && after.kind === "{" && !after.nl_before
            && first !== undefined && first.kind === "Ident" && second !== undefined && (second.kind === ":" || second.kind === ",")
    }

    /** From a `<` at `k`: does a type-argument list follow, closed by `>` and then a glued `(`? */
    private angleCallAhead(k: number): boolean {
        let depth = 0
        for (let n = 0; n < 64 && k < this.t.length; n++) {
            const tok = this.t[k]!
            switch (tok.kind) {
                case "<": depth++; k++; break
                case ">": depth--; k++; break
                case ">>": depth -= 2; k++; break
                case "Ident": case "Self": case ",": case ".": case "?": case "&": case "mut": case "*": k++; break
                case "[": case "t(": case "r{": case "(":
                    if (depth <= 0 || tok.match === undefined) return false
                    k = tok.match + 1
                    break
                default: return false
            }
            if (depth <= 0) {
                const next = this.t[k]
                return depth === 0 && next !== undefined && next.kind === "(" && !next.ws_before
            }
        }
        return false
    }

    private parseArgs(): (A.Expr | A.Spread)[] {
        const open = this.advance()
        const args = this.group(false, () => this.elementList(")", () => this.parseExpr()))
        this.jumpTo(this.closerIndex(open))
        this.expect(")")
        return args
    }

    /** Elements separated by `,` or newlines, with `...spread` and a trailing comma allowed. */
    private elementList<T>(close: TokenKind, elem: () => T): (T | A.Spread)[] {
        const out: (T | A.Spread)[] = []
        while (!this.at(close) && !this.at("EOF")) {
            if (this.at("...")) {
                const start = this.advance()
                const expr = this.parseExpr()
                out.push({ kind: "Spread", span: this.sp(start), expr })
            } else {
                out.push(elem())
            }
            if (this.eat(",")) continue
            if (this.at(close)) break
            if (this.cur.nl_before) continue
            this.fail("E_UNEXPECTED_TOKEN", `expected \`,\` or \`${close}\`, found ${describe(this.cur)}`)
        }
        return out
    }

    private parsePrimary(): A.Expr {
        const tok = this.cur
        switch (tok.kind) {
            case "Ident": {
                this.advance()
                const name = tok.value as string
                if (IMPLICIT_PARAM.test(name) && this.closures.length > 0 && this.closures[this.closures.length - 1]) {
                    this.report("E_IT_IN_NAMED_CLOSURE", `\`${name}\` is only available in closures without a parameter header`, tok)
                }
                return { kind: "Ident", span: this.sp(tok), name }
            }
            case "_": this.advance(); return { kind: "Ident", span: this.sp(tok), name: "_" }
            case "Self": this.advance(); return { kind: "Ident", span: this.sp(tok), name: "Self" }
            case "this": this.advance(); return { kind: "This", span: this.sp(tok) }
            case "Int": this.advance(); return { kind: "Int", span: this.sp(tok), value: tok.value as bigint }
            case "Float": this.advance(); return { kind: "Float", span: this.sp(tok), value: tok.value as number }
            case "String": this.advance(); return { kind: "Str", span: this.sp(tok), value: tok.value as string, raw: false }
            case "RawString": this.advance(); return { kind: "Str", span: this.sp(tok), value: tok.value as string, raw: true }
            case "Char": this.advance(); return { kind: "Char", span: this.sp(tok), value: tok.value as string }
            case "true": case "false": this.advance(); return { kind: "Bool", span: this.sp(tok), value: tok.kind === "true" }
            case "nil": this.advance(); return { kind: "Nil", span: this.sp(tok) }
            case "TemplateHead": return this.parseTemplate()
            case "(": return this.parseParen()
            case "[": {
                this.advance()
                const elems = this.group(false, () => this.elementList("]", () => this.parseExpr()))
                this.jumpTo(this.closerIndex(tok))
                this.expect("]")
                return { kind: "Vec", span: this.sp(tok), elems }
            }
            case "a[": {
                this.advance()
                const elems = this.group(false, () => this.elementList("]", () => this.parseExpr()))
                this.jumpTo(this.closerIndex(tok))
                this.expect("]")
                return { kind: "Array", span: this.sp(tok), elems }
            }
            case "t(": {
                this.advance()
                const elems = this.group(false, () => this.elementList(")", () => this.parseExpr()))
                this.jumpTo(this.closerIndex(tok))
                this.expect(")")
                return { kind: "Tuple", span: this.sp(tok), elems }
            }
            case "s{": {
                this.advance()
                const elems = this.group(true, () => this.elementList("}", () => this.parseExpr()))
                this.jumpTo(this.closerIndex(tok))
                this.expect("}")
                return { kind: "Set", span: this.sp(tok), elems }
            }
            case "m{": {
                this.advance()
                const entries = this.group(true, () => this.elementList("}", (): A.MapEntry => {
                    const kstart = this.cur
                    const key = this.parseExpr()
                    this.expect(":", "`:` between a map key and its value")
                    const value = this.parseExpr()
                    return { kind: "MapEntry", span: this.sp(kstart), key, value }
                }))
                this.jumpTo(this.closerIndex(tok))
                this.expect("}")
                return { kind: "Map", span: this.sp(tok), entries }
            }
            case "r{": {
                const fields = this.parseRecordFields("record")
                return { kind: "Record", span: this.sp(tok), fields }
            }
            case "_{": {
                const fields = this.parseRecordFields("record")
                return { kind: "Inferred", span: this.sp(tok), fields }
            }
            case "#{":
            case "#[": return this.parseClosure()
            case "{": {
                const k1 = this.peek(1)
                const k2 = this.peek(2)
                if ((k1.kind === "Ident" || k1.kind === "String") && k2.kind === ":" && this.peek(3).kind !== "for") {
                    this.report("E_BARE_BRACE_LITERAL", "a bare `{` is always a block: write `r{ … }` for a record, `m{ … }` for a map, or `_{ … }` for an inferred struct")
                    const fields = this.parseRecordFields("record")
                    return { kind: "Record", span: this.sp(tok), fields }
                }
                const block = this.parseBlock()
                return block
            }
            case "if": return this.parseIf()
            case "match": return this.parseMatch()
            case "for": return this.parseFor(null)
            case "while":
            case "loop": {
                this.report("E_RESERVED_KEYWORD", `\`${tok.kind}\` is reserved: MinScript loops use \`for\` (\`for cond { }\`, \`for { }\`)`)
                return this.parseFor(null)
            }
            case "select": return this.parseSelect()
            case "unsafe": {
                this.advance()
                const body = this.parseBlock()
                return { kind: "Unsafe", span: this.sp(tok), body }
            }
            case "recover": {
                this.advance()
                const body = this.parseBlock()
                return { kind: "Recover", span: this.sp(tok), body }
            }
            case "return": {
                this.advance()
                const value = this.canStartValue() ? this.parseExpr() : null
                return { kind: "Return", span: this.sp(tok), value }
            }
            case "break": {
                this.advance()
                let label: string | null = null
                if (this.at("Ident") && !this.cur.nl_before && this.labels.includes(this.cur.value as string)) {
                    label = this.advance().value as string
                }
                const value = this.canStartValue() ? this.parseExpr() : null
                return { kind: "Break", span: this.sp(tok), label, value }
            }
            case "continue": {
                this.advance()
                let label: string | null = null
                if (this.at("Ident") && !this.cur.nl_before && this.labels.includes(this.cur.value as string)) {
                    label = this.advance().value as string
                }
                return { kind: "Continue", span: this.sp(tok), label }
            }
            case "fun": return this.parseFunExpression()
        }
        if (RESERVED_KEYWORDS.has(tok.kind)) {
            this.fail("E_RESERVED_KEYWORD", `\`${tok.kind}\` is reserved for a future version`)
        }
        return this.fail("E_UNEXPECTED_TOKEN", `expected an expression, found ${describe(tok)}`)
    }

    /** After `return` / `break`: a value follows on the same line. */
    private canStartValue(): boolean {
        const tok = this.cur
        return EXPR_START.has(tok.kind) && !tok.nl_before
    }

    private parseTemplate(): A.Expr {
        const start = this.cur
        const parts: (string | A.Expr)[] = []
        let tok = this.advance()
        parts.push(tok.value as string)
        for (;;) {
            const expr = this.group(false, () => this.parseExpr())
            parts.push(expr)
            tok = this.cur
            if (tok.kind === "TemplateMiddle") {
                this.advance()
                parts.push(tok.value as string)
                continue
            }
            if (tok.kind === "TemplateTail") {
                this.advance()
                parts.push(tok.value as string)
                break
            }
            this.fail("E_UNEXPECTED_TOKEN", `expected \`}\` to end the interpolation, found ${describe(tok)}`)
        }
        return { kind: "Template", span: this.sp(start), parts }
    }

    private parseParen(): A.Expr {
        const open = this.cur
        const closeIdx = this.closerIndex(open)
        const after = this.t[closeIdx + 1]
        if (after !== undefined && (after.kind === "=>" || after.kind === "->") && !after.nl_before) {
            return this.parseArrowClosure(open)
        }
        this.advance()
        if (this.at(")")) {
            this.advance()
            this.report("E_BARE_TUPLE", "the unit value is `t()`", open)
            return { kind: "Tuple", span: this.sp(open), elems: [] }
        }
        const result = this.group(false, (): A.Expr => {
            const first = this.parseExpr()
            if (!this.at(",")) return { kind: "Paren", span: first.span, expr: first }
            this.report("E_BARE_TUPLE", "tuples are written `t(a, b)`", open)
            const elems: (A.Expr | A.Spread)[] = [first]
            while (this.eat(",")) {
                if (this.at(")")) break
                elems.push(this.parseExpr())
            }
            return { kind: "Tuple", span: first.span, elems }
        })
        this.jumpTo(closeIdx)
        this.expect(")")
        result.span = this.sp(open)
        return result
    }

    /** Recovery for `(a, b) => …` and `(a: T) -> U => …`. */
    private parseArrowClosure(open: Token): A.Expr {
        this.report("E_ARROW_CLOSURE", "arrow functions are not supported: write `#{ a, b => … }`", open)
        this.jumpTo(this.closerIndex(open) + 1)
        let ret: A.Type | null = null
        if (this.eat("->")) ret = this.parseType()
        this.expect("=>")
        const body = this.closureBodyFromExpr()
        return { kind: "Closure", span: this.sp(open), captures: null, params: null, ret, body }
    }

    /** Recovery for `fun(x) { … }` used as a value. */
    private parseFunExpression(): A.Expr {
        const start = this.advance()
        this.report("E_ARROW_CLOSURE", "function expressions are not supported: write `#{ x => … }`", start)
        if (this.at("(")) this.jumpTo(this.closerIndex(this.cur) + 1)
        let ret: A.Type | null = null
        if (this.eat("->")) ret = this.parseType()
        const body = this.parseBlock()
        return { kind: "Closure", span: this.sp(start), captures: null, params: null, ret, body }
    }

    private closureBodyFromExpr(): A.Block {
        if (this.at("{")) return this.parseBlock()
        const expr = this.parseExpr()
        return { kind: "Block", span: expr.span, stmts: [{ kind: "ExprStmt", span: expr.span, expr, semi: false }] }
    }

    /** `r{ … }`, `_{ … }`, `Name { … }`, and the recovery for a bare `{ k: v }`. */
    private parseRecordFields(what: "record" | "struct"): (A.RecordField | A.Spread)[] {
        const open = this.advance()
        const fields = this.group(true, () => this.elementList("}", (): A.RecordField | A.Spread => {
            const start = this.cur
            const keyTok = this.cur
            let key: string
            if (keyTok.kind === "Ident") {
                key = keyTok.value as string
            } else if (keyTok.kind === "String" && what === "record") {
                key = keyTok.value as string
            } else if (isKeyword(keyTok.kind) && this.peek().kind === ":") {
                key = keyTok.kind
            } else {
                this.report("E_INVALID_RECORD_KEY", `a ${what} key must be a name${what === "record" ? " or a string" : ""}, found ${describe(keyTok)}`)
                this.advance()
                if (this.eat(":")) this.parseExpr()
                return { kind: "RecordField", span: this.sp(start), key: "", value: null }
            }
            this.advance()
            let value: A.Expr | null = null
            if (this.eat(":")) value = this.parseExpr()
            else if (keyTok.kind === "String") this.fail("E_UNEXPECTED_TOKEN", "expected `:` after a string key")
            return { kind: "RecordField", span: this.sp(start), key, value }
        }))
        this.jumpTo(this.closerIndex(open))
        this.expect("}")
        return fields
    }

    // ---- closures -----------------------------------------------------------------------------

    private parseClosure(): A.Expr {
        const start = this.cur
        let captures: A.Capture[] | null = null
        let brace: Token
        if (this.at("#[")) {
            const open = this.advance()
            captures = this.group(false, () => this.parseCaptures())
            this.jumpTo(this.closerIndex(open))
            const close = this.expect("]")
            if (this.at("{")) {
                if (this.cur.ws_before) this.report("E_CAPTURE_NOT_GLUED", "the closure body `{` must be glued to the capture list: `#[x]{ … }`")
                brace = this.advance()
            } else if (this.at("(") && !this.cur.nl_before) {
                // `#[x](a) => …`: the old arrow form after a capture list
                this.report("E_CAPTURE_NOT_GLUED", "a capture list is followed directly by the body: `#[x]{ a => … }`", close)
                const paren = this.cur
                this.jumpTo(this.closerIndex(paren) + 1)
                let ret: A.Type | null = null
                if (this.eat("->")) ret = this.parseType()
                this.expect("=>")
                const body = this.closureBodyFromExpr()
                return { kind: "Closure", span: this.sp(start), captures, params: null, ret, body }
            } else {
                return this.fail("E_CAPTURE_NOT_GLUED", "a capture list must be followed by the closure body `{`")
            }
        } else {
            brace = this.advance()
        }

        const end = this.closerIndex(brace)
        const arrowAt = this.findClosureHeader(this.i, end)

        let params: A.ClosureParam[] | null = null
        let ret: A.Type | null = null
        const body = this.group(true, (): A.Block => {
            if (arrowAt >= 0) {
                const header = this.parseClosureHeader(arrowAt)
                params = header.params
                ret = header.ret
            }
            this.closures.push(params !== null)
            try {
                const bodyStart = this.cur
                const stmts = this.parseStmts(end)
                return { kind: "Block", span: this.sp(bodyStart), stmts }
            } finally {
                this.closures.pop()
            }
        })
        this.jumpTo(end)
        this.expect("}")
        return { kind: "Closure", span: this.sp(start), captures, params, ret, body }
    }

    private parseCaptures(): A.Capture[] {
        const caps: A.Capture[] = []
        while (!this.at("]") && !this.at("EOF")) {
            const start = this.cur
            let mode: A.Capture["mode"] = "move"
            if (this.eat("&")) mode = this.eat("mut") ? "mut" : "ref"
            if (!this.at("Ident")) {
                this.report("E_INVALID_CAPTURE", "a capture is `x`, `&x` or `&mut x`")
                this.skipCapture()
            } else {
                const name = this.advance().value as string
                if (!this.at(",") && !this.at("]")) {
                    this.report("E_INVALID_CAPTURE", "a capture is a plain name (`x`, `&x`, `&mut x`): capture the whole variable")
                    this.skipCapture()
                }
                caps.push({ kind: "Capture", span: this.sp(start), name, mode })
            }
            if (!this.eat(",")) break
        }
        return caps
    }

    private skipCapture(): void {
        while (!this.at(",") && !this.at("]") && !this.at("EOF")) {
            const tok = this.cur
            this.jumpTo(tok.match !== undefined && tok.match > this.i ? tok.match + 1 : this.i + 1)
        }
    }

    /**
     * Bounded scan for a parameter header (spec §4.4): from `from`, at depth 0, only header tokens or
     * skipped bracket groups, up to `=>` on the closure's first line. Returns the index of `=>`, or -1.
     * A header that starts on the next line is reported (E_CLOSURE_HEADER_LINE) and accepted.
     */
    private findClosureHeader(from: number, end: number): number {
        const scan = (): number => {
            let k = from
            while (k < end) {
                const tok = this.t[k]!
                if (k > from && tok.nl_before) return -1
                if (tok.kind === "=>") return k > from ? k : -1
                if (HEADER_GROUPS.has(tok.kind)) {
                    if (tok.match === undefined) return -1
                    k = tok.match + 1
                    continue
                }
                if (!HEADER_TOKENS.has(tok.kind)) return -1
                k++
            }
            return -1
        }
        const first = this.t[from]
        if (first === undefined || from >= end) return -1
        const arrow = scan()
        if (arrow >= 0 && first.nl_before) {
            this.report("E_CLOSURE_HEADER_LINE", "closure parameters (`a, b =>`) must be on the same line as the opening `#{`", first)
        }
        return arrow
    }

    private parseClosureHeader(arrowAt: number): { params: A.ClosureParam[], ret: A.Type | null } {
        const params: A.ClosureParam[] = []
        let ret: A.Type | null = null
        while (this.i < arrowAt) {
            const start = this.cur
            const mut = this.eat("mut") !== null
            const name = this.at("_") ? (this.advance(), "_") : this.identName("a closure parameter name")
            let type: A.Type | null = null
            if (this.eat(":")) type = this.parseType()
            params.push({ kind: "ClosureParam", span: this.sp(start), name, mut, type })
            if (this.eat(",")) continue
            if (this.eat("->")) ret = this.parseType()
            break
        }
        if (this.i !== arrowAt) this.fail("E_UNEXPECTED_TOKEN", `unexpected ${describe(this.cur)} in the closure parameters`)
        this.expect("=>")
        return { params, ret }
    }

    // ---- control flow -------------------------------------------------------------------------

    private parseExprNoStruct(): A.Expr {
        const saved = this.noStruct
        this.noStruct = true
        try {
            return this.parseExpr()
        } finally {
            this.noStruct = saved
        }
    }

    /** The `{` of a control-flow header (on the header line). */
    private parseHeaderBlock(what: string): A.Block {
        if (!this.at("{")) this.fail("E_UNEXPECTED_TOKEN", `expected \`{\` after the ${what} header, found ${describe(this.cur)}`)
        if (this.cur.nl_before) this.reportBraceNewline(`the \`{\` of ${what} goes on the same line as its header`)
        return this.parseBlock()
    }

    private parseIf(): A.Expr {
        const start = this.advance()
        let cond: A.Expr | A.LetCond
        if (this.at("let")) {
            const letTok = this.advance()
            const pattern = this.parsePattern()
            this.expect("=")
            const value = this.parseExprNoStruct()
            cond = { kind: "LetCond", span: this.sp(letTok), pattern, value }
        } else {
            cond = this.parseExprNoStruct()
        }
        const then = this.parseHeaderBlock("`if`")
        let elseBranch: A.Block | A.Expr | null = null
        if (this.at("else")) {
            this.advance()
            elseBranch = this.at("if") ? this.parseIf() : this.parseHeaderBlock("`else`")
        }
        return { kind: "If", span: this.sp(start), cond, then, else: elseBranch }
    }

    private parseFor(labelTok: Token | null): A.Expr {
        const start = labelTok ?? this.cur
        const kw = this.advance()           // `for` (or a reserved `while` / `loop`)
        const label = labelTok ? (labelTok.value as string) : null
        const node = (form: "infinite" | "cond" | "let" | "in", fields: { await?: boolean, pattern?: A.Pattern | null, pattern2?: A.Pattern | null, expr?: A.Expr | null }, body: A.Block): A.Expr => ({
            kind: "For", span: this.sp(start), label, form,
            await: fields.await ?? false, pattern: fields.pattern ?? null, pattern2: fields.pattern2 ?? null, expr: fields.expr ?? null, body,
        })

        if (kw.kind === "loop" || this.at("{")) {
            return node("infinite", {}, this.loopBody(label))
        }
        if (kw.kind === "for" && this.at("let")) {
            this.advance()
            const pattern = this.parsePattern()
            this.expect("=")
            const expr = this.parseExprNoStruct()
            return node("let", { pattern, expr }, this.loopBody(label))
        }
        if (kw.kind === "for" && this.headerHasIn()) {
            const isAwait = this.eat("await") !== null
            let pattern: A.Pattern
            if (this.at("in")) {
                this.report("E_INVALID_PATTERN", "expected a pattern before `in`: `for x in items`")
                pattern = { kind: "PError", span: this.sp(this.cur) }
            } else {
                pattern = this.parsePattern()
            }
            let pattern2: A.Pattern | null = null
            if (this.eat(",")) pattern2 = this.parsePattern()
            this.expect("in")
            const expr = this.parseExprNoStruct()
            return node("in", { await: isAwait, pattern, pattern2, expr }, this.loopBody(label))
        }
        const expr = this.parseExprNoStruct()
        return node("cond", { expr }, this.loopBody(label))
    }

    private loopBody(label: string | null): A.Block {
        if (label !== null) this.labels.push(label)
        try {
            return this.parseHeaderBlock("`for`")
        } finally {
            if (label !== null) this.labels.pop()
        }
    }

    /** Is there an `in` at depth 0 between here and the header's `{` (on this line)? */
    private headerHasIn(): boolean {
        let k = this.i
        while (k < this.t.length) {
            const tok = this.t[k]!
            if (tok.kind === "EOF" || (k > this.i && tok.nl_before) || tok.kind === "{") return false
            if (tok.kind === "in") return true
            k = tok.match !== undefined && tok.match > k ? tok.match + 1 : k + 1
        }
        return false
    }

    private parseMatch(): A.Expr {
        const start = this.advance()
        const subject = this.at("{") ? null : this.parseExprNoStruct()
        if (!this.at("{")) this.fail("E_UNEXPECTED_TOKEN", `expected \`{\` after the \`match\` subject, found ${describe(this.cur)}`)
        if (this.cur.nl_before) this.reportBraceNewline("the `{` of `match` goes on the same line")
        const open = this.advance()
        const end = this.closerIndex(open)
        const arms: A.MatchArm[] = []
        this.group(true, () => {
            while (this.i < end && !this.at("EOF")) {
                if (this.at(",") || this.at(";")) { this.advance(); continue }
                const armStart = this.i
                try {
                    arms.push(this.parseMatchArm(subject !== null))
                    this.endArm(end)
                } catch (e) {
                    if (!(e instanceof Sync)) throw e
                    this.syncFrom(armStart, end, e.at, (tok) => tok.kind === ",")
                }
            }
        })
        this.jumpTo(end)
        this.expect("}")
        return { kind: "Match", span: this.sp(start), subject, arms }
    }

    private parseMatchArm(hasSubject: boolean): A.MatchArm {
        const start = this.cur
        let pattern: A.Pattern | null = null
        let test: A.Expr | null = null
        let guard: A.Expr | null = null
        if (hasSubject) {
            pattern = this.parsePattern()
            if (this.eat("if")) guard = this.parseExpr()
        } else if (this.at("_") && this.peek().kind === "=>") {
            this.advance()
            pattern = { kind: "PWild", span: this.sp(start) }
        } else {
            test = this.parseExpr()
        }
        this.expect("=>")
        const body = this.parseExpr()
        return { kind: "MatchArm", span: this.sp(start), pattern, test, guard, body }
    }

    /** After an arm: `,`, a newline, or the closing `}`. */
    private endArm(end: number): void {
        if (this.at(",")) { this.advance(); return }
        if (this.i >= end || this.cur.nl_before) return
        this.fail("E_UNEXPECTED_TOKEN", `expected \`,\` or a newline after the arm, found ${describe(this.cur)}`)
    }

    private parseSelect(): A.Expr {
        const start = this.advance()
        if (!this.at("{")) this.fail("E_UNEXPECTED_TOKEN", `expected \`{\` after \`select\`, found ${describe(this.cur)}`)
        if (this.cur.nl_before) this.reportBraceNewline("the `{` of `select` goes on the same line")
        const open = this.advance()
        const end = this.closerIndex(open)
        const arms: A.SelectArm[] = []
        let elseBody: A.Expr | null = null
        let elseTok: Token | null = null
        let elseReported = false
        let sawArm = false
        this.group(true, () => {
            while (this.i < end && !this.at("EOF")) {
                if (this.at(",") || this.at(";")) { this.advance(); continue }
                const armStart = this.i
                sawArm = true
                try {
                    if (this.at("else")) {
                        const tok = this.advance()
                        if (elseTok !== null) this.report("E_SELECT_ELSE_NOT_LAST", "a `select` has at most one `else` arm, and it comes last", tok)
                        this.expect("=>")
                        const body = this.parseExpr()
                        elseBody ??= body
                        elseTok = tok
                    } else {
                        if (elseTok !== null && !elseReported) {
                            this.report("E_SELECT_ELSE_NOT_LAST", "the `else` arm of a `select` must come last", elseTok)
                            elseReported = true
                        }
                        arms.push(this.parseSelectArm(end))
                    }
                    this.endArm(end)
                } catch (e) {
                    if (!(e instanceof Sync)) throw e
                    this.syncFrom(armStart, end, e.at, (tok) => tok.kind === ",")
                }
            }
        })
        this.jumpTo(end)
        this.expect("}")
        if (!sawArm) this.report("E_SELECT_EMPTY", "a `select` needs at least one arm", start)
        return { kind: "Select", span: this.sp(start), arms, else: elseBody }
    }

    private parseSelectArm(end: number): A.SelectArm {
        const start = this.cur
        let pattern: A.Pattern | null = null
        if (this.selectArmHasPattern(end)) {
            pattern = this.parsePattern()
            this.expect("=")
        }
        const expr = this.parseExpr()
        this.expect("=>")
        const body = this.parseExpr()
        return { kind: "SelectArm", span: this.sp(start), pattern, expr, body }
    }

    /** `pattern = expr => body` iff a depth-0 `=` comes before the arm's `=>` (spec §4.9). */
    private selectArmHasPattern(end: number): boolean {
        let k = this.i
        while (k < end) {
            const tok = this.t[k]!
            if ((k > this.i && tok.nl_before) || tok.kind === "=>" || tok.kind === ",") return false
            if (tok.kind === "=") return true
            k = tok.match !== undefined && tok.match > k ? tok.match + 1 : k + 1
        }
        return false
    }

    // ---- patterns -----------------------------------------------------------------------------

    parsePattern(): A.Pattern {
        const start = this.cur
        const first = this.parsePatternAlt()
        if (!this.at("|")) return first
        const alts = [first]
        while (this.eat("|")) alts.push(this.parsePatternAlt())
        return { kind: "POr", span: this.sp(start), alts }
    }

    private parsePatternAlt(): A.Pattern {
        const start = this.cur
        switch (start.kind) {
            case "_":
                this.advance()
                return { kind: "PWild", span: this.sp(start) }
            case "mut": {
                this.advance()
                const name = this.identName("a binding name")
                return { kind: "PBind", span: this.sp(start), name, mut: true }
            }
            case "-":
            case "Int": case "Float": case "String": case "RawString": case "Char": case "true": case "false": case "nil": {
                const lit = this.parsePatternLiteral()
                return this.maybeRangePattern(start, lit)
            }
            case "..":
            case "..=": {
                this.advance()
                const end = this.parsePatternLiteral()
                return { kind: "PRange", span: this.sp(start), op: start.kind, start: null, end }
            }
            case "t(": {
                this.advance()
                const { elems, rest } = this.group(false, () => this.patternList(")"))
                this.jumpTo(this.closerIndex(start))
                this.expect(")")
                return { kind: "PTuple", span: this.sp(start), elems, rest }
            }
            case "(": {
                this.report("E_BARE_TUPLE", "tuple patterns are written `t(a, b)`")
                this.advance()
                const { elems, rest } = this.group(false, () => this.patternList(")"))
                this.jumpTo(this.closerIndex(start))
                this.expect(")")
                if (elems.length === 1 && !rest) return elems[0]!
                return { kind: "PTuple", span: this.sp(start), elems, rest }
            }
            case "r{": {
                const { fields, rest } = this.patternFields()
                return { kind: "PStruct", span: this.sp(start), path: null, fields, rest }
            }
            case "Ident":
            case "Self": {
                const path = [start.kind === "Self" ? "Self" : (start.value as string)]
                this.advance()
                while (this.at(".") && this.peek().kind === "Ident") {
                    this.advance()
                    path.push(this.advance().value as string)
                }
                if (this.at("(") && !this.cur.nl_before) {
                    const open = this.advance()
                    const { elems, rest } = this.group(false, () => this.patternList(")"))
                    this.jumpTo(this.closerIndex(open))
                    this.expect(")")
                    return { kind: "PCall", span: this.sp(start), path, args: elems, rest }
                }
                const isConstructor = path.length > 1 || isUpper(path[0]!)
                if (isConstructor && this.at("{") && !this.cur.nl_before) {
                    const { fields, rest } = this.patternFields()
                    return { kind: "PStruct", span: this.sp(start), path, fields, rest }
                }
                if (!isConstructor) return { kind: "PBind", span: this.sp(start), name: path[0]!, mut: false }
                return { kind: "PPath", span: this.sp(start), path }
            }
        }
        if (isKeyword(start.kind) && !RESERVED_KEYWORDS.has(start.kind)) {
            this.report("E_KEYWORD_AS_IDENT", `\`${start.kind}\` is a keyword and can't be used as a binding name`)
            this.advance()
            return { kind: "PBind", span: this.sp(start), name: start.kind, mut: false }
        }
        return this.fail("E_INVALID_PATTERN", `expected a pattern, found ${describe(start)}`)
    }

    private parsePatternLiteral(): A.Expr {
        const start = this.cur
        if (this.at("-")) {
            this.advance()
            const tok = this.cur
            if (tok.kind !== "Int" && tok.kind !== "Float") this.fail("E_INVALID_PATTERN", "expected a number after `-` in a pattern")
            const inner = this.parsePrimary()
            return { kind: "Unary", span: this.sp(start), op: "-", expr: inner }
        }
        if (!PATTERN_LITERAL.has(start.kind)) this.fail("E_INVALID_PATTERN", `expected a literal, found ${describe(start)}`)
        return this.parsePrimary()
    }

    private maybeRangePattern(start: Token, lit: A.Expr): A.Pattern {
        if (!this.at("..") && !this.at("..=")) return { kind: "PLit", span: this.sp(start), value: lit }
        const op = this.advance().kind as ".." | "..="
        const tok = this.cur
        const hasEnd = (PATTERN_LITERAL.has(tok.kind) || tok.kind === "-") && !tok.nl_before
        const end = hasEnd ? this.parsePatternLiteral() : null
        if (end === null && op === "..=") this.fail("E_INVALID_PATTERN", "`..=` needs an upper bound")
        return { kind: "PRange", span: this.sp(start), op, start: lit, end }
    }

    private patternList(close: TokenKind): { elems: A.Pattern[], rest: boolean } {
        const elems: A.Pattern[] = []
        let rest = false
        while (!this.at(close) && !this.at("EOF")) {
            if (this.at("..")) {
                this.advance()
                rest = true
            } else {
                elems.push(this.parsePattern())
            }
            if (!this.eat(",")) break
        }
        return { elems, rest }
    }

    private patternFields(): { fields: A.PatField[], rest: boolean } {
        const open = this.advance()
        const fields: A.PatField[] = []
        let rest = false
        this.group(true, () => {
            while (!this.at("}") && !this.at("EOF")) {
                if (this.at("..")) {
                    this.advance()
                    rest = true
                } else {
                    const start = this.cur
                    const name = this.identName("a field name")
                    let pattern: A.Pattern | null = null
                    if (this.eat(":")) pattern = this.parsePattern()
                    fields.push({ kind: "PatField", span: this.sp(start), name, pattern })
                }
                if (this.eat(",")) continue
                if (this.at("}") || this.cur.nl_before) continue
                this.fail("E_UNEXPECTED_TOKEN", `expected \`,\` or \`}\` in the pattern, found ${describe(this.cur)}`)
            }
        })
        this.jumpTo(this.closerIndex(open))
        this.expect("}")
        return { fields, rest }
    }
}
