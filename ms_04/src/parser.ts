// The MinScript parser (spec §2–§8, grammar §19): recursive descent for items, statements, types
// and patterns; Pratt parsing for expressions (precedence §3).
//
// Newlines are not tokens. The rules of §5.4 use each token's `nlBefore`: `nlSig` is true inside
// `{…}` and false inside `(…)` / `[…]`; where it is true, an infix operator on a new line ends the
// expression unless it is one of the continuation tokens. Postfix `(`, `[`, `.[` and `?` never
// cross a newline; `.` and `?.` always may.
//
// Errors: `report()` records a diagnostic where the intended form is clear and parsing goes on;
// `fail()` records one and throws `Sync`, caught at the nearest statement / item / member / arm /
// list element, which skips to the next one. Each mistake gives exactly one diagnostic.

import type * as A from "./ast.ts";
import { diag, type Diagnostic } from "./diagnostic.ts";
import { lex, type LexResult } from "./lexer.ts";
import { KEYWORDS, RESERVED_KEYWORDS, type Token } from "./token.ts";

export interface ParseResult {
    file: A.File;
    lexed: LexResult;
    /** lexer diagnostics first, then parser diagnostics */
    diagnostics: Diagnostic[];
}

export function parse(text: string | Uint8Array): ParseResult {
    const lexed = lex(text);
    const p = new Parser(lexed);
    const file = p.parseFile();
    return { file, lexed, diagnostics: [...lexed.diagnostics, ...p.diagnostics] };
}

class Sync extends Error {}

type Assoc = "left" | "right" | "none";

const INFIX: Readonly<Record<string, [number, Assoc]>> = {
    "=": [1, "right"], "+=": [1, "right"], "-=": [1, "right"], "*=": [1, "right"], "/=": [1, "right"],
    "%=": [1, "right"], "&=": [1, "right"], "|=": [1, "right"], "^=": [1, "right"], "<<=": [1, "right"],
    ">>=": [1, "right"], "??=": [1, "right"],
    or: [2, "left"],
    "..": [3, "none"], "..=": [3, "none"],
    "??": [4, "right"],
    "||": [5, "left"],
    "&&": [6, "left"],
    "==": [7, "none"], "!=": [7, "none"], "<": [7, "none"], "<=": [7, "none"], ">": [7, "none"], ">=": [7, "none"],
    "|": [8, "left"],
    "^": [9, "left"],
    "&": [10, "left"],
    "<<": [11, "left"], ">>": [11, "left"],
    "+": [12, "left"], "-": [12, "left"],
    "*": [13, "left"], "/": [13, "left"], "%": [13, "left"],
    as: [14, "left"],
};
const BP_ASSIGN = 1;
const BP_OR = 2;
const BP_RANGE = 3;
const BP_COMPARE = 7;

/** An infix token on a new line continues the expression only if it is one of these (§5.4 rule 2). */
const CONTINUES: ReadonlySet<string> = new Set([".", "?.", "&&", "||", "??", "or", "as"]);

/** Tokens the closure-header scan accepts before `=>` (§4.4). */
const CLOSURE_HEADER: ReadonlySet<string> = new Set(["Ident", "_", "var", "mut", ",", ":", "*", "&", "->", "?", ".", "Self"]);

const ITEM_START: ReadonlySet<string> = new Set([
    "pub", "fn", "fun", "async", "type", "union", "inter", "impl", "let", "var", "extern", "import", "#[",
]);

const isUpper = (name: string) => name.length > 0 && name[0]! >= "A" && name[0]! <= "Z";

class Parser {
    readonly toks: Token[];
    readonly src: Uint8Array;
    i = 0;
    diagnostics: Diagnostic[] = [];
    /** newlines end expressions here (inside `{…}`, not inside `(…)` / `[…]`) */
    nlSig = true;
    /** in an `if` / `for` / `match` / `lock` header: `Name {` is not a struct literal */
    noStruct = false;
    /** labels of the enclosing loops (closures start a new list) */
    labels: string[] = [];
    imports: A.Import[] = [];
    /** start offsets already reported, so one mistake gives one diagnostic */
    reported = new Set<number>();

    constructor(lexed: LexResult) {
        this.toks = lexed.tokens;
        this.src = lexed.src;
        for (const d of lexed.diagnostics) this.reported.add(d.start);
    }

    // ---- token helpers ------------------------------------------------------------------------

    get tok(): Token {
        return this.toks[this.i]!;
    }

    peek(k = 1): Token {
        return this.toks[Math.min(this.i + k, this.toks.length - 1)]!;
    }

    at(kind: string): boolean {
        return this.tok.kind === kind;
    }

    atIdent(name: string): boolean {
        return this.tok.kind === "Ident" && this.tok.value === name;
    }

    advance(): Token {
        const t = this.tok;
        if (this.i < this.toks.length - 1) this.i++;
        return t;
    }

    eat(kind: string): boolean {
        if (!this.at(kind)) return false;
        this.advance();
        return true;
    }

    text(t: Token): string {
        if (t.kind === "Ident") return t.value as string;
        if (t.kind === "EOF") return "end of file";
        return new TextDecoder().decode(this.src.subarray(t.start, t.end)) || t.kind;
    }

    describe(t: Token): string {
        return t.kind === "EOF" ? "end of file" : `\`${this.text(t)}\``;
    }

    /** Span from offset `start` to the end of the last consumed token. */
    sp(start: number): A.Span {
        const prev = this.toks[this.i - 1];
        return { start, end: prev && prev.end > start ? prev.end : start };
    }

    report(code: string, message: string, t: Token = this.tok, fix?: string, end?: number): void {
        if (t.synthetic || this.reported.has(t.start)) return;
        this.reported.add(t.start);
        this.diagnostics.push(diag(code, message, t.start, end ?? t.end, fix));
    }

    fail(code: string, message: string, t: Token = this.tok, fix?: string): never {
        this.report(code, message, t, fix);
        throw new Sync();
    }

    unexpected(what: string): never {
        this.fail("E_UNEXPECTED_TOKEN", `expected ${what}, found ${this.describe(this.tok)}`);
    }

    expect(kind: string, what = `\`${kind}\``): Token {
        if (!this.at(kind)) this.unexpected(what);
        return this.advance();
    }

    /** Skips one token, or a whole bracket group. */
    skipOne(): void {
        const t = this.tok;
        if (t.match !== undefined && t.match > this.i) this.i = t.match + 1;
        else this.advance();
    }

    /** After a failed statement: skip to the next statement (`;`, a newline) before index `end`. */
    syncStmt(end: number, start: number): void {
        if (this.i <= start && this.i < end) this.skipOne();
        while (this.i < end) {
            if (this.at(";")) {
                this.advance();
                return;
            }
            if (this.tok.nlBefore) return;
            this.skipOne();
        }
    }

    /** After a failed list element: skip to the next `,` (or newline, where newlines separate). */
    syncList(end: number, start: number, newlines: boolean): void {
        if (this.i <= start && this.i < end) this.skipOne();
        while (this.i < end) {
            if (this.at(",")) return;
            if (newlines && this.tok.nlBefore) return;
            this.skipOne();
        }
    }

    syncItem(start: number): void {
        if (this.i <= start) this.skipOne();
        while (!this.at("EOF")) {
            if (this.tok.nlBefore && (ITEM_START.has(this.tok.kind) || this.atSharedVar())) return;
            this.skipOne();
        }
    }

    /** Runs `f` inside a bracket group: newline significance as given, struct literals allowed. */
    group<T>(nlSig: boolean, f: () => T): T {
        const saved = [this.nlSig, this.noStruct] as const;
        this.nlSig = nlSig;
        this.noStruct = false;
        try {
            return f();
        } finally {
            [this.nlSig, this.noStruct] = saved;
        }
    }

    /** Runs `f` in an `if` / `for` / `match` / `lock` header. */
    header<T>(f: () => T): T {
        const saved = this.noStruct;
        this.noStruct = true;
        try {
            return f();
        } finally {
            this.noStruct = saved;
        }
    }

    /**
     * Parses comma-separated elements up to the closer at index `close`, then consumes it.
     * With `newlines`, a newline also separates elements, and so does plain juxtaposition when
     * `juxtapose` says the next token starts an element (union variants, type members).
     */
    list<T>(close: number, newlines: boolean, item: () => T, juxtapose?: () => boolean): T[] {
        const out: T[] = [];
        while (this.i < close) {
            const start = this.i;
            try {
                out.push(item());
            } catch (e) {
                if (!(e instanceof Sync)) throw e;
                this.syncList(close, start, newlines);
                if (this.at(",")) this.advance();
                continue;
            }
            if (this.i >= close) break;
            if (this.eat(",")) continue;
            if (newlines && this.tok.nlBefore) continue;
            if (juxtapose?.()) continue;
            this.report("E_UNEXPECTED_TOKEN", `expected \`,\` or \`${this.text(this.toks[close]!)}\`, found ${this.describe(this.tok)}`);
            this.syncList(close, this.i, newlines);
            this.eat(",");
        }
        this.i = close + 1;
        return out;
    }

    /** The matching closer of the opener at the current position. */
    closeOf(t: Token = this.tok): number {
        return t.match ?? this.toks.length - 1;
    }

    atSharedVar(): boolean {
        return this.atIdent("shared") && (this.peek().kind === "var" || this.peek().kind === "let");
    }

    // ---- names --------------------------------------------------------------------------------

    /** A binding name: an identifier; a keyword is reported and used as written. */
    bindingName(what = "a name"): string {
        const t = this.tok;
        if (t.kind === "Ident") {
            this.advance();
            return t.value as string;
        }
        if (KEYWORDS.has(t.kind)) {
            this.report("E_KEYWORD_AS_IDENT", `\`${t.kind}\` is a keyword and can't be ${what}`);
            this.advance();
            return t.kind;
        }
        this.unexpected(what);
    }

