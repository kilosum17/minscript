// Statements and expressions (spec §3–§5): the Pratt loop, unary and postfix operators, primaries.
package parser

import "app.lexer.{is_keyword, Token, Span}"
import "app.ast.*"

impl Parser {
    fun mk(&mut this, start: Span, kind: ExprKind) -> Expr {
        Expr { id: this.id(), span: this.sp(start), kind }
    }

    // ---- statements ----

    fun parse_block(&mut this) -> Result[Block, Sync] {
        let open = this.expect("{")?
        let end = this.closer_index(open)
        let saved = this.enter(true)
        let stmts = this.parse_stmts(end)
        this.leave(saved)
        this.jump_to(end)
        let _ = this.expect("}")?
        Ok(Block { id: this.id(), span: this.sp(open.span), stmts })
    }

    /// Statements up to the closer at index `end` (not consumed).
    fun parse_stmts(&mut this, end: int) -> Vec[Stmt] {
        var stmts = [] as Vec[Stmt]
        for this.i < end && !this.at("EOF") {
            if this.at(";") {
                let _ = this.advance()
                continue
            }
            let stmt_start = this.i
            match this.parse_stmt() {
                Err(e) => this.sync_from(stmt_start, end, e.at, "")
                Ok(parsed) => {
                    var stmt = parsed
                    var junk = false
                    if this.at(";") {
                        let _ = this.advance()
                        if let ExprStmt(es) = stmt {
                            var with_semi = es
                            with_semi.semi = true
                            stmt = ExprStmt(with_semi)
                        }
                    } else if this.i < end && !this.nl() {
                        junk = true
                    }
                    stmts.push(stmt)
                    // the statement is complete (kept); sync past what follows it on the line
                    if junk {
                        let found = describe(this.cur())
                        this.report("E_UNEXPECTED_TOKEN", "expected a newline or `;` after the statement, found ${found}")
                        this.sync_from(stmt_start, end, this.i, "")
                    }
                }
            }
        }
        stmts
    }

    fun parse_stmt(&mut this) -> Result[Stmt, Sync] {
        let tok = this.cur()
        if tok.kind == "@" {
            this.skip_attribute()
            return this.parse_stmt()
        }
        if tok.kind == "let" || tok.kind == "var" {
            return this.parse_let()
        }
        if tok.kind == "Ident" && this.peek(1).kind == ":" && this.peek(2).kind == "for" {
            let _ = this.advance()
            let _ = this.advance()
            let e = this.parse_for(Some(tok.clone()))?
            return Ok(ExprStmt(ExprStmtNode { id: this.id(), span: this.sp(tok.span), expr: e, semi: false }))
        }

        let e = this.parse_expr(0)?
        if this.at(":=") || this.at(":==") {
            let op = this.advance()
            var pattern = Pattern { id: this.id(), span: e.span, kind: PWild }
            if let Ident(name) = &e.kind {
                pattern = Pattern { id: pattern.id, span: e.span, kind: PBind { name: name.clone(), is_mut: false } }
            } else {
                this.report_at("E_SHORT_DECL_TARGET", "`${op.kind}` declares a plain name; use `let` for patterns and `=` to assign", op.span)
            }
            let value = this.parse_expr(0)?
            return Ok(Let(LetStmt { id: this.id(), span: this.sp(tok.span), mutable: op.kind == ":==", short: true, pattern, ty: None, value, else_branch: None }))
        }
        Ok(ExprStmt(ExprStmtNode { id: this.id(), span: this.sp(tok.span), expr: e, semi: false }))
    }

