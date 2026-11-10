package syntax

// The MinScript parser (spec §2–§8, grammar §19), ported from the TypeScript compiler's
// src/parser.ts: recursive descent for items, statements, types and patterns; Pratt parsing for
// expressions (precedence §3).
//
// Newlines are not tokens. The rules of §5.4 use each token's `nl` flag: `nl_sig` is true inside
// `{…}` and false inside `(…)` / `[…]`; where it is true, an infix operator on a new line ends the
// expression unless it is one of the continuation tokens. Postfix `(`, `[`, `.[` and `?` never
// cross a newline; `.` and `?.` always may.
//
// Errors: `report()` records a diagnostic where the intended form is clear and parsing goes on.
// Where the TypeScript parser throws (`fail()`), this one returns `None`, and `?` carries it to the
// nearest statement / item / member / arm / list element, which skips to the next one. Each
// mistake gives exactly one diagnostic.

pub type Parsed {
    pub file: File
    /// lexer diagnostics first, then parser diagnostics
    pub diagnostics: Vec[Diag]
}

pub fn parse(src: str) -> Parsed {
    lexed := lex(src)
    var p = Parser { toks: lexed.tokens, src }
    for d in lexed.diagnostics { p.reported.insert(d.start) }
    file := p.parse_file()
    var all = lexed.diagnostics
    all.extend(p.diags)
    Parsed { file, diagnostics: all }
}

/// The binding power and associativity of each infix operator (§3).
let INFIX = m{
    "=": t(1, "right"), "+=": t(1, "right"), "-=": t(1, "right"), "*=": t(1, "right"), "/=": t(1, "right"),
    "%=": t(1, "right"), "&=": t(1, "right"), "|=": t(1, "right"), "^=": t(1, "right"), "<<=": t(1, "right"),
    ">>=": t(1, "right"), "??=": t(1, "right"),
    "or": t(2, "left"),
    "..": t(3, "none"), "..=": t(3, "none"),
    "??": t(4, "right"),
    "||": t(5, "left"),
    "&&": t(6, "left"),
    "==": t(7, "none"), "!=": t(7, "none"), "<": t(7, "none"), "<=": t(7, "none"), ">": t(7, "none"), ">=": t(7, "none"),
    "|": t(8, "left"),
    "^": t(9, "left"),
    "&": t(10, "left"),
    "<<": t(11, "left"), ">>": t(11, "left"),
    "+": t(12, "left"), "-": t(12, "left"),
    "*": t(13, "left"), "/": t(13, "left"), "%": t(13, "left"),
    "as": t(14, "left"),
} as Map[str, t(int, str)]

let BP_ASSIGN = 1
let BP_OR = 2
let BP_RANGE = 3
let BP_COMPARE = 7

/// An infix token on a new line continues the expression only if it is one of these (§5.4 rule 2).
let CONTINUES = s{ ".", "?.", "&&", "||", "??", "or", "as" } as Set[str]

/// Tokens the closure-header scan accepts before `=>` (§4.4).
let CLOSURE_HEADER = s{ "Ident", "_", "var", "mut", ",", ":", "*", "&", "->", "?", ".", "Self" } as Set[str]

let ITEM_START = s{ "pub", "fn", "fun", "async", "type", "union", "inter", "impl", "let", "var", "extern", "import", "#[" } as Set[str]

fn is_upper(name: str) -> bool { name.len() > 0 && name.byte_at(0) >= b'A' && name.byte_at(0) <= b'Z' }

/// What `parse_item` produced: an item, nothing (a misplaced import), or a failure.
union ItemOut {
    Got(Item)
    Skip
    Fail
}