    /** A declared function or method name: keywords are allowed (§8.1, `pub fn yield`). */
    fnName(): string {
        const t = this.tok;
        if (t.kind === "Ident") return this.advance().value as string;
        if (KEYWORDS.has(t.kind)) {
            this.advance();
            return t.kind;
        }
        this.unexpected("a function name");
    }

    // ---- file and items -----------------------------------------------------------------------

    parseFile(): A.File {
        const start = this.tok.start;
        let pkg: string[] = [];
        try {
            if (!this.at("package")) this.unexpected("`package`");
            this.advance();
            // `package unsafe` is std.unsafe (§8.6): the one keyword that names a package
            const segment = () => (this.at("unsafe") ? (this.advance(), "unsafe") : this.bindingName("a package name"));
            pkg = [segment()];
            while (this.eat(".")) pkg.push(segment());
        } catch (e) {
            if (!(e instanceof Sync)) throw e;
            this.syncItem(this.i);
        }
        while (this.at("import")) {
            const s = this.i;
            try {
                this.imports.push(this.parseImport());
            } catch (e) {
                if (!(e instanceof Sync)) throw e;
                this.syncItem(s);
            }
        }
        const items: A.Item[] = [];
        while (!this.at("EOF")) {
            const s = this.i;
            try {
                const item = this.parseItem();
                if (item) items.push(item);
                if (!this.at("EOF") && !this.tok.nlBefore && !this.at(";")) {
                    this.fail("E_UNEXPECTED_TOKEN", `expected a new line after the item, found ${this.describe(this.tok)}`);
                }
                this.eat(";");
            } catch (e) {
                if (!(e instanceof Sync)) throw e;
                this.syncItem(s);
            }
        }
        return { kind: "File", span: { start, end: this.tok.end }, package: pkg, imports: this.imports, items };
    }

    parseImport(): A.Import {
        const start = this.expect("import").start;
        const isPub = this.eat("pub");
        if (!this.at("String")) this.unexpected("an import path string");
        const path = this.advance().value as string;
        let alias: string | null = null;
        if (this.eat("as")) alias = this.bindingName("an import alias");
        return { kind: "Import", span: this.sp(start), isPub, path, alias };
    }

    parseAttributes(): A.Attribute[] {
        const attrs: A.Attribute[] = [];
        while (this.at("#[")) {
            const open = this.tok;
            const close = this.closeOf();
            this.advance();
            try {
                if (!this.at("Ident")) this.fail("E_INVALID_ATTRIBUTE", "expected an attribute name");
                const name = this.advance().value as string;
                const args: A.AttrArg[] = [];
                if (this.at("(")) {
                    const c = this.closeOf();
                    this.advance();
                    args.push(...this.group(false, () => this.list(c, false, () => this.parseAttrArg())));
                }
                if (this.i !== close) this.fail("E_INVALID_ATTRIBUTE", "malformed attribute: expected `]`");
                this.i = close + 1;
                attrs.push({ kind: "Attribute", span: this.sp(open.start), name, args });
            } catch (e) {
                if (!(e instanceof Sync)) throw e;
                this.i = close + 1;
            }
            if (!this.tok.nlBefore && !this.at("#[")) {
                this.report("E_INVALID_ATTRIBUTE", "an attribute goes on its own line, before an item or member", open, undefined, this.toks[close]!.end);
            }
        }
        return attrs;
    }

    parseAttrArg(): A.AttrArg {
        const start = this.tok.start;
        const bad = (): never => this.fail("E_INVALID_ATTRIBUTE", "attribute arguments are lists of paths: `keeps: [v, this.items]`");
        if (!this.at("Ident")) bad();
        const name = this.advance().value as string;
        if (!this.eat(":") || !this.at("[")) bad();
        const c = this.closeOf();
        this.advance();
        const paths = this.list(c, false, () => {
            if (!this.at("this") && !this.at("Ident")) bad();
            const parts = [this.at("this") ? (this.advance(), "this") : (this.advance().value as string)];
            while (this.eat(".")) {
                if (!this.at("Ident")) bad();
                parts.push(this.advance().value as string);
            }
            return parts.join(".");
        });
        return { name, paths, span: this.sp(start) };
    }

    parseItem(): A.Item | null {
        const attrs = this.parseAttributes();
        const start = this.tok.start;
        const isPub = this.eat("pub");
        const t = this.tok;
        switch (t.kind) {
            case "fn": case "fun": case "async":
                return this.parseFn(attrs, isPub, start, "item");
            case "type":
                return this.parseTypeDecl(attrs, isPub, start);
            case "union":
                return this.parseUnion(attrs, isPub, start);
            case "inter":
                return this.parseInter(attrs, isPub, start);
            case "impl":
                return this.parseImpl(attrs, start);
            case "let":
                return this.parseTopLet(attrs, isPub, start);
            case "var":
                return this.parseTopVar(attrs, isPub, false, start);
            case "extern":
                return this.parseExtern(attrs, start);
            case "import": {
                this.report("E_IMPORT_AFTER_ITEM", "imports go before the first item");
                this.imports.push(this.parseImport());
                return null;
            }
        }
        if (this.atSharedVar()) {
            this.advance();
            if (this.at("let")) {
                this.report("E_SHARED_IMMUTABLE", "`shared let`: immutable values are already shared", t, "shared var");
                return this.parseTopLet(attrs, isPub, start);
            }
            return this.parseTopVar(attrs, isPub, true, start);
        }
        if (RESERVED_KEYWORDS.has(t.kind)) this.fail("E_RESERVED_KEYWORD", `\`${t.kind}\` is reserved`);
        this.fail("E_TOP_LEVEL_STATEMENT", "only declarations are allowed at the top level");
    }

    parseTopLet(attrs: A.Attribute[], isPub: boolean, start: number): A.LetDecl {
        this.expect("let");
        const name = this.bindingName();
        const type = this.eat(":") ? this.parseType() : null;
        this.expectAssign();
        const value = this.parseExpr(0);
        return { kind: "LetDecl", span: this.sp(start), attrs, isPub, name, type, value };
    }

    parseTopVar(attrs: A.Attribute[], isPub: boolean, shared: boolean, start: number): A.VarDecl {
        this.expect("var");
        const name = this.bindingName();
        const type = this.eat(":") ? this.parseType() : null;
        this.expectAssign();
        const value = this.parseExpr(0);
        return { kind: "VarDecl", span: this.sp(start), attrs, isPub, shared, name, type, value };
    }

    expectAssign(): void {
        if (this.at(":=") || this.at(":==")) {
            this.report("E_SHORT_DECL_TARGET", "`let x :=` mixes two forms: write `let x =` or `x :=`", this.tok, "=");
            this.advance();
            return;
        }
        this.expect("=");
    }

    /** `[async] fn name[G](params) -> R { body }`. `ctx`: item (body required), sig (optional). */
    parseFn(attrs: A.Attribute[], isPub: boolean, start: number, ctx: "item" | "sig"): A.FnDecl {
        const isAsync = this.eat("async");
        if (this.at("fun")) this.report("E_RESERVED_KEYWORD", "`fun` is now `fn`", this.tok, "fn");
        else if (!this.at("fn")) this.unexpected("`fn`");
        this.advance();
        const name = this.fnName();
        const generics = this.parseGenericParams();
        if (!this.at("(")) this.unexpected("`(`");
        const { receiver, params } = this.parseParams();
        let retStar = false;
        let ret: A.Type | null = null;
        if (this.eat("->")) {
            if (this.at("*")) {
                this.advance();
                retStar = true;
            }
            ret = this.parseType(true);
        }
        let body: A.Block | null = null;
        if (this.at("{")) body = this.parseBlock(true);
        else if (ctx === "item") this.unexpected("`{`");
        return { kind: "Fn", span: this.sp(start), attrs, isPub, isAsync, name, generics, receiver, params, retStar, ret, body };
    }

    parseGenericParams(): A.GenericParam[] {
        if (!this.at("[") || this.tok.wsBefore) return [];
        const close = this.closeOf();
        if (close === this.i + 1) {
            this.report("E_EXPECTED_TYPE_ARGUMENTS", "empty generic parameter list");
            this.i = close + 1;
            return [];
        }
        this.advance();
        return this.group(false, () =>
            this.list(close, false, () => {
                const start = this.tok.start;
                const name = this.expect("Ident", "a type parameter").value as string;
                const bounds: A.Type[] = [];
                if (this.eat(":")) {
                    bounds.push(this.parsePostfixType());
                    while (this.eat("&")) bounds.push(this.parsePostfixType());
                }
                return { name, bounds, span: this.sp(start) };
            }),
        );
    }

    parseParams(): { receiver: A.FnDecl["receiver"]; params: A.Param[] } {
        const close = this.closeOf();
        this.advance();
        let receiver: A.FnDecl["receiver"] = null;
        let first = true;
        const params: A.Param[] = [];
        this.group(false, () =>
            this.list(close, false, () => {
                const wasFirst = first;
                first = false;
                if (wasFirst) {
                    const r = this.tryReceiver();
                    if (r) {
                        receiver = r;
                        return;
                    }
                }
                params.push(this.parseParam());
            }),
        );
        for (let k = 0; k < params.length - 1; k++) {
            const p = params[k]!;
            if (p.variadic) {
                this.diagnostics.push(diag("E_VARIADIC_NOT_LAST", "a variadic parameter must be the last one", p.span.start, p.span.end));
            }
        }
        return { receiver, params };
    }

