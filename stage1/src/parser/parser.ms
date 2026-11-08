// The MinScript parser (spec §2–§8, §12), ported from minscript/src/parser.ts: recursive descent for
// items, statements, types and patterns; Pratt parsing for expressions (precedence: spec §3).
//
// Newlines are not tokens. The rules of spec §5.4 are applied with each token's `nl_before`:
// - `nl_sig` is true inside `{…}` and false inside `(…)` / `[…]`. Where it is true, an infix operator
//   on a new line ends the expression, except the continuation tokens (`continues`).
// - postfix `(`, `[`, `.[` and `?` never cross a newline; `.` and `?.` always may.
//
// Error handling: `fail()` reports one diagnostic and returns `Err(Sync)`, which `?` carries to the
// nearest statement / item / member / arm boundary, where the parser skips to the next one (stage 0
// throws an exception instead; the control flow is the same). `report()` records a diagnostic and
// keeps going: it is used where the intended form is clear (`Vec<int>`, `(a) => a`, `while`), so each
// mistake produces exactly one diagnostic.
package parser

import "app.lexer.{lex, js_number, is_keyword, Token, Span, Diagnostic, LexResult, Value}"
import "app.ast.*"

pub type ParseResult = {
    pub file: File
    /// lexer diagnostics first, then parser diagnostics
    pub diagnostics: Vec[Diagnostic]
    pub lexed: LexResult
}

pub fun parse(src: Vec[u8]) -> ParseResult {
    let lexed = lex(src)
    var p = Parser { t: lexed.tokens.clone() }
    let file = p.parse_file()
    var diagnostics = lexed.diagnostics.clone()
    diagnostics.extend(p.diagnostics)
    ParseResult { file, diagnostics, lexed }
}

/// Returned by `fail()` after reporting: carried with `?` to a recovery boundary.
type Sync = { at: int }

/// The newline / struct context of a bracket group, saved around it.
type GroupState = r{ nl_sig: bool, no_struct: bool }

/// Infix binding power and associativity (higher binds tighter), from spec §3.
type Infix = r{ bp: int, assoc: string }

fun infix(kind: &str) -> Infix? {
    match kind {
        "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "&=" | "|=" | "^=" | "<<=" | ">>=" | "??=" => Some(r{ bp: 1, assoc: "right" })
        "or" => Some(r{ bp: 2, assoc: "left" })
        ".." | "..=" => Some(r{ bp: 4, assoc: "none" })
        "??" => Some(r{ bp: 5, assoc: "right" })
        "||" => Some(r{ bp: 6, assoc: "left" })
        "&&" => Some(r{ bp: 7, assoc: "left" })
        "==" | "!=" | "<" | "<=" | ">" | ">=" => Some(r{ bp: 8, assoc: "none" })
        "|" => Some(r{ bp: 9, assoc: "left" })
        "^" => Some(r{ bp: 10, assoc: "left" })
        "&" => Some(r{ bp: 11, assoc: "left" })
        "<<" | ">>" => Some(r{ bp: 12, assoc: "left" })
        "+" | "-" => Some(r{ bp: 13, assoc: "left" })
        "*" | "/" | "%" => Some(r{ bp: 14, assoc: "left" })
        "as" => Some(r{ bp: 15, assoc: "left" })
        _ => None
    }
}

let BP_RANGE_OPERAND: int = 5
let BP_OR_RHS: int = 3

fun is_assign_op(k: &str) -> bool {
    match k {
        "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "&=" | "|=" | "^=" | "<<=" | ">>=" | "??=" => true
        _ => false
    }
}

fun is_comparison(k: &str) -> bool {
    match k {
        "==" | "!=" | "<" | "<=" | ">" | ">=" => true
        _ => false
    }
}

/// An infix/postfix token on a new line continues the expression only if it is one of these (§5.4 rule 2).
fun continues(k: &str) -> bool {
    match k {
        "." | "?." | "&&" | "||" | "??" | "or" | "as" => true
        _ => false
    }
}

/// Tokens that may start an expression.
fun expr_start(k: &str) -> bool {
    match k {
        "Ident" | "_" | "Int" | "Float" | "String" | "RawString" | "Char" | "TemplateHead" => true
        "true" | "false" | "nil" | "this" | "Self" => true
        "(" | "[" | "{" | "a[" | "t(" | "r{" | "m{" | "s{" | "_{" | "#{" | "#[" => true
        "-" | "!" | "&" | "*" | "~" | "--" | "++" | ".." | "..=" => true
        "await" | "if" | "match" | "for" | "select" | "unsafe" | "recover" | "return" | "break" | "continue" => true
        "fun" | "while" | "loop" => true
        _ => false
    }
}

fun type_start(k: &str) -> bool {
    match k {
        "Ident" | "Self" | "&" | "*" | "t(" | "r{" | "(" | "TypeOf" | "String" | "Int" | "true" | "false" => true
        _ => false
    }
}

fun item_start(k: &str) -> bool {
    match k {
        "pub" | "fun" | "async" | "type" | "union" | "inter" | "impl" | "let" | "var" | "extern" | "import" | "@" => true
        _ => false
    }
}

fun pattern_literal(k: &str) -> bool {
    match k {
        "Int" | "Float" | "String" | "RawString" | "Char" | "true" | "false" | "nil" => true
        _ => false
    }
}

fun is_reserved(k: &str) -> bool {
    match k {
        "while" | "loop" | "yield" | "macro" | "where" | "dyn" => true
        _ => false
    }
}