    fun parse_let(&mut this) -> Result[Stmt, Sync] {
        let start = this.advance()
        let mutable = start.kind == "var"
        let pattern = this.parse_pattern()?
        var ty: Type? = None
        if this.eat(":") {
            ty = Some(this.parse_type(false, true)?)
        }
        if this.at(":=") || this.at(":==") {
            this.report("E_SHORT_DECL_TARGET", "write `${start.kind} name = value` or `name ${if mutable { ":==" } else { ":=" }} value`, not both")
            let _ = this.advance()
        } else {
            let _ = this.expect("=")?
        }
        let value = this.parse_expr(0)?
        var else_branch: Block? = None
        if this.at("else") {
            let _ = this.advance()
            else_branch = Some(this.parse_block()?)
        }
        Ok(Let(LetStmt { id: this.id(), span: this.sp(start.span), mutable, short: false, pattern, ty, value, else_branch }))
    }

    // ---- expressions ----

    pub fun parse_expr(&mut this, min_bp: int) -> Result[Expr, Sync] {
        let start = this.cur().span
        var left = this.parse_unary()?

        for {
            let tok = this.cur()
            if tok.nl_before && this.nl_sig && !continues(tok.kind) {
                break
            }
            let Some(info) = infix(tok.kind) else { break }
            if info.bp < min_bp {
                break
            }

            if tok.kind == "as" {
                let _ = this.advance()
                let ty = this.parse_type(false, false)?
                left = this.mk(start, As { expr: Box(left), ty })
                continue
            }

            if tok.kind == "or" {
                let _ = this.advance()
                var name: string? = None
                var name_span: Span? = None
                if this.at("Ident") && this.peek(1).kind == "=>" {
                    let name_tok = this.advance()
                    name = Some(text_of(name_tok))
                    name_span = Some(name_tok.span)
                    let _ = this.advance()
                }
                let rhs = this.parse_expr(BP_OR_RHS)?
                left = this.mk(start, Or { expr: Box(left), name, name_span, rhs: Box(rhs) })
                continue
            }

            if info.assoc == "none" && is_non_assoc_chain(left, tok.kind) {
                this.report_at("E_NON_ASSOCIATIVE_OPERATOR", "`${tok.kind}` can't be chained: add parentheses", tok.span)
            }

            if tok.kind == ".." || tok.kind == "..=" {
                let _ = this.advance()
                var end: Box[Expr]? = None
                if this.can_start_operand() {
                    end = Some(Box(this.parse_expr(BP_RANGE_OPERAND)?))
                }
                left = this.mk(start, RangeExpr { op: tok.kind.clone(), start: Some(Box(left)), end })
                continue
            }

            let _ = this.advance()
            let right = this.parse_expr(if info.assoc == "right" { info.bp } else { info.bp + 1 })?

            if is_assign_op(tok.kind) {
                if !is_place(left) {
                    this.report_at("E_INVALID_ASSIGNMENT_TARGET", "the left side of an assignment must be a variable, field, index or `*pointer`", tok.span)
                }
                left = this.mk(start, Assign { op: tok.kind.clone(), target: Box(left), value: Box(right) })
                continue
            }
            if tok.kind == "??" && (is_logical(left) || is_logical(right)) {
                this.report_at("E_MIXED_NULLISH", "`??` can't be mixed with `&&` / `||` without parentheses", tok.span)
            }
            left = this.mk(start, Binary { op: tok.kind.clone(), left: Box(left), right: Box(right) })
        }
        Ok(left)
    }

    /// Whether the current token can start an operand here (used for open-ended ranges).
    fun can_start_operand(&this) -> bool {
        let tok = &this.t[this.i]
        if !expr_start(tok.kind) {
            return false
        }
        if tok.nl_before && this.nl_sig {
            return false
        }
        if tok.kind == "{" && this.no_struct {
            return false
        }
        true
    }