    /** `this`, `*this`, and the removed `&this`, `&mut this`, `mut this`, `self`. */
    tryReceiver(): A.FnDecl["receiver"] {
        const t = this.tok;
        const next = this.peek();
        const isSelf = (k: Token) => k.kind === "Ident" && k.value === "self";
        if (t.kind === "this") {
            this.advance();
            return "this";
        }
        if (isSelf(t) && next.kind !== ":") {
            this.report("E_UNKNOWN_RECEIVER", "the receiver is `this`", t, "this");
            this.advance();
            return "this";
        }
        if (t.kind === "*" && (next.kind === "this" || isSelf(next))) {
            if (isSelf(next)) this.report("E_UNKNOWN_RECEIVER", "the receiver is `*this`", next, "*this");
            this.i += 2;
            return "*this";
        }
        if (t.kind === "mut" && next.kind === "this") {
            this.report("E_MUT_REMOVED", "`mut this` is removed", t, "*this");
            this.i += 2;
            return "*this";
        }
        if (t.kind === "&") {
            const isMut = next.kind === "mut";
            const target = this.peek(isMut ? 2 : 1);
            if (target.kind === "this" || isSelf(target)) {
                this.report("E_BORROW_REMOVED", `\`&${isMut ? "mut " : ""}this\` is removed`, t, isMut ? "*this" : "this");
                this.i += isMut ? 3 : 2;
                return isMut ? "*this" : "this";
            }
        }
        return null;
    }

    parseParam(): A.Param {
        const start = this.tok.start;
        const variadic = this.eat("...");
        if (this.at("mut")) {
            this.report("E_MUT_REMOVED", "`mut` parameters are removed: use `x: *T`, or `var x = x` in the body", this.tok, "*T");
            this.advance();
        }
        if (this.at("&") || this.at("*")) {
            this.fail("E_INVALID_PARAM", "a parameter is `name: T` or `name: *T`");
        }
        const name = this.bindingName("a parameter name");
        if (!this.at(":")) {
            this.fail("E_EXPECTED_COLON", `parameter \`${name}\` needs a type: \`${name}: T\``);
        }
        this.advance();
        const { star, type } = this.parseModeType();
        return { name, star, variadic, type, span: this.sp(start) };
    }

    /** `T` or `*T`, as in a parameter; `&T` / `&mut T` are reported (§8.3). */
    parseModeType(): { star: boolean; type: A.Type } {
        if (this.at("*")) {
            this.advance();
            return { star: true, type: this.parseType() };
        }
        if (this.at("&")) {
            const amp = this.advance();
            const isMut = this.eat("mut");
            this.report("E_BORROW_REMOVED", `\`&${isMut ? "mut " : ""}T\` is removed: a parameter is \`T\` (read) or \`*T\` (write)`, amp, isMut ? "*T" : "T");
            return { star: isMut, type: this.parseType() };
        }
        return { star: false, type: this.parseType() };
    }

    parseImplList(): A.Type[] {
        const out: A.Type[] = [];
        if (!this.eat(":")) return out;
        out.push(this.parsePostfixType());
        while (this.eat(",")) out.push(this.parsePostfixType());
        return out;
    }

    /** After `type` / `union` / `inter` and the header: `{`, or `=` and an alias (§7.4). */
    parseTypeDecl(attrs: A.Attribute[], isPub: boolean, start: number): A.TypeDecl | A.UnionDecl {
        this.expect("type");
        const name = this.bindingName("a type name");
        const generics = this.parseGenericParams();
        const impls = this.parseImplList();
        if (this.at("=")) {
            const eq = this.advance();
            if (this.at("{")) {
                this.report("E_TYPE_EQUALS_BODY", "a nominal type has no `=` before its body", eq, "remove `=`");
            } else if (this.at("|")) {
                this.report("E_LEADING_PIPE_UNION", "`type X = | A | B` is now a union", eq, `union ${name} { A  B }`);
                const members = this.parsePipeUnion();
                return { kind: "UnionDecl", span: this.sp(start), attrs, isPub, name, generics, impls, members };
            } else {
                const alias = this.parseType();
                return { kind: "TypeDecl", span: this.sp(start), attrs, isPub, name, generics, impls, members: null, alias };
            }
        }
        if (!this.at("{")) this.unexpected("`{` or `=`");
        const members = this.parseMembers();
        return { kind: "TypeDecl", span: this.sp(start), attrs, isPub, name, generics, impls, members, alias: null };
    }

    /** Recovery for the old `type X = | A | B(T)` form. */
    parsePipeUnion(): A.Variant[] {
        const out: A.Variant[] = [];
        while (this.eat("|")) out.push(this.parseVariant());
        return out;
    }

    braceOnHeaderLine(): void {
        if (this.at("{") && this.tok.nlBefore) {
            this.report("E_OPEN_BRACE_NEWLINE", "`{` goes on the header line");
        }
    }

    parseMembers(): A.TypeMember[] {
        this.braceOnHeaderLine();
        const close = this.closeOf();
        this.advance();
        return this.group(true, () => this.list(close, true, () => this.parseMember(), () => this.memberStart()));
    }

    memberStart(): boolean {
        const k = this.tok.kind;
        return k === "Ident" || k === "pub" || k === "fn" || k === "fun" || k === "async" || k === "#[";
    }

    parseMember(): A.TypeMember {
        const attrs = this.parseAttributes();
        const start = this.tok.start;
        const isPub = this.eat("pub");
        if (this.at("fn") || this.at("fun") || this.at("async")) return this.parseFn(attrs, isPub, start, "item");
        return this.parseField(attrs, isPub, start);
    }

    parseField(attrs: A.Attribute[], isPub: boolean, start: number): A.Field {
        let mode: A.Field["mode"] = null;
        if ((this.atIdent("shared") || this.atIdent("once")) && this.peek().kind === "Ident" && this.peek(2).kind === ":") {
            mode = this.advance().value as "shared" | "once";
        } else if (this.at("mut")) {
            this.report("E_MUT_REMOVED", "fields have no `mut`: use `shared` for a field every copy sees");
            this.advance();
        }
        const name = this.bindingName("a field name");
        if (!this.at(":")) this.fail("E_EXPECTED_COLON", `field \`${name}\` needs a type: \`${name}: T\``);
        this.advance();
        if (this.at("*")) this.report("E_STAR_TYPE_NOT_PARAM", "`*T` is an access mode for parameters, not a field type", this.tok, "remove `*`");
        const type = this.parseType();
        const def = this.eat("=") ? this.parseExpr(0) : null;
        return { kind: "Field", span: this.sp(start), attrs, isPub, mode, name, type, default: def };
    }

    parseUnion(attrs: A.Attribute[], isPub: boolean, start: number): A.UnionDecl {
        this.expect("union");
        const name = this.bindingName("a union name");
        const generics = this.parseGenericParams();
        const impls = this.parseImplList();
        if (this.at("=")) {
            const eq = this.advance();
            this.report("E_TYPE_EQUALS_BODY", "a union has no `=` before its body", eq, "remove `=`");
        }
        if (!this.at("{")) this.unexpected("`{`");
        this.braceOnHeaderLine();
        const close = this.closeOf();
        this.advance();
        const members = this.group(true, () =>
            this.list(close, true, (): A.Variant | A.FnDecl => {
                const attrs2 = this.parseAttributes();
                const s = this.tok.start;
                const pub = this.eat("pub");
                if (this.at("fn") || this.at("fun") || this.at("async")) return this.parseFn(attrs2, pub, s, "item");
                return this.parseVariant();
            }, () => this.memberStart()),
        );
        return { kind: "UnionDecl", span: this.sp(start), attrs, isPub, name, generics, impls, members };
    }

    parseVariant(): A.Variant {
        const start = this.tok.start;
        const name = this.bindingName("a variant name");
        let tuple: A.Type[] | null = null;
        let fields: A.Field[] | null = null;
        if (this.at("(") && !this.tok.nlBefore) {
            const close = this.closeOf();
            this.advance();
            tuple = this.group(false, () => this.list(close, false, () => this.parseType()));
        } else if (this.at("{") && !this.tok.nlBefore) {
            const close = this.closeOf();
            this.advance();
            fields = this.group(true, () =>
                this.list(close, true, () => this.parseField([], false, this.tok.start), () => this.tok.kind === "Ident"),
            );
        }
        return { kind: "Variant", span: this.sp(start), name, tuple, fields };
    }

    parseInter(attrs: A.Attribute[], isPub: boolean, start: number): A.InterDecl {
        this.expect("inter");
        const name = this.bindingName("an interface name");
        const generics = this.parseGenericParams();
        const supers: A.Type[] = [];
        if (this.eat(":")) {
            supers.push(this.parsePostfixType());
            while (this.eat("&") || this.eat(",")) supers.push(this.parsePostfixType());
        }
        if (this.at("=")) {
            const eq = this.advance();
            if (this.at("{")) {
                this.report("E_TYPE_EQUALS_BODY", "an interface has no `=` before its body", eq, "remove `=`");
            } else {
                const alias = this.parseIntersectionType();
                return { kind: "InterDecl", span: this.sp(start), attrs, isPub, name, generics, supers, methods: null, alias };
            }
        }
        if (!this.at("{")) this.unexpected("`{` or `=`");
        this.braceOnHeaderLine();
        const close = this.closeOf();
        this.advance();
        const methods = this.group(true, () =>
            this.list(close, true, () => {
                const a = this.parseAttributes();
                const s = this.tok.start;
                const pub = this.eat("pub");
                return this.parseFn(a, pub, s, "sig");
            }, () => this.memberStart()),
        );
        return { kind: "InterDecl", span: this.sp(start), attrs, isPub, name, generics, supers, methods, alias: null };
    }

