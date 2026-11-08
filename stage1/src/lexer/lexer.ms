// The MinScript lexer (spec §1), ported from minscript/src/lexer.ts: a hand-written single pass over
// UTF-8 bytes.
//
// - Newlines are not tokens: each token carries `nl_before` / `ws_before`, and the parser applies the
//   statement rules of spec §5.4.
// - Comments go to a side list (`trivia`).
// - Openers record the index of their matching closer, and mismatched delimiters are recovered here,
//   so the parser always sees balanced brackets.
// - String interpolation uses a mode stack: `"a${x}b"` lexes as TemplateHead("a"), Ident(x),
//   TemplateTail("b"). Templates are always balanced: an unterminated one gets a zero-width tail.
package lexer

import "std.utf8"

/// Lexes a source file.
pub fun lex(src: Vec[u8]) -> LexResult {
    var l = Lexer { src }
    l.run()
}

// ---- string state -------------------------------------------------------------------------------

/// One source line of a string chunk. `ws` is the raw leading whitespace, kept apart for dedent.
type Segment = {
    /// starts after a source newline, so indentation may be stripped
    strip: bool
    /// render a "\n" before it
    emit_nl: bool
    ws: string = ""
    /// cooked text after the leading whitespace
    text: string = ""
    /// still collecting leading whitespace
    ws_mode: bool = true
}

type Chunk = { tok: int, segs: Vec[Segment] }

type StringState = {
    /// the opening quote(s), for diagnostics
    span: Span
    multiline: bool
    chunks: Vec[Chunk] = []
}

/// The mode stack: an open delimiter, or an interpolation inside a string (an index into `strings`).
union Entry = {
    Delim { opener: int, closer: string }
    Interp(int)
}

// byte values
let TAB: int = 0x09
let LF: int = 0x0a
let CR: int = 0x0d
let SPACE: int = 0x20
let DQUOTE: int = 0x22
let HASH: int = 0x23
let DOLLAR: int = 0x24
let SQUOTE: int = 0x27
let LPAREN: int = 0x28
let RPAREN: int = 0x29
let STAR: int = 0x2a
let PLUS: int = 0x2b
let MINUS: int = 0x2d
let DOT: int = 0x2e
let SLASH: int = 0x2f
let ZERO: int = 0x30
let LBRACKET: int = 0x5b
let BACKSLASH: int = 0x5c
let RBRACKET: int = 0x5d
let UNDERSCORE: int = 0x5f
let LBRACE: int = 0x7b
let RBRACE: int = 0x7d

