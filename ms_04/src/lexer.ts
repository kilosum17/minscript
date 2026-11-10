// The MinScript lexer (spec §1). It scans UTF-8 bytes and produces tokens with byte spans,
// `wsBefore` / `nlBefore` flags and, for every opener, the index of its matching closer.
//
// Delimiters are balanced here (§1.1): a closer that doesn't match the innermost opener is reported
// once, and the lexer inserts zero-width synthetic closers so the parser always sees a balanced
// stream. String interpolation uses a mode stack: `"a${x}b"` lexes as TemplateHead x TemplateTail.

import { diag, type Diagnostic } from "./diagnostic.ts";
import { KEYWORDS, OPENERS, PUNCTUATORS, endsExpression, type Token, type TokenValue } from "./token.ts";

export interface Trivia {
    kind: "line" | "doc" | "block";
    start: number;
    end: number;
}

export interface LexResult {
    src: Uint8Array;
    tokens: Token[];
    trivia: Trivia[];
    diagnostics: Diagnostic[];
}

export const LEXER_CODES: ReadonlySet<string> = new Set([
    "E_UNTERMINATED_STRING", "E_UNTERMINATED_COMMENT", "E_INVALID_ESCAPE", "E_INVALID_NUMBER",
    "E_INVALID_CHAR", "E_BYTE_LITERAL_NOT_ASCII", "E_UNKNOWN_CHARACTER", "E_UNMATCHED_DELIMITER",
    "E_TAGGED_RECORD_REMOVED",
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function lex(text: string | Uint8Array): LexResult {
    const src = typeof text === "string" ? encoder.encode(text) : text;
    return new Lexer(src).run();
}

// ---- character classes (bytes) ----------------------------------------------------------------

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isHex = (c: number) => isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
const isIdentStart = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f;
const isIdentChar = (c: number) => isIdentStart(c) || isDigit(c);

const NO_GLUE_BEFORE: ReadonlySet<string> = new Set([".", "?.", "fn", "type", "union", "inter"]);

/** One entry of the delimiter stack: an ordinary opener, or the interpolation of a template. */
interface Open {
    index: number;
    close: string;
    template?: Template;
}

/** A string with interpolations, while it is being lexed. */
interface Template {
    multiline: boolean;
    /** a newline inside an interpolation of this single-line string was already reported */
    reported?: boolean;
    /** token index and raw content span of each part */
    parts: { index: number; rawStart: number; rawEnd: number }[];
}

class Lexer {
    readonly src: Uint8Array;
    pos = 0;
    tokens: Token[] = [];
    trivia: Trivia[] = [];
    diagnostics: Diagnostic[] = [];
    stack: Open[] = [];
    wsBefore = false;
    nlBefore = false;

    constructor(src: Uint8Array) {
        this.src = src;
    }

    run(): LexResult {
        if (this.src[0] === 0xef && this.src[1] === 0xbb && this.src[2] === 0xbf) this.pos = 3;
        for (;;) {
            this.skipTrivia();
            if (this.pos >= this.src.length) break;
            this.token();
        }
        this.closeAllAtEof();
        this.push("EOF", this.src.length, this.src.length);
        return { src: this.src, tokens: this.tokens, trivia: this.trivia, diagnostics: this.diagnostics };
    }

    // ---- helpers ------------------------------------------------------------------------------

    at(offset = 0): number {
        return this.src[this.pos + offset] ?? -1;
    }

    text(start: number, end: number): string {
        return decoder.decode(this.src.subarray(start, end));
    }

    error(code: string, message: string, start: number, end: number, fix?: string): void {
        this.diagnostics.push(diag(code, message, start, end, fix));
    }

    push(kind: string, start: number, end: number, value?: TokenValue): number {
        const tok: Token = { kind, start, end, wsBefore: this.wsBefore, nlBefore: this.nlBefore };
        if (value !== undefined) tok.value = value;
        this.tokens.push(tok);
        this.wsBefore = false;
        this.nlBefore = false;
        return this.tokens.length - 1;
    }

    /** A zero-width closer inserted for balance; it leaves the next real token's flags alone. */
    pushSynthetic(kind: string, at: number): number {
        this.tokens.push({ kind, start: at, end: at, wsBefore: false, nlBefore: false, synthetic: true });
        return this.tokens.length - 1;
    }

    prevKind(): string {
        return this.tokens.length === 0 ? "" : this.tokens[this.tokens.length - 1]!.kind;
    }

    /** Length of the UTF-8 sequence starting at `pos` (1 for invalid bytes). */
    charLen(pos: number): number {
        const c = this.src[pos] ?? 0;
        if (c < 0x80) return 1;
        if (c >= 0xf0) return 4;
        if (c >= 0xe0) return 3;
        if (c >= 0xc0) return 2;
        return 1;
    }

    // ---- trivia -------------------------------------------------------------------------------

    skipTrivia(): void {
        while (this.pos < this.src.length) {
            const c = this.at();
            if (c === 0x20 || c === 0x09 || c === 0x0d) {
                this.pos++;
                this.wsBefore = true;
            } else if (c === 0x0a) {
                this.pos++;
                this.wsBefore = true;
                this.nlBefore = true;
                this.newlineInInterpolation(this.pos - 1);
            } else if (c === 0x2f && this.at(1) === 0x2f) {
                const start = this.pos;
                while (this.pos < this.src.length && this.at() !== 0x0a) this.pos++;
                const doc = this.src[start + 2] === 0x2f && this.src[start + 3] !== 0x2f;
                this.trivia.push({ kind: doc ? "doc" : "line", start, end: this.pos });
                this.wsBefore = true;
            } else if (c === 0x2f && this.at(1) === 0x2a) {
                this.blockComment();
                this.wsBefore = true;
            } else {
                return;
            }
        }
    }

    blockComment(): void {
        const start = this.pos;
        this.pos += 2;
        let depth = 1;
        while (this.pos < this.src.length && depth > 0) {
            const c = this.at();
            if (c === 0x2f && this.at(1) === 0x2a) {
                depth++;
                this.pos += 2;
            } else if (c === 0x2a && this.at(1) === 0x2f) {
                depth--;
                this.pos += 2;
            } else {
                if (c === 0x0a) this.nlBefore = true;
                this.pos++;
            }
        }
        if (depth > 0) this.error("E_UNTERMINATED_COMMENT", "`/*` is not closed", start, start + 2);
        this.trivia.push({ kind: "block", start, end: this.pos });
    }

    // ---- tokens -------------------------------------------------------------------------------

    token(): void {
        const start = this.pos;
        const c = this.at();

        if (isIdentStart(c)) return this.identOrSigil(start);
        if (isDigit(c)) return this.number(start, this.prevKind() === "." || this.prevKind() === "?.");
        if (c === 0x22) return this.string(start, start);
        if (c === 0x27) return this.char(start, false);
        if (c === 0x23) {
            const n = this.at(1);
            if (n === 0x7b) return this.opener("#{", start, 2);
            if (n === 0x5b) return this.opener("#[", start, 2);
            this.pos++;
            this.error("E_UNKNOWN_CHARACTER", "`#` starts no token (closures are `#{ … }`)", start, this.pos);
            return;
        }
        if (c === 0x2e) {
            // `.[` explicit generics; `.5` invalid float after a non-value (§1.5 rule 3)
            if (this.at(1) === 0x5b) return this.opener(".[", start, 2);
            if (isDigit(this.at(1)) && !endsExpression(this.prevKind())) {
                this.pos++;
                while (isDigit(this.at()) || this.at() === 0x5f) this.pos++;
                this.error("E_INVALID_NUMBER", "a float needs a digit before `.`", start, this.pos, "0" + this.text(start, this.pos));
                this.push("Float", start, this.pos, Number("0" + this.text(start, this.pos).replaceAll("_", "")));
                return;
            }
        }
        if (c === 0x29 || c === 0x5d || c === 0x7d) return this.closer(String.fromCharCode(c), start);

        for (const p of PUNCTUATORS) {
            if (this.matches(p)) {
                if (p in OPENERS) return this.opener(p, start, p.length);
                this.pos += p.length;
                this.push(p, start, this.pos);
                return;
            }
        }

        const len = this.charLen(start);
        this.pos += len;
        const what = c >= 0x80 ? "a non-ASCII character" : `\`${this.text(start, this.pos)}\``;
        this.error("E_UNKNOWN_CHARACTER", `${what} can't appear outside strings and comments`, start, this.pos);
    }

    matches(p: string): boolean {
        for (let i = 0; i < p.length; i++) {
            if (this.src[this.pos + i] !== p.charCodeAt(i)) return false;
        }
        return true;
    }

    identOrSigil(start: number): void {
        let end = start + 1;
        while (isIdentChar(this.src[end] ?? -1)) end++;
        const glued = end === start + 1 && !NO_GLUE_BEFORE.has(this.prevKind());
        if (glued) {
            const letter = this.src[start]!;
            const next = this.src[end] ?? -1;
            const sigil = String.fromCharCode(letter) + String.fromCharCode(next);
            if (sigil === "r{" || sigil === "m{" || sigil === "s{" || sigil === "_{" || sigil === "t(" || sigil === "a[") {
                return this.opener(sigil, start, 2);
            }
            if (sigil === 'r"') return this.rawString(start);
            if (sigil === "b'") return this.char(start, true);
        }
        this.pos = end;
        const name = this.text(start, end);
        const prev = this.prevKind();
        if (name === "_") this.push("_", start, end);
        else if (KEYWORDS.has(name) && prev !== "." && prev !== "?.") this.push(name, start, end);
        else this.push("Ident", start, end, name);
    }

    // ---- numbers (§1.5) -----------------------------------------------------------------------

    number(start: number, afterMember: boolean): void {
        if (afterMember) {
            // `t.0.1`: only a digit run
            while (isDigit(this.at())) this.pos++;
            this.push("Int", start, this.pos, BigInt(this.text(start, this.pos)));
            return;
        }
        let bad: string | null = null;
        let isFloat = false;
        const radix = this.at() === 0x30 ? this.at(1) : -1;
        if (radix === 0x78 || radix === 0x62 || radix === 0x6f) {
            this.pos += 2;
            const ok = radix === 0x78 ? isHex : radix === 0x62 ? (c: number) => c === 0x30 || c === 0x31 : (c: number) => c >= 0x30 && c <= 0x37;
            const digitsStart = this.pos;
            while (isIdentChar(this.at())) {
                const ch = this.at();
                if (ch !== 0x5f && !ok(ch)) bad ??= "invalid digit for its radix";
                this.pos++;
            }
            if (this.pos === digitsStart) bad ??= "a radix prefix needs digits";
        } else {
            this.digits();
            if (this.at() === 0x2e && isDigit(this.at(1))) {
                isFloat = true;
                this.pos++;
                this.digits();
            }
            if (this.at() === 0x65 || this.at() === 0x45) {
                isFloat = true;
                this.pos++;
                if (this.at() === 0x2b || this.at() === 0x2d) this.pos++;
                if (!isDigit(this.at())) bad ??= "an exponent needs digits";
                this.digits();
            }
            if (isIdentChar(this.at())) {
                bad ??= "letters can't follow a number";
                while (isIdentChar(this.at())) this.pos++;
            }
        }
        const raw = this.text(start, this.pos);
        if (bad === null && !underscoresOk(raw)) bad = "`_` may only sit between digits";
        if (bad !== null) {
            this.error("E_INVALID_NUMBER", `invalid number \`${raw}\`: ${bad}`, start, this.pos);
            this.push(isFloat ? "Float" : "Int", start, this.pos, isFloat ? 0 : 0n);
            return;
        }
        const clean = raw.replaceAll("_", "");
        if (isFloat) this.push("Float", start, this.pos, Number(clean));
        else this.push("Int", start, this.pos, BigInt(clean));
    }

    digits(): void {
        while (isDigit(this.at()) || this.at() === 0x5f) this.pos++;
    }

    // ---- delimiters (§1.1) --------------------------------------------------------------------

    opener(kind: string, start: number, len: number): void {
        this.pos = start + len;
        const index = this.push(kind, start, this.pos);
        this.stack.push({ index, close: OPENERS[kind]! });
    }

    closer(ch: string, start: number): void {
        const top = this.stack[this.stack.length - 1];
        if (top && top.close === ch) return this.closeTop(start, start + 1);
        let found = -1;
        for (let i = this.stack.length - 1; i >= 0; i--) {
            if (this.stack[i]!.close === ch) {
                found = i;
                break;
            }
        }
        if (found >= 0) {
            // the inner openers are unclosed: report each, close them with synthetic closers
            while (this.stack.length - 1 > found) {
                const inner = this.stack[this.stack.length - 1]!;
                const open = this.tokens[inner.index]!;
                this.error("E_UNMATCHED_DELIMITER", `\`${open.kind}\` is not closed before \`${ch}\``, open.start, open.end);
                this.closeTop(start, start, true);
            }
            return this.closeTop(start, start + 1);
        }
        if (top) {
            const open = this.tokens[top.index]!;
            this.error("E_UNMATCHED_DELIMITER", `expected \`${top.close}\` to close \`${open.kind}\`, found \`${ch}\``, start, start + 1);
            return this.closeTop(start, start + 1);
        }
        this.pos = start + 1;
        this.error("E_UNMATCHED_DELIMITER", `unexpected \`${ch}\`: nothing is open`, start, start + 1);
    }

    /** Closes the innermost opener with a closer spanning [start, end). */
    closeTop(start: number, end: number, synthetic = false): void {
        const top = this.stack.pop()!;
        if (top.template) {
            this.pos = synthetic ? start : end;
            if (synthetic) return this.endTemplate(top.template, start, start, start);
            return this.stringPart(top.template, start, end);
        }
        this.pos = synthetic ? start : end;
        const index = synthetic ? this.pushSynthetic(top.close, start) : this.push(top.close, start, end);
        this.tokens[top.index]!.match = index;
    }

    closeAllAtEof(): void {
        const end = this.src.length;
        while (this.stack.length > 0) {
            const top = this.stack[this.stack.length - 1]!;
            const open = this.tokens[top.index]!;
            if (top.template) this.error("E_UNTERMINATED_STRING", "this string is not closed", open.start, open.start + 1);
            else this.error("E_UNMATCHED_DELIMITER", `\`${open.kind}\` is not closed`, open.start, open.end);
            this.closeTop(end, end, true);
        }
    }

    /**
     * A newline inside an interpolation of a single-line string is an error (§1.5). It is reported
     * once per string, and lexing carries on as if the string were multi-line, so the rest of the
     * interpolation and the string's tail still pair up.
     */
    newlineInInterpolation(at: number): void {
        for (const open of this.stack) {
            const t = open.template;
            if (!t || t.multiline || t.reported) continue;
            t.reported = true;
            const head = this.tokens[open.index]!;
            this.error("E_UNTERMINATED_STRING", "a `\"…\"` string ends on its line, interpolations included (use `\"\"\"`)", head.start, at);
        }
    }

    // ---- strings (§1.5) -----------------------------------------------------------------------

    /** Lexes a string starting at its opening quote. */
    string(start: number, tokenStart: number): void {
        const multiline = this.at(1) === 0x22 && this.at(2) === 0x22;
        this.pos = start + (multiline ? 3 : 1);
        const tpl: Template = { multiline, parts: [] };
        this.scanPart(tpl, tokenStart, this.pos, true);
    }

    /** Resumes a template after the `}` of an interpolation, spanning [start, end). */
    stringPart(tpl: Template, start: number, end: number): void {
        this.pos = end;
        this.scanPart(tpl, start, end, false);
    }

    /**
     * Scans string content from `this.pos` up to the closing quote or the next `${`.
     * `tokenStart` is where the token began (the quote, or the `}` of an interpolation).
     */
    scanPart(tpl: Template, tokenStart: number, rawStart: number, first: boolean): void {
        const multiline = tpl.multiline;
        for (;;) {
            const c = this.at();
            if (c === -1 || (!multiline && c === 0x0a)) {
                this.error("E_UNTERMINATED_STRING", multiline ? "`\"\"\"` is not closed" : "a `\"…\"` string must end on its line (use `\"\"\"`)", tokenStart, this.pos);
                return this.finishPart(tpl, tokenStart, rawStart, this.pos, this.pos, first, true);
            }
            if (c === 0x22 && (!multiline || (this.at(1) === 0x22 && this.at(2) === 0x22))) {
                const rawEnd = this.pos;
                this.pos += multiline ? 3 : 1;
                return this.finishPart(tpl, tokenStart, rawStart, rawEnd, this.pos, first, true);
            }
            if (c === 0x5c) {
                this.escape(false);
                continue;
            }
            if (c === 0x24 && this.at(1) === 0x7b) {
                const rawEnd = this.pos;
                this.pos += 2;
                return this.finishPart(tpl, tokenStart, rawStart, rawEnd, this.pos, first, false);
            }
            this.pos += this.charLen(this.pos);
        }
    }

    finishPart(tpl: Template, tokenStart: number, rawStart: number, rawEnd: number, tokenEnd: number, first: boolean, last: boolean): void {
        if (first && last) {
            // no interpolation: a plain string
            const index = this.push("String", tokenStart, tokenEnd);
            tpl.parts.push({ index, rawStart, rawEnd });
            this.cook(tpl);
            return;
        }
        const kind = first ? "TemplateHead" : last ? "TemplateTail" : "TemplateMiddle";
        const index = this.push(kind, tokenStart, tokenEnd);
        tpl.parts.push({ index, rawStart, rawEnd });
        if (last) return this.endTemplateParts(tpl);
        this.stack.push({ index, close: "}", template: tpl });
    }

    /** A template closed early (EOF, newline, unbalanced closer): a zero-width tail at `at`. */
    endTemplate(tpl: Template, at: number, rawStart: number, rawEnd: number): void {
        const index = this.pushSynthetic("TemplateTail", at);
        tpl.parts.push({ index, rawStart, rawEnd });
        this.endTemplateParts(tpl);
    }

    endTemplateParts(tpl: Template): void {
        const tail = tpl.parts[tpl.parts.length - 1]!.index;
        for (const p of tpl.parts.slice(0, -1)) this.tokens[p.index]!.match = tail;
        this.cook(tpl);
    }

    /** Computes each part's value: CRLF → LF, `"""` indentation rules, then escapes. */
    cook(tpl: Template): void {
        const raws = tpl.parts.map((p) => this.text(p.rawStart, p.rawEnd).replaceAll("\r\n", "\n"));
        const lineStart = raws.map(() => false);
        if (tpl.multiline) {
            const firstLine = /^[ \t]*\n/.exec(raws[0]!);
            if (firstLine) {
                raws[0] = raws[0]!.slice(firstLine[0].length);
                lineStart[0] = true;
            }
            const last = raws.length - 1;
            const nl = raws[last]!.lastIndexOf("\n");
            const closing = nl >= 0 ? raws[last]!.slice(nl + 1) : null;
            if (closing !== null && /^[ \t]*$/.test(closing)) {
                raws[last] = raws[last]!.slice(0, nl);
                if (closing.length > 0) {
                    for (let i = 0; i < raws.length; i++) raws[i] = dedent(raws[i]!, closing, lineStart[i]!);
                }
            }
        }
        for (let i = 0; i < tpl.parts.length; i++) {
            const tok = this.tokens[tpl.parts[i]!.index]!;
            tok.value = unescape(raws[i]!, false);
            if (tpl.multiline) tok.multiline = true;
        }
    }

    /** Validates one escape at `this.pos` (the backslash) and skips it. */
    escape(byte: boolean): void {
        const start = this.pos;
        const c = this.at(1);
        this.pos += 2;
        if (c === -1) return;
        const simple = "nrt0\\\"'$";
        if (simple.includes(String.fromCharCode(c)) && (!byte || c !== 0x24)) return;
        if (c === 0x78) {
            const h1 = this.at();
            const h2 = this.at(1);
            if (isHex(h1) && isHex(h2)) {
                this.pos += 2;
                const v = parseInt(String.fromCharCode(h1, h2), 16);
                if (!byte && v > 0x7f) {
                    this.error("E_INVALID_ESCAPE", "`\\x` escapes in strings and chars are ASCII only (00–7F)", start, this.pos, "\\u{…}");
                }
                return;
            }
            this.error("E_INVALID_ESCAPE", "`\\x` needs two hex digits", start, this.pos);
            return;
        }
        if (c === 0x75 && !byte && this.at() === 0x7b) {
            this.pos++;
            const digitsStart = this.pos;
            while (isHex(this.at())) this.pos++;
            const n = this.pos - digitsStart;
            const closed = this.at() === 0x7d;
            if (closed) this.pos++;
            const v = n > 0 ? parseInt(this.text(digitsStart, digitsStart + n), 16) : -1;
            if (!closed || n < 1 || n > 6 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) {
                this.error("E_INVALID_ESCAPE", "`\\u{…}` takes 1–6 hex digits naming a Unicode scalar value", start, this.pos);
            }
            return;
        }
        this.pos = start + 1 + this.charLen(start + 1);
        this.error("E_INVALID_ESCAPE", `unknown escape \`${this.text(start, this.pos)}\``, start, this.pos);
    }

    rawString(start: number): void {
        this.pos = start + 2;
        while (this.pos < this.src.length && this.at() !== 0x22) this.pos++;
        const rawEnd = this.pos;
        if (this.pos >= this.src.length) this.error("E_UNTERMINATED_STRING", "`r\"` is not closed", start, start + 2);
        else this.pos++;
        this.push("RawString", start, this.pos, this.text(start + 2, rawEnd).replaceAll("\r\n", "\n"));
    }

    // ---- chars and bytes (§1.5, §1.6) ---------------------------------------------------------

    char(start: number, byte: boolean): void {
        const quote = start + (byte ? 1 : 0);
        this.pos = quote + 1;
        if (!byte && isDigit(this.at())) {
            // the removed tagged record `'1{`
            let p = this.pos;
            while (isDigit(this.src[p] ?? -1)) p++;
            if (this.src[p] === 0x7b) {
                this.error("E_TAGGED_RECORD_REMOVED", "tagged records are removed", start, p + 1, "r{ … }");
                return this.opener("r{", start, p + 1 - start);
            }
        }
        const kind = byte ? "Byte" : "Char";
        const what = byte ? "a byte literal" : "a char literal";
        const c = this.at();
        if (c === 0x27) {
            this.pos++;
            this.error("E_INVALID_CHAR", `${what} can't be empty`, start, this.pos);
            return void this.push(kind, start, this.pos, byte ? 0 : "");
        }
        if (c === -1 || c === 0x0a) {
            this.error("E_INVALID_CHAR", `${what} is not closed`, start, this.pos);
            return void this.push(kind, start, this.pos, byte ? 0 : "");
        }
        const contentStart = this.pos;
        if (c === 0x5c) this.escape(byte);
        else this.pos += this.charLen(this.pos);
        const content = this.text(contentStart, this.pos);
        if (this.at() === 0x27) {
            this.pos++;
            const cooked = unescape(content, byte);
            if (!byte) return void this.push(kind, start, this.pos, cooked);
            if (c !== 0x5c && c >= 0x80) {
                this.error("E_BYTE_LITERAL_NOT_ASCII", `\`${content}\` is several bytes in UTF-8`, start, this.pos, "b'\\xHH' or a str");
                return void this.push(kind, start, this.pos, 0);
            }
            return void this.push(kind, start, this.pos, byteValue(content));
        }
        // more than one character: `'ab'` up to the closing quote on this line, else unclosed `'a`
        let p = this.pos;
        while (p < this.src.length && this.src[p] !== 0x27 && this.src[p] !== 0x0a) p++;
        if (this.src[p] === 0x27) {
            this.pos = p + 1;
            this.error("E_INVALID_CHAR", `${what} holds one character (use a string)`, start, this.pos);
        } else {
            this.error("E_INVALID_CHAR", `${what} is not closed`, start, this.pos);
        }
        this.push(kind, start, this.pos, byte ? 0 : "");
    }
}

// ---- pure helpers ---------------------------------------------------------------------------

function underscoresOk(raw: string): boolean {
    const body = /^0[xob]/.test(raw) ? raw.slice(2) : raw;
    if (body.startsWith("_") || body.endsWith("_")) return false;
    return !/_[^0-9a-fA-F]|[^0-9a-fA-F]_/.test(body);
}

/** Strips, from each line start in `s`, the whitespace it shares with `indent` (§1.5). */
function dedent(s: string, indent: string, startsLine: boolean): string {
    const lines = s.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (i === 0 && !startsLine) continue;
        const line = lines[i]!;
        let n = 0;
        while (n < indent.length && n < line.length && line[n] === indent[n]) n++;
        lines[i] = line.slice(n);
    }
    return lines.join("\n");
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
    n: "\n", r: "\r", t: "\t", "0": "\0", "\\": "\\", '"': '"', "'": "'", $: "$",
};

/** Cooks escapes; invalid ones (already reported) keep their character. */
function unescape(s: string, byte: boolean): string {
    if (!s.includes("\\")) return s;
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const ch = s[i]!;
        if (ch !== "\\" || i + 1 >= s.length) {
            out += ch;
            continue;
        }
        const n = s[i + 1]!;
        if (n in SIMPLE_ESCAPES) {
            out += SIMPLE_ESCAPES[n];
            i++;
        } else if (n === "x" && /^[0-9a-fA-F]{2}/.test(s.slice(i + 2, i + 4))) {
            out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16));
            i += 3;
        } else if (n === "u" && !byte && s[i + 2] === "{") {
            const close = s.indexOf("}", i + 3);
            const v = close > 0 ? parseInt(s.slice(i + 3, close), 16) : NaN;
            if (close > 0 && Number.isFinite(v) && v <= 0x10ffff) {
                out += String.fromCodePoint(v);
                i = close;
            } else {
                out += n;
                i++;
            }
        } else {
            out += n;
            i++;
        }
    }
    return out;
}

function byteValue(content: string): number {
    const cooked = unescape(content, true);
    return cooked.charCodeAt(0) & 0xff;
}