    parseImpl(attrs: A.Attribute[], start: number): A.ImplDecl {
        this.expect("impl");
        const generics = this.at("[") && !this.tok.wsBefore ? this.parseGenericParams() : [];
        let first = this.parsePostfixType();
        const inters: A.Type[] = [];
        if (this.at(",") || this.at("for")) {
            inters.push(first);
            while (this.eat(",")) inters.push(this.parsePostfixType());
            this.expect("for");
            first = this.parsePostfixType();
        }
        if (!this.at("{")) this.unexpected("`{`");
        this.braceOnHeaderLine();
        const close = this.closeOf();
        this.advance();
        const methods = this.group(true, () =>
            this.list(close, true, () => {
                const a = this.parseAttributes();
                const s = this.tok.start;
                const pub = this.eat("pub");
                return this.parseFn(a, pub, s, "item");
            }, () => this.memberStart()),
        );
        return { kind: "ImplDecl", span: this.sp(start), attrs, generics, inters, target: first, methods };
    }

    parseExtern(attrs: A.Attribute[], start: number): A.ExternDecl {
        this.expect("extern");
        if (!this.at("String")) this.unexpected("an ABI string such as \"C\"");
        const abi = this.advance().value as string;
        if (!this.at("{")) this.unexpected("`{`");
        const close = this.closeOf();
        this.advance();
        const fns = this.group(true, () =>
            this.list(close, true, () => {
                const a = this.parseAttributes();
                const s = this.tok.start;
                const pub = this.eat("pub");
                return this.parseFn(a, pub, s, "sig");
            }, () => this.memberStart()),
        );
        return { kind: "ExternDecl", span: this.sp(start), attrs, abi, fns };
    }

    // ---- types (§7.1) -------------------------------------------------------------------------

    /** A full type: literal unions and intersections. `retPos`: after `->` (no `*` report). */
    parseType(_retPos = false): A.Type {
        const start = this.tok.start;
        const first = this.parseIntersectionType();
        if (!this.at("|")) return first;
        const alts = [first];
        while (this.eat("|")) alts.push(this.parseIntersectionType());
        return { kind: "TUnion", span: this.sp(start), alts };
    }

    parseIntersectionType(): A.Type {
        const start = this.tok.start;
        const first = this.parsePostfixType();
        if (!this.at("&")) return first;
        const parts = [first];
        while (this.eat("&")) parts.push(this.parsePostfixType());
        return { kind: "TInter", span: this.sp(start), parts };
    }

    parsePostfixType(): A.Type {
        const start = this.tok.start;
        let t = this.parsePrimaryType();
        if (this.at("?") && !this.tok.nlBefore) {
            this.advance();
            t = { kind: "TOptional", span: this.sp(start), inner: t };
            if (this.at("?") && !this.tok.nlBefore) {
                this.report("E_UNEXPECTED_TOKEN", "`T??` is not a type: an optional can't be optional");
                this.advance();
            }
        }
        return t;
    }

    parsePrimaryType(): A.Type {
        const t = this.tok;
        const start = t.start;
        switch (t.kind) {
            case "*":
                this.report("E_STAR_TYPE_NOT_PARAM", "`*T` is only allowed on parameters, receivers and return types", t, "remove `*`");
                this.advance();
                return this.parsePrimaryType();
            case "&": {
                this.advance();
                const isMut = this.eat("mut");
                this.report("E_BORROW_REMOVED", `\`&${isMut ? "mut " : ""}T\` is removed`, t, isMut ? "*T on a parameter" : "T");
                return this.parsePostfixType();
            }
            case "Ident": case "Self":
                return this.parseNamedType();
            case "unsafe":
                if (this.peek().kind === ".") return this.parseNamedType();
                break;
            case "t(": {
                const close = this.closeOf();
                this.advance();
                const elems = this.group(false, () => this.list(close, false, () => this.parseType()));
                return { kind: "TTuple", span: this.sp(start), elems };
            }
            case "r{": {
                const close = this.closeOf();
                this.advance();
                const fields = this.group(true, () =>
                    this.list(close, true, () => {
                        const s = this.tok.start;
                        const name = this.bindingName("a field name");
                        this.expect(":");
                        return { name, type: this.parseType(), span: this.sp(s) };
                    }, () => this.tok.kind === "Ident"),
                );
                return { kind: "TRecord", span: this.sp(start), fields };
            }
            case "(": {
                const close = this.closeOf();
                if (this.toks[close + 1]?.kind === "->") {
                    this.advance();
                    const params = this.group(false, () => this.list(close, false, () => this.parseModeType()));
                    this.expect("->");
                    const ret = this.parseType();
                    return { kind: "TFn", span: this.sp(start), params, ret };
                }
                this.advance();
                const elems = this.group(false, () => this.list(close, false, () => this.parseType()));
                if (elems.length === 1 && this.toks[close - 1]?.kind !== ",") return elems[0]!;
                this.diagnostics.push(diag("E_BARE_TUPLE", "a tuple type is written `t(A, B)`", start, this.sp(start).end, "t(…)"));
                return { kind: "TTuple", span: this.sp(start), elems };
            }
            case "TypeOf": {
                this.advance();
                const close = this.at("(") ? this.closeOf() : this.unexpected("`(`");
                this.advance();
                const path = [this.bindingName("a value path")];
                while (this.eat(".")) path.push(this.bindingName("a field name"));
                if (this.i !== close) this.unexpected("`)`");
                this.advance();
                return { kind: "TTypeOf", span: this.sp(start), path };
            }
            case "String":
                this.advance();
                return { kind: "TLit", span: this.sp(start), value: t.value as string };
            case "Int":
                this.advance();
                return { kind: "TLit", span: this.sp(start), value: t.value as bigint };
            case "true": case "false":
                this.advance();
                return { kind: "TLit", span: this.sp(start), value: t.kind === "true" };
            case "fn": case "fun":
                this.fail("E_UNEXPECTED_TOKEN", "a function type is written `(T) -> R`");
        }
        this.unexpected("a type");
    }

    parseNamedType(): A.Type {
        const start = this.tok.start;
        const first = this.advance();
        const path = [first.kind === "Ident" ? (first.value as string) : first.kind];
        while (this.at(".") && this.peek().kind === "Ident") {
            this.advance();
            path.push(this.advance().value as string);
        }
        let args: A.Type[] = [];
        if (this.at("[") && !this.tok.wsBefore) {
            const close = this.closeOf();
            if (close === this.i + 1) {
                this.report("E_EXPECTED_TYPE_ARGUMENTS", "empty type argument list");
                this.i = close + 1;
            } else {
                this.advance();
                args = this.group(false, () => this.list(close, false, () => this.parseType()));
            }
        } else if (this.at("<") && !this.tok.wsBefore) {
            const lt = this.tok;
            this.advance();
            args = this.parseAngleArgs();
            this.report("E_ANGLE_GENERICS", "generics use `[…]`", lt, `${path.join(".")}[…]`);
        }
        return { kind: "TName", span: this.sp(start), path, args };
    }

    /** After `<` of the removed angle-bracket generics: types up to the matching `>`. */
    parseAngleArgs(): A.Type[] {
        const args: A.Type[] = [];
        for (;;) {
            args.push(this.parseType());
            if (!this.eat(",")) break;
        }
        this.eatAngleClose();
        return args;
    }

    eatAngleClose(): void {
        const t = this.tok;
        if (t.kind === ">") {
            this.advance();
        } else if (t.kind === ">>" || t.kind === ">=" || t.kind === ">>=") {
            // split the token: consume its first `>`
            this.toks[this.i] = { ...t, kind: t.kind.slice(1), start: t.start + 1, wsBefore: false, nlBefore: false };
        } else {
            this.unexpected("`>`");
        }
    }

    // ---- blocks and statements ----------------------------------------------------------------

    /** `{ stmts }`. `headerLine`: the `{` of a declaration or control flow (§5.4 rule 7). */
    parseBlock(headerLine: boolean): A.Block {
        if (!this.at("{")) this.unexpected("`{`");
        if (headerLine) this.braceOnHeaderLine();
        const start = this.tok.start;
        const close = this.closeOf();
        this.advance();
        const stmts = this.group(true, () => this.parseStmts(close));
        this.i = close + 1;
        return { kind: "Block", span: this.sp(start), stmts };
    }

    parseStmts(end: number): A.Stmt[] {
        const stmts: A.Stmt[] = [];
        while (this.i < end) {
            const start = this.i;
            if (this.eat(";")) continue;
            try {
                stmts.push(this.parseStmt(end));
            } catch (e) {
                if (!(e instanceof Sync)) throw e;
                this.syncStmt(end, start);
            }
        }
        return stmts;
    }

    parseStmt(end: number): A.Stmt {
        const t = this.tok;
        const start = t.start;
        let stmt: A.Stmt;
        if (t.kind === "let") {
            stmt = this.parseLet(start);
        } else if (t.kind === "var") {
            stmt = this.parseVar(start, false);
        } else if (this.atSharedVar()) {
            const sh = this.advance();
            if (this.at("let")) {
                this.report("E_SHARED_IMMUTABLE", "`shared let`: immutable values are already shared", sh, "shared var");
                stmt = this.parseLet(start);
            } else {
                stmt = this.parseVar(start, true);
            }
        } else if (t.kind === "Ident" && (this.peek().kind === ":=" || this.peek().kind === ":==")) {
            const name = this.advance().value as string;
            const mutable = this.advance().kind === ":==";
            const value = this.parseExpr(0);
            stmt = { kind: "ShortDecl", span: this.sp(start), name, mutable, value };
        } else if (t.kind === "fn" || t.kind === "type" || t.kind === "union" || t.kind === "inter" || t.kind === "impl" || t.kind === "import") {
            if (t.kind !== "fn" || this.peek().kind !== "(") {
                this.fail("E_UNEXPECTED_TOKEN", `\`${t.kind}\` declarations are only allowed at the top level`);
            }
            stmt = this.exprStmt(start);
        } else {
            stmt = this.exprStmt(start);
        }
        if (this.at(";")) {
            this.advance();
            if (stmt.kind === "ExprStmt") stmt.semi = true;
        } else if (this.i < end && !this.tok.nlBefore) {
            this.fail("E_UNEXPECTED_TOKEN", `expected a new line or \`;\` before ${this.describe(this.tok)}`);
        }
        return stmt;
    }