fun is_digit(c: int) -> bool { c >= 0x30 && c <= 0x39 }
fun is_hex(c: int) -> bool { is_digit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66) }
fun is_oct(c: int) -> bool { c >= 0x30 && c <= 0x37 }
fun is_bin(c: int) -> bool { c == 0x30 || c == 0x31 }
fun is_ident_start(c: int) -> bool { (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c == UNDERSCORE }
fun is_ident_char(c: int) -> bool { is_ident_start(c) || is_digit(c) }

fun hex_value(c: int) -> int {
    if is_digit(c) { c - 0x30 } else if c >= 0x61 { c - 0x61 + 10 } else { c - 0x41 + 10 }
}

// ---- the lexer ----------------------------------------------------------------------------------

type Lexer = {
    src: Vec[u8]
    pos: int = 0
    line: int = 1
    line_start: int = 0
    ws_before: bool = false
    nl_before: bool = false
    tokens: Vec[Token] = []
    trivia: Vec[Trivia] = []
    diagnostics: Vec[Diagnostic] = []
    stack: Vec[Entry] = []
    strings: Vec[StringState] = []
    // column cache for the current line
    col_line: int = -1
    col_pos: int = 0
    col_val: int = 1

    fun run(mut this) -> LexResult {
        if this.at(0) == 0xef && this.at(1) == 0xbb && this.at(2) == 0xbf {
            this.pos = 3
            this.line_start = 3
        }
        for {
            this.skip_trivia()
            if this.pos >= this.src.len() {
                break
            }
            this.lex_token()
        }
        this.unwind_at_eof()
        let at = this.span_at(this.pos)
        this.push("EOF", this.pos, this.pos, at, None)
        LexResult { tokens: this.tokens, trivia: this.trivia, diagnostics: this.diagnostics }
    }

    // ---- positions and output ----

    /// The byte at `i`, or -1 past the end.
    fun at(&this, i: int) -> int {
        if i >= 0 && i < this.src.len() { this.src[i] as int } else { -1 }
    }

    fun col(&mut this, pos: int) -> int {
        if this.col_line != this.line_start || pos < this.col_pos {
            this.col_line = this.line_start
            this.col_pos = this.line_start
            this.col_val = 1
        }
        var i = this.col_pos
        for i < pos {
            if (this.at(i) & 0xc0) != 0x80 {
                this.col_val += 1
            }
            i += 1
        }
        this.col_pos = pos
        this.col_val
    }

    /// A span starting at `pos`, which must be on the current line.
    fun span_at(&mut this, pos: int) -> Span {
        let col = this.col(pos)
        r{ start: pos, end: pos, line: this.line, col }
    }

    fun push(&mut this, kind: &str, start: int, end: int, at: Span, value: Value?) -> int {
        var span = at
        span.start = start
        span.end = end
        this.tokens.push(Token { kind: kind.to_str(), span, ws_before: this.ws_before, nl_before: this.nl_before, closer: None, value })
        this.ws_before = false
        this.nl_before = false
        this.tokens.len() - 1
    }

    fun error(&mut this, code: &str, message: string, at: Span, end: int) {
        var span = at
        span.end = end
        this.diagnostics.push(Diagnostic { code: code.to_str(), message, span })
    }

    fun prev_kind(&this) -> string {
        if this.tokens.is_empty() { "" } else { this.tokens[this.tokens.len() - 1].kind.clone() }
    }

    /// Consumes a LF or CRLF at `pos`.
    fun consume_newline(&mut this) {
        if this.at(this.pos) == CR {
            this.pos += 1
        }
        this.pos += 1
        this.line += 1
        this.line_start = this.pos
    }

    fun at_newline(&this) -> bool {
        let c = this.at(this.pos)
        c == LF || (c == CR && this.at(this.pos + 1) == LF)
    }

    fun text(&this, start: int, end: int) -> string {
        utf8.decode_range(this.src, start, end)
    }

    // ---- trivia ----

    fun skip_trivia(&mut this) {
        for this.pos < this.src.len() {
            let c = this.at(this.pos)
            if c == SPACE || c == TAB || (c == CR && this.at(this.pos + 1) != LF) {
                this.pos += 1
                this.ws_before = true
            } else if this.at_newline() {
                this.end_single_line_interpolation()
                this.consume_newline()
                this.ws_before = true
                this.nl_before = true
            } else if c == SLASH && this.at(this.pos + 1) == SLASH {
                this.line_comment()
            } else if c == SLASH && this.at(this.pos + 1) == STAR {
                this.block_comment()
            } else {
                return
            }
        }
    }

    fun line_comment(&mut this) {
        let start = this.pos
        let at = this.span_at(start)
        var end = start
        for end < this.src.len() && this.at(end) != LF && !(this.at(end) == CR && this.at(end + 1) == LF) {
            end += 1
        }
        let is_doc = this.at(start + 2) == SLASH && this.at(start + 3) != SLASH
        this.add_trivia(if is_doc { "doc" } else { "line" }, start, end, at)
        this.pos = end
        this.ws_before = true
    }

    fun block_comment(&mut this) {
        let start = this.pos
        let at = this.span_at(start)
        this.pos += 2
        var depth = 1
        for this.pos < this.src.len() && depth > 0 {
            let c = this.at(this.pos)
            if c == SLASH && this.at(this.pos + 1) == STAR {
                depth += 1
                this.pos += 2
            } else if c == STAR && this.at(this.pos + 1) == SLASH {
                depth -= 1
                this.pos += 2
            } else if this.at_newline() {
                this.consume_newline()
                this.nl_before = true
            } else {
                this.pos += 1
            }
        }
        if depth > 0 {
            this.error("E_UNTERMINATED_COMMENT", "block comment is never closed (`/*` needs a matching `*/`; block comments nest)", at, start + 2)
        }
        this.add_trivia("block", start, this.pos, at)
        this.ws_before = true
    }

    fun add_trivia(&mut this, kind: &str, start: int, end: int, at: Span) {
        var span = at
        span.end = end
        let text = this.text(start, end)
        this.trivia.push(Trivia { kind: kind.to_str(), span, text })
    }

    // ---- tokens ----

    fun lex_token(&mut this) {
        let start = this.pos
        let c = this.at(start)
        let next = this.at(start + 1)

        if is_ident_start(c) {
            return this.ident_or_sigil(start)
        }
        if is_digit(c) {
            return this.number(start)
        }
        if c == DQUOTE {
            return this.string(start)
        }
        if c == SQUOTE {
            return this.char(start)
        }
        if c == HASH && next == LBRACE {
            return this.opener("#{", start, 2)
        }
        if c == HASH && next == LBRACKET {
            return this.opener("#[", start, 2)
        }
        if c == LPAREN {
            return this.opener("(", start, 1)
        }
        if c == LBRACKET {
            return this.opener("[", start, 1)
        }
        if c == LBRACE {
            return this.opener("{", start, 1)
        }
        if c == RPAREN {
            return this.close(")", start)
        }
        if c == RBRACKET {
            return this.close("]", start)
        }
        if c == RBRACE {
            return this.close("}", start)
        }
        if c == DOT && is_digit(next) {
            let prev = this.prev_kind()
            if !ends_expression(if prev.is_empty() { "EOF" } else { prev }) {
                return this.leading_dot_float(start)
            }
        }

        for p in punctuators(c).iter() {
            if this.starts_with(start, p) {
                if p == ".[" {
                    return this.opener(".[", start, 2)
                }
                this.pos = start + p.len()
                let at = this.span_at(start)
                this.push(p, start, this.pos, at, None)
                return
            }
        }
        this.unknown_character(start)
    }

    fun starts_with(&this, pos: int, text: &str) -> bool {
        var i = 0
        for i < text.len() {
            if this.at(pos + i) != text.byte_at(i) as int {
                return false
            }
            i += 1
        }
        true
    }

    fun unknown_character(&mut this, start: int) {
        let at = this.span_at(start)
        let c = this.at(start)
        let len = if c < 0x80 { 1 } else { utf8.sequence_length(c as u8) }
        let end = if start + len < this.src.len() { start + len } else { this.src.len() }
        let text = this.text(start, end)
        let hint = if c >= 0x80 { " (identifiers are ASCII; non-ASCII text belongs in strings and comments)" } else { "" }
        this.error("E_UNKNOWN_CHARACTER", "unexpected character `${text}`${hint}", at, end)
        this.pos = end
        this.ws_before = true
    }

    // ---- identifiers, keywords, sigils ----

    fun ident_or_sigil(&mut this, start: int) {
        var end = start + 1
        for end < this.src.len() && is_ident_char(this.at(end)) {
            end += 1
        }
        let at = this.span_at(start)
        let prev = this.prev_kind()

        if end == start + 1 && !no_glue(prev) {
            let letter = this.at(start)
            let glue = this.at(end)
            if glue == LBRACE && (letter == 0x72 || letter == 0x6d || letter == 0x73 || letter == UNDERSCORE) {
                let kind = "${(letter as char).to_str()}{"
                return this.opener(kind, start, 2)
            }
            if glue == LPAREN && letter == 0x74 {
                return this.opener("t(", start, 2)
            }
            if glue == LBRACKET && letter == 0x61 {
                return this.opener("a[", start, 2)
            }
            if glue == DQUOTE && letter == 0x72 {
                return this.raw_string(start)
            }
        }

        this.pos = end
        let member = prev == "." || prev == "?."
        let text = this.text(start, end)
        if !member {
            if end == start + 1 && this.at(start) == UNDERSCORE {
                this.push("_", start, end, at, None)
                return
            }
            if is_keyword(text) {
                this.push(text, start, end, at, None)
                return
            }
        }
        this.push("Ident", start, end, at, Some(Text(text)))
    }

    // ---- delimiters ----

    fun opener(&mut this, kind: &str, start: int, len: int) {
        let at = this.span_at(start)
        this.pos = start + len
        let idx = this.push(kind, start, this.pos, at, None)
        this.stack.push(Delim { opener: idx, closer: closer_of(kind) })
    }

    fun close(&mut this, ch: &str, start: int) {
        let at = this.span_at(start)

        // the opener this closer belongs to; an interpolation is a barrier for `)` and `]`
        var found = -1
        var i = this.stack.len() - 1
        for i >= 0 {
            let hit = match &this.stack[i] {
                Delim { closer, .. } => closer == ch
                Interp(_) => ch == "}"
            }
            if hit {
                found = i
                break
            }
            if let Interp(_) = &this.stack[i] {
                break
            }
            i -= 1
        }

        if found >= 0 {
            // close everything opened after it
            for this.stack.len() - 1 > found {
                let e = this.stack.pop().unwrap()
                if let Delim { opener, .. } = e {
                    this.unclosed(opener)
                }
            }
            let e = this.stack.pop().unwrap()
            match e {
                Interp(st) => this.string_chunk(st, start, at, false, 1)
                Delim { opener, .. } => {
                    this.pos = start + 1
                    let idx = this.push(ch, start, this.pos, at, None)
                    this.tokens[opener].closer = Some(idx)
                }
            }
            return
        }

        // A stray closer. If a delimiter is open, treat this as its closer (with the expected kind),
        // so the parser sees balanced brackets. Otherwise drop it.
        this.pos = start + 1
        let top = this.stack.last()
        if let Some(Delim { opener, closer }) = top {
            let open = this.tokens[opener].clone()
            this.error("E_UNMATCHED_DELIMITER", "expected `${closer}` to close `${open.kind}` at ${open.span.line}:${open.span.col}, found `${ch}`", at, this.pos)
            let _ = this.stack.pop()
            let idx = this.push(closer, start, this.pos, at, None)
            this.tokens[opener].closer = Some(idx)
        } else {
            this.error("E_UNMATCHED_DELIMITER", "unexpected `${ch}` with nothing open to close", at, this.pos)
            this.ws_before = true
        }
    }

    fun unclosed(&mut this, opener: int) {
        let open = this.tokens[opener].clone()
        let expected = closer_of(open.kind)
        this.error("E_UNMATCHED_DELIMITER", "`${open.kind}` is never closed (expected `${expected}`)", open.span, open.span.end)
    }

    fun unwind_at_eof(&mut this) {
        for let Some(e) = this.stack.pop() {
            match e {
                Delim { opener, .. } => this.unclosed(opener)
                Interp(st) => {
                    let span = this.strings[st].span
                    this.error("E_UNTERMINATED_STRING", "string is never closed", span, span.end)
                    this.synthetic_tail(st)
                }
            }
        }
    }

    /// Single-line strings stay on one line, interpolations included: a newline inside `"…${…` ends
    /// the string with an error and a zero-width TemplateTail.
    fun end_single_line_interpolation(&mut this) {
        var i = this.stack.len() - 1
        for i >= 0 {
            if let Interp(_) = &this.stack[i] {
                break
            }
            i -= 1
        }
        if i < 0 {
            return
        }
        let Interp(st) = &this.stack[i] else { return }
        if this.strings[st].multiline {
            return
        }
        this.stack.truncate(i)
        let span = this.strings[st].span
        this.error("E_UNTERMINATED_STRING", "string is never closed (a `\"…\"` string, interpolations included, must end on the line it starts; use `\"\"\"…\"\"\"` for multi-line text)", span, span.end)
        this.synthetic_tail(st)
    }

    fun synthetic_tail(&mut this, st: int) {
        let at = this.span_at(this.pos)
        let idx = this.push("TemplateTail", this.pos, this.pos, at, Some(Text("")))
        if this.strings[st].multiline {
            this.tokens[idx].multiline = true
        }
        this.strings[st].chunks.push(Chunk { tok: idx, segs: [] })
        this.finish_string(st, false)
    }

    // ---- numbers ----

    fun number(&mut this, start: int) {
        let at = this.span_at(start)
        let prev = this.prev_kind()
        var pos = start
        var invalid: string? = None
        var is_float = false

        // tuple indexing: after a member `.`, only digits (`t.0.1` is t . 0 . 1)
        if prev == "." || prev == "?." {
            for pos < this.src.len() && is_digit(this.at(pos)) {
                pos += 1
            }
            this.pos = pos
            let text = this.text(start, pos)
            this.push("Int", start, pos, at, Some(Int(decimal(text))))
            return
        }

        var radix_prefix = ""
        let p1 = this.at(start + 1)
        if this.at(start) == ZERO && (p1 == 0x78 || p1 == 0x6f || p1 == 0x62) {
            radix_prefix = "0${(p1 as char).to_str()}"
            pos = start + 2
            let radix = if p1 == 0x78 { 16 } else if p1 == 0x6f { 8 } else { 2 }
            let name = if p1 == 0x78 { "hex literal" } else if p1 == 0x6f { "octal literal" } else { "binary literal" }
            let end = this.scan_digits(pos, radix)
            if invalid.is_none() {
                invalid = check_run(this.text(pos, end), name)
            }
            pos = end
        } else {
            let end = this.scan_digits(pos, 10)
            if invalid.is_none() {
                invalid = check_run(this.text(pos, end), "number")
            }
            pos = end
            // fraction: `.` belongs to the number only when a digit follows
            if this.at(pos) == DOT && is_digit(this.at(pos + 1)) {
                is_float = true
                pos += 1
                let fend = this.scan_digits(pos, 10)
                if invalid.is_none() {
                    invalid = check_run(this.text(pos, fend), "fraction")
                }
                pos = fend
            }
            // exponent: e9, e-3, E+23
            let e = this.at(pos)
            if e == 0x65 || e == 0x45 {
                let sign = this.at(pos + 1)
                let digit_at = if sign == PLUS || sign == MINUS { pos + 2 } else { pos + 1 }
                if is_digit(this.at(digit_at)) {
                    is_float = true
                    pos = digit_at
                    let xend = this.scan_digits(pos, 10)
                    if invalid.is_none() {
                        invalid = check_run(this.text(pos, xend), "exponent")
                    }
                    pos = xend
                }
            }
        }

        // anything identifier-like glued to the number makes it invalid: `0b102`, `12px`, `1e`
        if pos < this.src.len() && is_ident_char(this.at(pos)) {
            let from = pos
            for pos < this.src.len() && is_ident_char(this.at(pos)) {
                pos += 1
            }
            let tail = this.text(from, pos)
            if invalid.is_none() {
                invalid = Some(if !radix_prefix.is_empty() {
                    "invalid digit or suffix `${tail}` in a ${radix_prefix} literal"
                } else {
                    "invalid suffix `${tail}` (numbers have no suffixes; use `x as T`)"
                })
            }
        }

        this.pos = pos
        let text = this.text(start, pos).replace("_", "")
        if let Some(why) = invalid {
            this.error("E_INVALID_NUMBER", "invalid number literal: ${why}", at, pos)
            if is_float {
                this.push("Float", start, pos, at, Some(Float(0.0)))
            } else {
                this.push("Int", start, pos, at, Some(Int("0")))
            }
            return
        }
        if is_float {
            this.push("Float", start, pos, at, Some(Float(text.to_float().unwrap())))
        } else {
            this.push("Int", start, pos, at, Some(Int(decimal(text))))
        }
    }

    /// The end of a run of digits of `radix` (and `_`) starting at `pos`.
    fun scan_digits(&this, pos: int, radix: int) -> int {
        var p = pos
        for p < this.src.len() {
            let c = this.at(p)
            let ok = if radix == 16 { is_hex(c) } else if radix == 8 { is_oct(c) } else if radix == 2 { is_bin(c) } else { is_digit(c) }
            if !ok && c != UNDERSCORE {
                break
            }
            p += 1
        }
        p
    }

    /// `.5`: not valid MinScript, lexed as a Float for recovery.
    fun leading_dot_float(&mut this, start: int) {
        let at = this.span_at(start)
        var pos = start + 1
        for pos < this.src.len() && (is_digit(this.at(pos)) || this.at(pos) == UNDERSCORE) {
            pos += 1
        }
        this.pos = pos
        let text = "0${this.text(start, pos).replace("_", "")}"
        this.error("E_INVALID_NUMBER", "a float needs a digit before the `.`: write `${text}`", at, pos)
        this.push("Float", start, pos, at, Some(Float(text.to_float().unwrap())))
    }

    // ---- escapes ----

    /// Reads an escape at `pos` (on the backslash): the cooked text, or the raw char on error.
    fun escape(&mut this) -> string {
        let start = this.pos
        let e = this.at(start + 1)
        let simple = match e {
            0x6e => "\n"
            0x72 => "\r"
            0x74 => "\t"
            0x30 => "\0"
            0x5c => "\\"
            0x22 => "\""
            0x27 => "'"
            0x24 => "$"
            _ => ""
        }
        if !simple.is_empty() {
            this.pos = start + 2
            return simple
        }
        if e == 0x78 {
            let h1 = this.at(start + 2)
            let h2 = this.at(start + 3)
            if is_hex(h1) && is_hex(h2) {
                let v = hex_value(h1) * 16 + hex_value(h2)
                this.pos = start + 4
                if v > 0x7f {
                    let at = this.span_at(start)
                    this.error("E_INVALID_ESCAPE", "`\\x` escapes are ASCII only (00–7F); use `\\u{${hex_upper(v)}}`", at, this.pos)
                    return "\u{FFFD}"
                }
                return (v as char).to_str()
            }
            this.pos = start + 2
            let at = this.span_at(start)
            this.error("E_INVALID_ESCAPE", "`\\x` needs exactly two hex digits", at, this.pos)
            return "\u{FFFD}"
        }
        if e == 0x75 {
            if this.at(start + 2) == LBRACE {
                var p = start + 3
                for p < this.src.len() && is_hex(this.at(p)) && p - (start + 3) < 7 {
                    p += 1
                }
                let digits = this.text(start + 3, p)
                if this.at(p) == RBRACE && digits.len() >= 1 && digits.len() <= 6 {
                    var v = 0
                    var k = 0
                    for k < digits.len() {
                        v = v * 16 + hex_value(digits.byte_at(k) as int)
                        k += 1
                    }
                    this.pos = p + 1
                    if v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff) {
                        let at = this.span_at(start)
                        this.error("E_INVALID_ESCAPE", "`\\u{${digits}}` is not a Unicode scalar value", at, this.pos)
                        return "\u{FFFD}"
                    }
                    return (v as char).to_str()
                }
            }
            this.pos = start + 2
            let at = this.span_at(start)
            this.error("E_INVALID_ESCAPE", "`\\u` must be written `\\u{…}` with 1–6 hex digits", at, this.pos)
            return "\u{FFFD}"
        }
        // unknown escape: keep the character literally
        if e < 0 || e == LF || e == CR {
            this.pos = start + 1
            let at = this.span_at(start)
            this.error("E_INVALID_ESCAPE", "`\\` at the end of a line", at, this.pos)
            return ""
        }
        let len = if e < 0x80 { 1 } else { utf8.sequence_length(e as u8) }
        this.pos = if start + 1 + len < this.src.len() { start + 1 + len } else { this.src.len() }
        let ch = this.text(start + 1, this.pos)
        let at = this.span_at(start)
        this.error("E_INVALID_ESCAPE", "unknown escape `\\${ch}` (valid: \\n \\r \\t \\0 \\\\ \\\" \\' \\$ \\xNN \\u{…})", at, this.pos)
        ch
    }

    // ---- strings ----

    fun string(&mut this, start: int) {
        let multiline = this.at(start + 1) == DQUOTE && this.at(start + 2) == DQUOTE
        let at = this.span_at(start)
        let quote_len = if multiline { 3 } else { 1 }
        var span = at
        span.end = start + quote_len
        this.strings.push(StringState { span, multiline })
        this.string_chunk(this.strings.len() - 1, start, at, true, quote_len)
    }

    /// Lexes one chunk of a string: from its opening (the quote(s), or the `}` that ends an
    /// interpolation) up to `${`, the closing quote(s), or an error.
    fun string_chunk(&mut this, st: int, start: int, at: Span, first: bool, open_len: int) {
        this.pos = start + open_len
        let multiline = this.strings[st].multiline
        var segs = [Segment { strip: false, emit_nl: false }]
        let done = if first { "String" } else { "TemplateTail" }

        for {
            let s = segs.len() - 1
            if this.pos >= this.src.len() {
                let span = this.strings[st].span
                this.error("E_UNTERMINATED_STRING", "string is never closed", span, span.end)
                this.emit_chunk(st, done, start, at, segs)
                this.finish_string(st, false)
                return
            }
            let c = this.at(this.pos)

            if c == DQUOTE {
                if !multiline {
                    this.pos += 1
                    this.emit_chunk(st, done, start, at, segs)
                    this.finish_string(st, true)
                    return
                }
                if this.at(this.pos + 1) == DQUOTE && this.at(this.pos + 2) == DQUOTE {
                    this.pos += 3
                    this.emit_chunk(st, done, start, at, segs)
                    this.finish_string(st, true)
                    return
                }
                this.pos += 1
                segs[s].ws_mode = false
                segs[s].text += "\""
                continue
            }

            if c == DOLLAR && this.at(this.pos + 1) == LBRACE {
                this.pos += 2
                this.emit_chunk(st, if first { "TemplateHead" } else { "TemplateMiddle" }, start, at, segs)
                this.stack.push(Interp(st))
                return
            }

            if c == BACKSLASH {
                segs[s].ws_mode = false
                let cooked = this.escape()
                segs[s].text += cooked
                continue
            }

            if this.at_newline() {
                if !multiline {
                    let span = this.strings[st].span
                    this.error("E_UNTERMINATED_STRING", "string is never closed (a `\"…\"` string must end on the line it starts; use `\"\"\"…\"\"\"` for multi-line text)", span, this.pos)
                    this.emit_chunk(st, done, start, at, segs)
                    this.finish_string(st, false)
                    return
                }
                this.consume_newline()
                segs.push(Segment { strip: true, emit_nl: true })
                continue
            }

            if segs[s].ws_mode && (c == SPACE || c == TAB) {
                segs[s].ws += if c == SPACE { " " } else { "\t" }
                this.pos += 1
                continue
            }

            // a run of literal bytes
            segs[s].ws_mode = false
            let from = this.pos
            for this.pos < this.src.len() {
                let d = this.at(this.pos)
                if d == DQUOTE || d == BACKSLASH || d == LF || d == CR {
                    break
                }
                if d == DOLLAR && this.at(this.pos + 1) == LBRACE {
                    break
                }
                this.pos += 1
            }
            if this.pos == from {
                // a lone CR (not part of CRLF)
                this.pos += 1
                segs[s].text += "\r"
            } else {
                let run = this.text(from, this.pos)
                segs[s].text += run
            }
        }
    }

    fun emit_chunk(&mut this, st: int, kind: &str, start: int, at: Span, segs: Vec[Segment]) {
        let idx = this.push(kind, start, this.pos, at, None)
        if this.strings[st].multiline {
            this.tokens[idx].multiline = true
        }
        this.strings[st].chunks.push(Chunk { tok: idx, segs })
    }

    /// Computes the cooked value of every chunk once the string has ended (dedent for `"""`).
    fun finish_string(&mut this, st: int, closed: bool) {
        if this.strings[st].multiline {
            dedent(this.strings[st], closed)
        }
        for ch in this.strings[st].chunks.iter() {
            var out = ""
            for seg in ch.segs.iter() {
                if seg.emit_nl {
                    out += "\n"
                }
                out += seg.ws
                out += seg.text
            }
            this.tokens[ch.tok].value = Some(Text(out))
        }
    }

    fun raw_string(&mut this, start: int) {
        let at = this.span_at(start)
        this.pos = start + 2
        let from = this.pos
        for this.pos < this.src.len() && this.at(this.pos) != DQUOTE {
            if this.at_newline() {
                this.consume_newline()
            } else {
                this.pos += 1
            }
        }
        let body = this.text(from, this.pos).replace("\r\n", "\n")
        if this.pos >= this.src.len() {
            this.error("E_UNTERMINATED_STRING", "raw string is never closed (raw strings can't contain `\"`)", at, start + 2)
        } else {
            this.pos += 1
        }
        this.push("RawString", start, this.pos, at, Some(Text(body)))
    }

    // ---- characters ----

    fun char(&mut this, start: int) {
        let at = this.span_at(start)

        // removed tagged records: '1{ … }
        if is_digit(this.at(start + 1)) {
            var j = start + 1
            for is_digit(this.at(j)) {
                j += 1
            }
            if this.at(j) == LBRACE {
                this.error("E_TAGGED_RECORD_REMOVED", "tagged records were removed: write `r{ … }`", at, j + 1)
                this.pos = j + 1
                let idx = this.push("r{", start, this.pos, at, None)
                this.stack.push(Delim { opener: idx, closer: "}" })
                return
            }
        }

        this.pos = start + 1
        let c = this.at(this.pos)
        if c == SQUOTE {
            this.pos += 1
            this.error("E_INVALID_CHAR", "empty character literal", at, this.pos)
            this.push("Char", start, this.pos, at, Some(Text("")))
            return
        }
        if c < 0 || this.at_newline() {
            this.error("E_INVALID_CHAR", "character literal is never closed", at, this.pos)
            this.push("Char", start, this.pos, at, Some(Text("")))
            return
        }

        var value = ""
        if c == BACKSLASH {
            value = this.escape()
        } else {
            let len = if c < 0x80 { 1 } else { utf8.sequence_length(c as u8) }
            let end = if this.pos + len < this.src.len() { this.pos + len } else { this.src.len() }
            value = this.text(this.pos, end)
            this.pos = end
        }

        if this.at(this.pos) == SQUOTE {
            this.pos += 1
            this.push("Char", start, this.pos, at, Some(Text(value)))
            return
        }

        // 'ab': look a short way ahead for the closing quote, without crossing whitespace
        var k = this.pos
        for k < this.src.len() && k - this.pos < 32 {
            let d = this.at(k)
            if d == SQUOTE || d == SPACE || d == TAB || d == LF || d == CR {
                break
            }
            k += 1
        }
        if this.at(k) == SQUOTE {
            this.pos = k + 1
            this.error("E_INVALID_CHAR", "a character literal holds exactly one character; use a string (`\"…\"`) for text", at, this.pos)
        } else {
            this.error("E_INVALID_CHAR", "character literal is never closed", at, this.pos)
        }
        this.push("Char", start, this.pos, at, Some(Text(value)))
    }
}