/// Tokens allowed in a closure parameter header, besides skipped bracket groups (spec §4.4).
fun header_token(k: &str) -> bool {
    match k {
        "Ident" | "_" | "mut" | "," | ":" | "&" | "->" | "?" | "." | "Self" | "*" => true
        _ => false
    }
}

fun header_group(k: &str) -> bool {
    match k {
        "(" | "[" | "t(" | "r{" | "a[" => true
        _ => false
    }
}

/// `it`, `it1`, `it2`, …
fun is_implicit_param(name: &str) -> bool {
    if name == "it" {
        return true
    }
    if !name.starts_with("it") || name.len() < 3 {
        return false
    }
    let first = name.byte_at(2) as int
    if first < 0x31 || first > 0x39 {
        return false
    }
    var i = 3
    for i < name.len() {
        let c = name.byte_at(i) as int
        if c < 0x30 || c > 0x39 {
            return false
        }
        i += 1
    }
    true
}

fun is_upper(name: &str) -> bool {
    if name.is_empty() {
        return false
    }
    let c = name.byte_at(0) as int
    c >= 0x41 && c <= 0x5a
}

/// The text of a token's value (identifiers, strings).
fun text_of(tok: &Token) -> string {
    let Some(v) = &tok.value else { return "" }
    value_text(v)
}

fun value_text(v: &Value) -> string {
    match v {
        Text(s) => s.clone()
        Int(d) => d.clone()
        Float(x) => js_number(x)
    }
}

fun describe(tok: &Token) -> string {
    match tok.kind {
        "EOF" => "end of file"
        "Ident" => "identifier `${text_of(tok)}`"
        "Int" | "Float" => "number `${text_of(tok)}`"
        "String" | "RawString" | "TemplateHead" => "a string"
        "Char" => "a character"
        _ => "`${tok.kind}`"
    }
}

/// What a container's members are, for `parse_members`.
union MemberKind = {
    StructMembers      // a struct body: fields and methods
    VariantFields      // `Card { number: string }`
    UnionMembers       // variants and methods
    InterMembers       // method signatures
    ImplMembers        // methods
    RecordTypeFields   // `r{ x: f64 }`
    ExternFuns         // signatures
}

/// What `parse_members` collected.
type Members = {
    fields: Vec[Field] = []
    methods: Vec[FunDecl] = []
    variants: Vec[Variant] = []
}

// ---- the parser ----------------------------------------------------------------------------------