    exprStmt(start: number): A.ExprStmt {
        const expr = this.parseExpr(0);
        return { kind: "ExprStmt", span: this.sp(start), expr, semi: false };
    }

    parseLet(start: number): A.LetStmt {
        this.expect("let");
        const pattern = this.parsePattern();
        const type = this.eat(":") ? this.parseType() : null;
        this.expectAssign();
        const value = this.parseExpr(0);
        const els = this.at("else") ? (this.advance(), this.parseBlock(true)) : null;
        return { kind: "LetStmt", span: this.sp(start), pattern, type, value, else: els };
    }

    parseVar(start: number, shared: boolean): A.VarStmt {
        this.expect("var");
        if (!this.at("Ident") && !KEYWORDS.has(this.tok.kind)) {
            this.fail("E_UNEXPECTED_TOKEN", "`var` takes a name; destructure with `let t(var a, b) = …`");
        }
        const name = this.bindingName();
        const type = this.eat(":") ? this.parseType() : null;
        this.expectAssign();
        const value = this.parseExpr(0);
        return { kind: "VarStmt", span: this.sp(start), shared, name, type, value };
    }

    // ---- expressions (§3, §4) -----------------------------------------------------------------

    parseExpr(minBp: number): A.Expr {
        const start = this.tok.start;
        let left = this.parseUnary();
        for (;;) {
            const t = this.tok;
            if (t.nlBefore && this.nlSig && !CONTINUES.has(t.kind)) break;
            if (t.kind === ":=" || t.kind === ":==") {
                if (minBp > BP_ASSIGN) break;
                this.report("E_SHORT_DECL_TARGET", "`:=` declares a plain name: use `=` to assign, or `let` to destructure");
                this.advance();
                const value = this.parseExpr(BP_ASSIGN);
                left = { kind: "Assign", span: this.sp(start), op: "=", target: left, value };
                continue;
            }
            if ((t.kind === "++" || t.kind === "--") && !t.nlBefore) {
                this.report("E_RESERVED_OPERATOR", `\`${t.kind}\` is not an operator`, t, t.kind === "++" ? "+= 1" : "-= 1");
                this.advance();
                continue;
            }
            const info = INFIX[t.kind];
            if (!info) break;
            const [bp, assoc] = info;
            if (bp < minBp) break;
            this.advance();
            if (t.kind === "as") {
                const type = this.parsePostfixType();
                left = { kind: "As", span: this.sp(start), expr: left, type };
                continue;
            }
            if (t.kind === "or") {
                let name: string | null = null;
                if (this.at("Ident") && this.peek().kind === "=>") {
                    name = this.advance().value as string;
                    this.advance();
                }
                const rhs = this.parseExpr(BP_OR + 1);
                left = { kind: "Or", span: this.sp(start), expr: left, name, rhs };
                continue;
            }
            if (t.kind === ".." || t.kind === "..=") {
                if (isRange(left)) this.report("E_NON_ASSOCIATIVE_OPERATOR", "ranges can't be chained", t);
                const end = this.canStartOperand() ? this.parseExpr(BP_RANGE + 1) : null;
                left = { kind: "Range", span: this.sp(start), inclusive: t.kind === "..=", start: left, end };
                continue;
            }
            const right = this.parseExpr(assoc === "right" ? bp : bp + 1);
            if (bp === BP_ASSIGN) {
                if (!isPlace(left)) {
                    this.diagnostics.push(diag("E_INVALID_ASSIGNMENT_TARGET", "the left side of an assignment must be a name, field or index", left.span.start, left.span.end));
                }
                left = { kind: "Assign", span: this.sp(start), op: t.kind, target: left, value: right };
                continue;
            }
            if (bp === BP_COMPARE && isComparison(left)) {
                this.report("E_NON_ASSOCIATIVE_OPERATOR", `\`${t.kind}\` can't be chained: add parentheses`, t);
            }
            if ((t.kind === "??" && (isLogical(left) || isLogical(right))) || ((t.kind === "&&" || t.kind === "||") && (isNullish(left) || isNullish(right)))) {
                this.report("E_MIXED_NULLISH", "`??` can't be mixed with `&&` / `||` without parentheses", t);
            }
            left = { kind: "Binary", span: this.sp(start), op: t.kind, left, right };
        }
        return left;
    }

    /** Whether the current token can start the operand of an open-ended range (`a..`). */
    canStartOperand(): boolean {
        const t = this.tok;
        if (t.nlBefore && this.nlSig) return false;
        switch (t.kind) {
            case ")": case "]": case "}": case ",": case ";": case "{": case "=>": case "EOF": case "or": case "else":
                return false;
        }
        return !(t.kind in INFIX) || t.kind === "-" || t.kind === "&" || t.kind === "*";
    }

    parseUnary(): A.Expr {
        const t = this.tok;
        const start = t.start;
        switch (t.kind) {
            case "-": case "!": {
                this.advance();
                const operand = this.parseUnary();
                return { kind: "Unary", span: this.sp(start), op: t.kind, operand };
            }
            case "~": {
                this.report("E_RESERVED_OPERATOR", "`~` is not an operator: bitwise-not is `!`", t, "!");
                this.advance();
                const operand = this.parseUnary();
                return { kind: "Unary", span: this.sp(start), op: "!", operand };
            }
            case "++": case "--": {
                this.report("E_RESERVED_OPERATOR", `\`${t.kind}\` is not an operator`, t, t.kind === "++" ? "+= 1" : "-= 1");
                this.advance();
                return this.parseUnary();
            }
            case "&": case "*": {
                this.advance();
                if (t.kind === "&") this.eat("mut");
                this.report("E_BORROW_REMOVED", `prefix \`${t.kind}\` is removed: v0.4 has no borrow or dereference operator`, t, "drop it");
                return this.parseUnary();
            }
            case "await": {
                this.advance();
                const operand = this.parsePostfix(this.parsePrimary(), true);
                const node: A.Expr = { kind: "Await", span: this.sp(start), operand };
                return this.parsePostfix(node, false);
            }
            case "..": case "..=": {
                this.advance();
                const end = this.canStartOperand() ? this.parseExpr(BP_RANGE + 1) : null;
                return { kind: "Range", span: this.sp(start), inclusive: t.kind === "..=", start: null, end };
            }
        }
        return this.parsePostfix(this.parsePrimary(), false);
    }

    parsePostfix(expr: A.Expr, stopAtTry: boolean): A.Expr {
        const start = expr.span.start;
        for (;;) {
            const t = this.tok;
            switch (t.kind) {
                case ".": {
                    this.advance();
                    const n = this.tok;
                    if (n.kind !== "Ident" && n.kind !== "Int") this.unexpected("a field or method name");
                    this.advance();
                    const name = n.kind === "Int" ? String(n.value) : (n.value as string);
                    expr = { kind: "Member", span: this.sp(start), target: expr, name, optional: false };
                    continue;
                }
                case "?.": {
                    if (stopAtTry) return expr;
                    this.advance();
                    const n = this.tok;
                    if (n.kind !== "Ident" && n.kind !== "Int") this.unexpected("a field or method name");
                    this.advance();
                    const name = n.kind === "Int" ? String(n.value) : (n.value as string);
                    expr = { kind: "Member", span: this.sp(start), target: expr, name, optional: true };
                    continue;
                }
                case "(": {
                    if (t.nlBefore) return expr;
                    const close = this.closeOf();
                    this.advance();
                    const args = this.group(false, () => this.list(close, false, () => this.parseElem()));
                    expr = { kind: "Call", span: this.sp(start), callee: expr, args };
                    continue;
                }
                case "[": {
                    if (t.nlBefore) return expr;
                    const close = this.closeOf();
                    this.advance();
                    const index = this.group(false, () => {
                        if (this.i === close) this.unexpected("an index");
                        const e = this.parseExpr(0);
                        if (this.i !== close) this.unexpected("`]`");
                        return e;
                    });
                    this.i = close + 1;
                    expr = { kind: "Index", span: this.sp(start), target: expr, index };
                    continue;
                }
                case ".[": {
                    if (t.nlBefore) this.report("E_GENERIC_ARGS_NEWLINE", "`.[` can't start a line");
                    const close = this.closeOf();
                    if (close === this.i + 1) {
                        this.report("E_EXPECTED_TYPE_ARGUMENTS", "empty `.[]`");
                        this.i = close + 1;
                        continue;
                    }
                    this.advance();
                    const args = this.group(false, () => this.list(close, false, () => this.parseType()));
                    expr = { kind: "GenericApply", span: this.sp(start), target: expr, args };
                    continue;
                }
                case "?": {
                    if (t.nlBefore || stopAtTry) return expr;
                    this.advance();
                    expr = { kind: "Try", span: this.sp(start), expr };
                    continue;
                }
                case "{": {
                    if (t.nlBefore || !isTypePath(expr)) return expr;
                    if (this.noStruct) {
                        if (!this.looksLikeStructInHeader()) return expr;
                        this.report("E_STRUCT_LITERAL_IN_HEADER", "a struct literal in a header needs parentheses", t, "(P { … })");
                    }
                    const items = this.parseRecItems(false);
                    expr = { kind: "Struct", span: this.sp(start), type: expr, items };
                    continue;
                }
                case "<": {
                    if (t.wsBefore || !isPathExpr(expr) || !this.looksLikeAngleCall()) return expr;
                    this.advance();
                    const args = this.parseAngleArgs();
                    this.report("E_ANGLE_GENERICS", "explicit generics use `.[…]`", t, ".[…]");
                    expr = { kind: "GenericApply", span: this.sp(start), target: expr, args };
                    continue;
                }
            }
            return expr;
        }
    }