    fun parse_unary(&mut this) -> Result[Expr, Sync] {
        let start_tok = this.cur()
        let start = start_tok.span
        match start_tok.kind {
            "-" | "!" => {
                let _ = this.advance()
                let e = this.parse_unary()?
                return Ok(this.mk(start, Unary { op: start_tok.kind.clone(), expr: Box(e) }))
            }
            "&" => {
                let _ = this.advance()
                let is_mut = this.eat("mut")
                let e = this.parse_unary()?
                return Ok(this.mk(start, Unary { op: if is_mut { "&mut" } else { "&" }, expr: Box(e) }))
            }
            "*" => {
                let _ = this.advance()
                let e = this.parse_unary()?
                return Ok(this.mk(start, Unary { op: "*", expr: Box(e) }))
            }
            "~" | "--" | "++" => {
                let hint = if start_tok.kind == "~" { "bitwise not is `!` on integers" } else { "write `x += 1` / `x -= 1`" }
                this.report("E_RESERVED_OPERATOR", "`${start_tok.kind}` is reserved: ${hint}")
                let _ = this.advance()
                let e = this.parse_unary()?
                if start_tok.kind == "++" {
                    return Ok(e)
                }
                return Ok(this.mk(start, Unary { op: if start_tok.kind == "~" { "!" } else { "-" }, expr: Box(e) }))
            }
            "await" => {
                // the operand is a postfix chain up to the first `?` / `?.` (spec §3.1)
                let _ = this.advance()
                let primary = this.parse_primary()?
                let operand = this.parse_postfix(primary, true, None)?
                let awaited = this.mk(start, Await(Box(operand)))
                return this.parse_postfix(awaited, false, Some(start))
            }
            ".." | "..=" => {
                let _ = this.advance()
                var end: Box[Expr]? = None
                if this.can_start_operand() {
                    end = Some(Box(this.parse_expr(BP_RANGE_OPERAND)?))
                }
                return Ok(this.mk(start, RangeExpr { op: start_tok.kind.clone(), start: None, end }))
            }
            _ => {}
        }
        let primary = this.parse_primary()?
        this.parse_postfix(primary, false, None)
    }

    fun parse_postfix(&mut this, first: Expr, stop_at_try: bool, start_at: Span?) -> Result[Expr, Sync] {
        let start = start_at ?? first.span
        var e = first
        for {
            let tok = this.cur()
            match tok.kind {
                "." => {
                    let _ = this.advance()
                    let t(name, index) = this.member_name()?
                    e = this.mk(start, Member { object: Box(e), name, index })
                }
                "?." => {
                    if stop_at_try {
                        return Ok(e)
                    }
                    let _ = this.advance()
                    let t(name, index) = this.member_name()?
                    e = this.mk(start, OptMember { object: Box(e), name, index })
                }
                "(" => {
                    if tok.nl_before {
                        return Ok(e)
                    }
                    let args = this.parse_args()?
                    e = this.mk(start, Call { callee: Box(e), args })
                }
                "[" => {
                    if tok.nl_before {
                        return Ok(e)
                    }
                    let _ = this.advance()
                    let saved = this.enter(false)
                    let index = this.parse_expr(0)
                    this.leave(saved)
                    let idx = index?
                    this.jump_to(this.closer_index(tok))
                    let _ = this.expect("]")?
                    e = this.mk(start, IndexExpr { object: Box(e), index: Box(idx) })
                }
                ".[" => {
                    if tok.nl_before {
                        this.report("E_GENERIC_ARGS_NEWLINE", "`.[` must be on the same line as the expression it applies to")
                    }
                    let args = this.parse_type_args()?
                    e = this.mk(start, GenericApply { target: Box(e), args })
                }
                "?" => {
                    if tok.nl_before || stop_at_try {
                        return Ok(e)
                    }
                    let _ = this.advance()
                    e = this.mk(start, Try(Box(e)))
                }
                "{" => {
                    if tok.nl_before || !is_type_path(e) {
                        return Ok(e)
                    }
                    if this.no_struct {
                        if !this.looks_like_struct_in_header(tok) {
                            return Ok(e)
                        }
                        this.report("E_STRUCT_LITERAL_IN_HEADER", "a struct literal can't appear directly in an `if` / `for` / `match` header: wrap it in parentheses")
                    }
                    let fields = this.parse_record_fields("struct")?
                    e = this.mk(start, StructLit { ty: Box(e), fields })
                }
                "++" | "--" => {
                    if tok.nl_before {
                        return Ok(e)
                    }
                    this.report("E_RESERVED_OPERATOR", "`${tok.kind}` is reserved: write `x ${if tok.kind == "++" { "+=" } else { "-=" }} 1`")
                    let _ = this.advance()
                }
                "<" => {
                    // `f<T>(x)`: generic arguments written with angle brackets
                    if tok.ws_before || !is_path_expr(e) || !this.angle_call_ahead(this.i) {
                        return Ok(e)
                    }
                    let args = this.parse_angle_args()?
                    e = this.mk(start, GenericApply { target: Box(e), args })
                }
                ":" => {
                    // `f::<T>(x)` (turbofish)
                    let n1 = this.peek(1)
                    let n2 = this.peek(2)
                    if tok.ws_before || n1.kind != ":" || n1.ws_before || n2.kind != "<" || !is_path_expr(e) {
                        return Ok(e)
                    }
                    let _ = this.advance()
                    let _ = this.advance()
                    let args = this.parse_angle_args()?
                    e = this.mk(start, GenericApply { target: Box(e), args })
                }
                _ => return Ok(e)
            }
        }
    }