type Parser {
    toks: Vec[Token]
    src: str
    i: int = 0
    diags: Vec[Diag] = []
    /// newlines end expressions here (inside `{…}`, not inside `(…)` / `[…]`)
    nl_sig: bool = true
    /// in an `if` / `for` / `match` / `lock` header: `Name {` is not a struct literal
    no_struct: bool = false
    /// labels of the enclosing loops (closures start a new list)
    labels: Vec[str] = []
    imports: Vec[Import] = []
    /// start offsets already reported, so one mistake gives one diagnostic
    reported: Set[int] = s{}

    // ---- token helpers ------------------------------------------------------------------------

    fn tok(this) -> Token { this.toks[this.i] }

    fn peek(this, k: int) -> Token {
        n := this.toks.len() - 1
        this.toks[if this.i + k < n { this.i + k } else { n }]
    }

    fn at(this, kind: str) -> bool { this.toks[this.i].kind == kind }

    fn at_ident(this, name: str) -> bool {
        t := this.toks[this.i]
        t.kind == "Ident" && name_of(t) == name
    }

    fn advance(*this) -> Token {
        t := this.toks[this.i]
        if this.i < this.toks.len() - 1 { this.i += 1 }
        t
    }

    /// Consumes the current token and returns its name or text value.
    fn advance_name(*this) -> str { name_of(this.advance()) }

    fn eat(*this, kind: str) -> bool {
        if !this.at(kind) { return false }
        this.advance()
        true
    }

    fn text(this, t: Token) -> str {
        if t.kind == "Ident" { return name_of(t) }
        if t.kind == "EOF" { return "end of file" }
        s := this.src.substring(t.start, t.end)
        if s.is_empty() { t.kind } else { s }
    }

    fn describe(this, t: Token) -> str {
        if t.kind == "EOF" { "end of file" } else { "`${this.text(t)}`" }
    }

    /// The span from offset `start` to the end of the last consumed token.
    fn sp(this, start: int) -> Span {
        if this.i == 0 { return Span { start, end: start } }
        prev := this.toks[this.i - 1]
        Span { start, end: if prev.end > start { prev.end } else { start } }
    }

    fn report_at(*this, code: str, message: str, t: Token, fix: str?, end: int) {
        if t.synthetic || this.reported.has(t.start) { return }
        this.reported.insert(t.start)
        this.diags.push(Diag { code, message, start: t.start, end, fix })
    }

    fn report(*this, code: str, message: str) {
        t := this.tok()
        this.report_at(code, message, t, None, t.end)
    }

    fn report_tok(*this, code: str, message: str, t: Token, fix: str) {
        this.report_at(code, message, t, Some(fix), t.end)
    }

    /// A diagnostic that isn't tied to a token (not deduplicated).
    fn push_diag(*this, code: str, message: str, start: int, end: int, fix: str?) {
        this.diags.push(Diag { code, message, start, end, fix })
    }

    /// `expected <what>, found …`: reported; the caller then returns None.
    fn unexpected(*this, what: str) {
        message := "expected ${what}, found ${this.describe(this.tok())}"
        this.report("E_UNEXPECTED_TOKEN", message)
    }

    fn expect(*this, kind: str) -> Token? {
        if !this.at(kind) {
            this.unexpected("`${kind}`")
            return None
        }
        Some(this.advance())
    }

    fn expect_what(*this, kind: str, what: str) -> Token? {
        if !this.at(kind) {
            this.unexpected(what)
            return None
        }
        Some(this.advance())
    }

    /// Skips one token, or a whole bracket group.
    fn skip_one(*this) {
        t := this.tok()
        if t.closer > this.i { this.i = t.closer + 1 } else { this.advance() }
    }

    /// After a failed statement: skip to the next statement (`;`, a newline) before index `end`.
    fn sync_stmt(*this, end: int, start: int) {
        if this.i <= start && this.i < end { this.skip_one() }
        for this.i < end {
            if this.at(";") {
                this.advance()
                return
            }
            if this.tok().nl { return }
            this.skip_one()
        }
    }

    /// After a failed list element: skip to the next `,` (or newline, where newlines separate).
    fn sync_list(*this, end: int, start: int, newlines: bool) {
        if this.i <= start && this.i < end { this.skip_one() }
        for this.i < end {
            if this.at(",") { return }
            if newlines && this.tok().nl { return }
            this.skip_one()
        }
    }

    fn sync_item(*this, start: int) {
        if this.i <= start { this.skip_one() }
        for !this.at("EOF") {
            if this.tok().nl && (ITEM_START.has(this.tok().kind) || this.at_shared_var()) { return }
            this.skip_one()
        }
    }

    /// Runs `f` inside a bracket group: newline significance as given, struct literals allowed.
    fn group[T](*this, nl_sig: bool, f: (*Parser) -> T) -> T {
        saved_nl := this.nl_sig
        saved_ns := this.no_struct
        this.nl_sig = nl_sig
        this.no_struct = false
        r := f(this)
        this.nl_sig = saved_nl
        this.no_struct = saved_ns
        r
    }

    /// Runs `f` in an `if` / `for` / `match` / `lock` header.
    fn header[T](*this, f: (*Parser) -> T) -> T {
        saved := this.no_struct
        this.no_struct = true
        r := f(this)
        this.no_struct = saved
        r
    }

    /// Parses comma-separated elements up to the closer at index `close`, then consumes it. With
    /// `newlines`, a newline also separates elements, and so does plain juxtaposition when
    /// `juxtapose` says the next token starts an element (union variants, type members).
    fn list[T](*this, close: int, newlines: bool, item: (*Parser) -> T?, juxtapose: (Parser) -> bool) -> Vec[T] {
        var out = [] as Vec[T]
        for this.i < close {
            start := this.i
            match item(this) {
                Some(v) => out.push(v)
                None => {
                    this.sync_list(close, start, newlines)
                    if this.at(",") { this.advance() }
                    continue
                }
            }
            if this.i >= close { break }
            if this.eat(",") { continue }
            if newlines && this.tok().nl { continue }
            if juxtapose(this) { continue }
            message := "expected `,` or `${this.text(this.toks[close])}`, found ${this.describe(this.tok())}"
            this.report("E_UNEXPECTED_TOKEN", message)
            this.sync_list(close, this.i, newlines)
            this.eat(",")
        }
        this.i = close + 1
        out
    }

    /// The matching closer of the opener at the current position.
    fn close_of(this) -> int {
        t := this.tok()
        if t.closer >= 0 { t.closer } else { this.toks.len() - 1 }
    }

    fn at_shared_var(this) -> bool {
        this.at_ident("shared") && (this.peek(1).kind == "var" || this.peek(1).kind == "let")
    }

    // ---- names --------------------------------------------------------------------------------

    /// A binding name: an identifier; a keyword is reported and used as written.
    fn binding_name(*this, what: str) -> str? {
        t := this.tok()
        if t.kind == "Ident" {
            this.advance()
            return Some(name_of(t))
        }
        if KEYWORDS.has(t.kind) {
            this.report("E_KEYWORD_AS_IDENT", "`${t.kind}` is a keyword and can't be ${what}")
            this.advance()
            return Some(t.kind)
        }
        this.unexpected(what)
        None
    }

    /// A declared function or method name: keywords are allowed (§8.1, `pub fn yield`).
    fn fn_name(*this) -> str? {
        t := this.tok()
        if t.kind == "Ident" { return Some(this.advance_name()) }
        if KEYWORDS.has(t.kind) {
            this.advance()
            return Some(t.kind)
        }
        this.unexpected("a function name")
        None
    }

    // ---- file and items -----------------------------------------------------------------------

    fn parse_file(*this) -> File {
        start := this.tok().start
        var pkg = [] as Vec[str]
        if let None = this.parse_package(pkg) { this.sync_item(this.i) }
        for this.at("import") {
            s := this.i
            match this.parse_import() {
                Some(imp) => this.imports.push(imp)
                None => this.sync_item(s)
            }
        }
        var items = [] as Vec[Item]
        for !this.at("EOF") {
            s := this.i
            match this.parse_item_line() {
                Got(item) => items.push(item)
                Skip => {}
                Fail => this.sync_item(s)
            }
        }
        File { pkg, imports: this.imports, items, span: Span { start, end: this.tok().end } }
    }

    fn parse_package(*this, pkg: *Vec[str]) -> bool? {
        if !this.at("package") {
            this.unexpected("`package`")
            return None
        }
        this.advance()
        pkg.push(this.package_segment()?)
        for this.eat(".") { pkg.push(this.package_segment()?) }
        Some(true)
    }

    /// `package unsafe` is std.unsafe (§8.6): the one keyword that names a package.
    fn package_segment(*this) -> str? {
        if this.at("unsafe") {
            this.advance()
            return Some("unsafe")
        }
        this.binding_name("a package name")
    }

    /// An item, then the new line (or `;`) that must follow it.
    fn parse_item_line(*this) -> ItemOut {
        out := this.parse_item()
        if let Fail = out { return Fail }
        if !this.at("EOF") && !this.tok().nl && !this.at(";") {
            this.report("E_UNEXPECTED_TOKEN", "expected a new line after the item, found ${this.describe(this.tok())}")
            return Fail
        }
        this.eat(";")
        out
    }

    fn parse_import(*this) -> Import? {
        start := (this.expect("import")?).start
        is_pub := this.eat("pub")
        if !this.at("String") {
            this.unexpected("an import path string")
            return None
        }
        path := this.advance_name()
        var alias: str? = None
        if this.eat("as") { alias = Some(this.binding_name("an import alias")?) }
        Some(Import { is_pub, path, alias, span: this.sp(start) })
    }

    fn parse_attributes(*this) -> Vec[Attribute] {
        var attrs = [] as Vec[Attribute]
        for this.at("#[") {
            open := this.tok()
            close := this.close_of()
            this.advance()
            if let Some(a) = this.parse_attribute(open, close) { attrs.push(a) }
            this.i = close + 1
            if !this.tok().nl && !this.at("#[") {
                this.report_at("E_INVALID_ATTRIBUTE", "an attribute goes on its own line, before an item or member", open, None, this.toks[close].end)
            }
        }
        attrs
    }

    fn parse_attribute(*this, open: Token, close: int) -> Attribute? {
        if !this.at("Ident") {
            this.report("E_INVALID_ATTRIBUTE", "expected an attribute name")
            return None
        }
        name := this.advance_name()
        var args = [] as Vec[AttrArg]
        if this.at("(") {
            c := this.close_of()
            this.advance()
            args = this.group(false, #{ p: *Parser => p.list(c, false, #{ q: *Parser => q.parse_attr_arg() }, no_juxtapose) })
        }
        if this.i != close {
            this.report("E_INVALID_ATTRIBUTE", "malformed attribute: expected `]`")
            return None
        }
        this.i = close + 1
        Some(Attribute { name, args, span: this.sp(open.start) })
    }

    fn bad_attr_arg(*this) {
        this.report("E_INVALID_ATTRIBUTE", "attribute arguments are lists of paths: `keeps: [v, this.items]`")
    }

    fn parse_attr_arg(*this) -> AttrArg? {
        start := this.tok().start
        if !this.at("Ident") {
            this.bad_attr_arg()
            return None
        }
        name := this.advance_name()
        if !this.eat(":") || !this.at("[") {
            this.bad_attr_arg()
            return None
        }
        c := this.close_of()
        this.advance()
        paths := this.list(c, false, #{ p: *Parser => p.parse_attr_path() }, no_juxtapose)
        Some(AttrArg { name, paths, span: this.sp(start) })
    }

    fn parse_attr_path(*this) -> str? {
        if !this.at("this") && !this.at("Ident") {
            this.bad_attr_arg()
            return None
        }
        var parts = [if this.at("this") { this.advance(); "this" } else { this.advance_name() }] as Vec[str]
        for this.eat(".") {
            if !this.at("Ident") {
                this.bad_attr_arg()
                return None
            }
            parts.push(this.advance_name())
        }
        Some(parts.join("."))
    }

    fn parse_item(*this) -> ItemOut {
        attrs := this.parse_attributes()
        start := this.tok().start
        is_pub := this.eat("pub")
        t := this.tok()
        let r: Item? = match t.kind {
            "fn" | "fun" | "async" => {
                f := this.parse_fn(attrs, is_pub, start, true)
                f.map(#{ d => Item { k: IFn(d), span: d.span } })
            }
            "type" => this.parse_type_decl(attrs, is_pub, start)
            "union" => this.parse_union(attrs, is_pub, start)
            "inter" => this.parse_inter(attrs, is_pub, start)
            "impl" => this.parse_impl(attrs, start)
            "let" => this.parse_top_let(attrs, is_pub, start)
            "var" => this.parse_top_var(attrs, is_pub, false, start)
            "extern" => this.parse_extern(attrs, start)
            "import" => {
                this.report("E_IMPORT_AFTER_ITEM", "imports go before the first item")
                let Some(imp) = this.parse_import() else { return Fail }
                this.imports.push(imp)
                return Skip
            }
            _ => {
                if this.at_shared_var() {
                    this.advance()
                    if this.at("let") {
                        this.report_tok("E_SHARED_IMMUTABLE", "`shared let`: immutable values are already shared", t, "shared var")
                        this.parse_top_let(attrs, is_pub, start)
                    } else {
                        this.parse_top_var(attrs, is_pub, true, start)
                    }
                } else {
                    if RESERVED_KEYWORDS.has(t.kind) {
                        this.report("E_RESERVED_KEYWORD", "`${t.kind}` is reserved")
                    } else {
                        this.report("E_TOP_LEVEL_STATEMENT", "only declarations are allowed at the top level")
                    }
                    None
                }
            }
        }
        match r {
            Some(item) => Got(item)
            None => Fail
        }
    }

    fn parse_top_let(*this, attrs: Vec[Attribute], is_pub: bool, start: int) -> Item? {
        this.expect("let")?
        name := this.binding_name("a name")?
        var ty: Type? = None
        if this.eat(":") { ty = Some(this.parse_type()?) }
        this.expect_assign()?
        value := this.parse_expr(0)?
        span := this.sp(start)
        Some(Item { k: LetDecl { attrs, is_pub, name, ty, value }, span })
    }

    fn parse_top_var(*this, attrs: Vec[Attribute], is_pub: bool, shared: bool, start: int) -> Item? {
        this.expect("var")?
        name := this.binding_name("a name")?
        var ty: Type? = None
        if this.eat(":") { ty = Some(this.parse_type()?) }
        this.expect_assign()?
        value := this.parse_expr(0)?
        span := this.sp(start)
        Some(Item { k: VarDecl { attrs, is_pub, shared, name, ty, value }, span })
    }

    fn expect_assign(*this) -> bool? {
        if this.at(":=") || this.at(":==") {
            this.report_tok("E_SHORT_DECL_TARGET", "`let x :=` mixes two forms: write `let x =` or `x :=`", this.tok(), "=")
            this.advance()
            return Some(true)
        }
        this.expect("=")?
        Some(true)
    }

    /// `[async] fn name[G](params) -> R { body }`. `item`: a body is required (else a signature).
    fn parse_fn(*this, attrs: Vec[Attribute], is_pub: bool, start: int, item: bool) -> FnDecl? {
        is_async := this.eat("async")
        if this.at("fun") {
            this.report_tok("E_RESERVED_KEYWORD", "`fun` is now `fn`", this.tok(), "fn")
        } else if !this.at("fn") {
            this.unexpected("`fn`")
            return None
        }
        this.advance()
        name := this.fn_name()?
        generics := this.parse_generic_params()?
        if !this.at("(") {
            this.unexpected("`(`")
            return None
        }
        let t(receiver, params) = this.parse_params()?
        var ret_star = false
        var ret: Type? = None
        if this.eat("->") {
            if this.at("*") {
                this.advance()
                ret_star = true
            }
            ret = Some(this.parse_type()?)
        }
        var body: Block? = None
        if this.at("{") {
            body = Some(this.parse_block(true)?)
        } else if item {
            this.unexpected("`{`")
            return None
        }
        Some(FnDecl { attrs, is_pub, is_async, name, generics, receiver, params, ret_star, ret, body, span: this.sp(start) })
    }

    fn parse_generic_params(*this) -> Vec[GenericParam]? {
        if !this.at("[") || this.tok().ws { return Some([]) }
        close := this.close_of()
        if close == this.i + 1 {
            this.report("E_EXPECTED_TYPE_ARGUMENTS", "empty generic parameter list")
            this.i = close + 1
            return Some([])
        }
        this.advance()
        Some(this.group(false, #{ p: *Parser => p.list(close, false, #{ q: *Parser => q.parse_generic_param() }, no_juxtapose) }))
    }

    fn parse_generic_param(*this) -> GenericParam? {
        start := this.tok().start
        name := name_of(this.expect_what("Ident", "a type parameter")?)
        var bounds = [] as Vec[Type]
        if this.eat(":") {
            bounds.push(this.parse_postfix_type()?)
            for this.eat("&") { bounds.push(this.parse_postfix_type()?) }
        }
        Some(GenericParam { name, bounds, span: this.sp(start) })
    }

    fn parse_params(*this) -> t(str?, Vec[Param])? {
        close := this.close_of()
        this.advance()
        var receiver: str? = None
        var first = true
        var params = [] as Vec[Param]
        this.group(false, #{ p: *Parser =>
            p.list(close, false, #{ q: *Parser =>
                was_first := first
                first = false
                if was_first {
                    if let Some(r) = q.try_receiver() {
                        receiver = Some(r)
                        return Some(true)
                    }
                }
                params.push(q.parse_param()?)
                Some(true)
            }, no_juxtapose)
        })
        for k in 0..params.len() - 1 {
            pa := params[k]
            if pa.variadic { this.push_diag("E_VARIADIC_NOT_LAST", "a variadic parameter must be the last one", pa.span.start, pa.span.end, None) }
        }
        Some(t(receiver, params))
    }

    /// `this`, `*this`, and the removed `&this`, `&mut this`, `mut this`, `self`.
    fn try_receiver(*this) -> str? {
        t := this.tok()
        next := this.peek(1)
        if t.kind == "this" {
            this.advance()
            return Some("this")
        }
        if is_self(t) && next.kind != ":" {
            this.report_tok("E_UNKNOWN_RECEIVER", "the receiver is `this`", t, "this")
            this.advance()
            return Some("this")
        }
        if t.kind == "*" && (next.kind == "this" || is_self(next)) {
            if is_self(next) { this.report_tok("E_UNKNOWN_RECEIVER", "the receiver is `*this`", next, "*this") }
            this.i += 2
            return Some("*this")
        }
        if t.kind == "mut" && next.kind == "this" {
            this.report_tok("E_MUT_REMOVED", "`mut this` is removed", t, "*this")
            this.i += 2
            return Some("*this")
        }
        if t.kind == "&" {
            is_mut := next.kind == "mut"
            target := this.peek(if is_mut { 2 } else { 1 })
            if target.kind == "this" || is_self(target) {
                this.report_tok("E_BORROW_REMOVED", "`&${if is_mut { "mut " } else { "" }}this` is removed", t, if is_mut { "*this" } else { "this" })
                this.i += if is_mut { 3 } else { 2 }
                return Some(if is_mut { "*this" } else { "this" })
            }
        }
        None
    }

    fn parse_param(*this) -> Param? {
        start := this.tok().start
        variadic := this.eat("...")
        if this.at("mut") {
            this.report_tok("E_MUT_REMOVED", "`mut` parameters are removed: use `x: *T`, or `var x = x` in the body", this.tok(), "*T")
            this.advance()
        }
        if this.at("&") || this.at("*") {
            this.report("E_INVALID_PARAM", "a parameter is `name: T` or `name: *T`")
            return None
        }
        name := this.binding_name("a parameter name")?
        if !this.at(":") {
            this.report("E_EXPECTED_COLON", "parameter `${name}` needs a type: `${name}: T`")
            return None
        }
        this.advance()
        mt := this.parse_mode_type()?
        Some(Param { name, star: mt.star, variadic, ty: mt.ty, span: this.sp(start) })
    }

    /// `T` or `*T`, as in a parameter; `&T` / `&mut T` are reported (§8.3).
    fn parse_mode_type(*this) -> ModeType? {
        if this.at("*") {
            this.advance()
            return Some(ModeType { star: true, ty: this.parse_type()? })
        }
        if this.at("&") {
            amp := this.advance()
            is_mut := this.eat("mut")
            message := "`&${if is_mut { "mut " } else { "" }}T` is removed: a parameter is `T` (read) or `*T` (write)"
            this.report_tok("E_BORROW_REMOVED", message, amp, if is_mut { "*T" } else { "T" })
            return Some(ModeType { star: is_mut, ty: this.parse_type()? })
        }
        Some(ModeType { star: false, ty: this.parse_type()? })
    }

    fn parse_impl_list(*this) -> Vec[Type]? {
        var out = [] as Vec[Type]
        if !this.eat(":") { return Some(out) }
        out.push(this.parse_postfix_type()?)
        for this.eat(",") { out.push(this.parse_postfix_type()?) }
        Some(out)
    }

    /// After `type` and the header: `{`, or `=` and an alias (§7.4).
    fn parse_type_decl(*this, attrs: Vec[Attribute], is_pub: bool, start: int) -> Item? {
        this.expect("type")?
        name := this.binding_name("a type name")?
        generics := this.parse_generic_params()?
        impls := this.parse_impl_list()?
        if this.at("=") {
            eq := this.advance()
            if this.at("{") {
                this.report_tok("E_TYPE_EQUALS_BODY", "a nominal type has no `=` before its body", eq, "remove `=`")
            } else if this.at("|") {
                this.report_tok("E_LEADING_PIPE_UNION", "`type X = | A | B` is now a union", eq, "union ${name} { A  B }")
                var members = [] as Vec[UnionMember]
                for this.eat("|") { members.push(UVariant(this.parse_variant()?)) }
                return Some(Item { k: UnionDecl { attrs, is_pub, name, generics, impls, members }, span: this.sp(start) })
            } else {
                alias := this.parse_type()?
                return Some(Item { k: TypeDecl { attrs, is_pub, name, generics, impls, members: None, alias: Some(alias) }, span: this.sp(start) })
            }
        }
        if !this.at("{") {
            this.unexpected("`{` or `=`")
            return None
        }
        members := this.parse_members()
        Some(Item { k: TypeDecl { attrs, is_pub, name, generics, impls, members: Some(members), alias: None }, span: this.sp(start) })
    }

    fn brace_on_header_line(*this) {
        if this.at("{") && this.tok().nl { this.report("E_OPEN_BRACE_NEWLINE", "`{` goes on the header line") }
    }

    fn parse_members(*this) -> Vec[Member] {
        this.brace_on_header_line()
        close := this.close_of()
        this.advance()
        this.group(true, #{ p: *Parser => p.list(close, true, #{ q: *Parser => q.parse_member() }, member_start) })
    }

    fn parse_member(*this) -> Member? {
        attrs := this.parse_attributes()
        start := this.tok().start
        is_pub := this.eat("pub")
        if this.at("fn") || this.at("fun") || this.at("async") { return Some(MFn(this.parse_fn(attrs, is_pub, start, true)?)) }
        Some(MField(this.parse_field(attrs, is_pub, start)?))
    }

    fn parse_field(*this, attrs: Vec[Attribute], is_pub: bool, start: int) -> FieldDecl? {
        var mode: str? = None
        if (this.at_ident("shared") || this.at_ident("once")) && this.peek(1).kind == "Ident" && this.peek(2).kind == ":" {
            mode = Some(this.advance_name())
        } else if this.at("mut") {
            this.report("E_MUT_REMOVED", "fields have no `mut`: use `shared` for a field every copy sees")
            this.advance()
        }
        name := this.binding_name("a field name")?
        if !this.at(":") {
            this.report("E_EXPECTED_COLON", "field `${name}` needs a type: `${name}: T`")
            return None
        }
        this.advance()
        if this.at("*") { this.report_tok("E_STAR_TYPE_NOT_PARAM", "`*T` is an access mode for parameters, not a field type", this.tok(), "remove `*`") }
        ty := this.parse_type()?
        var default: Expr? = None
        if this.eat("=") { default = Some(this.parse_expr(0)?) }
        Some(FieldDecl { attrs, is_pub, mode, name, ty, default, span: this.sp(start) })
    }

    fn parse_union(*this, attrs: Vec[Attribute], is_pub: bool, start: int) -> Item? {
        this.expect("union")?
        name := this.binding_name("a union name")?
        generics := this.parse_generic_params()?
        impls := this.parse_impl_list()?
        if this.at("=") {
            eq := this.advance()
            this.report_tok("E_TYPE_EQUALS_BODY", "a union has no `=` before its body", eq, "remove `=`")
        }
        if !this.at("{") {
            this.unexpected("`{`")
            return None
        }
        this.brace_on_header_line()
        close := this.close_of()
        this.advance()
        members := this.group(true, #{ p: *Parser => p.list(close, true, #{ q: *Parser => q.parse_union_member() }, member_start) })
        Some(Item { k: UnionDecl { attrs, is_pub, name, generics, impls, members }, span: this.sp(start) })
    }

    fn parse_union_member(*this) -> UnionMember? {
        attrs := this.parse_attributes()
        s := this.tok().start
        is_pub := this.eat("pub")
        if this.at("fn") || this.at("fun") || this.at("async") { return Some(UFn(this.parse_fn(attrs, is_pub, s, true)?)) }
        Some(UVariant(this.parse_variant()?))
    }

    fn parse_variant(*this) -> Variant? {
        start := this.tok().start
        name := this.binding_name("a variant name")?
        var tuple: Vec[Type]? = None
        var fields: Vec[FieldDecl]? = None
        if this.at("(") && !this.tok().nl {
            close := this.close_of()
            this.advance()
            tuple = Some(this.group(false, #{ p: *Parser => p.list(close, false, #{ q: *Parser => q.parse_type() }, no_juxtapose) }))
        } else if this.at("{") && !this.tok().nl {
            close := this.close_of()
            this.advance()
            fields = Some(this.group(true, #{ p: *Parser =>
                p.list(close, true, #{ q: *Parser => q.parse_field([], false, q.tok().start) }, #{ q => q.tok().kind == "Ident" })
            }))
        }
        Some(Variant { name, tuple, fields, span: this.sp(start) })
    }

    fn parse_inter(*this, attrs: Vec[Attribute], is_pub: bool, start: int) -> Item? {
        this.expect("inter")?
        name := this.binding_name("an interface name")?
        generics := this.parse_generic_params()?
        var supers = [] as Vec[Type]
        if this.eat(":") {
            supers.push(this.parse_postfix_type()?)
            for this.eat("&") || this.eat(",") { supers.push(this.parse_postfix_type()?) }
        }
        if this.at("=") {
            eq := this.advance()
            if this.at("{") {
                this.report_tok("E_TYPE_EQUALS_BODY", "an interface has no `=` before its body", eq, "remove `=`")
            } else {
                alias := this.parse_intersection_type()?
                return Some(Item { k: InterDecl { attrs, is_pub, name, generics, supers, methods: None, alias: Some(alias) }, span: this.sp(start) })
            }
        }
        if !this.at("{") {
            this.unexpected("`{` or `=`")
            return None
        }
        this.brace_on_header_line()
        close := this.close_of()
        this.advance()
        methods := this.group(true, #{ p: *Parser => p.list(close, true, #{ q: *Parser => q.parse_method(false) }, member_start) })
        Some(Item { k: InterDecl { attrs, is_pub, name, generics, supers, methods: Some(methods), alias: None }, span: this.sp(start) })
    }

    /// A method of an `impl` (`item`: with a body) or a signature of an `inter` / `extern`.
    fn parse_method(*this, item: bool) -> FnDecl? {
        attrs := this.parse_attributes()
        s := this.tok().start
        is_pub := this.eat("pub")
        this.parse_fn(attrs, is_pub, s, item)
    }

    fn parse_impl(*this, attrs: Vec[Attribute], start: int) -> Item? {
        this.expect("impl")?
        var generics = [] as Vec[GenericParam]
        if this.at("[") && !this.tok().ws { generics = this.parse_generic_params()? }
        var first = this.parse_postfix_type()?
        var inters = [] as Vec[Type]
        if this.at(",") || this.at("for") {
            inters.push(first)
            for this.eat(",") { inters.push(this.parse_postfix_type()?) }
            this.expect("for")?
            first = this.parse_postfix_type()?
        }
        if !this.at("{") {
            this.unexpected("`{`")
            return None
        }
        this.brace_on_header_line()
        close := this.close_of()
        this.advance()
        methods := this.group(true, #{ p: *Parser => p.list(close, true, #{ q: *Parser => q.parse_method(true) }, member_start) })
        Some(Item { k: ImplDecl { attrs, generics, inters, target: first, methods }, span: this.sp(start) })
    }

    fn parse_extern(*this, attrs: Vec[Attribute], start: int) -> Item? {
        this.expect("extern")?
        if !this.at("String") {
            this.unexpected("an ABI string such as \"C\"")
            return None
        }
        abi := this.advance_name()
        if !this.at("{") {
            this.unexpected("`{`")
            return None
        }
        close := this.close_of()
        this.advance()
        fns := this.group(true, #{ p: *Parser => p.list(close, true, #{ q: *Parser => q.parse_method(false) }, member_start) })
        Some(Item { k: ExternDecl { attrs, abi, fns }, span: this.sp(start) })
    }

    // ---- types (§7.1) -------------------------------------------------------------------------

    /// A full type: literal unions and intersections.
    fn parse_type(*this) -> Type? {
        start := this.tok().start
        first := this.parse_intersection_type()?
        if !this.at("|") { return Some(first) }
        var alts = [first] as Vec[Type]
        for this.eat("|") { alts.push(this.parse_intersection_type()?) }
        Some(Type { k: TUnion { alts }, span: this.sp(start) })
    }

    fn parse_intersection_type(*this) -> Type? {
        start := this.tok().start
        first := this.parse_postfix_type()?
        if !this.at("&") { return Some(first) }
        var parts = [first] as Vec[Type]
        for this.eat("&") { parts.push(this.parse_postfix_type()?) }
        Some(Type { k: TInter { parts }, span: this.sp(start) })
    }

    fn parse_postfix_type(*this) -> Type? {
        start := this.tok().start
        var ty = this.parse_primary_type()?
        if this.at("?") && !this.tok().nl {
            this.advance()
            ty = Type { k: TOptional { inner: ty }, span: this.sp(start) }
            if this.at("?") && !this.tok().nl {
                this.report("E_UNEXPECTED_TOKEN", "`T??` is not a type: an optional can't be optional")
                this.advance()
            }
        }
        Some(ty)
    }

    fn parse_primary_type(*this) -> Type? {
        t := this.tok()
        start := t.start
        match t.kind {
            "*" => {
                this.report_tok("E_STAR_TYPE_NOT_PARAM", "`*T` is only allowed on parameters, receivers and return types", t, "remove `*`")
                this.advance()
                return this.parse_primary_type()
            }
            "&" => {
                this.advance()
                is_mut := this.eat("mut")
                this.report_tok("E_BORROW_REMOVED", "`&${if is_mut { "mut " } else { "" }}T` is removed", t, if is_mut { "*T on a parameter" } else { "T" })
                return this.parse_postfix_type()
            }
            "Ident" | "Self" => return this.parse_named_type()
            "unsafe" => if this.peek(1).kind == "." { return this.parse_named_type() }
            "t(" => {
                close := this.close_of()
                this.advance()
                elems := this.group(false, #{ p: *Parser => p.list(close, false, #{ q: *Parser => q.parse_type() }, no_juxtapose) })
                return Some(Type { k: TTuple { elems }, span: this.sp(start) })
            }
            "r{" => {
                close := this.close_of()
                this.advance()
                fields := this.group(true, #{ p: *Parser =>
                    p.list(close, true, #{ q: *Parser => q.parse_record_type_field() }, #{ q => q.tok().kind == "Ident" })
                })
                return Some(Type { k: TRecord { fields }, span: this.sp(start) })
            }
            "(" => {
                close := this.close_of()
                if close + 1 < this.toks.len() && this.toks[close + 1].kind == "->" {
                    this.advance()
                    params := this.group(false, #{ p: *Parser => p.list(close, false, #{ q: *Parser => q.parse_mode_type() }, no_juxtapose) })
                    this.expect("->")?
                    ret := this.parse_type()?
                    return Some(Type { k: TFn { params, ret }, span: this.sp(start) })
                }
                this.advance()
                elems := this.group(false, #{ p: *Parser => p.list(close, false, #{ q: *Parser => q.parse_type() }, no_juxtapose) })
                if elems.len() == 1 && this.toks[close - 1].kind != "," { return Some(elems[0]) }
                this.push_diag("E_BARE_TUPLE", "a tuple type is written `t(A, B)`", start, this.sp(start).end, Some("t(…)"))
                return Some(Type { k: TTuple { elems }, span: this.sp(start) })
            }
            "TypeOf" => {
                this.advance()
                if !this.at("(") {
                    this.unexpected("`(`")
                    return None
                }
                close := this.close_of()
                this.advance()
                var path = [this.binding_name("a value path")?] as Vec[str]
                for this.eat(".") { path.push(this.binding_name("a field name")?) }
                if this.i != close {
                    this.unexpected("`)`")
                    return None
                }
                this.advance()
                return Some(Type { k: TTypeOf { path }, span: this.sp(start) })
            }
            "String" => {
                this.advance()
                return Some(Type { k: TLit { value: LStr(name_of(t)) }, span: this.sp(start) })
            }
            "Int" => {
                this.advance()
                return Some(Type { k: TLit { value: LInt(name_of(t)) }, span: this.sp(start) })
            }
            "true" | "false" => {
                this.advance()
                return Some(Type { k: TLit { value: LBool(t.kind == "true") }, span: this.sp(start) })
            }
            "fn" | "fun" => {
                this.report("E_UNEXPECTED_TOKEN", "a function type is written `(T) -> R`")
                return None
            }
            _ => {}
        }
        this.unexpected("a type")
        None
    }

    fn parse_record_type_field(*this) -> TField? {
        s := this.tok().start
        name := this.binding_name("a field name")?
        this.expect(":")?
        ty := this.parse_type()?
        Some(TField { name, ty, span: this.sp(s) })
    }

    fn parse_named_type(*this) -> Type? {
        start := this.tok().start
        first := this.advance()
        var path = [if first.kind == "Ident" { name_of(first) } else { first.kind }] as Vec[str]
        for this.at(".") && this.peek(1).kind == "Ident" {
            this.advance()
            path.push(this.advance_name())
        }
        var args = [] as Vec[Type]
        if this.at("[") && !this.tok().ws {
            close := this.close_of()
            if close == this.i + 1 {
                this.report("E_EXPECTED_TYPE_ARGUMENTS", "empty type argument list")
                this.i = close + 1
            } else {
                this.advance()
                args = this.group(false, #{ p: *Parser => p.list(close, false, #{ q: *Parser => q.parse_type() }, no_juxtapose) })
            }
        } else if this.at("<") && !this.tok().ws {
            lt := this.tok()
            this.advance()
            args = this.parse_angle_args()?
            this.report_tok("E_ANGLE_GENERICS", "generics use `[…]`", lt, "${path.join(".")}[…]")
        }
        Some(Type { k: TName { path, args }, span: this.sp(start) })
    }

    /// After `<` of the removed angle-bracket generics: types up to the matching `>`.
    fn parse_angle_args(*this) -> Vec[Type]? {
        var args = [] as Vec[Type]
        for {
            args.push(this.parse_type()?)
            if !this.eat(",") { break }
        }
        this.eat_angle_close()?
        Some(args)
    }

    fn eat_angle_close(*this) -> bool? {
        t := this.tok()
        if t.kind == ">" {
            this.advance()
        } else if t.kind == ">>" || t.kind == ">=" || t.kind == ">>=" {
            // split the token: consume its first `>`
            this.toks[this.i] = Token { ...t, kind: t.kind.substring(1, t.kind.len()), start: t.start + 1, ws: false, nl: false }
        } else {
            this.unexpected("`>`")
            return None
        }
        Some(true)
    }

    // ---- blocks and statements ----------------------------------------------------------------

    /// `{ stmts }`. `header_line`: the `{` of a declaration or control flow (§5.4 rule 7).
    fn parse_block(*this, header_line: bool) -> Block? {
        if !this.at("{") {
            this.unexpected("`{`")
            return None
        }
        if header_line { this.brace_on_header_line() }
        start := this.tok().start
        close := this.close_of()
        this.advance()
        stmts := this.group(true, #{ p: *Parser => p.parse_stmts(close) })
        this.i = close + 1
        Some(Block { stmts, span: this.sp(start) })
    }

    fn parse_stmts(*this, end: int) -> Vec[Stmt] {
        var stmts = [] as Vec[Stmt]
        for this.i < end {
            start := this.i
            if this.eat(";") { continue }
            match this.parse_stmt(end) {
                Some(s) => stmts.push(s)
                None => this.sync_stmt(end, start)
            }
        }
        stmts
    }

    fn parse_stmt(*this, end: int) -> Stmt? {
        t := this.tok()
        start := t.start
        var stmt = if t.kind == "let" {
            this.parse_let(start)?
        } else if t.kind == "var" {
            this.parse_var(start, false)?
        } else if this.at_shared_var() {
            sh := this.advance()
            if this.at("let") {
                this.report_tok("E_SHARED_IMMUTABLE", "`shared let`: immutable values are already shared", sh, "shared var")
                this.parse_let(start)?
            } else {
                this.parse_var(start, true)?
            }
        } else if t.kind == "Ident" && (this.peek(1).kind == ":=" || this.peek(1).kind == ":==") {
            name := this.advance_name()
            mutable := this.advance().kind == ":=="
            value := this.parse_expr(0)?
            Stmt { k: ShortDecl { name, mutable, value }, span: this.sp(start) }
        } else {
            if t.kind == "fn" || t.kind == "type" || t.kind == "union" || t.kind == "inter" || t.kind == "impl" || t.kind == "import" {
                if t.kind != "fn" || this.peek(1).kind != "(" {
                    this.report("E_UNEXPECTED_TOKEN", "`${t.kind}` declarations are only allowed at the top level")
                    return None
                }
            }
            this.expr_stmt(start)?
        }
        if this.at(";") {
            this.advance()
            if let ExprStmt { expr, .. } = stmt.k { stmt = Stmt { k: ExprStmt { expr, semi: true }, span: stmt.span } }
        } else if this.i < end && !this.tok().nl {
            this.report("E_UNEXPECTED_TOKEN", "expected a new line or `;` before ${this.describe(this.tok())}")
            return None
        }
        Some(stmt)
    }

    fn expr_stmt(*this, start: int) -> Stmt? {
        expr := this.parse_expr(0)?
        Some(Stmt { k: ExprStmt { expr, semi: false }, span: this.sp(start) })
    }

    fn parse_let(*this, start: int) -> Stmt? {
        this.expect("let")?
        pattern := this.parse_pattern()?
        var ty: Type? = None
        if this.eat(":") { ty = Some(this.parse_type()?) }
        this.expect_assign()?
        value := this.parse_expr(0)?
        var els: Block? = None
        if this.at("else") {
            this.advance()
            els = Some(this.parse_block(true)?)
        }
        Some(Stmt { k: LetStmt { pattern, ty, value, els }, span: this.sp(start) })
    }

    fn parse_var(*this, start: int, shared: bool) -> Stmt? {
        this.expect("var")?
        if !this.at("Ident") && !KEYWORDS.has(this.tok().kind) {
            this.report("E_UNEXPECTED_TOKEN", "`var` takes a name; destructure with `let t(var a, b) = …`")
            return None
        }
        name := this.binding_name("a name")?
        var ty: Type? = None
        if this.eat(":") { ty = Some(this.parse_type()?) }
        this.expect_assign()?
        value := this.parse_expr(0)?
        Some(Stmt { k: VarStmt { shared, name, ty, value }, span: this.sp(start) })
    }

    // ---- expressions (§3, §4) -----------------------------------------------------------------

    fn parse_expr(*this, min_bp: int) -> Expr? {
        start := this.tok().start
        var left = this.parse_unary()?
        for {
            t := this.tok()
            if t.nl && this.nl_sig && !CONTINUES.has(t.kind) { break }
            if t.kind == ":=" || t.kind == ":==" {
                if min_bp > BP_ASSIGN { break }
                this.report("E_SHORT_DECL_TARGET", "`:=` declares a plain name: use `=` to assign, or `let` to destructure")
                this.advance()
                value := this.parse_expr(BP_ASSIGN)?
                left = Expr { k: Assign { op: "=", target: left, value }, span: this.sp(start) }
                continue
            }
            if (t.kind == "++" || t.kind == "--") && !t.nl {
                this.report_tok("E_RESERVED_OPERATOR", "`${t.kind}` is not an operator", t, if t.kind == "++" { "+= 1" } else { "-= 1" })
                this.advance()
                continue
            }
            let Some(info) = INFIX.get(t.kind) else { break }
            let t(bp, assoc) = info
            if bp < min_bp { break }
            this.advance()
            if t.kind == "as" {
                ty := this.parse_postfix_type()?
                left = Expr { k: As { expr: left, ty }, span: this.sp(start) }
                continue
            }
            if t.kind == "or" {
                var name: str? = None
                if this.at("Ident") && this.peek(1).kind == "=>" {
                    name = Some(this.advance_name())
                    this.advance()
                }
                rhs := this.parse_expr(BP_OR + 1)?
                left = Expr { k: Or { expr: left, name, rhs }, span: this.sp(start) }
                continue
            }
            if t.kind == ".." || t.kind == "..=" {
                if is_range(left) { this.report_at("E_NON_ASSOCIATIVE_OPERATOR", "ranges can't be chained", t, None, t.end) }
                var end: Expr? = None
                if this.can_start_operand() { end = Some(this.parse_expr(BP_RANGE + 1)?) }
                left = Expr { k: Range { inclusive: t.kind == "..=", start: Some(left), end }, span: this.sp(start) }
                continue
            }
            right := this.parse_expr(if assoc == "right" { bp } else { bp + 1 })?
            if bp == BP_ASSIGN {
                if !is_place(left) {
                    this.push_diag("E_INVALID_ASSIGNMENT_TARGET", "the left side of an assignment must be a name, field or index", left.span.start, left.span.end, None)
                }
                left = Expr { k: Assign { op: t.kind, target: left, value: right }, span: this.sp(start) }
                continue
            }
            if bp == BP_COMPARE && is_comparison(left) {
                this.report_at("E_NON_ASSOCIATIVE_OPERATOR", "`${t.kind}` can't be chained: add parentheses", t, None, t.end)
            }
            nullish_mix := (t.kind == "??" && (is_logical(left) || is_logical(right))) || ((t.kind == "&&" || t.kind == "||") && (is_nullish(left) || is_nullish(right)))
            if nullish_mix {
                this.report_at("E_MIXED_NULLISH", "`??` can't be mixed with `&&` / `||` without parentheses", t, None, t.end)
            }
            left = Expr { k: Binary { op: t.kind, left, right }, span: this.sp(start) }
        }
        Some(left)
    }

    /// Whether the current token can start the operand of an open-ended range (`a..`).
    fn can_start_operand(this) -> bool {
        t := this.tok()
        if t.nl && this.nl_sig { return false }
        match t.kind {
            ")" | "]" | "}" | "," | ";" | "{" | "=>" | "EOF" | "or" | "else" => false
            _ => !INFIX.has(t.kind) || t.kind == "-" || t.kind == "&" || t.kind == "*"
        }
    }

    fn parse_unary(*this) -> Expr? {
        t := this.tok()
        start := t.start
        match t.kind {
            "-" | "!" => {
                this.advance()
                operand := this.parse_unary()?
                return Some(Expr { k: Unary { op: t.kind, operand }, span: this.sp(start) })
            }
            "~" => {
                this.report_tok("E_RESERVED_OPERATOR", "`~` is not an operator: bitwise-not is `!`", t, "!")
                this.advance()
                operand := this.parse_unary()?
                return Some(Expr { k: Unary { op: "!", operand }, span: this.sp(start) })
            }
            "++" | "--" => {
                this.report_tok("E_RESERVED_OPERATOR", "`${t.kind}` is not an operator", t, if t.kind == "++" { "+= 1" } else { "-= 1" })
                this.advance()
                return this.parse_unary()
            }
            "&" | "*" => {
                this.advance()
                if t.kind == "&" { this.eat("mut") }
                this.report_tok("E_BORROW_REMOVED", "prefix `${t.kind}` is removed: v0.4 has no borrow or dereference operator", t, "drop it")
                return this.parse_unary()
            }
            "await" => {
                this.advance()
                primary := this.parse_primary()?
                operand := this.parse_postfix(primary, true)?
                node := Expr { k: Await { operand }, span: this.sp(start) }
                return this.parse_postfix(node, false)
            }
            ".." | "..=" => {
                this.advance()
                var end: Expr? = None
                if this.can_start_operand() { end = Some(this.parse_expr(BP_RANGE + 1)?) }
                return Some(Expr { k: Range { inclusive: t.kind == "..=", start: None, end }, span: this.sp(start) })
            }
            _ => {}
        }
        primary := this.parse_primary()?
        this.parse_postfix(primary, false)
    }

    fn member_name(*this) -> str? {
        n := this.tok()
        if n.kind != "Ident" && n.kind != "Int" {
            this.unexpected("a field or method name")
            return None
        }
        this.advance()
        Some(name_of(n))
    }

    fn parse_postfix(*this, first: Expr, stop_at_try: bool) -> Expr? {
        var expr = first
        start := expr.span.start
        for {
            t := this.tok()
            match t.kind {
                "." => {
                    this.advance()
                    name := this.member_name()?
                    expr = Expr { k: MemberE { target: expr, name, optional: false }, span: this.sp(start) }
                }
                "?." => {
                    if stop_at_try { return Some(expr) }
                    this.advance()
                    name := this.member_name()?
                    expr = Expr { k: MemberE { target: expr, name, optional: true }, span: this.sp(start) }
                }
                "(" => {
                    if t.nl { return Some(expr) }
                    close := this.close_of()
                    this.advance()
                    args := this.group(false, #{ p: *Parser => p.list(close, false, #{ q: *Parser => q.parse_elem() }, no_juxtapose) })
                    expr = Expr { k: Call { callee: expr, args }, span: this.sp(start) }
                }
                "[" => {
                    if t.nl { return Some(expr) }
                    close := this.close_of()
                    this.advance()
                    let r = this.group(false, #{ p: *Parser => p.parse_index(close) })
                    this.i = close + 1
                    index := r?
                    expr = Expr { k: Index { target: expr, index }, span: this.sp(start) }
                }
                ".[" => {
                    if t.nl { this.report("E_GENERIC_ARGS_NEWLINE", "`.[` can't start a line") }
                    close := this.close_of()
                    if close == this.i + 1 {
                        this.report("E_EXPECTED_TYPE_ARGUMENTS", "empty `.[]`")
                        this.i = close + 1
                        continue
                    }
                    this.advance()
                    args := this.group(false, #{ p: *Parser => p.list(close, false, #{ q: *Parser => q.parse_type() }, no_juxtapose) })
                    expr = Expr { k: GenericApply { target: expr, args }, span: this.sp(start) }
                }
                "?" => {
                    if t.nl || stop_at_try { return Some(expr) }
                    this.advance()
                    expr = Expr { k: Try { expr }, span: this.sp(start) }
                }
                "{" => {
                    if t.nl || !is_type_path(expr) { return Some(expr) }
                    if this.no_struct {
                        if !this.looks_like_struct_in_header() { return Some(expr) }
                        this.report_tok("E_STRUCT_LITERAL_IN_HEADER", "a struct literal in a header needs parentheses", t, "(P { … })")
                    }
                    items := this.parse_rec_items(false)
                    expr = Expr { k: Struct { ty: expr, items }, span: this.sp(start) }
                }
                "<" => {
                    if t.ws || !is_path_expr(expr) || !this.looks_like_angle_call() { return Some(expr) }
                    this.advance()
                    args := this.parse_angle_args()?
                    this.report_tok("E_ANGLE_GENERICS", "explicit generics use `.[…]`", t, ".[…]")
                    expr = Expr { k: GenericApply { target: expr, args }, span: this.sp(start) }
                }
                _ => return Some(expr)
            }
        }
    }

    fn parse_index(*this, close: int) -> Expr? {
        if this.i == close {
            this.unexpected("an index")
            return None
        }
        e := this.parse_expr(0)?
        if this.i != close {
            this.unexpected("`]`")
            return None
        }
        Some(e)
    }

    /// `if x == P { a: 1 } { … }`: `{ name:` and another `{` right after the closer.
    fn looks_like_struct_in_header(this) -> bool {
        close := this.close_of()
        a := this.peek(1)
        b := this.peek(2)
        keyed := (a.kind == "Ident" && b.kind == ":" && this.peek(3).kind != "for") || (a.kind == "..." && close > this.i + 1)
        if !keyed || close + 1 >= this.toks.len() { return false }
        after := this.toks[close + 1]
        after.kind == "{" && !after.nl
    }

    /// `f<T>(x)`: type-like tokens up to a glued `>`, then a glued `(`.
    fn looks_like_angle_call(this) -> bool {
        var depth = 1
        var j = this.i + 1
        for j < this.toks.len() {
            k := this.toks[j]
            if k.kind == "<" {
                depth += 1
            } else if k.kind == ">" {
                depth -= 1
            } else if k.kind == ">>" {
                depth -= 2
            } else if k.kind == "[" || k.kind == "t(" {
                if k.closer >= 0 { j = k.closer }
                j += 1
                continue
            } else if k.kind != "Ident" && k.kind != "," && k.kind != "?" && k.kind != "." && k.kind != "Self" {
                return false
            }
            if depth <= 0 { break }
            j += 1
        }
        depth == 0 && j + 1 < this.toks.len() && this.toks[j + 1].kind == "(" && !this.toks[j + 1].ws
    }

    fn parse_elem(*this) -> Elem? {
        start := this.tok().start
        spread := this.eat("...")
        value := this.parse_expr(0)?
        Some(Elem { spread, value, span: this.sp(start) })
    }

    fn parse_primary(*this) -> Expr? {
        t := this.tok()
        start := t.start
        match t.kind {
            "Ident" => {
                if this.peek(1).kind == ":" && this.peek(2).kind == "for" { return this.parse_labeled_for() }
                this.advance()
                return Some(Expr { k: Ident { name: name_of(t) }, span: this.sp(start) })
            }
            "Int" => {
                this.advance()
                return Some(Expr { k: Int { value: name_of(t) }, span: this.sp(start) })
            }
            "Float" => {
                this.advance()
                let v = match t.value {
                    Float(f) => f
                    _ => 0.0
                }
                return Some(Expr { k: Float { value: v }, span: this.sp(start) })
            }
            "String" | "RawString" => {
                this.advance()
                return Some(Expr { k: Str { value: name_of(t), raw: t.kind == "RawString", multiline: t.multiline }, span: this.sp(start) })
            }
            "TemplateHead" => return Some(this.parse_template())
            "Char" => {
                this.advance()
                return Some(Expr { k: Char { value: name_of(t) }, span: this.sp(start) })
            }
            "Byte" => {
                this.advance()
                let v = match t.value {
                    Byte(b) => b
                    _ => 0
                }
                return Some(Expr { k: Byte { value: v }, span: this.sp(start) })
            }
            "true" | "false" => {
                this.advance()
                return Some(Expr { k: Bool { value: t.kind == "true" }, span: this.sp(start) })
            }
            "nil" => {
                this.advance()
                return Some(Expr { k: Nil, span: this.sp(start) })
            }
            "this" => {
                this.advance()
                return Some(Expr { k: This, span: this.sp(start) })
            }
            "Self" => {
                this.advance()
                return Some(Expr { k: SelfExpr, span: this.sp(start) })
            }
            "(" => return this.parse_paren()
            "[" | "a[" | "t(" | "s{" => {
                close := this.close_of()
                this.advance()
                set := t.kind == "s{"
                elems := this.group(set, #{ p: *Parser => p.list(close, set, #{ q: *Parser => q.parse_elem() }, no_juxtapose) })
                let k: ExprKind = match t.kind {
                    "[" => VecLit { elems }
                    "a[" => ArrayLit { elems }
                    "t(" => TupleLit { elems }
                    _ => SetLit { elems }
                }
                return Some(Expr { k, span: this.sp(start) })
            }
            "r{" => {
                items := this.parse_rec_items(true)
                return Some(Expr { k: Record { items }, span: this.sp(start) })
            }
            "_{" => {
                items := this.parse_rec_items(true)
                return Some(Expr { k: Inferred { items }, span: this.sp(start) })
            }
            "m{" => return this.parse_map()
            "#{" => return this.parse_closure(this.i, start)
            "#[" => {
                close := this.close_of()
                this.report_at("E_CAPTURE_LIST_REMOVED", "capture lists are removed: captures are inferred", t, Some("drop the list"), this.toks[close].end)
                this.i = close + 1
                if close + 1 >= this.toks.len() || this.toks[close + 1].kind != "{" {
                    this.unexpected("`{`")
                    return None
                }
                return this.parse_closure(this.i, start)
            }
            "{" => return this.parse_brace_expr()
            "if" => return this.parse_if()
            "match" => return this.parse_match()
            "select" => return this.parse_select()
            "lock" => return this.parse_lock()
            "for" => return this.parse_for(None, start)
            "while" | "loop" => {
                this.report_tok("E_RESERVED_KEYWORD", "`${t.kind}` is reserved: loops use `for`", t, "for")
                return this.parse_for(None, start)
            }
            "unsafe" | "recover" => {
                if t.kind == "unsafe" && this.peek(1).kind == "." {
                    // the `std.unsafe` package: `unsafe.Ptr.null()`
                    this.advance()
                    return Some(Expr { k: Ident { name: "unsafe" }, span: this.sp(start) })
                }
                this.advance()
                body := this.parse_block(true)?
                let k: ExprKind = if t.kind == "unsafe" { Unsafe { body } } else { Recover { body } }
                return Some(Expr { k, span: this.sp(start) })
            }
            "return" => {
                this.advance()
                var value: Expr? = None
                if this.can_start_value() { value = Some(this.parse_expr(0)?) }
                return Some(Expr { k: Return { value }, span: this.sp(start) })
            }
            "break" | "continue" => {
                this.advance()
                var label: str? = None
                if this.at("Ident") && !this.tok().nl && this.labels.contains(name_of(this.tok())) { label = Some(this.advance_name()) }
                if t.kind == "continue" { return Some(Expr { k: Continue { label }, span: this.sp(start) }) }
                var value: Expr? = None
                if this.can_start_value() { value = Some(this.parse_expr(0)?) }
                return Some(Expr { k: Break { label, value }, span: this.sp(start) })
            }
            "fn" | "fun" => if this.peek(1).kind == "(" { return this.parse_fn_expression() }
            "mut" => {
                this.report_tok("E_MUT_REMOVED", "`mut` is removed: use `var`", t, "var")
                return None
            }
            _ => {}
        }
        if RESERVED_KEYWORDS.has(t.kind) {
            this.report("E_RESERVED_KEYWORD", "`${t.kind}` is reserved")
            this.advance()
            return Some(Expr { k: Ident { name: t.kind }, span: this.sp(start) })
        }
        this.unexpected("an expression")
        None
    }

    /// After `return` / `break`: whether a value follows on the same line.
    fn can_start_value(this) -> bool {
        t := this.tok()
        if t.nl { return false }
        match t.kind {
            ";" | "}" | ")" | "]" | "," | "EOF" | "else" | "=>" => false
            _ => !INFIX.has(t.kind) || t.kind == "-"
        }
    }

    fn parse_template(*this) -> Expr {
        head := this.tok()
        start := head.start
        tail := this.close_of()
        var parts = [name_of(head)] as Vec[str]
        var exprs = [] as Vec[Expr]
        this.advance()
        saved_nl := this.nl_sig
        saved_ns := this.no_struct
        this.nl_sig = false
        this.no_struct = false
        for this.i <= tail {
            s := this.i
            match this.parse_expr(0) {
                Some(e) => exprs.push(e)
                None => exprs.push(Expr { k: ErrorE, span: this.sp(this.toks[s].start) })
            }
            // skip anything left before the next part
            for this.i < tail && this.tok().kind != "TemplateMiddle" {
                this.report("E_UNEXPECTED_TOKEN", "expected `}` to end the interpolation, found ${this.describe(this.tok())}")
                this.skip_one()
            }
            part := this.advance()
            parts.push(name_of(part))
            if part.kind == "TemplateTail" || this.i > tail { break }
        }
        this.nl_sig = saved_nl
        this.no_struct = saved_ns
        this.i = tail + 1
        Expr { k: Template { parts, exprs, multiline: head.multiline }, span: this.sp(start) }
    }

    fn parse_paren(*this) -> Expr? {
        open := this.tok()
        start := open.start
        close := this.close_of()
        if close + 1 < this.toks.len() && this.toks[close + 1].kind == "=>" && this.looks_like_param_list(this.i + 1, close) {
            return this.parse_arrow_closure(close, start)
        }
        this.advance()
        if this.i == close {
            this.i = close + 1
            this.push_diag("E_BARE_TUPLE", "the unit value is written `t()`", start, this.sp(start).end, Some("t()"))
            return Some(Expr { k: TupleLit { elems: [] }, span: this.sp(start) })
        }
        elems := this.group(false, #{ p: *Parser => p.list(close, false, #{ q: *Parser => q.parse_elem() }, no_juxtapose) })
        if elems.len() == 1 && this.toks[close - 1].kind != "," && !elems[0].spread {
            return Some(Expr { k: Paren { expr: elems[0].value }, span: this.sp(start) })
        }
        this.push_diag("E_BARE_TUPLE", "a tuple is written `t(a, b)`", start, this.sp(start).end, Some("t(…)"))
        Some(Expr { k: TupleLit { elems }, span: this.sp(start) })
    }

    /// `(a, b)` / `(a: T)` / `()`: names, `:`-types and commas only.
    fn looks_like_param_list(this, from: int, close: int) -> bool {
        var j = from
        for j < close {
            k := this.toks[j]
            if k.closer > j {
                j = k.closer
            } else if k.kind != "Ident" && k.kind != "," && k.kind != ":" && k.kind != "?" && k.kind != "." {
                return false
            }
            j += 1
        }
        true
    }

    fn parse_simple_closure_param(*this) -> ClosureParam? {
        s := this.tok().start
        name := this.binding_name("a parameter name")?
        var ty: Type? = None
        if this.eat(":") { ty = Some(this.parse_type()?) }
        Some(ClosureParam { name, is_var: false, star: false, ty, span: this.sp(s) })
    }

    /// The removed `(a, b) => body`: reported, parsed as a closure.
    fn parse_arrow_closure(*this, close: int, start: int) -> Expr? {
        open := this.advance()
        params := this.group(false, #{ p: *Parser => p.list(close, false, #{ q: *Parser => q.parse_simple_closure_param() }, no_juxtapose) })
        this.report_at("E_ARROW_CLOSURE", "closures are written `#{ a => … }`", open, Some("#{ a => … }"), this.toks[close + 1].end)
        this.expect("=>")?
        body := this.parse_expr(0)?
        stmt := Stmt { k: ExprStmt { expr: body, semi: false }, span: body.span }
        Some(Expr { k: Closure { params: Some(params), ret: None, body: [stmt] }, span: this.sp(start) })
    }

    /// The removed `fn(x) { … }` expression.
    fn parse_fn_expression(*this) -> Expr? {
        t := this.advance()
        start := t.start
        close := this.close_of()
        this.report_tok("E_ARROW_CLOSURE", "closures are written `#{ x => … }`", t, "#{ x => … }")
        this.advance()
        params := this.group(false, #{ p: *Parser => p.list(close, false, #{ q: *Parser => q.parse_simple_closure_param() }, no_juxtapose) })
        if this.eat("->") { this.parse_type()? }
        body := this.parse_block(false)?
        Some(Expr { k: Closure { params: Some(params), ret: None, body: body.stmts }, span: this.sp(start) })
    }

    /// `#{ [params =>] stmts }`; `open` is the index of `#{` (or of the `{` after a removed capture list).
    fn parse_closure(*this, open: int, start: int) -> Expr? {
        close := if this.toks[open].closer >= 0 { this.toks[open].closer } else { this.toks.len() - 1 }
        this.i = open + 1
        arrow := this.scan_closure_header(open, close)
        var params: Vec[ClosureParam]? = None
        var ret: Type? = None
        saved_labels := this.labels
        this.labels = []
        if arrow >= 0 {
            let r = this.group(false, #{ p: *Parser => p.closure_header(arrow) })
            this.i = arrow + 1
            match r {
                Some(h) => {
                    params = Some(h.0)
                    ret = h.1
                }
                None => {
                    this.labels = saved_labels
                    return None
                }
            }
        }
        body := this.group(true, #{ p: *Parser => p.parse_stmts(close) })
        this.i = close + 1
        this.labels = saved_labels
        Some(Expr { k: Closure { params, ret, body }, span: this.sp(start) })
    }

    /// The parameters (and `-> R`) of a closure header, up to the `=>` at index `arrow`.
    fn closure_header(*this, arrow: int) -> t(Vec[ClosureParam], Type?)? {
        var params = [] as Vec[ClosureParam]
        for {
            s := this.i
            match this.parse_closure_param() {
                Some(cp) => params.push(cp)
                None => {
                    this.i = if s + 1 > this.i { s + 1 } else { this.i }
                    for this.i < arrow && !this.at(",") && !this.at("->") { this.skip_one() }
                }
            }
            if !this.eat(",") { break }
        }
        var ret: Type? = None
        if this.eat("->") { ret = Some(this.parse_type()?) }
        if this.i != arrow {
            this.report("E_UNEXPECTED_TOKEN", "expected `=>`, found ${this.describe(this.tok())}")
        }
        Some(t(params, ret))
    }

    /// The index of the header's `=>`, or -1 when the closure has no header (§4.4).
    fn scan_closure_header(*this, open: int, close: int) -> int {
        var saw_newline = false
        var j = open + 1
        for j < close {
            t := this.toks[j]
            if t.kind == "=>" {
                if j == open + 1 { return -1 }
                if saw_newline { this.report_at("E_CLOSURE_HEADER_LINE", "closure parameters go on the closure's first line", t, None, t.end) }
                return j
            }
            if t.nl { saw_newline = true }
            if t.kind == "[" || t.kind == "(" || t.kind == "t(" || t.kind == "r{" {
                if t.closer >= 0 { j = t.closer }
                j += 1
                continue
            }
            if !CLOSURE_HEADER.has(t.kind) { return -1 }
            j += 1
        }
        -1
    }

    fn parse_closure_param(*this) -> ClosureParam? {
        start := this.tok().start
        var is_var = false
        if this.at("var") {
            this.advance()
            is_var = true
        } else if this.at("mut") {
            this.report_tok("E_MUT_REMOVED", "`mut` is removed: a writable copy of a parameter is `var x`", this.tok(), "var")
            this.advance()
            is_var = true
        }
        name := if this.at("_") { this.advance(); "_" } else { this.binding_name("a parameter name")? }
        var star = false
        var ty: Type? = None
        if this.eat(":") {
            mt := this.parse_mode_type()?
            star = mt.star
            ty = Some(mt.ty)
        }
        Some(ClosureParam { name, is_var, star, ty, span: this.sp(start) })
    }

    /// `{` in expression position: a block, or the removed bare literal `{ k: v }`.
    fn parse_brace_expr(*this) -> Expr? {
        a := this.peek(1)
        b := this.peek(2)
        keyed := (a.kind == "Ident" || a.kind == "String") && b.kind == ":" && this.peek(3).kind != "for"
        if keyed {
            start := this.tok().start
            this.report_tok("E_BARE_BRACE_LITERAL", "`{` always starts a block", this.tok(), "_{ … }, r{ … } or m{ … }")
            items := this.parse_rec_items(true)
            return Some(Expr { k: Inferred { items }, span: this.sp(start) })
        }
        block := this.parse_block(false)?
        Some(Expr { k: BlockE(block), span: block.span })
    }

    /// `{ name: value, name, "key": value, ...base }` after `r{`, `_{`, `Name {` (§4.3).
    fn parse_rec_items(*this, quoted_keys: bool) -> Vec[RecItem] {
        close := this.close_of()
        this.advance()
        this.group(true, #{ p: *Parser =>
            p.list(close, true, #{ q: *Parser => q.parse_rec_item(quoted_keys) }, #{ q => q.tok().kind == "Ident" || q.tok().kind == "..." })
        })
    }

    fn parse_rec_item(*this, quoted_keys: bool) -> RecItem? {
        start := this.tok().start
        if this.eat("...") {
            value := this.parse_expr(0)?
            return Some(RSpread { value, span: this.sp(start) })
        }
        k := this.tok()
        var name = ""
        var quoted = false
        if k.kind == "Ident" {
            name = name_of(k)
        } else if k.kind == "String" && quoted_keys {
            name = name_of(k)
            quoted = true
        } else if KEYWORDS.has(k.kind) && this.peek(1).kind == ":" {
            name = k.kind
        } else {
            this.report("E_INVALID_RECORD_KEY", "a record key is a name or (in `r{}`) a string")
            return None
        }
        this.advance()
        if !this.eat(":") {
            if quoted {
                this.report("E_EXPECTED_COLON", "a quoted key needs a value")
                return None
            }
            return Some(RField { name, quoted, value: None, span: this.sp(start) })
        }
        value := this.parse_expr(0)?
        Some(RField { name, quoted, value: Some(value), span: this.sp(start) })
    }

    fn parse_map(*this) -> Expr? {
        start := this.tok().start
        close := this.close_of()
        this.advance()
        entries := this.group(true, #{ p: *Parser => p.list(close, true, #{ q: *Parser => q.parse_map_entry() }, no_juxtapose) })
        Some(Expr { k: MapLit { entries }, span: this.sp(start) })
    }

    fn parse_map_entry(*this) -> MapEntry? {
        s := this.tok().start
        if this.eat("...") {
            value := this.parse_expr(0)?
            return Some(MSpread { value, span: this.sp(s) })
        }
        key := this.parse_expr(0)?
        this.expect_what(":", "`:` after a map key")?
        value := this.parse_expr(0)?
        Some(MEntry { key, value, span: this.sp(s) })
    }

    fn parse_if(*this) -> Expr? {
        start := (this.expect("if")?).start
        var pattern: Pattern? = None
        if this.eat("let") {
            pattern = Some(this.parse_pattern()?)
            this.expect("=")?
        }
        cond := this.header(#{ p: *Parser => p.parse_expr(0) })?
        then := this.parse_block(true)?
        var els: Expr? = None
        if this.at("else") {
            this.advance()
            if this.at("if") {
                els = Some(this.parse_if()?)
            } else {
                b := this.parse_block(true)?
                els = Some(Expr { k: BlockE(b), span: b.span })
            }
        }
        Some(Expr { k: If { pattern, cond, then, els }, span: this.sp(start) })
    }

    fn parse_match(*this) -> Expr? {
        start := (this.expect("match")?).start
        var subject: Expr? = None
        if !this.at("{") { subject = Some(this.header(#{ p: *Parser => p.parse_expr(0) })?) }
        if !this.at("{") {
            this.unexpected("`{`")
            return None
        }
        this.brace_on_header_line()
        close := this.close_of()
        this.advance()
        has_subject := subject.is_some()
        arms := this.group(true, #{ p: *Parser => p.list(close, true, #{ q: *Parser => q.parse_arm(has_subject) }, no_juxtapose) })
        Some(Expr { k: Match { subject, arms }, span: this.sp(start) })
    }

    fn parse_arm(*this, has_subject: bool) -> Arm? {
        s := this.tok().start
        var pattern: Pattern? = None
        var cond: Expr? = None
        var guard: Expr? = None
        if has_subject || (this.at("_") && this.peek(1).kind == "=>") {
            pattern = Some(this.parse_pattern()?)
            if this.eat("if") { guard = Some(this.parse_expr(0)?) }
        } else {
            cond = Some(this.parse_expr(0)?)
        }
        this.expect("=>")?
        body := this.parse_expr(0)?
        Some(Arm { pattern, guard, cond, body, span: this.sp(s) })
    }

    fn parse_select(*this) -> Expr? {
        start := (this.expect("select")?).start
        if !this.at("{") {
            this.unexpected("`{`")
            return None
        }
        this.brace_on_header_line()
        open := this.tok()
        close := this.close_of()
        this.advance()
        var els: Expr? = None
        var else_tok: Token? = None
        var arms = [] as Vec[SelectArm]
        this.group(true, #{ p: *Parser =>
            p.list(close, true, #{ q: *Parser =>
                s := q.tok().start
                if q.at("else") && q.peek(1).kind == "=>" {
                    e := q.advance()
                    q.advance()
                    body := q.parse_expr(0)?
                    if else_tok.is_some() {
                        q.report_at("E_SELECT_ELSE_NOT_LAST", "a `select` has at most one `else` arm", e, None, e.end)
                    } else {
                        els = Some(body)
                    }
                    else_tok = Some(e)
                    return Some(true)
                }
                if let Some(et) = else_tok {
                    q.report_at("E_SELECT_ELSE_NOT_LAST", "the `else` arm must be the last one", et, None, et.end)
                }
                var pattern: Pattern? = None
                if q.select_arm_has_pattern(close) {
                    pattern = Some(q.parse_pattern()?)
                    q.expect("=")?
                }
                expr := q.parse_expr(0)?
                q.expect("=>")?
                body := q.parse_expr(0)?
                arms.push(SelectArm { pattern, expr, body, span: q.sp(s) })
                Some(true)
            }, no_juxtapose)
        })
        if arms.is_empty() && els.is_none() {
            this.push_diag("E_SELECT_EMPTY", "a `select` needs at least one arm", open.start, open.end, None)
        }
        Some(Expr { k: Select { arms, els }, span: this.sp(start) })
    }

    /// A depth-0 `=` before the arm's `=>` means `pattern = promise => body` (§4.9).
    fn select_arm_has_pattern(this, close: int) -> bool {
        var j = this.i
        for j < close {
            t := this.toks[j]
            if t.kind == "=>" { return false }
            if t.kind == "=" { return true }
            if t.closer > j { j = t.closer }
            j += 1
        }
        false
    }

    fn parse_lock(*this) -> Expr? {
        start := (this.expect("lock")?).start
        let places = this.header(#{ p: *Parser => p.lock_places() })?
        body := this.parse_block(true)?
        Some(Expr { k: Lock { places, body }, span: this.sp(start) })
    }

    fn lock_places(*this) -> Vec[Expr]? {
        var places = [this.parse_expr(0)?] as Vec[Expr]
        for this.eat(",") { places.push(this.parse_expr(0)?) }
        Some(places)
    }

    fn parse_labeled_for(*this) -> Expr? {
        start := this.tok().start
        label := this.advance_name()
        this.advance() // `:`
        this.parse_for(Some(label), start)
    }

    /// The loop body, with the loop's label in scope.
    fn for_body(*this, label: str?) -> Block? {
        saved := this.labels
        if let Some(l) = label { this.labels.push(l) }
        b := this.parse_block(true)
        this.labels = saved
        b
    }

    fn parse_for(*this, label: str?, start: int) -> Expr? {
        kw := this.advance() // `for`, or the reported `while` / `loop`
        if this.at("{") || kw.kind == "loop" {
            body := this.for_body(label)?
            return Some(Expr { k: For { label, form: "infinite", is_await: false, pattern: None, pattern2: None, expr: None, body }, span: this.sp(start) })
        }
        if this.eat("let") {
            pattern := this.parse_pattern()?
            this.expect("=")?
            expr := this.header(#{ p: *Parser => p.parse_expr(0) })?
            body := this.for_body(label)?
            return Some(Expr { k: For { label, form: "let", is_await: false, pattern: Some(pattern), pattern2: None, expr: Some(expr), body }, span: this.sp(start) })
        }
        iter_await := this.at("await") && this.header_has_in(this.i + 1)
        if iter_await || this.header_has_in(this.i) {
            if iter_await { this.advance() }
            pattern := this.parse_pattern()?
            var pattern2: Pattern? = None
            if this.eat(",") { pattern2 = Some(this.parse_pattern()?) }
            this.expect("in")?
            expr := this.header(#{ p: *Parser => p.parse_expr(0) })?
            body := this.for_body(label)?
            return Some(Expr { k: For { label, form: "in", is_await: iter_await, pattern: Some(pattern), pattern2, expr: Some(expr), body }, span: this.sp(start) })
        }
        cond := this.header(#{ p: *Parser => p.parse_expr(0) })?
        body := this.for_body(label)?
        Some(Expr { k: For { label, form: "cond", is_await: false, pattern: None, pattern2: None, expr: Some(cond), body }, span: this.sp(start) })
    }

    /// Whether the loop header starting at `from` has a depth-0 `in` before its block (§5.3).
    fn header_has_in(this, from: int) -> bool {
        var j = from
        for j < this.toks.len() {
            t := this.toks[j]
            if t.kind == "in" { return true }
            if t.kind == "{" || t.kind == "EOF" || t.kind == ";" { return false }
            if t.closer > j { j = t.closer }
            j += 1
        }
        false
    }

    // ---- patterns (§6) ------------------------------------------------------------------------

    fn parse_pattern(*this) -> Pattern? {
        start := this.tok().start
        first := this.parse_alt_pattern()?
        if !this.at("|") { return Some(first) }
        var alts = [first] as Vec[Pattern]
        for this.eat("|") { alts.push(this.parse_alt_pattern()?) }
        Some(Pattern { k: POr { alts }, span: this.sp(start) })
    }

    fn parse_alt_pattern(*this) -> Pattern? {
        t := this.tok()
        start := t.start
        match t.kind {
            "_" => {
                this.advance()
                return Some(Pattern { k: PWild, span: this.sp(start) })
            }
            "var" | "mut" => {
                if t.kind == "mut" { this.report_tok("E_MUT_REMOVED", "`mut` is removed: a writable binding is `var x`", t, "var") }
                this.advance()
                name := this.binding_name("a name")?
                return Some(Pattern { k: PBind { name, is_var: true }, span: this.sp(start) })
            }
            "-" | "Int" | "Float" | "String" | "RawString" | "Char" | "Byte" | "true" | "false" | "nil" => {
                lit := this.parse_literal_pattern()?
                if this.at("..") || this.at("..=") {
                    inclusive := this.advance().kind == "..="
                    end := this.parse_literal_pattern()?
                    return Some(Pattern { k: PRange { start: lit, end, inclusive }, span: this.sp(start) })
                }
                return Some(Pattern { k: PLit { value: lit }, span: this.sp(start) })
            }
            "t(" => {
                close := this.close_of()
                this.advance()
                var rest = false
                var elems = [] as Vec[Pattern]
                this.group(false, #{ p: *Parser =>
                    p.list(close, false, #{ q: *Parser =>
                        if q.eat("..") {
                            rest = true
                        } else {
                            elems.push(q.parse_pattern()?)
                        }
                        Some(true)
                    }, no_juxtapose)
                })
                return Some(Pattern { k: PTuple { elems, rest }, span: this.sp(start) })
            }
            "r{" => {
                let t(fields, rest) = this.parse_field_patterns()
                return Some(Pattern { k: PRecord { fields, rest }, span: this.sp(start) })
            }
            "Ident" | "Self" => {
                this.advance()
                var path = [if t.kind == "Self" { "Self" } else { name_of(t) }] as Vec[str]
                for this.at(".") && this.peek(1).kind == "Ident" {
                    this.advance()
                    path.push(this.advance_name())
                }
                if this.at("(") && !this.tok().nl {
                    close := this.close_of()
                    this.advance()
                    var rest = false
                    var args = [] as Vec[Pattern]
                    this.group(false, #{ p: *Parser =>
                        p.list(close, false, #{ q: *Parser =>
                            if q.eat("..") {
                                rest = true
                            } else {
                                args.push(q.parse_pattern()?)
                            }
                            Some(true)
                        }, no_juxtapose)
                    })
                    return Some(Pattern { k: PCtor { path, args: Some(args), fields: None, rest }, span: this.sp(start) })
                }
                if this.at("{") && !this.tok().nl && is_upper(path[path.len() - 1]) {
                    let t(fields, rest) = this.parse_field_patterns()
                    return Some(Pattern { k: PCtor { path, args: None, fields: Some(fields), rest }, span: this.sp(start) })
                }
                if path.len() == 1 && !is_upper(path[0]) {
                    return Some(Pattern { k: PBind { name: path[0], is_var: false }, span: this.sp(start) })
                }
                return Some(Pattern { k: PCtor { path, args: None, fields: None, rest: false }, span: this.sp(start) })
            }
            _ => {}
        }
        if KEYWORDS.has(t.kind) {
            this.report("E_KEYWORD_AS_IDENT", "`${t.kind}` is a keyword and can't be a binding name")
            this.advance()
            return Some(Pattern { k: PBind { name: t.kind, is_var: false }, span: this.sp(start) })
        }
        this.report("E_INVALID_PATTERN", "expected a pattern, found ${this.describe(t)}")
        None
    }

    fn parse_literal_pattern(*this) -> Expr? {
        t := this.tok()
        start := t.start
        if t.kind == "-" {
            this.advance()
            n := this.tok()
            if n.kind != "Int" && n.kind != "Float" {
                this.report("E_INVALID_PATTERN", "`-` in a pattern goes before a number")
                return None
            }
            operand := this.parse_primary()?
            return Some(Expr { k: Unary { op: "-", operand }, span: this.sp(start) })
        }
        match t.kind {
            "Int" | "Float" | "String" | "RawString" | "Char" | "Byte" | "true" | "false" | "nil" => return this.parse_primary()
            _ => {}
        }
        this.report("E_INVALID_PATTERN", "expected a literal, found ${this.describe(t)}")
        None
    }

    fn parse_field_patterns(*this) -> t(Vec[FieldPat], bool) {
        close := this.close_of()
        this.advance()
        var rest = false
        var fields = [] as Vec[FieldPat]
        this.group(true, #{ p: *Parser =>
            p.list(close, true, #{ q: *Parser =>
                if q.eat("..") {
                    rest = true
                    return Some(true)
                }
                s := q.tok().start
                var is_var = false
                if q.at("var") || q.at("mut") {
                    if q.at("mut") { q.report_tok("E_MUT_REMOVED", "`mut` is removed", q.tok(), "var") }
                    q.advance()
                    is_var = true
                }
                name := q.binding_name("a field name")?
                var pattern: Pattern? = None
                if !is_var && q.eat(":") { pattern = Some(q.parse_pattern()?) }
                fields.push(FieldPat { name, pattern, is_var, span: q.sp(s) })
                Some(true)
            }, no_juxtapose)
        })
        t(fields, rest)
    }
}

// ---- helpers -----------------------------------------------------------------------------------

/// The name or text a token carries (an Ident's name, a literal's cooked text, an Int's digits).
fn name_of(t: Token) -> str {
    match t.value {
        Name(n) => n
        Text(s) => s
        Int(d) => d
        _ => ""
    }
}

fn is_self(t: Token) -> bool { t.kind == "Ident" && name_of(t) == "self" }

fn no_juxtapose(_p: Parser) -> bool { false }

fn member_start(p: Parser) -> bool {
    k := p.tok().kind
    k == "Ident" || k == "pub" || k == "fn" || k == "fun" || k == "async" || k == "#["
}

fn is_place(e: Expr) -> bool {
    match e.k {
        Ident { .. } | MemberE { .. } | Index { .. } | This => true
        Paren { expr } => is_place(expr)
        _ => false
    }
}

/// `Name`, `pkg.Name`, `Name.Variant`, `Name.[T]`: a path whose last segment is PascalCase (§4.2).
fn is_type_path(e: Expr) -> bool {
    match e.k {
        Ident { name } => is_upper(name)
        MemberE { target, name, optional } => !optional && is_upper(name) && is_path_expr(target)
        GenericApply { target, .. } => is_type_path(target)
        _ => false
    }
}

fn is_path_expr(e: Expr) -> bool {
    match e.k {
        Ident { .. } => true
        MemberE { target, optional, .. } => !optional && is_path_expr(target)
        _ => false
    }
}

fn is_comparison(e: Expr) -> bool {
    match e.k {
        Binary { op, .. } => op == "==" || op == "!=" || op == "<" || op == "<=" || op == ">" || op == ">="
        _ => false
    }
}

fn is_range(e: Expr) -> bool {
    match e.k {
        Range { .. } => true
        _ => false
    }
}

fn is_logical(e: Expr) -> bool {
    match e.k {
        Binary { op, .. } => op == "&&" || op == "||"
        _ => false
    }
}

fn is_nullish(e: Expr) -> bool {
    match e.k {
        Binary { op, .. } => op == "??"
        _ => false
    }
}