    /** `if x == P { a: 1 } { … }`: `{ name:` and another `{` right after the closer. */
    looksLikeStructInHeader(): boolean {
        const close = this.closeOf();
        const a = this.peek(1);
        const b = this.peek(2);
        const after = this.toks[close + 1];
        const keyed = (a.kind === "Ident" && b.kind === ":" && this.peek(3).kind !== "for") || (a.kind === "..." && close > this.i + 1);
        return keyed && after !== undefined && after.kind === "{" && !after.nlBefore;
    }

    /** `f<T>(x)`: type-like tokens up to a glued `>`, then a glued `(`. */
    looksLikeAngleCall(): boolean {
        let depth = 1;
        let j = this.i + 1;
        for (; j < this.toks.length; j++) {
            const k = this.toks[j]!;
            if (k.kind === "<") depth++;
            else if (k.kind === ">") depth--;
            else if (k.kind === ">>") depth -= 2;
            else if (k.kind === "[" || k.kind === "t(") {
                j = k.match ?? j;
                continue;
            } else if (k.kind !== "Ident" && k.kind !== "," && k.kind !== "?" && k.kind !== "." && k.kind !== "Self") return false;
            if (depth <= 0) break;
        }
        const next = this.toks[j + 1];
        return depth === 0 && next !== undefined && next.kind === "(" && !next.wsBefore;
    }

    parseElem(): A.Elem {
        const start = this.tok.start;
        const spread = this.eat("...");
        const value = this.parseExpr(0);
        return { spread, value, span: this.sp(start) };
    }

    parsePrimary(): A.Expr {
        const t = this.tok;
        const start = t.start;
        switch (t.kind) {
            case "Ident":
                if (this.peek().kind === ":" && this.peek(2).kind === "for") return this.parseLabeledFor();
                this.advance();
                return { kind: "Ident", span: this.sp(start), name: t.value as string };
            case "Int":
                this.advance();
                return { kind: "Int", span: this.sp(start), value: t.value as bigint };
            case "Float":
                this.advance();
                return { kind: "Float", span: this.sp(start), value: t.value as number };
            case "String": case "RawString":
                this.advance();
                return { kind: "Str", span: this.sp(start), value: t.value as string, raw: t.kind === "RawString", multiline: !!t.multiline };
            case "TemplateHead":
                return this.parseTemplate();
            case "Char":
                this.advance();
                return { kind: "Char", span: this.sp(start), value: t.value as string };
            case "Byte":
                this.advance();
                return { kind: "Byte", span: this.sp(start), value: t.value as number };
            case "true": case "false":
                this.advance();
                return { kind: "Bool", span: this.sp(start), value: t.kind === "true" };
            case "nil":
                this.advance();
                return { kind: "Nil", span: this.sp(start) };
            case "this":
                this.advance();
                return { kind: "This", span: this.sp(start) };
            case "Self":
                this.advance();
                return { kind: "SelfExpr", span: this.sp(start) };
            case "(":
                return this.parseParen();
            case "[": case "a[": case "t(": case "s{": {
                const close = this.closeOf();
                this.advance();
                const elems = this.group(t.kind === "s{", () => this.list(close, t.kind === "s{", () => this.parseElem()));
                const kind = t.kind === "[" ? "Vec" : t.kind === "a[" ? "Array" : t.kind === "t(" ? "Tuple" : "Set";
                return { kind, span: this.sp(start), elems };
            }
            case "r{": {
                const items = this.parseRecItems(true);
                return { kind: "Record", span: this.sp(start), items };
            }
            case "_{": {
                const items = this.parseRecItems(true);
                return { kind: "Inferred", span: this.sp(start), items };
            }
            case "m{":
                return this.parseMap();
            case "#{":
                return this.parseClosure(this.i, start);
            case "#[": {
                const close = this.closeOf();
                const brace = this.toks[close + 1];
                this.report("E_CAPTURE_LIST_REMOVED", "capture lists are removed: captures are inferred", t, "drop the list", this.toks[close]!.end);
                this.i = close + 1;
                if (!brace || brace.kind !== "{") this.unexpected("`{`");
                return this.parseClosure(this.i, start);
            }
            case "{":
                return this.parseBraceExpr();
            case "if":
                return this.parseIf();
            case "match":
                return this.parseMatch();
            case "select":
                return this.parseSelect();
            case "lock":
                return this.parseLock();
            case "for":
                return this.parseFor(null, start);
            case "while": case "loop":
                this.report("E_RESERVED_KEYWORD", `\`${t.kind}\` is reserved: loops use \`for\``, t, "for");
                return this.parseFor(null, start);
            case "unsafe": case "recover": {
                if (t.kind === "unsafe" && this.peek().kind === ".") {
                    // the `std.unsafe` package: `unsafe.Ptr.null()`
                    this.advance();
                    return { kind: "Ident", span: this.sp(start), name: "unsafe" };
                }
                this.advance();
                const body = this.parseBlock(true);
                return t.kind === "unsafe" ? { kind: "Unsafe", span: this.sp(start), body } : { kind: "Recover", span: this.sp(start), body };
            }
            case "return": {
                this.advance();
                const value = this.canStartValue() ? this.parseExpr(0) : null;
                return { kind: "Return", span: this.sp(start), value };
            }
            case "break": case "continue": {
                this.advance();
                let label: string | null = null;
                if (this.at("Ident") && !this.tok.nlBefore && this.labels.includes(this.tok.value as string)) {
                    label = this.advance().value as string;
                }
                if (t.kind === "continue") return { kind: "Continue", span: this.sp(start), label };
                const value = this.canStartValue() ? this.parseExpr(0) : null;
                return { kind: "Break", span: this.sp(start), label, value };
            }
            case "fn": case "fun":
                if (this.peek().kind === "(") return this.parseFnExpression();
                break;
            case "mut":
                this.fail("E_MUT_REMOVED", "`mut` is removed: use `var`", t, "var");
        }
        if (RESERVED_KEYWORDS.has(t.kind)) {
            this.report("E_RESERVED_KEYWORD", `\`${t.kind}\` is reserved`);
            this.advance();
            return { kind: "Ident", span: this.sp(start), name: t.kind };
        }
        this.unexpected("an expression");
    }

    /** After `return` / `break`: whether a value follows on the same line. */
    canStartValue(): boolean {
        const t = this.tok;
        if (t.nlBefore) return false;
        switch (t.kind) {
            case ";": case "}": case ")": case "]": case ",": case "EOF": case "else": case "=>":
                return false;
        }
        return !(t.kind in INFIX) || t.kind === "-";
    }

    parseTemplate(): A.Template {
        const head = this.tok;
        const start = head.start;
        const tail = this.closeOf();
        const parts = [head.value as string];
        const exprs: A.Expr[] = [];
        this.advance();
        this.group(false, () => {
            while (this.i <= tail) {
                const s = this.i;
                try {
                    exprs.push(this.parseExpr(0));
                } catch (e) {
                    if (!(e instanceof Sync)) throw e;
                    exprs.push({ kind: "Error", span: this.sp(this.toks[s]!.start) });
                }
                // skip anything left before the next part
                while (this.i < tail && this.tok.kind !== "TemplateMiddle") {
                    this.report("E_UNEXPECTED_TOKEN", `expected \`}\` to end the interpolation, found ${this.describe(this.tok)}`);
                    this.skipOne();
                }
                const part = this.advance();
                parts.push((part.value as string | undefined) ?? "");
                if (part.kind === "TemplateTail" || this.i > tail) break;
            }
        });
        this.i = tail + 1;
        return { kind: "Template", span: this.sp(start), parts, exprs, multiline: !!head.multiline };
    }

    parseParen(): A.Expr {
        const open = this.tok;
        const start = open.start;
        const close = this.closeOf();
        if (this.toks[close + 1]?.kind === "=>" && this.looksLikeParamList(this.i + 1, close)) {
            return this.parseArrowClosure(close, start);
        }
        this.advance();
        if (this.i === close) {
            this.i = close + 1;
            this.diagnostics.push(diag("E_BARE_TUPLE", "the unit value is written `t()`", start, this.sp(start).end, "t()"));
            return { kind: "Tuple", span: this.sp(start), elems: [] };
        }
        const elems = this.group(false, () => this.list(close, false, () => this.parseElem()));
        if (elems.length === 1 && this.toks[close - 1]?.kind !== "," && !elems[0]!.spread) {
            return { kind: "Paren", span: this.sp(start), expr: elems[0]!.value };
        }
        this.diagnostics.push(diag("E_BARE_TUPLE", "a tuple is written `t(a, b)`", start, this.sp(start).end, "t(…)"));
        return { kind: "Tuple", span: this.sp(start), elems };
    }

    /** `(a, b)` / `(a: T)` / `()`: names, `:`-types and commas only. */
    looksLikeParamList(from: number, close: number): boolean {
        for (let j = from; j < close; j++) {
            const k = this.toks[j]!;
            if (k.match !== undefined && k.match > j) j = k.match;
            else if (k.kind !== "Ident" && k.kind !== "," && k.kind !== ":" && k.kind !== "?" && k.kind !== ".") return false;
        }
        return true;
    }