    /// A member name after `.`: a name, or a tuple index.
    fun member_name(&mut this) -> Result[t(string, bool), Sync] {
        let tok = this.cur()
        if tok.kind == "Ident" {
            let _ = this.advance()
            return Ok(t(text_of(tok), false))
        }
        if tok.kind == "Int" {
            let _ = this.advance()
            return Ok(t(text_of(tok), true))
        }
        this.fail("E_UNEXPECTED_TOKEN", "expected a field or method name after `.`, found ${describe(tok)}")
    }

    /// In a header, `P { a: 1 } {` (a struct literal followed by the real block) is a misplaced struct literal.
    fun looks_like_struct_in_header(&this, open: &Token) -> bool {
        let Some(close) = open.closer else { return false }
        if close + 1 >= this.t.len() || this.i + 2 >= this.t.len() {
            return false
        }
        let after = &this.t[close + 1]
        let first = &this.t[this.i + 1]
        let second = &this.t[this.i + 2]
        after.kind == "{" && !after.nl_before && first.kind == "Ident" && (second.kind == ":" || second.kind == ",")
    }

    /// From a `<` at `k`: does a type-argument list follow, closed by `>` and then a glued `(`?
    fun angle_call_ahead(&this, from: int) -> bool {
        var k = from
        var depth = 0
        var n = 0
        for n < 64 && k < this.t.len() {
            let tok = &this.t[k]
            match tok.kind {
                "<" => {
                    depth += 1
                    k += 1
                }
                ">" => {
                    depth -= 1
                    k += 1
                }
                ">>" => {
                    depth -= 2
                    k += 1
                }
                "Ident" | "Self" | "," | "." | "?" | "&" | "mut" | "*" => k += 1
                "[" | "t(" | "r{" | "(" => {
                    if depth <= 0 {
                        return false
                    }
                    let Some(c) = tok.closer else { return false }
                    k = c + 1
                }
                _ => return false
            }
            if depth <= 0 {
                if depth != 0 || k >= this.t.len() {
                    return false
                }
                let next = &this.t[k]
                return next.kind == "(" && !next.ws_before
            }
            n += 1
        }
        false
    }

    fun parse_args(&mut this) -> Result[Vec[Elem], Sync] {
        let open = this.advance()
        let saved = this.enter(false)
        let args = this.expr_list(")")
        this.leave(saved)
        let list = args?
        this.jump_to(this.closer_index(open))
        let _ = this.expect(")")?
        Ok(list)
    }

