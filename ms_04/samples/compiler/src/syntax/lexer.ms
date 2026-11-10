package syntax

// The MinScript lexer (spec §1), ported from the TypeScript compiler's src/lexer.ts. It scans UTF-8
// bytes and produces tokens with byte spans, `ws` / `nl` flags and, for every opener, the index of
// its matching closer.
//
// Delimiters are balanced here (§1.1): a closer that doesn't match the innermost opener is reported
// once, and the lexer inserts zero-width synthetic closers so the parser always sees a balanced
// stream. String interpolation uses a mode stack: `"a${x}b"` lexes as TemplateHead x TemplateTail.

/// A comment, kept beside the tokens (the formatter and the LSP need them).
pub type Trivia {
    /// "line", "doc" or "block"
    pub kind: str
    pub start: int
    pub end: int
}

pub type Lexed {
    pub tokens: Vec[Token]
    pub trivia: Vec[Trivia]
    pub diagnostics: Vec[Diag]
}

/// One entry of the delimiter stack: an ordinary opener, or the interpolation of a template
/// (`template` is its index in `Lexer.templates`, -1 for none).
type Open {
    index: int
    close: str
    template: int = -1
}

/// A part of a template: its token, and the span of its raw content.
type Part {
    index: int
    raw_start: int
    raw_end: int
}

/// A string with interpolations, while it is being lexed. Several stack entries refer to one
/// template, so templates live in a Vec and are referred to by index (v0.4 has no shared mutable
/// objects without `shared`).
type Template {
    multiline: bool
    /// a newline inside an interpolation of this single-line string was already reported
    reported: bool = false
    parts: Vec[Part] = []
}

/// `.` `?.` `fn` `type` `union` `inter`: a letter after them is never a sigil (§1.7).
let NO_GLUE_BEFORE = s{ ".", "?.", "fn", "type", "union", "inter" } as Set[str]