    /** The removed `(a, b) => body`: reported, parsed as a closure. */
    parseArrowClosure(close: number, start: number): A.Closure {
        const open = this.advance();
        const params = this.group(false, () =>
            this.list(close, false, (): A.ClosureParam => {
                const s = this.tok.start;
                const name = this.bindingName("a parameter name");
                const type = this.eat(":") ? this.parseType() : null;
                return { name, isVar: false, star: false, type, span: this.sp(s) };
            }),
        );
        this.report("E_ARROW_CLOSURE", "closures are written `#{ a => … }`", open, "#{ a => … }", this.toks[close + 1]!.end);
        this.expect("=>");
        const body = this.parseExpr(0);
        return { kind: "Closure", span: this.sp(start), params, ret: null, body: [{ kind: "ExprStmt", span: body.span, expr: body, semi: false }] };
    }

    /** The removed `fn(x) { … }` expression. */
    parseFnExpression(): A.Closure {
        const t = this.advance();
        const start = t.start;
        const close = this.closeOf();
        this.report("E_ARROW_CLOSURE", "closures are written `#{ x => … }`", t, "#{ x => … }");
        this.advance();
        const params = this.group(false, () =>
            this.list(close, false, (): A.ClosureParam => {
                const s = this.tok.start;
                const name = this.bindingName("a parameter name");
                const type = this.eat(":") ? this.parseType() : null;
                return { name, isVar: false, star: false, type, span: this.sp(s) };
            }),
        );
        if (this.eat("->")) this.parseType();
        const body = this.parseBlock(false);
        return { kind: "Closure", span: this.sp(start), params, ret: null, body: body.stmts };
    }

    /** `#{ [params =>] stmts }`; `open` is the index of `#{` (or of the `{` after a removed capture list). */
    parseClosure(open: number, start: number): A.Closure {
        const close = this.toks[open]!.match ?? this.toks.length - 1;
        this.i = open + 1;
        const arrow = this.scanClosureHeader(open, close);
        let params: A.ClosureParam[] | null = null;
        let ret: A.Type | null = null;
        const savedLabels = this.labels;
        this.labels = [];
        try {
            if (arrow >= 0) {
                params = [];
                this.group(false, () => {
                    for (;;) {
                        const s = this.i;
                        try {
                            params!.push(this.parseClosureParam());
                        } catch (e) {
                            if (!(e instanceof Sync)) throw e;
                            this.i = Math.max(s + 1, this.i);
                            while (this.i < arrow && !this.at(",") && !this.at("->")) this.skipOne();
                        }
                        if (!this.eat(",")) break;
                    }
                    if (this.eat("->")) ret = this.parseType();
                    if (this.i !== arrow) {
                        this.report("E_UNEXPECTED_TOKEN", `expected \`=>\`, found ${this.describe(this.tok)}`);
                    }
                });
                this.i = arrow + 1;
            }
            const body = this.group(true, () => this.parseStmts(close));
            this.i = close + 1;
            return { kind: "Closure", span: this.sp(start), params, ret, body };
        } finally {
            this.labels = savedLabels;
        }
    }

    /** Index of the header's `=>`, or -1 when the closure has no header (§4.4). */
    scanClosureHeader(open: number, close: number): number {
        let sawNewline = false;
        for (let j = open + 1; j < close; j++) {
            const t = this.toks[j]!;
            if (t.kind === "=>") {
                if (j === open + 1) return -1;
                if (sawNewline) this.report("E_CLOSURE_HEADER_LINE", "closure parameters go on the closure's first line", t);
                return j;
            }
            if (t.nlBefore) sawNewline = true;
            if (t.kind === "[" || t.kind === "(" || t.kind === "t(" || t.kind === "r{") {
                j = t.match ?? j;
                continue;
            }
            if (!CLOSURE_HEADER.has(t.kind)) return -1;
        }
        return -1;
    }

    parseClosureParam(): A.ClosureParam {
        const start = this.tok.start;
        let isVar = false;
        if (this.at("var")) {
            this.advance();
            isVar = true;
        } else if (this.at("mut")) {
            this.report("E_MUT_REMOVED", "`mut` is removed: a writable copy of a parameter is `var x`", this.tok, "var");
            this.advance();
            isVar = true;
        }
        const name = this.at("_") ? (this.advance(), "_") : this.bindingName("a parameter name");
        let star = false;
        let type: A.Type | null = null;
        if (this.eat(":")) ({ star, type } = this.parseModeType());
        return { name, isVar, star, type, span: this.sp(start) };
    }

    /** `{` in expression position: a block, or the removed bare literal `{ k: v }`. */
    parseBraceExpr(): A.Expr {
        const a = this.peek(1);
        const b = this.peek(2);
        const keyed = (a.kind === "Ident" || a.kind === "String") && b.kind === ":" && this.peek(3).kind !== "for";
        if (keyed) {
            const start = this.tok.start;
            this.report("E_BARE_BRACE_LITERAL", "`{` always starts a block", this.tok, "_{ … }, r{ … } or m{ … }");
            const items = this.parseRecItems(true);
            return { kind: "Inferred", span: this.sp(start), items };
        }
        return this.parseBlock(false);
    }

    /** `{ name: value, name, "key": value, ...base }` after `r{`, `_{`, `Name {` (§4.3). */
    parseRecItems(quotedKeys: boolean): A.RecItem[] {
        const close = this.closeOf();
        this.advance();
        return this.group(true, () =>
            this.list(close, true, (): A.RecItem => {
                const start = this.tok.start;
                if (this.eat("...")) return { kind: "Spread", value: this.parseExpr(0), span: this.sp(start) };
                const k = this.tok;
                let name: string;
                let quoted = false;
                if (k.kind === "Ident") name = k.value as string;
                else if (k.kind === "String" && quotedKeys) {
                    name = k.value as string;
                    quoted = true;
                } else if (KEYWORDS.has(k.kind) && this.peek().kind === ":") name = k.kind;
                else this.fail("E_INVALID_RECORD_KEY", "a record key is a name or (in `r{}`) a string");
                this.advance();
                if (!this.eat(":")) {
                    if (quoted) this.fail("E_EXPECTED_COLON", "a quoted key needs a value");
                    return { kind: "Field", name, quoted, value: null, span: this.sp(start) };
                }
                return { kind: "Field", name, quoted, value: this.parseExpr(0), span: this.sp(start) };
            }, () => this.tok.kind === "Ident" || this.tok.kind === "..."),
        );
    }

    parseMap(): A.MapLit {
        const start = this.tok.start;
        const close = this.closeOf();
        this.advance();
        const entries = this.group(true, () =>
            this.list(close, true, (): A.MapEntry => {
                const s = this.tok.start;
                if (this.eat("...")) return { kind: "Spread", value: this.parseExpr(0), span: this.sp(s) };
                const key = this.parseExpr(0);
                this.expect(":", "`:` after a map key");
                const value = this.parseExpr(0);
                return { kind: "Entry", key, value, span: this.sp(s) };
            }),
        );
        return { kind: "Map", span: this.sp(start), entries };
    }

    parseIf(): A.If {
        const start = this.expect("if").start;
        let pattern: A.Pattern | null = null;
        let cond: A.Expr;
        if (this.eat("let")) {
            pattern = this.parsePattern();
            this.expect("=");
            cond = this.header(() => this.parseExpr(0));
        } else {
            cond = this.header(() => this.parseExpr(0));
        }
        const then = this.parseBlock(true);
        let els: A.Block | A.If | null = null;
        if (this.at("else")) {
            this.advance();
            els = this.at("if") ? this.parseIf() : this.parseBlock(true);
        }
        return { kind: "If", span: this.sp(start), pattern, cond, then, else: els };
    }

    parseMatch(): A.Match {
        const start = this.expect("match").start;
        const subject = this.at("{") ? null : this.header(() => this.parseExpr(0));
        if (!this.at("{")) this.unexpected("`{`");
        this.braceOnHeaderLine();
        const close = this.closeOf();
        this.advance();
        const arms = this.group(true, () =>
            this.list(close, true, (): A.Arm => {
                const s = this.tok.start;
                let pattern: A.Pattern | null = null;
                let cond: A.Expr | null = null;
                let guard: A.Expr | null = null;
                if (subject !== null || (this.at("_") && this.peek().kind === "=>")) {
                    pattern = this.parsePattern();
                    if (this.eat("if")) guard = this.parseExpr(0);
                } else {
                    cond = this.parseExpr(0);
                }
                this.expect("=>");
                const body = this.parseExpr(0);
                return { pattern, guard, cond, body, span: this.sp(s) };
            }),
        );
        return { kind: "Match", span: this.sp(start), subject, arms };
    }

    parseSelect(): A.Select {
        const start = this.expect("select").start;
        if (!this.at("{")) this.unexpected("`{`");
        this.braceOnHeaderLine();
        const open = this.tok;
        const close = this.closeOf();
        this.advance();
        let els: A.Expr | null = null;
        let elseTok: Token | null = null;
        const arms: A.SelectArm[] = [];
        this.group(true, () =>
            this.list(close, true, () => {
                const s = this.tok.start;
                if (this.at("else") && this.peek().kind === "=>") {
                    const e = this.advance();
                    this.advance();
                    const body = this.parseExpr(0);
                    if (elseTok) this.report("E_SELECT_ELSE_NOT_LAST", "a `select` has at most one `else` arm", e);
                    else els = body;
                    elseTok = e;
                    return;
                }
                if (elseTok) {
                    this.report("E_SELECT_ELSE_NOT_LAST", "the `else` arm must be the last one", elseTok);
                }
                let pattern: A.Pattern | null = null;
                if (this.selectArmHasPattern(close)) {
                    pattern = this.parsePattern();
                    this.expect("=");
                }
                const expr = this.parseExpr(0);
                this.expect("=>");
                const body = this.parseExpr(0);
                arms.push({ pattern, expr, body, span: this.sp(s) });
            }),
        );
        if (arms.length === 0 && els === null) {
            this.diagnostics.push(diag("E_SELECT_EMPTY", "a `select` needs at least one arm", open.start, open.end));
        }
        return { kind: "Select", span: this.sp(start), arms, else: els };
    }