    /// After an element: `,` (continue), the closer or a newline (stop / continue), else an error.
    /// Returns true to stop.
    fun after_element(&mut this, close: &str) -> Result[bool, Sync] {
        if this.eat(",") {
            return Ok(false)
        }
        if this.at(close) {
            return Ok(true)
        }
        if this.nl() {
            return Ok(false)
        }
        let found = describe(this.cur())
        this.fail("E_UNEXPECTED_TOKEN", "expected `,` or `${close}`, found ${found}")
    }

    /// Expressions separated by `,` or newlines, with `...spread` and a trailing comma allowed.
    fun expr_list(&mut this, close: &str) -> Result[Vec[Elem], Sync] {
        var out = [] as Vec[Elem]
        for !this.at(close) && !this.at("EOF") {
            if this.at("...") {
                let start = this.advance()
                let e = this.parse_expr(0)?
                out.push(ESpread { span: this.sp(start.span), expr: e })
            } else {
                out.push(EValue(this.parse_expr(0)?))
            }
            if this.after_element(close)? {
                break
            }
        }
        Ok(out)
    }

    fun parse_primary(&mut this) -> Result[Expr, Sync] {
        let tok = this.cur()
        let start = tok.span
        match tok.kind {
            "Ident" => {
                let _ = this.advance()
                let name = text_of(tok)
                if is_implicit_param(name) && !this.closures.is_empty() && this.closures[this.closures.len() - 1] {
                    this.report_at("E_IT_IN_NAMED_CLOSURE", "`${name}` is only available in closures without a parameter header", tok.span)
                }
                Ok(this.mk(start, Ident(name)))
            }
            "_" => {
                let _ = this.advance()
                Ok(this.mk(start, Ident("_")))
            }
            "Self" => {
                let _ = this.advance()
                Ok(this.mk(start, Ident("Self")))
            }
            "this" => {
                let _ = this.advance()
                Ok(this.mk(start, This))
            }
            "Int" => {
                let _ = this.advance()
                Ok(this.mk(start, Int(text_of(tok))))
            }
            "Float" => {
                let _ = this.advance()
                var x = 0.0
                if let Some(v) = &tok.value {
                    if let Float(f) = v {
                        x = f
                    }
                }
                Ok(this.mk(start, Float(x)))
            }
            "String" => {
                let _ = this.advance()
                Ok(this.mk(start, Str { value: text_of(tok), raw: false }))
            }
            "RawString" => {
                let _ = this.advance()
                Ok(this.mk(start, Str { value: text_of(tok), raw: true }))
            }
            "Char" => {
                let _ = this.advance()
                Ok(this.mk(start, Char(text_of(tok))))
            }
            "true" | "false" => {
                let _ = this.advance()
                Ok(this.mk(start, Bool(tok.kind == "true")))
            }
            "nil" => {
                let _ = this.advance()
                Ok(this.mk(start, Nil))
            }
            "TemplateHead" => this.parse_template()
            "(" => this.parse_paren()
            "[" | "a[" | "t(" => {
                let _ = this.advance()
                let close = if tok.kind == "t(" { ")" } else { "]" }
                let saved = this.enter(false)
                let list = this.expr_list(close)
                this.leave(saved)
                let elems = list?
                this.jump_to(this.closer_index(tok))
                let _ = this.expect(close)?
                let kind: ExprKind = match tok.kind {
                    "[" => VecLit(elems)
                    "a[" => ArrayLit(elems)
                    _ => TupleLit(elems)
                }
                Ok(this.mk(start, kind))
            }
            "s{" => {
                let _ = this.advance()
                let saved = this.enter(true)
                let list = this.expr_list("}")
                this.leave(saved)
                let elems = list?
                this.jump_to(this.closer_index(tok))
                let _ = this.expect("}")?
                Ok(this.mk(start, SetLit(elems)))
            }
            "m{" => {
                let _ = this.advance()
                let saved = this.enter(true)
                let list = this.map_entries()
                this.leave(saved)
                let entries = list?
                this.jump_to(this.closer_index(tok))
                let _ = this.expect("}")?
                Ok(this.mk(start, MapLit(entries)))
            }
            "r{" => {
                let fields = this.parse_record_fields("record")?
                Ok(this.mk(start, RecordLit(fields)))
            }
            "_{" => {
                let fields = this.parse_record_fields("record")?
                Ok(this.mk(start, Inferred(fields)))
            }
            "#{" | "#[" => this.parse_closure()
            "{" => {
                let k1 = this.peek(1)
                let k2 = this.peek(2)
                if (k1.kind == "Ident" || k1.kind == "String") && k2.kind == ":" && this.peek(3).kind != "for" {
                    this.report("E_BARE_BRACE_LITERAL", "a bare `{` is always a block: write `r{ … }` for a record, `m{ … }` for a map, or `_{ … }` for an inferred struct")
                    let fields = this.parse_record_fields("record")?
                    return Ok(this.mk(start, RecordLit(fields)))
                }
                let b = this.parse_block()?
                Ok(Expr { id: this.id(), span: b.span, kind: BlockExpr(b) })
            }
            "if" => this.parse_if()
            "match" => this.parse_match()
            "for" => this.parse_for(None)
            "while" | "loop" => {
                this.report("E_RESERVED_KEYWORD", "`${tok.kind}` is reserved: MinScript loops use `for` (`for cond { }`, `for { }`)")
                this.parse_for(None)
            }
            "select" => this.parse_select()
            "unsafe" => {
                let _ = this.advance()
                let body = this.parse_block()?
                Ok(this.mk(start, Unsafe(body)))
            }
            "recover" => {
                let _ = this.advance()
                let body = this.parse_block()?
                Ok(this.mk(start, Recover(body)))
            }
            "return" => {
                let _ = this.advance()
                var value: Box[Expr]? = None
                if this.can_start_value() {
                    value = Some(Box(this.parse_expr(0)?))
                }
                Ok(this.mk(start, Return(value)))
            }
            "break" => {
                let _ = this.advance()
                let label = this.loop_label()
                var value: Box[Expr]? = None
                if this.can_start_value() {
                    value = Some(Box(this.parse_expr(0)?))
                }
                Ok(this.mk(start, Break { label, value }))
            }
            "continue" => {
                let _ = this.advance()
                let label = this.loop_label()
                Ok(this.mk(start, Continue(label)))
            }
            "fun" => this.parse_fun_expression()
            _ => {
                if is_reserved(tok.kind) {
                    return this.fail("E_RESERVED_KEYWORD", "`${tok.kind}` is reserved for a future version")
                }
                this.fail("E_UNEXPECTED_TOKEN", "expected an expression, found ${describe(tok)}")
            }
        }
    }

