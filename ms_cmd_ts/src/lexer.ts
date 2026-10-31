export type TokenKind = string;

export interface Span { start: number; end: number; line: number; column: number; endLine: number; endColumn: number }
export interface Token {
  kind: TokenKind;
  lexeme: string;
  value?: string | number | boolean;
  span: Span;
  ws_before: boolean;
  nl_before: boolean;
  matching: number | null;
}
export interface Trivia { kind: "LINE_COMMENT" | "BLOCK_COMMENT"; text: string; span: Span }
export interface LexResult { source: string; tokens: Token[]; trivia: Trivia[]; errors: LexError[] }
export interface LexError { code: string; message: string; span: Span }

type StringMode = { type: "string"; quote: '"' | '"""'; raw: boolean; start: number };
type InterpolationMode = { type: "interpolation"; depth: number; start: number };
type Mode = StringMode | InterpolationMode;

const KEYWORDS = new Set([
  "package", "import", "pub", "type", "inter", "impl", "fun", "async", "let", "var", "mut", "extern",
  "if", "else", "match", "for", "in", "while", "loop", "break", "continue", "return",
  "await", "or", "as", "unsafe", "recover", "true", "false", "nil", "this", "Self", "TypeOf",
]);
const OPERATORS = [
  ">>=", "<<=", "...", "..=", "?.", "??", ":==", ":=", "->", "=>", "==", "!=", "<=", ">=", "&&", "||",
  "<<", ">>", "+=", "-=", "*=", "/=", "%=", "..", "++", "--",
  "=", "+", "-", "*", "/", "%", "<", ">", "!", "&", "|", "^", "~", "?", ".", ":", ";", ",", "@",
  "(", ")", "[", "]", "{", "}",
];
const OPEN_TO_CLOSE: Record<string, string> = {
  "LPAREN": "RPAREN", "LBRACKET": "RBRACKET", "LBRACE": "RBRACE",
  "RECORD_OPEN": "RBRACE", "MAP_OPEN": "RBRACE", "SET_OPEN": "RBRACE", "INFERRED_OPEN": "RBRACE",
  "TAGGED_RECORD_OPEN": "RBRACE", "CLOSURE_OPEN": "RBRACE", "TUPLE_OPEN": "RPAREN",
  "ARRAY_OPEN": "RBRACKET", "VEC_OPEN": "RBRACKET", "CAPTURE_OPEN": "RBRACKET",
  "INTERP_START": "INTERP_END",
};
const CLOSERS = new Set(["RPAREN", "RBRACKET", "RBRACE", "INTERP_END"]);

export class MinScriptLexer {
  private source: string;
  private i = 0;
  private line = 1;
  private column = 1;
  private tokens: Token[] = [];
  private trivia: Trivia[] = [];
  private errors: LexError[] = [];
  private modes: Mode[] = [];
  private delimiters: Array<{ tokenIndex: number; expected: string }> = [];
  private hadWhitespace = true;
  private hadNewline = false;
  private afterDot = false;

  constructor(input: string) {
    this.source = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  }

  lex(): LexResult {
    while (!this.eof()) {
      const mode = this.modes[this.modes.length - 1];
      if (mode?.type === "string") { this.scanStringSegment(mode); continue; }
      this.scanTrivia();
      if (this.eof()) break;
      const active = this.modes[this.modes.length - 1];
      if (active?.type === "interpolation" && this.peek() === "}" && active.depth === 0) {
        const token = this.emit("INTERP_END", 1);
        this.closeDelimiter("INTERP_END", token);
        this.modes.pop();
        continue;
      }
      this.scanToken();
    }
    for (const open of this.delimiters) {
      const token = this.tokens[open.tokenIndex];
      this.errors.push({ code: "E_UNCLOSED_DELIMITER", message: `Expected ${open.expected} to close ${token.lexeme}`, span: token.span });
    }
    if (this.modes.length) {
      const mode = this.modes[this.modes.length - 1];
      this.error("E_UNTERMINATED_STRING", "Unterminated string or interpolation", mode.start, this.i);
    }
    return { source: this.source, tokens: this.tokens, trivia: this.trivia, errors: this.errors };
  }