    /** A depth-0 `=` before the arm's `=>` means `pattern = promise => body` (§4.9). */
    selectArmHasPattern(close: number): boolean {
        for (let j = this.i; j < close; j++) {
            const t = this.toks[j]!;
            if (t.kind === "=>") return false;
            if (t.kind === "=") return true;
            if (t.match !== undefined && t.match > j) j = t.match;
        }
        return false;
    }

    parseLock(): A.Lock {
        const start = this.expect("lock").start;
        const places: A.Expr[] = [];
        this.header(() => {
            places.push(this.parseExpr(0));
            while (this.eat(",")) places.push(this.parseExpr(0));
        });
        const body = this.parseBlock(true);
        return { kind: "Lock", span: this.sp(start), places, body };
    }

    parseLabeledFor(): A.For {
        const start = this.tok.start;
        const label = this.advance().value as string;
        this.advance(); // `:`
        return this.parseFor(label, start);
    }

    parseFor(label: string | null, start: number): A.For {
        const kw = this.advance(); // `for`, or the reported `while` / `loop`
        const body = (): A.Block => {
            const saved = this.labels;
            this.labels = label ? [...saved, label] : saved;
            try {
                return this.parseBlock(true);
            } finally {
                this.labels = saved;
            }
        };
        const node = (form: A.For["form"], isAwait: boolean, pattern: A.Pattern | null, pattern2: A.Pattern | null, expr: A.Expr | null): A.For => {
            const b = body();
            return { kind: "For", span: this.sp(start), label, form, isAwait, pattern, pattern2, expr, body: b };
        };
        if (this.at("{") || kw.kind === "loop") return node("infinite", false, null, null, null);
        if (this.eat("let")) {
            const pattern = this.parsePattern();
            this.expect("=");
            const expr = this.header(() => this.parseExpr(0));
            return node("let", false, pattern, null, expr);
        }
        const iterAwait = this.at("await") && this.headerHasIn(this.i + 1);
        if (iterAwait || this.headerHasIn(this.i)) {
            if (iterAwait) this.advance();
            const pattern = this.parsePattern();
            const pattern2 = this.eat(",") ? this.parsePattern() : null;
            this.expect("in");
            const expr = this.header(() => this.parseExpr(0));
            return node("in", iterAwait, pattern, pattern2, expr);
        }
        const cond = this.header(() => this.parseExpr(0));
        return node("cond", false, null, null, cond);
    }

    /** Whether the loop header starting at `from` has a depth-0 `in` before its block (§5.3). */
    headerHasIn(from: number): boolean {
        for (let j = from; j < this.toks.length; j++) {
            const t = this.toks[j]!;
            if (t.kind === "in") return true;
            if (t.kind === "{" || t.kind === "EOF" || t.kind === ";") return false;
            if (t.match !== undefined && t.match > j) j = t.match;
        }
        return false;
    }

    // ---- patterns (§6) ------------------------------------------------------------------------

    parsePattern(): A.Pattern {
        const start = this.tok.start;
        const first = this.parseAltPattern();
        if (!this.at("|")) return first;
        const alts = [first];
        while (this.eat("|")) alts.push(this.parseAltPattern());
        return { kind: "POr", span: this.sp(start), alts };
    }

    parseAltPattern(): A.Pattern {
        const t = this.tok;
        const start = t.start;
        switch (t.kind) {
            case "_":
                this.advance();
                return { kind: "PWild", span: this.sp(start) };
            case "var": case "mut": {
                if (t.kind === "mut") this.report("E_MUT_REMOVED", "`mut` is removed: a writable binding is `var x`", t, "var");
                this.advance();
                const name = this.bindingName();
                return { kind: "PBind", span: this.sp(start), name, isVar: true };
            }
            case "-": case "Int": case "Float": case "String": case "RawString": case "Char": case "Byte":
            case "true": case "false": case "nil": {
                const lit = this.parseLiteralPattern();
                if (this.at("..") || this.at("..=")) {
                    const inclusive = this.advance().kind === "..=";
                    const end = this.parseLiteralPattern();
                    return { kind: "PRange", span: this.sp(start), start: lit, end, inclusive };
                }
                return { kind: "PLit", span: this.sp(start), value: lit };
            }
            case "t(": {
                const close = this.closeOf();
                this.advance();
                let rest = false;
                const elems: A.Pattern[] = [];
                this.group(false, () =>
                    this.list(close, false, () => {
                        if (this.eat("..")) rest = true;
                        else elems.push(this.parsePattern());
                    }),
                );
                return { kind: "PTuple", span: this.sp(start), elems, rest };
            }
            case "r{": {
                const { fields, rest } = this.parseFieldPatterns();
                return { kind: "PRecord", span: this.sp(start), fields, rest };
            }
            case "Ident": case "Self": {
                const path = [this.advance().value as string ?? "Self"];
                if (t.kind === "Self") path[0] = "Self";
                while (this.at(".") && this.peek().kind === "Ident") {
                    this.advance();
                    path.push(this.advance().value as string);
                }
                if (this.at("(") && !this.tok.nlBefore) {
                    const close = this.closeOf();
                    this.advance();
                    let rest = false;
                    const args: A.Pattern[] = [];
                    this.group(false, () =>
                        this.list(close, false, () => {
                            if (this.eat("..")) rest = true;
                            else args.push(this.parsePattern());
                        }),
                    );
                    return { kind: "PCtor", span: this.sp(start), path, args, fields: null, rest };
                }
                if (this.at("{") && !this.tok.nlBefore && isUpper(path[path.length - 1]!)) {
                    const { fields, rest } = this.parseFieldPatterns();
                    return { kind: "PCtor", span: this.sp(start), path, args: null, fields, rest };
                }
                if (path.length === 1 && !isUpper(path[0]!)) {
                    return { kind: "PBind", span: this.sp(start), name: path[0]!, isVar: false };
                }
                return { kind: "PCtor", span: this.sp(start), path, args: null, fields: null, rest: false };
            }
        }
        if (KEYWORDS.has(t.kind)) {
            this.report("E_KEYWORD_AS_IDENT", `\`${t.kind}\` is a keyword and can't be a binding name`);
            this.advance();
            return { kind: "PBind", span: this.sp(start), name: t.kind, isVar: false };
        }
        this.fail("E_INVALID_PATTERN", `expected a pattern, found ${this.describe(t)}`);
    }

    parseLiteralPattern(): A.Expr {
        const t = this.tok;
        const start = t.start;
        if (t.kind === "-") {
            this.advance();
            const n = this.tok;
            if (n.kind !== "Int" && n.kind !== "Float") this.fail("E_INVALID_PATTERN", "`-` in a pattern goes before a number");
            const operand = this.parsePrimary();
            return { kind: "Unary", span: this.sp(start), op: "-", operand };
        }
        switch (t.kind) {
            case "Int": case "Float": case "String": case "RawString": case "Char": case "Byte":
            case "true": case "false": case "nil":
                return this.parsePrimary();
        }
        this.fail("E_INVALID_PATTERN", `expected a literal, found ${this.describe(t)}`);
    }

    parseFieldPatterns(): { fields: A.FieldPat[]; rest: boolean } {
        const close = this.closeOf();
        this.advance();
        let rest = false;
        const fields: A.FieldPat[] = [];
        this.group(true, () =>
            this.list(close, true, () => {
                if (this.eat("..")) {
                    rest = true;
                    return;
                }
                const s = this.tok.start;
                let isVar = false;
                if (this.at("var") || this.at("mut")) {
                    if (this.at("mut")) this.report("E_MUT_REMOVED", "`mut` is removed", this.tok, "var");
                    this.advance();
                    isVar = true;
                }
                const name = this.bindingName("a field name");
                const pattern = !isVar && this.eat(":") ? this.parsePattern() : null;
                fields.push({ name, pattern, isVar, span: this.sp(s) });
            }),
        );
        return { fields, rest };
    }
}

// ---- expression shape helpers ------------------------------------------------------------------

function isPlace(e: A.Expr): boolean {
    switch (e.kind) {
        case "Ident": case "Member": case "Index": case "This":
            return true;
        case "Paren":
            return isPlace(e.expr);
        default:
            return false;
    }
}

/** `Name`, `pkg.Name`, `Name.Variant`, `Name.[T]`: a path whose last segment is PascalCase (§4.2). */
function isTypePath(e: A.Expr): boolean {
    switch (e.kind) {
        case "Ident":
            return isUpper(e.name);
        case "Member":
            return !e.optional && isUpper(e.name) && isPathExpr(e.target);
        case "GenericApply":
            return isTypePath(e.target);
        default:
            return false;
    }
}

function isPathExpr(e: A.Expr): boolean {
    return e.kind === "Ident" || (e.kind === "Member" && !e.optional && isPathExpr(e.target));
}

const COMPARISONS: ReadonlySet<string> = new Set(["==", "!=", "<", "<=", ">", ">="]);

function isComparison(e: A.Expr): boolean {
    return e.kind === "Binary" && COMPARISONS.has(e.op);
}

function isRange(e: A.Expr): boolean {
    return e.kind === "Range";
}

function isLogical(e: A.Expr): boolean {
    return e.kind === "Binary" && (e.op === "&&" || e.op === "||");
}

function isNullish(e: A.Expr): boolean {
    return e.kind === "Binary" && e.op === "??";
}