    /// `break outer` / `continue outer`: a label of an enclosing loop, on the same line.
    fun loop_label(&mut this) -> string? {
        if this.at("Ident") && !this.nl() {
            let name = text_of(this.cur())
            if this.labels.contains(name) {
                let _ = this.advance()
                return Some(name)
            }
        }
        None
    }

    /// After `return` / `break`: a value follows on the same line.
    fun can_start_value(&this) -> bool {
        let tok = &this.t[this.i]
        expr_start(tok.kind) && !tok.nl_before
    }

    fun parse_template(&mut this) -> Result[Expr, Sync] {
        let start = this.cur().span
        var parts = [] as Vec[TemplatePart]
        let head = this.advance()
        parts.push(Text(text_of(head)))
        for {
            let saved = this.enter(false)
            let inner = this.parse_expr(0)
            this.leave(saved)
            parts.push(Interp(inner?))
            let tok = this.cur()
            if tok.kind == "TemplateMiddle" {
                let _ = this.advance()
                parts.push(Text(text_of(tok)))
                continue
            }
            if tok.kind == "TemplateTail" {
                let _ = this.advance()
                parts.push(Text(text_of(tok)))
                break
            }
            return this.fail("E_UNEXPECTED_TOKEN", "expected `}` to end the interpolation, found ${describe(tok)}")
        }
        Ok(this.mk(start, Template(parts)))
    }