fn is_digit(c: int) -> bool { c >= 0x30 && c <= 0x39 }
fn is_hex(c: int) -> bool { is_digit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46) }
fn is_ident_start(c: int) -> bool { (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c == 0x5f }
fn is_ident_char(c: int) -> bool { is_ident_start(c) || is_digit(c) }

/// Lexes a whole source text.
pub fn lex(src: str) -> Lexed {
    var lx = Lexer { src }
    lx.run()
    Lexed { tokens: lx.tokens, trivia: lx.trivia, diagnostics: lx.diagnostics }
}

type Lexer {
    src: str
    pos: int = 0
    tokens: Vec[Token] = []
    trivia: Vec[Trivia] = []
    diagnostics: Vec[Diag] = []
    stack: Vec[Open] = []
    templates: Vec[Template] = []
    ws: bool = false
    nl: bool = false

    fn run(*this) {
        if this.at(0) == 0xef && this.at(1) == 0xbb && this.at(2) == 0xbf { this.pos = 3 }
        for {
            this.skip_trivia()
            if this.pos >= this.src.len() { break }
            this.token()
        }
        this.close_all_at_eof()
        n := this.src.len()
        this.push("EOF", n, n, NoValue)
    }

    // ---- helpers ------------------------------------------------------------------------------

    /// The byte at `pos + offset`, or -1 past the end.
    fn at(this, offset: int) -> int { this.byte(this.pos + offset) }

    fn byte(this, i: int) -> int {
        if i >= 0 && i < this.src.len() { this.src.byte_at(i) as int } else { -1 }
    }

    fn text(this, start: int, end: int) -> str { this.src.substring(start, end) }

    fn error(*this, code: str, message: str, start: int, end: int) {
        this.diagnostics.push(Diag { code, message, start, end })
    }

    fn error_fix(*this, code: str, message: str, start: int, end: int, fix: str) {
        this.diagnostics.push(Diag { code, message, start, end, fix: Some(fix) })
    }

    fn push(*this, kind: str, start: int, end: int, value: Value) -> int {
        this.tokens.push(Token { kind, start, end, ws: this.ws, nl: this.nl, value })
        this.ws = false
        this.nl = false
        this.tokens.len() - 1
    }

    /// A zero-width closer inserted for balance; it leaves the next real token's flags alone.
    fn push_synthetic(*this, kind: str, at: int) -> int {
        this.tokens.push(Token { kind, start: at, end: at, synthetic: true })
        this.tokens.len() - 1
    }

    fn prev_kind(this) -> str {
        if this.tokens.is_empty() { "" } else { this.tokens[this.tokens.len() - 1].kind }
    }

    /// The length of the UTF-8 sequence starting at `p` (1 for invalid bytes).
    fn char_len(this, p: int) -> int {
        c := this.byte(p)
        if c < 0x80 { 1 } else if c >= 0xf0 { 4 } else if c >= 0xe0 { 3 } else if c >= 0xc0 { 2 } else { 1 }
    }

    fn matches(this, p: str) -> bool {
        for i in 0..p.len() {
            if this.at(i) != p.byte_at(i) as int { return false }
        }
        true
    }

    // ---- trivia -------------------------------------------------------------------------------

    fn skip_trivia(*this) {
        for this.pos < this.src.len() {
            c := this.at(0)
            if c == 0x20 || c == 0x09 || c == 0x0d {
                this.pos += 1
                this.ws = true
            } else if c == 0x0a {
                this.pos += 1
                this.ws = true
                this.nl = true
                this.newline_in_interpolation(this.pos - 1)
            } else if c == 0x2f && this.at(1) == 0x2f {
                start := this.pos
                for this.pos < this.src.len() && this.at(0) != 0x0a { this.pos += 1 }
                doc := this.byte(start + 2) == 0x2f && this.byte(start + 3) != 0x2f
                this.trivia.push(Trivia { kind: if doc { "doc" } else { "line" }, start, end: this.pos })
                this.ws = true
            } else if c == 0x2f && this.at(1) == 0x2a {
                this.block_comment()
                this.ws = true
            } else {
                return
            }
        }
    }

    fn block_comment(*this) {
        start := this.pos
        this.pos += 2
        var depth = 1
        for this.pos < this.src.len() && depth > 0 {
            c := this.at(0)
            if c == 0x2f && this.at(1) == 0x2a {
                depth += 1
                this.pos += 2
            } else if c == 0x2a && this.at(1) == 0x2f {
                depth -= 1
                this.pos += 2
            } else {
                if c == 0x0a { this.nl = true }
                this.pos += 1
            }
        }
        if depth > 0 { this.error("E_UNTERMINATED_COMMENT", "`/*` is not closed", start, start + 2) }
        this.trivia.push(Trivia { kind: "block", start, end: this.pos })
    }

    // ---- tokens -------------------------------------------------------------------------------

    fn token(*this) {
        start := this.pos
        c := this.at(0)
        if is_ident_start(c) { return this.ident_or_sigil(start) }
        if is_digit(c) {
            prev := this.prev_kind()
            return this.number(start, prev == "." || prev == "?.")
        }
        if c == 0x22 { return this.string(start, start) }
        if c == 0x27 { return this.char_lit(start, false) }
        if c == 0x23 {
            n := this.at(1)
            if n == 0x7b { return this.opener("#{", start, 2) }
            if n == 0x5b { return this.opener("#[", start, 2) }
            this.pos += 1
            this.error("E_UNKNOWN_CHARACTER", "`#` starts no token (closures are `#{ … }`)", start, this.pos)
            return
        }
        if c == 0x2e {
            // `.[` explicit generics; `.5` invalid float after a non-value (§1.5 rule 3)
            if this.at(1) == 0x5b { return this.opener(".[", start, 2) }
            if is_digit(this.at(1)) && !ends_expression(this.prev_kind()) {
                this.pos += 1
                for is_digit(this.at(0)) || this.at(0) == 0x5f { this.pos += 1 }
                raw := this.text(start, this.pos)
                this.error_fix("E_INVALID_NUMBER", "a float needs a digit before `.`", start, this.pos, "0${raw}")
                this.push("Float", start, this.pos, Float(("0" + raw.replace("_", "")).to_float() ?? 0.0))
                return
            }
        }
        if c == 0x29 || c == 0x5d || c == 0x7d { return this.closer(this.text(start, start + 1), start) }
        for p in PUNCTUATORS {
            if this.matches(p) {
                if OPENERS.has(p) { return this.opener(p, start, p.len()) }
                this.pos += p.len()
                this.push(p, start, this.pos, NoValue)
                return
            }
        }
        this.pos += this.char_len(start)
        what := if c >= 0x80 { "a non-ASCII character" } else { "`${this.text(start, this.pos)}`" }
        this.error("E_UNKNOWN_CHARACTER", "${what} can't appear outside strings and comments", start, this.pos)
    }

    fn ident_or_sigil(*this, start: int) {
        var end = start + 1
        for is_ident_char(this.byte(end)) { end += 1 }
        if end == start + 1 && !NO_GLUE_BEFORE.has(this.prev_kind()) {
            sigil := this.text(start, start + 1) + this.text(end, end + 1)
            if sigil == "r{" || sigil == "m{" || sigil == "s{" || sigil == "_{" || sigil == "t(" || sigil == "a[" {
                return this.opener(sigil, start, 2)
            }
            if sigil == "r\"" { return this.raw_string(start) }
            if sigil == "b'" { return this.char_lit(start, true) }
        }
        this.pos = end
        name := this.text(start, end)
        prev := this.prev_kind()
        if name == "_" {
            this.push("_", start, end, NoValue)
        } else if KEYWORDS.has(name) && prev != "." && prev != "?." {
            this.push(name, start, end, NoValue)
        } else {
            this.push("Ident", start, end, Name(name))
        }
    }

    // ---- numbers (§1.5) -----------------------------------------------------------------------

    fn number(*this, start: int, after_member: bool) {
        if after_member {
            // `t.0.1`: only a digit run
            for is_digit(this.at(0)) { this.pos += 1 }
            this.push("Int", start, this.pos, Int(strip_zeros(this.text(start, this.pos))))
            return
        }
        var bad: str? = None
        var is_float = false
        var radix = 10
        r := if this.at(0) == 0x30 { this.at(1) } else { -1 }
        if r == 0x78 || r == 0x62 || r == 0x6f {
            radix = if r == 0x78 { 16 } else if r == 0x62 { 2 } else { 8 }
            this.pos += 2
            digits_start := this.pos
            for is_ident_char(this.at(0)) {
                ch := this.at(0)
                if ch != 0x5f && !digit_ok(ch, radix) { bad = bad ?? Some("invalid digit for its radix") }
                this.pos += 1
            }
            if this.pos == digits_start { bad = bad ?? Some("a radix prefix needs digits") }
        } else {
            this.digits()
            if this.at(0) == 0x2e && is_digit(this.at(1)) {
                is_float = true
                this.pos += 1
                this.digits()
            }
            if this.at(0) == 0x65 || this.at(0) == 0x45 {
                is_float = true
                this.pos += 1
                if this.at(0) == 0x2b || this.at(0) == 0x2d { this.pos += 1 }
                if !is_digit(this.at(0)) { bad = bad ?? Some("an exponent needs digits") }
                this.digits()
            }
            if is_ident_char(this.at(0)) {
                bad = bad ?? Some("letters can't follow a number")
                for is_ident_char(this.at(0)) { this.pos += 1 }
            }
        }
        raw := this.text(start, this.pos)
        if bad.is_none() && !underscores_ok(raw) { bad = Some("`_` may only sit between digits") }
        if let Some(why) = bad {
            this.error("E_INVALID_NUMBER", "invalid number `${raw}`: ${why}", start, this.pos)
            this.push(if is_float { "Float" } else { "Int" }, start, this.pos, if is_float { Float(0.0) } else { Int("0") })
            return
        }
        clean := raw.replace("_", "")
        if is_float {
            this.push("Float", start, this.pos, Float(clean.to_float() ?? 0.0))
        } else if radix == 10 {
            this.push("Int", start, this.pos, Int(strip_zeros(clean)))
        } else {
            this.push("Int", start, this.pos, Int(to_decimal(clean.substring(2, clean.len()), radix)))
        }
    }

    fn digits(*this) {
        for is_digit(this.at(0)) || this.at(0) == 0x5f { this.pos += 1 }
    }

    // ---- delimiters (§1.1) --------------------------------------------------------------------

    fn opener(*this, kind: str, start: int, len: int) {
        this.pos = start + len
        index := this.push(kind, start, this.pos, NoValue)
        this.stack.push(Open { index, close: OPENERS[kind] })
    }

    fn closer(*this, ch: str, start: int) {
        n := this.stack.len()
        if n > 0 && this.stack[n - 1].close == ch { return this.close_top(start, start + 1, false) }
        var found = -1
        var i = n - 1
        for i >= 0 {
            if this.stack[i].close == ch {
                found = i
                break
            }
            i -= 1
        }
        if found >= 0 {
            // the inner openers are unclosed: report each, close them with synthetic closers
            for this.stack.len() - 1 > found {
                open := this.tokens[this.stack[this.stack.len() - 1].index]
                this.error("E_UNMATCHED_DELIMITER", "`${open.kind}` is not closed before `${ch}`", open.start, open.end)
                this.close_top(start, start, true)
            }
            return this.close_top(start, start + 1, false)
        }
        if n > 0 {
            top := this.stack[n - 1]
            open := this.tokens[top.index]
            this.error("E_UNMATCHED_DELIMITER", "expected `${top.close}` to close `${open.kind}`, found `${ch}`", start, start + 1)
            return this.close_top(start, start + 1, false)
        }
        this.pos = start + 1
        this.error("E_UNMATCHED_DELIMITER", "unexpected `${ch}`: nothing is open", start, start + 1)
    }

    /// Closes the innermost opener with a closer spanning [start, end).
    fn close_top(*this, start: int, end: int, synthetic: bool) {
        let Some(top) = this.stack.pop() else { return }
        this.pos = if synthetic { start } else { end }
        if top.template >= 0 {
            if synthetic { return this.end_template(top.template, start, start, start) }
            return this.scan_part(top.template, start, end, false)
        }
        index := if synthetic { this.push_synthetic(top.close, start) } else { this.push(top.close, start, end, NoValue) }
        this.tokens[top.index].closer = index
    }

    fn close_all_at_eof(*this) {
        end := this.src.len()
        for !this.stack.is_empty() {
            top := this.stack[this.stack.len() - 1]
            open := this.tokens[top.index]
            if top.template >= 0 {
                this.error("E_UNTERMINATED_STRING", "this string is not closed", open.start, open.start + 1)
            } else {
                this.error("E_UNMATCHED_DELIMITER", "`${open.kind}` is not closed", open.start, open.end)
            }
            this.close_top(end, end, true)
        }
    }

    /// A newline inside an interpolation of a single-line string is an error (§1.5). It is
    /// reported once per string, and lexing carries on as if the string were multi-line, so the
    /// rest of the interpolation and the string's tail still pair up.
    fn newline_in_interpolation(*this, at: int) {
        for i in 0..this.stack.len() {
            t := this.stack[i].template
            if t < 0 || this.templates[t].multiline || this.templates[t].reported { continue }
            this.templates[t].reported = true
            head := this.tokens[this.stack[i].index]
            this.error("E_UNTERMINATED_STRING", "a `\"…\"` string ends on its line, interpolations included (use `\"\"\"`)", head.start, at)
        }
    }

    // ---- strings (§1.5) -----------------------------------------------------------------------

    /// Lexes a string starting at its opening quote.
    fn string(*this, start: int, token_start: int) {
        multiline := this.at(1) == 0x22 && this.at(2) == 0x22
        this.pos = start + if multiline { 3 } else { 1 }
        this.templates.push(Template { multiline })
        this.scan_part(this.templates.len() - 1, token_start, this.pos, true)
    }

    /// Scans string content from `pos` up to the closing quote or the next `${`. `token_start` is
    /// where the token began (the quote, or the `}` of an interpolation).
    fn scan_part(*this, t: int, token_start: int, raw_start: int, first: bool) {
        multiline := this.templates[t].multiline
        for {
            c := this.at(0)
            if c == -1 || (!multiline && c == 0x0a) {
                msg := if multiline { "`\"\"\"` is not closed" } else { "a `\"…\"` string must end on its line (use `\"\"\"`)" }
                this.error("E_UNTERMINATED_STRING", msg, token_start, this.pos)
                return this.finish_part(t, token_start, raw_start, this.pos, this.pos, first, true)
            }
            if c == 0x22 && (!multiline || (this.at(1) == 0x22 && this.at(2) == 0x22)) {
                raw_end := this.pos
                this.pos += if multiline { 3 } else { 1 }
                return this.finish_part(t, token_start, raw_start, raw_end, this.pos, first, true)
            }
            if c == 0x5c {
                this.escape(false)
                continue
            }
            if c == 0x24 && this.at(1) == 0x7b {
                raw_end := this.pos
                this.pos += 2
                return this.finish_part(t, token_start, raw_start, raw_end, this.pos, first, false)
            }
            this.pos += this.char_len(this.pos)
        }
    }

    fn finish_part(*this, t: int, token_start: int, raw_start: int, raw_end: int, token_end: int, first: bool, last: bool) {
        if first && last {
            // no interpolation: a plain string
            index := this.push("String", token_start, token_end, NoValue)
            this.templates[t].parts.push(Part { index, raw_start, raw_end })
            this.cook(t)
            return
        }
        kind := if first { "TemplateHead" } else if last { "TemplateTail" } else { "TemplateMiddle" }
        index := this.push(kind, token_start, token_end, NoValue)
        this.templates[t].parts.push(Part { index, raw_start, raw_end })
        if last { return this.end_template_parts(t) }
        this.stack.push(Open { index, close: "}", template: t })
    }

    /// A template closed early (EOF, newline, unbalanced closer): a zero-width tail at `at`.
    fn end_template(*this, t: int, at: int, raw_start: int, raw_end: int) {
        index := this.push_synthetic("TemplateTail", at)
        this.templates[t].parts.push(Part { index, raw_start, raw_end })
        this.end_template_parts(t)
    }

    fn end_template_parts(*this, t: int) {
        parts := this.templates[t].parts
        tail := parts[parts.len() - 1].index
        for i in 0..parts.len() - 1 { this.tokens[parts[i].index].closer = tail }
        this.cook(t)
    }

    /// Computes each part's value: CRLF → LF, the `"""` indentation rules, then escapes.
    fn cook(*this, t: int) {
        tpl := this.templates[t]
        var raws = tpl.parts.map(#{ p, _i => this.text(p.raw_start, p.raw_end).replace("\r\n", "\n") })
        var line_start = tpl.parts.map(#{ _p, _i => false })
        if tpl.multiline {
            // a first line holding only spaces and tabs is dropped
            if let Some(n) = blank_first_line(raws[0]) {
                raws[0] = raws[0].substring(n, raws[0].len())
                line_start[0] = true
            }
            last := raws.len() - 1
            if let Some(nl) = last_newline(raws[last]) {
                closing := raws[last].substring(nl + 1, raws[last].len())
                if is_blank(closing) {
                    raws[last] = raws[last].substring(0, nl)
                    if closing.len() > 0 {
                        for i in 0..raws.len() { raws[i] = dedent(raws[i], closing, line_start[i]) }
                    }
                }
            }
        }
        for i in 0..tpl.parts.len() {
            index := tpl.parts[i].index
            this.tokens[index].value = Text(unescape(raws[i], false))
            if tpl.multiline { this.tokens[index].multiline = true }
        }
    }

    /// Validates one escape at `pos` (the backslash) and skips it.
    fn escape(*this, byte: bool) {
        start := this.pos
        c := this.at(1)
        this.pos += 2
        if c == -1 { return }
        simple := c == 0x6e || c == 0x72 || c == 0x74 || c == 0x30 || c == 0x5c || c == 0x22 || c == 0x27 || c == 0x24
        if simple && (!byte || c != 0x24) { return }
        if c == 0x78 {
            h1 := this.at(0)
            h2 := this.at(1)
            if is_hex(h1) && is_hex(h2) {
                this.pos += 2
                if !byte && hex_value(h1) * 16 + hex_value(h2) > 0x7f {
                    this.error_fix("E_INVALID_ESCAPE", "`\\x` escapes in strings and chars are ASCII only (00–7F)", start, this.pos, "\\u{…}")
                }
                return
            }
            this.error("E_INVALID_ESCAPE", "`\\x` needs two hex digits", start, this.pos)
            return
        }
        if c == 0x75 && !byte && this.at(0) == 0x7b {
            this.pos += 1
            digits_start := this.pos
            var v = 0
            for is_hex(this.at(0)) {
                if v <= 0x10ffff { v = v * 16 + hex_value(this.at(0)) }
                this.pos += 1
            }
            n := this.pos - digits_start
            closed := this.at(0) == 0x7d
            if closed { this.pos += 1 }
            if !closed || n < 1 || n > 6 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff) {
                this.error("E_INVALID_ESCAPE", "`\\u{…}` takes 1–6 hex digits naming a Unicode scalar value", start, this.pos)
            }
            return
        }
        this.pos = start + 1 + this.char_len(start + 1)
        this.error("E_INVALID_ESCAPE", "unknown escape `${this.text(start, this.pos)}`", start, this.pos)
    }

    fn raw_string(*this, start: int) {
        this.pos = start + 2
        for this.pos < this.src.len() && this.at(0) != 0x22 { this.pos += 1 }
        raw_end := this.pos
        if this.pos >= this.src.len() {
            this.error("E_UNTERMINATED_STRING", "`r\"` is not closed", start, start + 2)
        } else {
            this.pos += 1
        }
        this.push("RawString", start, this.pos, Text(this.text(start + 2, raw_end).replace("\r\n", "\n")))
    }

    // ---- chars and bytes (§1.5, §1.6) ---------------------------------------------------------

    fn char_lit(*this, start: int, byte: bool) {
        quote := start + if byte { 1 } else { 0 }
        this.pos = quote + 1
        if !byte && is_digit(this.at(0)) {
            // the removed tagged record `'1{`
            var p = this.pos
            for is_digit(this.byte(p)) { p += 1 }
            if this.byte(p) == 0x7b {
                this.error_fix("E_TAGGED_RECORD_REMOVED", "tagged records are removed", start, p + 1, "r{ … }")
                return this.opener("r{", start, p + 1 - start)
            }
        }
        kind := if byte { "Byte" } else { "Char" }
        what := if byte { "a byte literal" } else { "a char literal" }
        let empty: Value = if byte { Byte(0) } else { Text("") }
        c := this.at(0)
        if c == 0x27 {
            this.pos += 1
            this.error("E_INVALID_CHAR", "${what} can't be empty", start, this.pos)
            this.push(kind, start, this.pos, empty)
            return
        }
        if c == -1 || c == 0x0a {
            this.error("E_INVALID_CHAR", "${what} is not closed", start, this.pos)
            this.push(kind, start, this.pos, empty)
            return
        }
        content_start := this.pos
        if c == 0x5c { this.escape(byte) } else { this.pos += this.char_len(this.pos) }
        content := this.text(content_start, this.pos)
        if this.at(0) == 0x27 {
            this.pos += 1
            cooked := unescape(content, byte)
            if !byte {
                this.push(kind, start, this.pos, Text(cooked))
                return
            }
            if c != 0x5c && c >= 0x80 {
                this.error_fix("E_BYTE_LITERAL_NOT_ASCII", "`${content}` is several bytes in UTF-8", start, this.pos, "b'\\xHH' or a str")
                this.push(kind, start, this.pos, Byte(0))
                return
            }
            this.push(kind, start, this.pos, Byte(byte_value(cooked)))
            return
        }
        // more than one character: `'ab'` up to the closing quote on this line, else unclosed `'a`
        var p = this.pos
        for p < this.src.len() && this.byte(p) != 0x27 && this.byte(p) != 0x0a { p += 1 }
        if this.byte(p) == 0x27 {
            this.pos = p + 1
            this.error("E_INVALID_CHAR", "${what} holds one character (use a string)", start, this.pos)
        } else {
            this.error("E_INVALID_CHAR", "${what} is not closed", start, this.pos)
        }
        this.push(kind, start, this.pos, empty)
    }
}

// ---- pure helpers ---------------------------------------------------------------------------

fn digit_ok(c: int, radix: int) -> bool {
    if radix == 16 { is_hex(c) } else if radix == 2 { c == 0x30 || c == 0x31 } else { c >= 0x30 && c <= 0x37 }
}

fn hex_value(c: int) -> int {
    if is_digit(c) { c - 0x30 } else if c >= 0x61 { c - 0x61 + 10 } else { c - 0x41 + 10 }
}

/// `0x`, `0o`, `0b` digits → decimal digits, with arbitrary precision (a u64 literal fits no int).
fn to_decimal(digits: str, radix: int) -> str {
    var out = [0] as Vec[int]                      // little-endian decimal digits
    for i in 0..digits.len() {
        var carry = hex_value(digits.byte_at(i) as int)
        for j in 0..out.len() {
            v := out[j] * radix + carry
            out[j] = v % 10
            carry = v / 10
        }
        for carry > 0 {
            out.push(carry % 10)
            carry /= 10
        }
    }
    var s = ""
    var k = out.len() - 1
    for k >= 0 {
        s += "${out[k]}"
        k -= 1
    }
    s
}

fn strip_zeros(s: str) -> str {
    var i = 0
    for i < s.len() - 1 && s.byte_at(i) == b'0' { i += 1 }
    s.substring(i, s.len())
}

fn underscores_ok(raw: str) -> bool {
    has_prefix := raw.len() >= 2 && raw.byte_at(0) == b'0' && (raw.byte_at(1) == b'x' || raw.byte_at(1) == b'o' || raw.byte_at(1) == b'b')
    body := if has_prefix { raw.substring(2, raw.len()) } else { raw }
    if body.starts_with("_") || body.ends_with("_") { return false }
    for i in 0..body.len() {
        if body.byte_at(i) != b'_' { continue }
        if !is_hex(body.byte_at(i - 1) as int) || !is_hex(body.byte_at(i + 1) as int) { return false }
    }
    true
}

/// The length of a first line holding only spaces and tabs, its `\n` included.
fn blank_first_line(s: str) -> int? {
    for i in 0..s.len() {
        c := s.byte_at(i)
        if c == b'\n' { return Some(i + 1) }
        if c != b' ' && c != b'\t' { return None }
    }
    None
}

fn last_newline(s: str) -> int? {
    var i = s.len() - 1
    for i >= 0 {
        if s.byte_at(i) == b'\n' { return Some(i) }
        i -= 1
    }
    None
}

fn is_blank(s: str) -> bool {
    for i in 0..s.len() {
        c := s.byte_at(i)
        if c != b' ' && c != b'\t' { return false }
    }
    true
}

/// Strips, from each line start in `s`, the whitespace it shares with `indent` (§1.5).
fn dedent(s: str, indent: str, starts_line: bool) -> str {
    var lines = s.split("\n")
    for i in 0..lines.len() {
        if i == 0 && !starts_line { continue }
        line := lines[i]
        var n = 0
        for n < indent.len() && n < line.len() && line.byte_at(n) == indent.byte_at(n) { n += 1 }
        lines[i] = line.substring(n, line.len())
    }
    lines.join("\n")
}

/// Cooks escapes; invalid ones (already reported) keep their character.
fn unescape(s: str, byte: bool) -> str {
    if !s.contains("\\") { return s }
    var out = ""
    var i = 0
    n := s.len()
    for i < n {
        c := s.byte_at(i)
        if c != b'\\' || i + 1 >= n {
            // copy one whole UTF-8 sequence
            w := sequence_len(c)
            out += s.substring(i, i + w)
            i += w
            continue
        }
        e := s.byte_at(i + 1)
        if e == b'n' { out += "\n"; i += 2 }
        else if e == b'r' { out += "\r"; i += 2 }
        else if e == b't' { out += "\t"; i += 2 }
        else if e == b'0' { out += "\0"; i += 2 }
        else if e == b'\\' || e == b'"' || e == b'\'' || e == b'$' { out += s.substring(i + 1, i + 2); i += 2 }
        else if e == b'x' && i + 3 < n + 0 && is_hex(s.byte_at(i + 2) as int) && is_hex(s.byte_at(i + 3) as int) {
            out += "${(hex_value(s.byte_at(i + 2) as int) * 16 + hex_value(s.byte_at(i + 3) as int)) as char}"
            i += 4
        } else if e == b'u' && !byte && i + 2 < n && s.byte_at(i + 2) == b'{' {
            var j = i + 3
            var v = 0
            for j < n && is_hex(s.byte_at(j) as int) {
                if v <= 0x10ffff { v = v * 16 + hex_value(s.byte_at(j) as int) }
                j += 1
            }
            if j < n && s.byte_at(j) == b'}' && j > i + 3 && v <= 0x10ffff {
                out += "${v as char}"
                i = j + 1
            } else {
                out += "u"
                i += 2
            }
        } else {
            w := sequence_len(e)
            out += s.substring(i + 1, i + 1 + w)
            i += 1 + w
        }
    }
    out
}

fn sequence_len(lead: u8) -> int {
    b := lead as int
    if b >= 0xf0 { 4 } else if b >= 0xe0 { 3 } else if b >= 0xc0 { 2 } else { 1 }
}

fn byte_value(cooked: str) -> int {
    if cooked.is_empty() { 0 } else { (cooked.chars()[0] as int) % 256 }
}