/// A number problem: an empty run, or `_` not between digits.
fun check_run(run: string, what: &str) -> string? {
    if run.is_empty() {
        return Some("${what} has no digits")
    }
    if run.starts_with("_") || run.ends_with("_") {
        return Some("`_` must sit between digits")
    }
    None
}

/// `"""` rules (spec §1.5):
/// - a first line that is empty (only whitespace after the opening quotes) is dropped;
/// - if the closing quotes sit on a line of their own, that line's whitespace is the indentation
///   stripped from every line, and the line itself is dropped.
/// Lines indented less than the closing line lose only the whitespace they share with it.
fun dedent(st: &mut StringState, closed: bool) {
    if st.chunks.is_empty() {
        return
    }
    if st.chunks[0].segs.len() > 1 && st.chunks[0].segs[0].text.is_empty() {
        let _ = st.chunks[0].segs.remove(0)
        st.chunks[0].segs[0].emit_nl = false
    }

    var indent = ""
    let last_chunk = st.chunks.len() - 1
    let n = st.chunks[last_chunk].segs.len()
    if closed && n > 0 && st.chunks[last_chunk].segs[n - 1].strip && st.chunks[last_chunk].segs[n - 1].text.is_empty() {
        indent = st.chunks[last_chunk].segs[n - 1].ws.clone()
        let _ = st.chunks[last_chunk].segs.pop()
    }

    for ch in st.chunks.iter_mut() {
        for seg in ch.segs.iter_mut() {
            if !seg.strip {
                continue
            }
            if seg.ws.starts_with(indent) {
                seg.ws = seg.ws.substring(indent.len(), seg.ws.len()).to_str()
            } else if seg.text.is_empty() {
                seg.ws = ""
            } else {
                var i = 0
                for i < seg.ws.len() && i < indent.len() && seg.ws.byte_at(i) == indent.byte_at(i) {
                    i += 1
                }
                seg.ws = seg.ws.substring(i, seg.ws.len()).to_str()
            }
        }
    }
}