    fun parse_paren(&mut this) -> Result[Expr, Sync] {
        let open = this.cur()
        let close_idx = this.closer_index(open)
        if close_idx + 1 < this.t.len() {
            let after = &this.t[close_idx + 1]
            if (after.kind == "=>" || after.kind == "->") && !after.nl_before {
                return this.parse_arrow_closure(open)
            }
        }
        let _ = this.advance()
        if this.at(")") {
            let _ = this.advance()
            this.report_at("E_BARE_TUPLE", "the unit value is `t()`", open.span)
            return Ok(this.mk(open.span, TupleLit([])))
        }
        let saved = this.enter(false)
        let inner = this.paren_inner(open)
        this.leave(saved)
        var result = inner?
        this.jump_to(close_idx)
        let _ = this.expect(")")?
        result.span = this.sp(open.span)
        Ok(result)
    }

    fun paren_inner(&mut this, open: &Token) -> Result[Expr, Sync] {
        let first = this.parse_expr(0)?
        let span = first.span
        if !this.at(",") {
            return Ok(Expr { id: this.id(), span, kind: Paren(Box(first)) })
        }
        this.report_at("E_BARE_TUPLE", "tuples are written `t(a, b)`", open.span)
        var elems = [EValue(first)] as Vec[Elem]
        for this.eat(",") {
            if this.at(")") {
                break
            }
            elems.push(EValue(this.parse_expr(0)?))
        }
        Ok(Expr { id: this.id(), span, kind: TupleLit(elems) })
    }

    /// Recovery for `(a, b) => …` and `(a: T) -> U => …`.
    fun parse_arrow_closure(&mut this, open: Token) -> Result[Expr, Sync] {
        this.report_at("E_ARROW_CLOSURE", "arrow functions are not supported: write `#{ a, b => … }`", open.span)
        this.jump_to(this.closer_index(open) + 1)
        var ret: Type? = None
        if this.eat("->") {
            ret = Some(this.parse_type(false, true)?)
        }
        let _ = this.expect("=>")?
        let body = this.closure_body_from_expr()?
        Ok(this.mk(open.span, Closure { captures: None, params: None, ret, body }))
    }

    /// Recovery for `fun(x) { … }` used as a value.
    fun parse_fun_expression(&mut this) -> Result[Expr, Sync] {
        let start = this.advance()
        this.report_at("E_ARROW_CLOSURE", "function expressions are not supported: write `#{ x => … }`", start.span)
        if this.at("(") {
            let next = this.closer_index(this.cur()) + 1
            this.jump_to(next)
        }
        var ret: Type? = None
        if this.eat("->") {
            ret = Some(this.parse_type(false, true)?)
        }
        let body = this.parse_block()?
        Ok(this.mk(start.span, Closure { captures: None, params: None, ret, body }))
    }

    fun closure_body_from_expr(&mut this) -> Result[Block, Sync] {
        if this.at("{") {
            return this.parse_block()
        }
        let e = this.parse_expr(0)?
        let span = e.span
        let stmt: Stmt = ExprStmt(ExprStmtNode { id: this.id(), span, expr: e, semi: false })
        Ok(Block { id: this.id(), span, stmts: [stmt] })
    }

    /// `m{ key: value, … }` entries.
    fun map_entries(&mut this) -> Result[Vec[MapItem], Sync] {
        var out = [] as Vec[MapItem]
        for !this.at("}") && !this.at("EOF") {
            if this.at("...") {
                let start = this.advance()
                let e = this.parse_expr(0)?
                out.push(MSpread { span: this.sp(start.span), expr: e })
            } else {
                let kstart = this.cur().span
                let key = this.parse_expr(0)?
                let _ = this.expect_what(":", "`:` between a map key and its value")?
                let value = this.parse_expr(0)?
                out.push(MEntry(MapEntry { id: this.id(), span: this.sp(kstart), key, value }))
            }
            if this.after_element("}")? {
                break
            }
        }
        Ok(out)
    }