pub type Parser = {
    pub diagnostics: Vec[Diagnostic] = []
    t: Vec[Token]
    i: int = 0
    prev_end: int = 0
    /// newlines end expressions (inside `{…}`)
    nl_sig: bool = true
    /// in an if/for/match header: `Name {` is not a struct literal
    no_struct: bool = false
    /// half of a `>>` already consumed by a nested `<…>` (E_ANGLE_GENERICS recovery)
    gt_pending: bool = false
    angle_depth: int = 0
    labels: Vec[string] = []
    /// stack: does the enclosing closure have a parameter header?
    closures: Vec[bool] = []
    next_id: int = 0

    // ---- token helpers ----

    fun id(&mut this) -> int {
        this.next_id += 1
        this.next_id
    }

    fun cur(&this) -> Token { this.t[this.i].clone() }
    fun kind(&this) -> string { this.t[this.i].kind.clone() }
    fun peek(&this, k: int) -> Token {
        let at = if this.i + k < this.t.len() { this.i + k } else { this.t.len() - 1 }
        this.t[at].clone()
    }
    fun at(&this, kind: &str) -> bool { this.t[this.i].kind == kind }
    fun nl(&this) -> bool { this.t[this.i].nl_before }

    fun advance(&mut this) -> Token {
        let tok = this.t[this.i].clone()
        if tok.kind != "EOF" {
            this.i += 1
        }
        this.prev_end = tok.span.end
        tok
    }

    fun eat(&mut this, kind: &str) -> bool {
        if this.at(kind) {
            let _ = this.advance()
            return true
        }
        false
    }

    fun expect(&mut this, kind: &str) -> Result[Token, Sync] {
        if this.at(kind) {
            return Ok(this.advance())
        }
        let found = describe(this.cur())
        this.fail("E_UNEXPECTED_TOKEN", "expected `${kind}`, found ${found}")
    }

    fun expect_what(&mut this, kind: &str, what: &str) -> Result[Token, Sync] {
        if this.at(kind) {
            return Ok(this.advance())
        }
        let found = describe(this.cur())
        this.fail("E_UNEXPECTED_TOKEN", "expected ${what}, found ${found}")
    }

    fun jump_to(&mut this, index: int) {
        this.i = if index < this.t.len() - 1 { index } else { this.t.len() - 1 }
        this.prev_end = if this.i > 0 { this.t[this.i - 1].span.end } else { 0 }
    }

    /// The span from `start` to the end of the last consumed token.
    fun sp(&this, start: Span) -> Span {
        r{ start: start.start, end: if this.prev_end > start.start { this.prev_end } else { start.start }, line: start.line, col: start.col }
    }

    fun closer_index(&this, opener: &Token) -> int {
        opener.closer ?? this.t.len() - 1
    }

    /// The index after the token at `k`: past its closer, if it is an opener.
    fun skip_index(&this, k: int) -> int {
        match this.t[k].closer {
            Some(c) => if c > k { c + 1 } else { k + 1 }
            None => k + 1
        }
    }

    // ---- diagnostics ----

    fun report(&mut this, code: &str, message: string) {
        let span = this.t[this.i].span
        this.report_at(code, message, span)
    }

    fun report_at(&mut this, code: &str, message: string, span: Span) {
        this.diagnostics.push(Diagnostic { code: code.to_str(), message, span })
    }

    /// E_OPEN_BRACE_NEWLINE, reported at the end of the header (the line the `{` belongs on).
    fun report_brace_newline(&mut this, message: string) {
        let at = if this.i > 0 { this.i - 1 } else { 0 }
        let span = this.t[at].span
        this.report_at("E_OPEN_BRACE_NEWLINE", message, span)
    }

    fun fail[T](&mut this, code: &str, message: string) -> Result[T, Sync] {
        this.report(code, message)
        Err(Sync { at: this.i })
    }

    fun fail_at[T](&mut this, code: &str, message: string, span: Span) -> Result[T, Sync] {
        this.report_at(code, message, span)
        Err(Sync { at: this.i })
    }

    /// Enters a bracket group's newline/struct context; `leave` restores the saved one.
    fun enter(&mut this, nl_sig: bool) -> GroupState {
        let saved = r{ nl_sig: this.nl_sig, no_struct: this.no_struct }
        this.nl_sig = nl_sig
        this.no_struct = false
        saved
    }

    fun leave(&mut this, saved: GroupState) {
        this.nl_sig = saved.nl_sig
        this.no_struct = saved.no_struct
    }

    /// After a `Sync` at `err_at`, skips from `start` at the same bracket depth to the next boundary:
    /// a token on a new line (or one for which `stop` is true) at or after the error, past `;`, or
    /// `end` (the container's closer). `stop`: "item", "comma" or "".
    fun sync_from(&mut this, start: int, end: int, err_at: int, stop: &str) {
        var k = start
        for k < end {
            let tok = &this.t[k]
            let stops = match stop {
                "item" => item_start(tok.kind)
                "comma" => tok.kind == ","
                _ => false
            }
            if k >= err_at && k > start && (tok.nl_before || stops) {
                break
            }
            if tok.kind == ";" && k >= err_at {
                k += 1
                break
            }
            k = this.skip_index(k)
        }
        this.jump_to(if k < end { k } else { end })
    }

    // ---- file and items ----

    pub fun parse_file(&mut this) -> File {
        let start = this.cur().span
        var pkg = [] as Vec[string]
        if this.at("package") {
            let _ = this.advance()
            if let Ok(name) = this.dotted_name("package name") {
                pkg = name
            }
        } else {
            let found = describe(this.cur())
            this.report("E_UNEXPECTED_TOKEN", "expected `package` at the start of the file, found ${found}")
        }

        var imports = [] as Vec[Import]
        var items = [] as Vec[Item]
        let eof = this.t.len() - 1
        for !this.at("EOF") {
            let item_start_at = this.i
            if this.at(";") {
                let _ = this.advance()
                continue
            }
            let step = this.file_entry(imports, items)
            if let Err(e) = step {
                this.sync_from(item_start_at, eof, e.at, "item")
                this.sync_to_item_start()
            }
        }
        File { id: this.id(), span: this.sp(start), package_path: pkg, imports, items }
    }

    /// One import or item, and the newline after it.
    fun file_entry(&mut this, imports: &mut Vec[Import], items: &mut Vec[Item]) -> Result[void, Sync] {
        if this.at("import") {
            let tok = this.cur()
            let imp = this.parse_import()?
            if !items.is_empty() {
                this.report_at("E_IMPORT_AFTER_ITEM", "imports must come before the first item", tok.span)
            }
            imports.push(imp)
        } else {
            let item = this.parse_item()?
            match item {
                Some(found) => items.push(found)
                None => return Ok()
            }
        }
        if !this.at("EOF") && !this.at(";") && !this.nl() {
            let found = describe(this.cur())
            return this.fail("E_UNEXPECTED_TOKEN", "expected a newline after the declaration, found ${found}")
        }
        Ok()
    }

    /// From a newline boundary, keep skipping lines until one starts with an item keyword.
    fun sync_to_item_start(&mut this) {
        for !this.at("EOF") && !(item_start(this.kind()) && this.nl()) {
            let next = this.skip_index(this.i)
            this.jump_to(next)
        }
    }

    fun dotted_name(&mut this, what: &str) -> Result[Vec[string], Sync] {
        var parts = [this.ident_name(what)?]
        for this.at(".") && this.peek(1).kind == "Ident" {
            let _ = this.advance()
            parts.push(this.ident_name(what)?)
        }
        Ok(parts)
    }

    /// An identifier; a keyword in its place is reported (E_KEYWORD_AS_IDENT) and accepted.
    fun ident_name(&mut this, what: &str) -> Result[string, Sync] {
        let tok = this.cur()
        if tok.kind == "Ident" {
            let _ = this.advance()
            return Ok(text_of(tok))
        }
        if is_keyword(tok.kind) {
            this.report("E_KEYWORD_AS_IDENT", "`${tok.kind}` is a keyword and can't be used as ${what}")
            let _ = this.advance()
            return Ok(tok.kind.clone())
        }
        this.fail("E_UNEXPECTED_TOKEN", "expected ${what}, found ${describe(tok)}")
    }

    fun parse_import(&mut this) -> Result[Import, Sync] {
        let start = this.advance()
        let is_pub = this.eat("pub")
        let path_tok = this.cur()
        if path_tok.kind != "String" && path_tok.kind != "RawString" {
            return this.fail("E_UNEXPECTED_TOKEN", "expected an import path string, found ${describe(path_tok)}")
        }
        let _ = this.advance()
        var alias: string? = None
        if this.eat("as") {
            alias = Some(this.ident_name("an import alias")?)
        }
        Ok(Import { id: this.id(), span: this.sp(start.span), path: text_of(path_tok), is_pub, alias })
    }

    fun skip_attribute(&mut this) {
        let at = this.advance()
        this.report_at("E_ATTRIBUTES_RESERVED", "attributes (`@name`) are reserved for a future version", at.span)
        if this.at("Ident") && !this.cur().ws_before {
            let _ = this.advance()
        }
        if this.at("(") && !this.nl() {
            let next = this.closer_index(this.cur()) + 1
            this.jump_to(next)
        }
    }

    fun parse_item(&mut this) -> Result[Item?, Sync] {
        for this.at("@") {
            this.skip_attribute()
        }
        let start = this.cur().span
        let is_pub = this.eat("pub")
        match this.kind() {
            "fun" => return Ok(Some(Fun(this.parse_fun(start, is_pub, false, "item", false)?)))
            "async" => {
                let _ = this.advance()
                if !this.at("fun") {
                    let found = describe(this.cur())
                    return this.fail("E_UNEXPECTED_TOKEN", "expected `fun` after `async`, found ${found}")
                }
                return Ok(Some(Fun(this.parse_fun(start, is_pub, true, "item", false)?)))
            }
            "type" => return Ok(Some(this.parse_type_decl(start, is_pub)?))
            "union" => return Ok(Some(Union(this.parse_union_decl(start, is_pub)?)))
            "inter" => return Ok(Some(Inter(this.parse_inter_decl(start, is_pub)?)))
            "impl" => return Ok(Some(Impl(this.parse_impl(start)?)))
            "let" => return Ok(Some(Let(this.parse_let_decl(start, is_pub)?)))
            "var" => {
                this.report("E_GLOBAL_VAR", "top-level `var` is not allowed: use `let`, or `Ref(…)` for mutable global state")
                return Ok(Some(Let(this.parse_let_decl(start, is_pub)?)))
            }
            "extern" => return Ok(Some(Extern(this.parse_extern(start)?)))
            _ => {}
        }
        if is_pub {
            let found = describe(this.cur())
            return this.fail("E_UNEXPECTED_TOKEN", "expected a declaration after `pub`, found ${found}")
        }
        this.report("E_TOP_LEVEL_STATEMENT", "only declarations are allowed at the top level; move this into a function")
        this.sync_from(this.i, this.t.len() - 1, this.i + 1, "item")
        this.sync_to_item_start()
        Ok(None)
    }

    fun parse_generic_params(&mut this) -> Result[Vec[GenericParam], Sync] {
        if this.at("<") {
            let lt = this.cur()
            this.report_at("E_ANGLE_GENERICS", "generic parameters use `[…]`: write `name[T]`", lt.span)
            let _ = this.advance()
            let params = this.generic_param_list(true)?
            let _ = this.close_angle()
            return Ok(params)
        }
        if !this.at("[") {
            return Ok([])
        }
        let _ = this.advance()
        let saved = this.enter(false)
        let params = this.generic_param_list(false)
        this.leave(saved)
        let ps = params?
        let _ = this.expect("]")?
        Ok(ps)
    }

    /// `angle`: closed by `>` (E_ANGLE_GENERICS recovery), else by `]`.
    fun generic_param_list(&mut this, angle: bool) -> Result[Vec[GenericParam], Sync] {
        var params = [] as Vec[GenericParam]
        for {
            let done = if angle { this.gt_pending || this.at(">") || this.at(">>") } else { this.at("]") }
            if done {
                break
            }
            let start = this.cur().span
            let name = this.ident_name("a generic parameter name")?
            var bounds = [] as Vec[Type]
            if this.eat(":") {
                bounds.push(this.parse_type_postfix()?)
                for this.eat("&") {
                    bounds.push(this.parse_type_postfix()?)
                }
            }
            params.push(GenericParam { id: this.id(), span: this.sp(start), name, bounds })
            if !this.eat(",") {
                break
            }
        }
        if params.is_empty() {
            this.report("E_EXPECTED_TYPE_ARGUMENTS", "expected at least one generic parameter")
        }
        Ok(params)
    }

    /// `member`: a method, which may be named after a keyword (`fun or`), since it is only called after `.`
    fun parse_fun(&mut this, start: Span, is_pub: bool, is_async: bool, mode: &str, member: bool) -> Result[FunDecl, Sync] {
        let _ = this.expect("fun")?
        var name = ""
        let k = this.kind()
        // a method, or a `pub fun` (called as `pkg.name`), may be named after a keyword: `fun or`, `runtime.yield`
        if (member && is_keyword(k) && !is_reserved(k)) || (is_pub && is_keyword(k)) {
            name = this.advance().kind
        } else {
            name = this.ident_name("a function name")?
        }
        let generics = this.parse_generic_params()?
        let open = this.expect("(")?
        let saved = this.enter(false)
        let parsed = this.parse_params()
        this.leave(saved)
        let t(receiver, params) = parsed?
        this.jump_to(this.closer_index(open))
        let _ = this.expect(")")?

        var ret: Type? = None
        if this.eat("->") {
            ret = Some(this.parse_type(false, true)?)
        } else if this.at(":") {
            return this.fail("E_UNEXPECTED_TOKEN", "return types are written with `->`: `fun f() -> int`")
        }

        var body: Block? = None
        if this.at("{") {
            if this.nl() {
                this.report_brace_newline("the `{` of a function body goes on the same line as its signature")
            }
            body = Some(this.parse_function_body()?)
        } else if mode == "item" {
            let found = describe(this.cur())
            return this.fail("E_UNEXPECTED_TOKEN", "expected `{` to start the function body, found ${found}")
        }
        Ok(FunDecl { id: this.id(), span: this.sp(start), is_pub, is_async, name, generics, receiver, params, ret, body })
    }

    fun parse_function_body(&mut this) -> Result[Block, Sync] {
        var saved_labels = [] as Vec[string]
        var saved_closures = [] as Vec[bool]
        saved_labels.extend(this.labels.clone())
        saved_closures.extend(this.closures.clone())
        this.labels = []
        this.closures = []
        let body = this.parse_block()
        this.labels = saved_labels
        this.closures = saved_closures
        body
    }

    fun parse_params(&mut this) -> Result[t(string?, Vec[Param]), Sync] {
        var receiver: string? = None
        var params = [] as Vec[Param]
        var variadic: Span? = None
        var first = true
        for !this.at(")") && !this.at("EOF") {
            if first {
                first = false
                if let Some(r) = this.try_receiver() {
                    receiver = Some(r)
                    if !this.eat(",") {
                        break
                    }
                    continue
                }
            }
            if let Some(v) = variadic {
                this.report_at("E_VARIADIC_NOT_LAST", "a variadic parameter (`...name: T`) must be the last parameter", v)
                variadic = None
            }
            let start_tok = this.cur()
            let p = this.parse_param()?
            if p.variadic {
                variadic = Some(start_tok.span)
            }
            params.push(p)
            if !this.eat(",") {
                break
            }
        }
        if !this.at(")") {
            let found = describe(this.cur())
            return this.fail("E_UNEXPECTED_TOKEN", "expected `,` or `)` in the parameter list, found ${found}")
        }
        Ok(t(receiver, params))
    }

    fun try_receiver(&mut this) -> string? {
        let k0 = this.kind()
        let k1 = this.peek(1).kind
        let k2 = this.peek(2).kind
        if k0 == "this" {
            let _ = this.advance()
            return Some("this")
        }
        if k0 == "&" && k1 == "this" {
            let _ = this.advance()
            let _ = this.advance()
            return Some("&this")
        }
        if k0 == "&" && k1 == "mut" && k2 == "this" {
            let _ = this.advance()
            let _ = this.advance()
            let _ = this.advance()
            return Some("&mut this")
        }
        if k0 == "mut" && k1 == "this" {
            let _ = this.advance()
            let _ = this.advance()
            return Some("mut this")
        }

        // `self` receivers from other languages
        let p0 = this.cur()
        let p1 = this.peek(1)
        let p2 = this.peek(2)
        let p3 = this.peek(3)
        var n = -1
        var recv = "this"
        if is_self(p0) && ends_param(p1) {
            n = 1
            recv = "this"
        } else if k0 == "&" && is_self(p1) && ends_param(p2) {
            n = 2
            recv = "&this"
        } else if k0 == "&" && k1 == "mut" && is_self(p2) && ends_param(p3) {
            n = 3
            recv = "&mut this"
        } else if k0 == "mut" && is_self(p1) && ends_param(p2) {
            n = 2
            recv = "mut this"
        }
        if n < 0 {
            return None
        }
        this.report("E_UNKNOWN_RECEIVER", "the receiver is `this`: write `${recv}`")
        var k = 0
        for k < n {
            let _ = this.advance()
            k += 1
        }
        Some(recv)
    }

    fun parse_param(&mut this) -> Result[Param, Sync] {
        let start = this.cur().span
        if this.at("&") {
            this.report("E_INVALID_PARAM", "`&` belongs on the type: write `name: &T`")
            let _ = this.advance()
            let _ = this.eat("mut")
        }
        let variadic = this.eat("...")
        let is_mut = this.eat("mut")
        let name = this.ident_name("a parameter name")?
        this.expect_colon("parameter")?
        let ty = this.parse_type(false, true)?
        Ok(Param { id: this.id(), span: this.sp(start), name, is_mut, variadic, ty })
    }

    /// `:` before a type. When it is missing but a type follows on the same line, report and continue.
    fun expect_colon(&mut this, what: &str) -> Result[void, Sync] {
        if this.eat(":") {
            return Ok()
        }
        if type_start(this.kind()) && !this.nl() {
            this.report("E_EXPECTED_COLON", "expected `:` between the ${what} name and its type")
            return Ok()
        }
        let found = describe(this.cur())
        this.fail("E_EXPECTED_COLON", "expected `:` and a type after the ${what} name, found ${found}")
    }

    fun parse_impl_list(&mut this) -> Result[Vec[Type], Sync] {
        var impls = [] as Vec[Type]
        if !this.eat(":") {
            return Ok(impls)
        }
        impls.push(this.parse_type_postfix()?)
        for this.eat(",") {
            impls.push(this.parse_type_postfix()?)
        }
        Ok(impls)
    }

    fun parse_type_decl(&mut this, start: Span, is_pub: bool) -> Result[Item, Sync] {
        let _ = this.advance()
        let name = this.ident_name("a type name")?
        let generics = this.parse_generic_params()?
        let impls = this.parse_impl_list()?
        let _ = this.expect("=")?

        if this.at("|") {
            this.report("E_LEADING_PIPE_UNION", "sum types are declared with `union`: `union X = { A  B }`")
            var variants = [] as Vec[Variant]
            for this.eat("|") {
                variants.push(this.parse_variant()?)
            }
            return Ok(Union(UnionDecl { id: this.id(), span: this.sp(start), is_pub, name, generics, impls, variants, methods: [] }))
        }
        if this.at("{") {
            let body = this.parse_struct_body()?
            return Ok(TypeDef(TypeDecl { id: this.id(), span: this.sp(start), is_pub, name, generics, impls, body: Struct(body) }))
        }
        let body = this.parse_type(true, true)?
        Ok(TypeDef(TypeDecl { id: this.id(), span: this.sp(start), is_pub, name, generics, impls, body: Alias(body) }))
    }

    /// Parses `{ member* }` with per-member recovery. Members are separated by `,`, `;`, newlines, or nothing.
    fun parse_members(&mut this, kind: &MemberKind, opener: &str) -> Result[Members, Sync] {
        let open = this.expect(opener)?
        let end = this.closer_index(open)
        var acc = Members {}
        let saved = this.enter(true)
        for this.i < end && !this.at("EOF") {
            if this.at(",") || this.at(";") {
                let _ = this.advance()
                continue
            }
            let member_start = this.i
            if let Err(e) = this.parse_member(kind, acc) {
                this.sync_from(member_start, end, e.at, "")
            }
        }
        this.leave(saved)
        this.jump_to(end)
        let _ = this.expect("}")?
        Ok(acc)
    }

    fun parse_member(&mut this, kind: &MemberKind, acc: &mut Members) -> Result[void, Sync] {
        match kind {
            StructMembers | UnionMembers => {
                for this.at("@") {
                    this.skip_attribute()
                }
                let mstart = this.cur().span
                let is_pub = this.eat("pub")
                if this.at("fun") {
                    acc.methods.push(this.parse_fun(mstart, is_pub, false, "item", true)?)
                } else if this.at("async") {
                    let _ = this.advance()
                    acc.methods.push(this.parse_fun(mstart, is_pub, true, "item", true)?)
                } else if let StructMembers = kind {
                    acc.fields.push(this.parse_field(mstart, is_pub, true)?)
                } else {
                    acc.variants.push(this.parse_variant()?)
                }
            }
            VariantFields | RecordTypeFields => {
                let fstart = this.cur().span
                let is_pub = this.eat("pub")
                let allow_default = if let VariantFields = kind { true } else { false }
                acc.fields.push(this.parse_field(fstart, is_pub, allow_default)?)
            }
            InterMembers | ImplMembers => {
                let mstart = this.cur().span
                let is_pub = this.eat("pub")
                let is_async = this.eat("async")
                let mode = if let InterMembers = kind { "sig" } else { "item" }
                acc.methods.push(this.parse_fun(mstart, is_pub, is_async, mode, true)?)
            }
            ExternFuns => {
                let mstart = this.cur().span
                let is_pub = this.eat("pub")
                acc.methods.push(this.parse_fun(mstart, is_pub, false, "sig", false)?)
            }
        }
        Ok()
    }

    fun parse_struct_body(&mut this) -> Result[StructBody, Sync] {
        let start = this.cur().span
        let m = this.parse_members(StructMembers, "{")?
        Ok(StructBody { id: this.id(), span: this.sp(start), fields: m.fields, methods: m.methods })
    }

    fun parse_field(&mut this, start: Span, is_pub: bool, allow_default: bool) -> Result[Field, Sync] {
        let name = this.ident_name("a field name")?
        this.expect_colon("field")?
        let ty = this.parse_type(false, true)?
        var default: Expr? = None
        if allow_default && this.eat("=") {
            default = Some(this.parse_expr(0)?)
        }
        Ok(Field { id: this.id(), span: this.sp(start), is_pub, name, ty, default })
    }

    fun parse_variant(&mut this) -> Result[Variant, Sync] {
        let start = this.cur().span
        let name = this.ident_name("a variant name")?
        var tuple: Vec[Type]? = None
        var fields: Vec[Field]? = None
        if this.at("(") && !this.nl() {
            let open = this.advance()
            let saved = this.enter(false)
            let list = this.type_list(")")
            this.leave(saved)
            tuple = Some(list?)
            this.jump_to(this.closer_index(open))
            let _ = this.expect(")")?
        } else if this.at("{") && !this.nl() {
            let m = this.parse_members(VariantFields, "{")?
            fields = Some(m.fields)
        }
        Ok(Variant { id: this.id(), span: this.sp(start), name, tuple, fields })
    }

    fun parse_union_decl(&mut this, start: Span, is_pub: bool) -> Result[UnionDecl, Sync] {
        let _ = this.advance()
        let name = this.ident_name("a union name")?
        let generics = this.parse_generic_params()?
        let impls = this.parse_impl_list()?
        let _ = this.expect("=")?
        let m = this.parse_members(UnionMembers, "{")?
        Ok(UnionDecl { id: this.id(), span: this.sp(start), is_pub, name, generics, impls, variants: m.variants, methods: m.methods })
    }

    fun parse_inter_decl(&mut this, start: Span, is_pub: bool) -> Result[InterDecl, Sync] {
        let _ = this.advance()
        let name = this.ident_name("an interface name")?
        let generics = this.parse_generic_params()?
        var supers = [] as Vec[Type]
        if this.eat(":") {
            supers.push(this.parse_type_postfix()?)
            for this.eat("&") || this.eat(",") {
                supers.push(this.parse_type_postfix()?)
            }
        }
        let _ = this.expect("=")?
        if !this.at("{") {
            let composition = this.parse_type(false, true)?
            return Ok(InterDecl { id: this.id(), span: this.sp(start), is_pub, name, generics, supers, methods: None, composition: Some(composition) })
        }
        let m = this.parse_members(InterMembers, "{")?
        Ok(InterDecl { id: this.id(), span: this.sp(start), is_pub, name, generics, supers, methods: Some(m.methods), composition: None })
    }

    fun parse_impl(&mut this, start: Span) -> Result[ImplDecl, Sync] {
        let _ = this.advance()
        let generics = if this.at("[") || this.at("<") { this.parse_generic_params()? } else { [] }
        var first = [this.parse_type_postfix()?]
        for this.eat(",") {
            first.push(this.parse_type_postfix()?)
        }
        var interfaces = [] as Vec[Type]
        var target = first[0].clone()
        if this.eat("for") {
            interfaces = first
            target = this.parse_type_postfix()?
        } else if first.len() > 1 {
            return this.fail("E_UNEXPECTED_TOKEN", "expected `for` after a list of interfaces: `impl A, B for T`")
        }
        if this.nl() && this.at("{") {
            this.report_brace_newline("the `{` of an `impl` goes on the same line")
        }
        let m = this.parse_members(ImplMembers, "{")?
        Ok(ImplDecl { id: this.id(), span: this.sp(start), generics, interfaces, target, methods: m.methods })
    }

    fun parse_let_decl(&mut this, start: Span, is_pub: bool) -> Result[LetDecl, Sync] {
        let _ = this.advance()
        let name = this.ident_name("a name")?
        var ty: Type? = None
        if this.eat(":") {
            ty = Some(this.parse_type(false, true)?)
        }
        let _ = this.expect("=")?
        let value = this.parse_expr(0)?
        Ok(LetDecl { id: this.id(), span: this.sp(start), is_pub, name, ty, value })
    }

    fun parse_extern(&mut this, start: Span) -> Result[ExternDecl, Sync] {
        let _ = this.advance()
        let abi_tok = this.expect_what("String", "an ABI string such as `\"C\"`")?
        let m = this.parse_members(ExternFuns, "{")?
        Ok(ExternDecl { id: this.id(), span: this.sp(start), abi: text_of(abi_tok), funs: m.methods })
    }

    // ---- types ----

    fun mk_type(&mut this, start: Span, kind: TypeKind) -> Type {
        Type { id: this.id(), span: this.sp(start), kind }
    }

    /// Type grammar (spec §7.1). `union` allows `A | B` (only on the right of `type X =`). `&` between
    /// types is an intersection (if `allow_inter`); a leading `&` is a borrow of the postfix type after it.
    fun parse_type(&mut this, union_ok: bool, allow_inter: bool) -> Result[Type, Sync] {
        let start = this.cur().span
        var first = this.parse_type_inter(allow_inter)?
        if union_ok && this.at("|") {
            var members = [first]
            for this.eat("|") {
                members.push(this.parse_type_inter(allow_inter)?)
            }
            first = this.mk_type(start, TUnion(members))
        }
        Ok(first)
    }

    fun parse_type_inter(&mut this, allow_inter: bool) -> Result[Type, Sync] {
        let start = this.cur().span
        let first = this.parse_type_postfix()?
        if !allow_inter || !this.at("&") || this.nl() {
            return Ok(first)
        }
        var members = [first]
        for this.at("&") && !this.nl() {
            let _ = this.advance()
            members.push(this.parse_type_postfix()?)
        }
        Ok(this.mk_type(start, TIntersection(members)))
    }

    fun parse_type_postfix(&mut this) -> Result[Type, Sync] {
        let start = this.cur().span
        var ty = this.parse_type_primary()?
        for this.at("?") && !this.nl() {
            if let TOption(_) = &ty.kind {
                this.report("E_UNEXPECTED_TOKEN", "`T??` is not a type: an Option can't be optional again")
            }
            let _ = this.advance()
            ty = this.mk_type(start, TOption(Box(ty)))
        }
        Ok(ty)
    }

    fun parse_type_primary(&mut this) -> Result[Type, Sync] {
        let start_tok = this.cur()
        let start = start_tok.span
        match start_tok.kind {
            "Ident" | "Self" => {
                var path = [if start_tok.kind == "Self" { "Self" } else { text_of(start_tok) }]
                let _ = this.advance()
                for this.at(".") && this.peek(1).kind == "Ident" {
                    let _ = this.advance()
                    path.push(text_of(this.advance()))
                }
                var args = [] as Vec[Type]
                if this.at("[") && !this.cur().ws_before {
                    args = this.parse_type_args()?
                } else if this.at("<") && !this.cur().ws_before {
                    args = this.parse_angle_args()?
                }
                Ok(this.mk_type(start, TName { path, args }))
            }
            "&" => {
                let _ = this.advance()
                let is_mut = this.eat("mut")
                let inner = this.parse_type_postfix()?
                Ok(this.mk_type(start, TRef { is_mut, inner: Box(inner) }))
            }
            "&&" => {
                // `&&T`: a borrow of a borrow
                let _ = this.advance()
                let inner = this.parse_type_postfix()?
                let inner_ref = this.mk_type(start, TRef { is_mut: false, inner: Box(inner) })
                Ok(this.mk_type(start, TRef { is_mut: false, inner: Box(inner_ref) }))
            }
            "*" => {
                let _ = this.advance()
                let is_mut = this.eat("mut")
                let inner = this.parse_type_postfix()?
                Ok(this.mk_type(start, TPtr { is_mut, inner: Box(inner) }))
            }
            "t(" => {
                let _ = this.advance()
                let saved = this.enter(false)
                let list = this.type_list(")")
                this.leave(saved)
                let elems = list?
                this.jump_to(this.closer_index(start_tok))
                let _ = this.expect(")")?
                Ok(this.mk_type(start, TTuple(elems)))
            }
            "r{" => {
                let m = this.parse_members(RecordTypeFields, "r{")?
                Ok(this.mk_type(start, TRecord(m.fields)))
            }
            "(" => {
                let _ = this.advance()
                let saved = this.enter(false)
                let list = this.type_list(")")
                this.leave(saved)
                let elems = list?
                this.jump_to(this.closer_index(start_tok))
                let _ = this.expect(")")?
                if this.at("->") {
                    let _ = this.advance()
                    let ret = this.parse_type(false, true)?
                    return Ok(this.mk_type(start, TFn { params: elems, ret: Box(ret) }))
                }
                if elems.len() == 1 {
                    return Ok(elems[0].clone())
                }
                this.report_at("E_BARE_TUPLE", "tuple types are written `t(A, B)`", start)
                Ok(this.mk_type(start, TTuple(elems)))
            }
            "TypeOf" => {
                let _ = this.advance()
                let open = this.expect("(")?
                let saved = this.enter(false)
                let name = this.dotted_name("a value path")
                this.leave(saved)
                let path = name?
                this.jump_to(this.closer_index(open))
                let _ = this.expect(")")?
                Ok(this.mk_type(start, TTypeOf(path)))
            }
            "String" => {
                let _ = this.advance()
                Ok(this.mk_type(start, TLiteral(LitStr(text_of(start_tok)))))
            }
            "Int" => {
                let _ = this.advance()
                Ok(this.mk_type(start, TLiteral(LitInt(text_of(start_tok)))))
            }
            "true" | "false" => {
                let _ = this.advance()
                Ok(this.mk_type(start, TLiteral(LitBool(start_tok.kind == "true"))))
            }
            _ => this.fail("E_UNEXPECTED_TOKEN", "expected a type, found ${describe(start_tok)}")
        }
    }

    fun type_list(&mut this, close: &str) -> Result[Vec[Type], Sync] {
        var types = [] as Vec[Type]
        for !this.at(close) && !this.at("EOF") {
            types.push(this.parse_type(false, true)?)
            if !this.eat(",") {
                break
            }
        }
        Ok(types)
    }

    /// `[A, B]` after a type name, or `.[A, B]` in an expression.
    fun parse_type_args(&mut this) -> Result[Vec[Type], Sync] {
        let open = this.advance()
        if this.at("]") {
            this.report("E_EXPECTED_TYPE_ARGUMENTS", "expected at least one type argument inside `[ ]`")
            let _ = this.advance()
            return Ok([])
        }
        let saved = this.enter(false)
        let list = this.type_list("]")
        this.leave(saved)
        let args = list?
        this.jump_to(this.closer_index(open))
        let _ = this.expect("]")?
        Ok(args)
    }

    /// Recovery for `Name<A, B>`: report once (outermost), then parse the arguments.
    fun parse_angle_args(&mut this) -> Result[Vec[Type], Sync] {
        let lt = this.advance()
        if this.angle_depth == 0 {
            this.report_at("E_ANGLE_GENERICS", "generic arguments use `[…]` in types and `.[…]` in expressions: `Vec[int]`, `f.[T](x)`", lt.span)
        }
        this.angle_depth += 1
        let r = this.angle_args_inner()
        this.angle_depth -= 1
        r
    }

    fun angle_args_inner(&mut this) -> Result[Vec[Type], Sync] {
        var args = [] as Vec[Type]
        for !this.gt_pending && !this.at(">") && !this.at(">>") && !this.at("EOF") {
            args.push(this.parse_type(false, true)?)
            if !this.eat(",") {
                break
            }
        }
        if !this.close_angle() {
            let found = describe(this.cur())
            return this.fail("E_UNEXPECTED_TOKEN", "expected `>`, found ${found}")
        }
        Ok(args)
    }

    fun close_angle(&mut this) -> bool {
        if this.gt_pending {
            this.gt_pending = false
            return true
        }
        if this.at(">") {
            let _ = this.advance()
            return true
        }
        if this.at(">>") {
            let _ = this.advance()
            this.gt_pending = true
            return true
        }
        false
    }
}

fun is_self(tok: &Token) -> bool {
    tok.kind == "Ident" && text_of(tok) == "self"
}

fun ends_param(tok: &Token) -> bool {
    tok.kind == "," || tok.kind == ")"
}