/// The decimal digits of an integer literal (`0x1F`, `1_000`; `_` already removed), of any size.
fun decimal(text: string) -> string {
    var radix = 10
    var digits = text.clone()
    if text.starts_with("0x") || text.starts_with("0o") || text.starts_with("0b") {
        radix = if text.starts_with("0x") { 16 } else if text.starts_with("0o") { 8 } else { 2 }
        digits = text.substring(2, text.len()).to_str()
    }
    // little-endian base-10000 limbs
    var limbs = [0]
    var i = 0
    for i < digits.len() {
        var carry = hex_value(digits.byte_at(i) as int)
        var k = 0
        for k < limbs.len() {
            let v = limbs[k] * radix + carry
            limbs[k] = v % 10000
            carry = v / 10000
            k += 1
        }
        for carry > 0 {
            limbs.push(carry % 10000)
            carry = carry / 10000
        }
        i += 1
    }
    var out = "${limbs[limbs.len() - 1]}"
    var j = limbs.len() - 2
    for j >= 0 {
        let part = "${limbs[j]}"
        out += "0000".substring(0, 4 - part.len())
        out += part
        j -= 1
    }
    out
}

fun hex_upper(n: int) -> string {
    let digits = "0123456789ABCDEF"
    if n == 0 {
        return "0"
    }
    var out = ""
    var v = n
    for v > 0 {
        out = "${digits.substring(v % 16, v % 16 + 1)}${out}"
        v = v / 16
    }
    out
}