    /// `r{ … }`, `_{ … }`, `Name { … }`, and the recovery for a bare `{ k: v }`. `what`: "record" / "struct".
    fun parse_record_fields(&mut this, what: &str) -> Result[Vec[RecordItem], Sync] {
        let open = this.advance()
        let saved = this.enter(true)
        let list = this.record_items(what)
        this.leave(saved)
        let fields = list?
        this.jump_to(this.closer_index(open))
        let _ = this.expect("}")?
        Ok(fields)
    }

    fun record_items(&mut this, what: &str) -> Result[Vec[RecordItem], Sync] {
        var out = [] as Vec[RecordItem]
        for !this.at("}") && !this.at("EOF") {
            if this.at("...") {
                let start = this.advance()
                let e = this.parse_expr(0)?
                out.push(RSpread { span: this.sp(start.span), expr: e })
            } else {
                out.push(RField(this.record_field(what)?))
            }
            if this.after_element("}")? {
                break
            }
        }
        Ok(out)
    }

    fun record_field(&mut this, what: &str) -> Result[RecordField, Sync] {
        let key_tok = this.cur()
        let start = key_tok.span
        var key = ""
        if key_tok.kind == "Ident" {
            key = text_of(key_tok)
        } else if key_tok.kind == "String" && what == "record" {
            key = text_of(key_tok)
        } else if is_keyword(key_tok.kind) && this.peek(1).kind == ":" {
            key = key_tok.kind.clone()
        } else {
            this.report("E_INVALID_RECORD_KEY", "a ${what} key must be a name${if what == "record" { " or a string" } else { "" }}, found ${describe(key_tok)}")
            let _ = this.advance()
            if this.eat(":") {
                let _ = this.parse_expr(0)?
            }
            return Ok(RecordField { id: this.id(), span: this.sp(start), key: "", value: None })
        }
        let _ = this.advance()
        var value: Expr? = None
        if this.eat(":") {
            value = Some(this.parse_expr(0)?)
        } else if key_tok.kind == "String" {
            return this.fail("E_UNEXPECTED_TOKEN", "expected `:` after a string key")
        }
        Ok(RecordField { id: this.id(), span: this.sp(start), key, value })
    }
}

fun is_non_assoc_chain(left: &Expr, op: &str) -> bool {
    if is_comparison(op) {
        if let Binary { op: lop, .. } = &left.kind {
            return is_comparison(lop)
        }
        return false
    }
    if op == ".." || op == "..=" {
        if let RangeExpr { .. } = &left.kind {
            return true
        }
    }
    false
}

fun is_logical(e: &Expr) -> bool {
    if let Binary { op, .. } = &e.kind {
        return op == "&&" || op == "||"
    }
    false
}

fun is_place(e: &Expr) -> bool {
    match &e.kind {
        Ident(_) | Member { .. } | IndexExpr { .. } | This => true
        Unary { op, .. } => op == "*"
        Paren(inner) => is_place(inner.get())
        _ => false
    }
}

fun is_path_expr(e: &Expr) -> bool {
    match &e.kind {
        Ident(_) => true
        Member { object, index, .. } => !index && is_path_expr(object.get())
        _ => false
    }
}

/// `User`, `models.User`, `Box.[i32]`: may be followed by a struct literal body.
fun is_type_path(e: &Expr) -> bool {
    match &e.kind {
        Ident(name) => is_upper(name)
        Member { object, name, index } => !index && is_upper(name) && is_path_expr(object.get())
        GenericApply { target, .. } => is_type_path(target.get())
        _ => false
    }
}