  private scanTrivia(): void {
    while (!this.eof()) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\n") {
        this.hadWhitespace = true;
        if (c === "\n") this.hadNewline = true;
        this.advance();
        continue;
      }
      if (this.startsWith("//")) {
        const start = this.i, pos = this.position();
        const doc = this.startsWith("///");
        while (!this.eof() && this.peek() !== "\n") this.advance();
        const text = this.source.slice(start, this.i);
        const span = this.makeSpan(start, pos);
        this.trivia.push({ kind: "LINE_COMMENT", text, span });
        if (doc) this.emitAt("DOC_COMMENT", start, this.i, text, pos);
        this.hadWhitespace = true;
        continue;
      }
      if (this.startsWith("/*")) {
        const start = this.i, pos = this.position();
        this.advance(2);
        let depth = 1;
        while (!this.eof() && depth > 0) {
          if (this.startsWith("/*")) { depth++; this.advance(2); }
          else if (this.startsWith("*/")) { depth--; this.advance(2); }
          else { if (this.peek() === "\n") this.hadNewline = true; this.advance(); }
        }
        const text = this.source.slice(start, this.i);
        this.trivia.push({ kind: "BLOCK_COMMENT", text, span: this.makeSpan(start, pos) });
        if (depth > 0) this.error("E_UNTERMINATED_COMMENT", "Unterminated block comment", start, this.i);
        this.hadWhitespace = true;
        continue;
      }
      break;
    }
  }

  private scanToken(): void {
    const c = this.peek();
    if (this.modes[this.modes.length - 1]?.type === "interpolation" && c === "{") {
      (this.modes[this.modes.length - 1] as InterpolationMode).depth++;
    } else if (this.modes[this.modes.length - 1]?.type === "interpolation" && c === "}") {
      (this.modes[this.modes.length - 1] as InterpolationMode).depth--;
    }

    if (c === "r" && this.peek(1) === "`") { this.scanRawString(); return; }
    if (c === "#" && (this.peek(1) === "{" || this.peek(1) === "[")) {
      const kind = this.peek(1) === "{" ? "CLOSURE_OPEN" : "CAPTURE_OPEN";
      const close = this.peek(1) === "{" ? "RBRACE" : "RBRACKET";
      const token = this.emit(kind, 2); this.pushDelimiter(token, close); this.afterDot = false; return;
    }
    if (c === "t" && this.peek(1) === "(" && !this.afterDot && !this.isIdentPart(this.source[this.i - 1] ?? "")) {
      const token = this.emit("TUPLE_OPEN", 2); this.pushDelimiter(token, "RPAREN"); this.afterDot = false; return;
    }
    if (c === "'" && this.scanTagOrChar()) return;
    if (c === '"') { this.startString(); return; }
    if (this.isDigit(c)) { this.scanNumber(); return; }
    if (this.isIdentStart(c)) { this.scanIdentifierOrSigil(); return; }
    if (c === "_") { this.scanIdentifierOrSigil(); return; }

    for (const op of OPERATORS) {
      if (!this.startsWith(op)) continue;
      const kind = this.operatorKind(op);
      const token = this.emit(kind, op.length);
      if (op === "." || op === "?.") this.afterDot = true;
      else if (kind !== "DOC_COMMENT") this.afterDot = false;
      if (op === "(") this.pushDelimiter(token, "RPAREN");
      else if (op === "[") this.pushDelimiter(token, "RBRACKET");
      else if (op === "{") this.pushDelimiter(token, "RBRACE");
      else if (op === ")" || op === "]" || op === "}") this.closeDelimiter(kind, token);
      return;
    }
    this.error("E_UNKNOWN_CHARACTER", `Unexpected character ${JSON.stringify(c)}`, this.i, this.i + 1);
    this.advance();
  }

  private scanIdentifierOrSigil(): void {
    const start = this.i, pos = this.position();
    if (this.peek() === "_" && this.peek(1) === "{") { this.emit("INFERRED_OPEN", 2); this.pushLastDelimiter("RBRACE"); this.afterDot = false; return; }
    while (this.isIdentPart(this.peek())) this.advance();
    const word = this.source.slice(start, this.i);
    const next = this.peek();
    if (this.i === start + 1 && !this.afterDot && next === "{") {
      const sigil: Record<string, string> = { r: "RECORD_OPEN", m: "MAP_OPEN", s: "SET_OPEN" };
      if (sigil[word]) { const token = this.emitAt(sigil[word], start, this.i + 1, word + "{", pos); this.advance(); this.pushDelimiter(token, "RBRACE"); this.afterDot = false; return; }
    }
    if (this.i === start + 1 && !this.afterDot && next === "[") {
      const sigil: Record<string, string> = { a: "ARRAY_OPEN", v: "VEC_OPEN" };
      if (sigil[word]) { const token = this.emitAt(sigil[word], start, this.i + 1, word + "[", pos); this.advance(); this.pushDelimiter(token, "RBRACKET"); this.afterDot = false; return; }
    }
    let kind = word === "_" ? "WILDCARD" : "IDENT";
    if (word !== "_" && !this.afterDot && KEYWORDS.has(word)) kind = "KW_" + word.toUpperCase();
    else if (word !== "_" && !this.afterDot && (/^it(?:[1-9][0-9]*)?$/.test(word))) kind = "IT_IDENT";
    const token = this.emitAt(kind, start, this.i, word, pos);
    this.afterDot = false;
    void token;
  }

  private scanNumber(): void {
    const start = this.i, pos = this.position();
    let base = 10;
    if (this.startsWith("0x") || this.startsWith("0X")) { base = 16; this.advance(2); this.consumeDigits(/[0-9a-fA-F_]/); }
    else if (this.startsWith("0b") || this.startsWith("0B")) { base = 2; this.advance(2); this.consumeDigits(/[01_]/); }
    else if (this.startsWith("0o") || this.startsWith("0O")) { base = 8; this.advance(2); this.consumeDigits(/[0-7_]/); }
    else {
      this.consumeDigits(/[0-9_]/);
      if (!this.afterDot && this.peek() === "." && this.isDigit(this.peek(1))) { this.advance(); this.consumeDigits(/[0-9_]/); }
      if (this.peek() === "e" || this.peek() === "E") {
        const save = this.i; this.advance(); if (this.peek() === "+" || this.peek() === "-") this.advance();
        if (this.isDigit(this.peek())) this.consumeDigits(/[0-9_]/); else this.i = save;
      }
    }
    const raw = this.source.slice(start, this.i);
    const clean = raw.replaceAll("_", "");
    const isFloat = base === 10 && /[.eE]/.test(clean);
    const value = isFloat ? Number(clean) : Number.parseInt(clean.slice(base === 10 ? 0 : 2), base);
    this.emitAt(isFloat ? "FLOAT" : "INT", start, this.i, value, pos);
    this.afterDot = false;
  }

  private scanTagOrChar(): boolean {
    const start = this.i;
    // A complete quoted scalar wins over the tagged-record form: '1' is a char, '1{ is a tag.
    if (this.peek(1) !== "\\" && this.peek(1) !== "\n") {
      const cp = this.source.codePointAt(this.i + 1);
      const width = cp !== undefined && cp > 0xffff ? 2 : 1;
      if (cp !== undefined && this.source[this.i + 1 + width] === "'") {
        const pos = this.position(), ch = String.fromCodePoint(cp); this.advance(2 + width); this.emitAt("CHAR", start, this.i, ch, pos); this.afterDot = false; return true;
      }
    }
    if (this.peek(1) === "\\") {
      let j = this.i + 2;
      while (j < this.source.length && this.source[j] !== "'" && this.source[j] !== "\n") j++;
      if (this.source[j] === "'") { const pos = this.position(); this.advance(j - this.i + 1); this.emitAt("CHAR", start, this.i, this.source.slice(start, this.i), pos); this.afterDot = false; return true; }
    }
    let j = this.i + 1;
    while (/[0-9]/.test(this.source[j] ?? "")) j++;
    if (j > this.i + 1 && this.source[j] === "{") {
      const token = this.emit("TAGGED_RECORD_OPEN", j - this.i + 1, this.source.slice(this.i + 1, j));
      this.pushDelimiter(token, "RBRACE"); this.afterDot = false; return true;
    }
    this.error("E_INVALID_CHAR_OR_TAG", "Expected a character literal such as 'x' or a tagged record opener such as '1{", start, Math.min(start + 2, this.source.length));
    this.advance(); return true;
  }

  private startString(): void {
    const start = this.i;
    const quote = this.startsWith('"""') ? '"""' : '"';
    const pos = this.position(); this.advance(quote.length);
    const mode: StringMode = { type: "string", quote, raw: false, start };
    this.modes.push(mode);
    this.emitAt("STRING_START", start, this.i, quote, pos);
  }

  private scanStringSegment(mode: StringMode): void {
    const start = this.i, startPos = this.position();
    let value = "";
    while (!this.eof()) {
      if (this.source.startsWith(mode.quote, this.i)) {
        if (this.i > start) this.emitAt("STRING_TEXT", start, this.i, value, startPos);
        const qStart = this.i, qPos = this.position(); this.advance(mode.quote.length);
        this.emitAt("STRING_END", qStart, this.i, mode.quote, qPos);
        this.modes.pop(); this.afterDot = false; return;
      }
      if (mode.quote === '"' && this.peek() === "\n") {
        this.error("E_NEWLINE_IN_STRING", "A normal string cannot contain a newline; use a triple-quoted string", mode.start, this.i);
        this.modes.pop(); return;
      }
      if (this.startsWith("${")) {
        if (this.i > start) this.emitAt("STRING_TEXT", start, this.i, value, startPos);
        const p = this.position(); this.advance(2); const token = this.emitAt("INTERP_START", this.i - 2, this.i, "${", p);
        this.pushDelimiter(token, "INTERP_END");
        this.modes.push({ type: "interpolation", depth: 0, start: this.i - 2 });
        return;
      }
      if (this.peek() === "\\") {
        const escapeStart = this.i; this.advance();
        const e = this.peek();
        const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", "0": "\0", "\\": "\\", '"': '"', "'": "'", "$": "$" };
        if (e in simple) { value += simple[e]; this.advance(); continue; }
        if (e === "x" && /^[0-9a-fA-F]{2}$/.test(this.source.slice(this.i + 1, this.i + 3))) { value += String.fromCharCode(Number.parseInt(this.source.slice(this.i + 1, this.i + 3), 16)); this.advance(3); continue; }
        if (e === "u" && this.peek(1) === "{") {
          this.advance(2); const hexStart = this.i; while (/[0-9a-fA-F]/.test(this.peek())) this.advance(); const hex = this.source.slice(hexStart, this.i);
          if (!hex || this.peek() !== "}") this.error("E_INVALID_ESCAPE", "Invalid Unicode escape; expected \\u{HEX}", escapeStart, this.i);
          else { this.advance(); const cp = Number.parseInt(hex, 16); if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) this.error("E_INVALID_ESCAPE", "Unicode escape is not a valid scalar value", escapeStart, this.i); else value += String.fromCodePoint(cp); }
          continue;
        }
        this.error("E_INVALID_ESCAPE", `Unknown escape \\${e}`, escapeStart, this.i + (e ? 1 : 0));
        if (e) this.advance(); continue;
      }
      value += this.peek(); this.advance();
    }
    if (this.i > start) this.emitAt("STRING_TEXT", start, this.i, value, startPos);
    this.error("E_UNTERMINATED_STRING", "Unterminated string", mode.start, this.i);
    this.modes.pop();
  }

  private scanRawString(): void {
    const start = this.i, pos = this.position(); this.advance(2);
    const contentStart = this.i;
    while (!this.eof() && this.peek() !== "`") this.advance();
    const value = this.source.slice(contentStart, this.i);
    if (this.eof()) this.error("E_UNTERMINATED_RAW_STRING", "Unterminated raw string", start, this.i);
    else this.advance();
    this.emitAt("RAW_STRING", start, this.i, value, pos); this.afterDot = false;
  }

  private operatorKind(op: string): string {
    const map: Record<string, string> = { "(": "LPAREN", ")": "RPAREN", "[": "LBRACKET", "]": "RBRACKET", "{": "LBRACE", "}": "RBRACE" };
    return map[op] ?? "OP_" + op;
  }
  private emit(kind: string, length: number, value?: string | number | boolean): Token {
    const start = this.i, pos = this.position(); this.advance(length);
    return this.emitAt(kind, start, this.i, value, pos);
  }
  private emitAt(kind: string, start: number, end: number, value: string | number | boolean | undefined, pos: { line: number; column: number }): Token {
    const token: Token = { kind, lexeme: this.source.slice(start, end), ...(value === undefined ? {} : { value }), span: this.makeSpan(start, pos, end), ws_before: this.hadWhitespace, nl_before: this.hadNewline, matching: null };
    this.tokens.push(token); this.hadWhitespace = false; this.hadNewline = false;
    return token;
  }
  private pushLastDelimiter(expected: string): void { this.pushDelimiter(this.tokens[this.tokens.length - 1], expected); }
  private pushDelimiter(token: Token, expected: string): void { this.delimiters.push({ tokenIndex: this.tokens.length - 1, expected }); }
  private closeDelimiter(kind: string, token: Token): void {
    const open = this.delimiters[this.delimiters.length - 1];
    if (!open) { this.errors.push({ code: "E_UNEXPECTED_CLOSER", message: `Unexpected ${token.lexeme}`, span: token.span }); return; }
    if (open.expected !== kind) { this.errors.push({ code: "E_MISMATCHED_DELIMITER", message: `Expected ${open.expected}, found ${kind}`, span: token.span }); return; }
    this.delimiters.pop(); const openToken = this.tokens[open.tokenIndex];
    openToken.matching = this.tokens.length - 1; token.matching = open.tokenIndex;
  }
  private error(code: string, message: string, start: number, end: number): void {
    this.errors.push({ code, message, span: this.makeSpan(start, this.positionAt(start), end) });
  }
  private makeSpan(start: number, pos: { line: number; column: number }, end = this.i): Span {
    const endPos = end === this.i ? this.position() : this.positionAt(end);
    return { start, end, line: pos.line, column: pos.column, endLine: endPos.line, endColumn: endPos.column };
  }
  private position(): { line: number; column: number } { return { line: this.line, column: this.column }; }
  private positionAt(index: number): { line: number; column: number } {
    let line = 1, column = 1;
    for (let j = 0; j < index; j++) { if (this.source[j] === "\n") { line++; column = 1; } else column++; }
    return { line, column };
  }
  private consumeDigits(pattern: RegExp): void { while (!this.eof() && pattern.test(this.peek())) this.advance(); }
  private advance(n = 1): void {
    for (let j = 0; j < n && !this.eof(); j++) { if (this.source[this.i] === "\n") { this.line++; this.column = 1; } else this.column++; this.i++; }
  }
  private peek(offset = 0): string { return this.source[this.i + offset] ?? ""; }
  private startsWith(value: string): boolean { return this.source.startsWith(value, this.i); }
  private eof(): boolean { return this.i >= this.source.length; }
  private isDigit(c: string): boolean { return c >= "0" && c <= "9"; }
  private isIdentStart(c: string): boolean { return /[A-Za-z]/.test(c); }
  private isIdentPart(c: string): boolean { return /[A-Za-z0-9_]/.test(c); }
}

export function lex(source: string): LexResult { return new MinScriptLexer(source).lex(); }
