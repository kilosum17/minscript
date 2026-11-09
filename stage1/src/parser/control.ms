// Closures, control flow and patterns (spec §4.4, §4.9, §5, §6).
package parser

import "app.lexer.{is_keyword, Token, Span}"
import "app.ast.*"

impl Parser {
    // ---- closures ----

    fun parse_closure(&mut this) -> Result[Expr, Sync] {
        let start = this.cur_span()
        var captures: Vec[Capture]? = None
        var brace: Token? = None
        if this.at("#[") {
            let open = this.advance()
            let saved = this.enter(false)
            let caps = this.parse_captures()
            this.leave(saved)
            captures = Some(caps?)
            this.jump_to(this.closer_index(open))
            let close = this.expect("]")?
            if this.at("{") {
                if this.t[this.i].ws_before {
                    this.report("E_CAPTURE_NOT_GLUED", "the closure body `{` must be glued to the capture list: `#[x]{ … }`")
                }
                brace = Some(this.advance())
            } else if this.at("(") && !this.nl() {
                // `#[x](a) => …`: the old arrow form after a capture list
                this.report_at("E_CAPTURE_NOT_GLUED", "a capture list is followed directly by the body: `#[x]{ a => … }`", close.span)
                let next = this.closer_index(this.cur()) + 1
                this.jump_to(next)
                var ret: Type? = None
                if this.eat("->") {
                    ret = Some(this.parse_type(false, true)?)
                }
                let _ = this.expect("=>")?
                let body = this.closure_body_from_expr()?
                return Ok(this.mk(start, Closure { captures, params: None, ret, body }))
            } else {
                return this.fail("E_CAPTURE_NOT_GLUED", "a capture list must be followed by the closure body `{`")
            }
        } else {
            brace = Some(this.advance())
        }

        let open = brace.unwrap()
        let end = this.closer_index(open)
        let arrow_at = this.find_closure_header(this.i, end)

        let saved = this.enter(true)
        let parts = this.closure_parts(arrow_at, end)
        this.leave(saved)
        let t(params, ret, body) = parts?
        this.jump_to(end)
        let _ = this.expect("}")?
        Ok(this.mk(start, Closure { captures, params, ret, body }))
    }

    fun closure_parts(&mut this, arrow_at: int, end: int) -> Result[t(Vec[ClosureParam]?, Type?, Block), Sync] {
        var params: Vec[ClosureParam]? = None
        var ret: Type? = None
        if arrow_at >= 0 {
            let t(ps, r) = this.parse_closure_header(arrow_at)?
            params = Some(ps)
            ret = r
        }
        this.closures.push(params.is_some())
        let body_start = this.cur_span()
        let stmts = this.parse_stmts(end)
        let _ = this.closures.pop()
        let body = Block { id: this.id(), span: this.sp(body_start), stmts }
        Ok(t(params, ret, body))
    }

    fun parse_captures(&mut this) -> Result[Vec[Capture], Sync] {
        var caps = [] as Vec[Capture]
        for !this.at("]") && !this.at("EOF") {
            let start = this.cur_span()
            var mode = "move"
            if this.eat("&") {
                mode = if this.eat("mut") { "mut" } else { "ref" }
            }
            if !this.at("Ident") {
                this.report("E_INVALID_CAPTURE", "a capture is `x`, `&x` or `&mut x`")
                this.skip_capture()
            } else {
                let name = text_of(this.advance())
                if !this.at(",") && !this.at("]") {
                    this.report("E_INVALID_CAPTURE", "a capture is a plain name (`x`, `&x`, `&mut x`): capture the whole variable")
                    this.skip_capture()
                }
                caps.push(Capture { id: this.id(), span: this.sp(start), name, mode })
            }
            if !this.eat(",") {
                break
            }
        }
        Ok(caps)
    }

    fun skip_capture(&mut this) {
        for !this.at(",") && !this.at("]") && !this.at("EOF") {
            let next = this.skip_index(this.i)
            this.jump_to(next)
        }
    }

    /// Bounded scan for a parameter header (spec §4.4): from `from`, at depth 0, only header tokens or
    /// skipped bracket groups, up to `=>` on the closure's first line. Returns the index of `=>`, or -1.
    /// A header that starts on the next line is reported (E_CLOSURE_HEADER_LINE) and accepted.
    fun find_closure_header(&mut this, from: int, end: int) -> int {
        if from >= end || from >= this.t.len() {
            return -1
        }
        let arrow = this.scan_header(from, end)
        if arrow >= 0 && this.t[from].nl_before {
            let span = this.t[from].span
            this.report_at("E_CLOSURE_HEADER_LINE", "closure parameters (`a, b =>`) must be on the same line as the opening `#{`", span)
        }
        arrow
    }

    fun scan_header(&this, from: int, end: int) -> int {
        var k = from
        for k < end {
            let tok = &this.t[k]
            if k > from && tok.nl_before {
                return -1
            }
            if tok.kind == "=>" {
                return if k > from { k } else { -1 }
            }
            if header_group(tok.kind) {
                let Some(c) = tok.closer else { return -1 }
                k = c + 1
                continue
            }
            if !header_token(tok.kind) {
                return -1
            }
            k += 1
        }
        -1
    }

    fun parse_closure_header(&mut this, arrow_at: int) -> Result[t(Vec[ClosureParam], Type?), Sync] {
        var params = [] as Vec[ClosureParam]
        var ret: Type? = None
        for this.i < arrow_at {
            let start = this.cur_span()
            let is_mut = this.eat("mut")
            var name = ""
            if this.at("_") {
                this.skip()
                name = "_"
            } else {
                name = this.ident_name("a closure parameter name")?
            }
            var ty: Type? = None
            if this.eat(":") {
                ty = Some(this.parse_type(false, true)?)
            }
            params.push(ClosureParam { id: this.id(), span: this.sp(start), name, is_mut, ty })
            if this.eat(",") {
                continue
            }
            if this.eat("->") {
                ret = Some(this.parse_type(false, true)?)
            }
            break
        }
        if this.i != arrow_at {
            let found = describe(this.cur())
            return this.fail("E_UNEXPECTED_TOKEN", "unexpected ${found} in the closure parameters")
        }
        let _ = this.expect("=>")?
        Ok(t(params, ret))
    }

    // ---- control flow ----

    fun parse_expr_no_struct(&mut this) -> Result[Expr, Sync] {
        let saved = this.no_struct
        this.no_struct = true
        let e = this.parse_expr(0)
        this.no_struct = saved
        e
    }

    /// The `{` of a control-flow header (on the header line).
    fun parse_header_block(&mut this, what: &str) -> Result[Block, Sync] {
        if !this.at("{") {
            let found = describe(this.cur())
            return this.fail("E_UNEXPECTED_TOKEN", "expected `{` after the ${what} header, found ${found}")
        }
        if this.nl() {
            this.report_brace_newline("the `{` of ${what} goes on the same line as its header")
        }
        this.parse_block()
    }

    fun parse_if(&mut this) -> Result[Expr, Sync] {
        let start = this.advance()
        var cond: Cond? = None
        if this.at("let") {
            let let_tok = this.advance()
            let pattern = this.parse_pattern()?
            let _ = this.expect("=")?
            let value = this.parse_expr_no_struct()?
            cond = Some(CLet(LetCond { id: this.id(), span: this.sp(let_tok.span), pattern, value: Box(value) }))
        } else {
            cond = Some(CExpr(Box(this.parse_expr_no_struct()?)))
        }
        let then = this.parse_header_block("`if`")?
        var else_branch: Box[Expr]? = None
        if this.at("else") {
            this.skip()
            if this.at("if") {
                else_branch = Some(Box(this.parse_if()?))
            } else {
                let b = this.parse_header_block("`else`")?
                else_branch = Some(Box(Expr { id: this.id(), span: b.span, kind: BlockExpr(b) }))
            }
        }
        Ok(this.mk(start.span, If { cond: cond.unwrap(), then, else_branch }))
    }

    fun parse_for(&mut this, label_tok: Token?) -> Result[Expr, Sync] {
        let start = match &label_tok {
            Some(l) => l.span
            None => this.cur_span()
        }
        let kw = this.advance()           // `for` (or a reserved `while` / `loop`)
        let label = match &label_tok {
            Some(l) => Some(text_of(l))
            None => None
        }

        if kw.kind == "loop" || this.at("{") {
            let body = this.loop_body(label)?
            return Ok(this.mk(start, For { label, form: "infinite", is_await: false, pattern: None, pattern2: None, expr: None, body }))
        }
        if kw.kind == "for" && this.at("let") {
            this.skip()
            let pattern = this.parse_pattern()?
            let _ = this.expect("=")?
            let value = this.parse_expr_no_struct()?
            let body = this.loop_body(label)?
            return Ok(this.mk(start, For { label, form: "let", is_await: false, pattern: Some(pattern), pattern2: None, expr: Some(Box(value)), body }))
        }
        if kw.kind == "for" && this.header_has_in() {
            let is_await = this.eat("await")
            var pattern = Pattern { id: 0, span: this.cur_span(), kind: PError }
            if this.at("in") {
                this.report("E_INVALID_PATTERN", "expected a pattern before `in`: `for x in items`")
                let span = this.cur_span()
                pattern = Pattern { id: this.id(), span: this.sp(span), kind: PError }
            } else {
                pattern = this.parse_pattern()?
            }
            var pattern2: Pattern? = None
            if this.eat(",") {
                pattern2 = Some(this.parse_pattern()?)
            }
            let _ = this.expect("in")?
            let iterable = this.parse_expr_no_struct()?
            let body = this.loop_body(label)?
            return Ok(this.mk(start, For { label, form: "in", is_await, pattern: Some(pattern), pattern2, expr: Some(Box(iterable)), body }))
        }
        let cond = this.parse_expr_no_struct()?
        let body = this.loop_body(label)?
        Ok(this.mk(start, For { label, form: "cond", is_await: false, pattern: None, pattern2: None, expr: Some(Box(cond)), body }))
    }

    fun loop_body(&mut this, label: &string?) -> Result[Block, Sync] {
        if let Some(l) = label {
            this.labels.push(l.clone())
        }
        let body = this.parse_header_block("`for`")
        if label.is_some() {
            let _ = this.labels.pop()
        }
        body
    }

    /// Is there an `in` at depth 0 between here and the header's `{` (on this line)?
    fun header_has_in(&this) -> bool {
        var k = this.i
        for k < this.t.len() {
            let tok = &this.t[k]
            if tok.kind == "EOF" || (k > this.i && tok.nl_before) || tok.kind == "{" {
                return false
            }
            if tok.kind == "in" {
                return true
            }
            k = this.skip_index(k)
        }
        false
    }

    fun parse_match(&mut this) -> Result[Expr, Sync] {
        let start = this.advance()
        var subject: Box[Expr]? = None
        if !this.at("{") {
            subject = Some(Box(this.parse_expr_no_struct()?))
        }
        if !this.at("{") {
            let found = describe(this.cur())
            return this.fail("E_UNEXPECTED_TOKEN", "expected `{` after the `match` subject, found ${found}")
        }
        if this.nl() {
            this.report_brace_newline("the `{` of `match` goes on the same line")
        }
        let open = this.advance()
        let end = this.closer_index(open)
        var arms = [] as Vec[MatchArm]
        let has_subject = subject.is_some()
        let saved = this.enter(true)
        for this.i < end && !this.at("EOF") {
            if this.at(",") || this.at(";") {
                this.skip()
                continue
            }
            let arm_start = this.i
            match this.parse_match_arm(has_subject) {
                Err(e) => this.sync_from(arm_start, end, e.at, "comma")
                Ok(arm) => {
                    // kept even when what follows it is wrong (as in stage 0)
                    arms.push(arm)
                    if let Err(e) = this.end_arm(end) {
                        this.sync_from(arm_start, end, e.at, "comma")
                    }
                }
            }
        }
        this.leave(saved)
        this.jump_to(end)
        let _ = this.expect("}")?
        Ok(this.mk(start.span, Match { subject, arms }))
    }

    fun parse_match_arm(&mut this, has_subject: bool) -> Result[MatchArm, Sync] {
        let start = this.cur_span()
        var pattern: Pattern? = None
        var test: Expr? = None
        var guard: Expr? = None
        if has_subject {
            pattern = Some(this.parse_pattern()?)
            if this.eat("if") {
                guard = Some(this.parse_expr(0)?)
            }
        } else if this.at("_") && this.peek(1).kind == "=>" {
            this.skip()
            pattern = Some(Pattern { id: this.id(), span: this.sp(start), kind: PWild })
        } else {
            test = Some(this.parse_expr(0)?)
        }
        let _ = this.expect("=>")?
        let body = this.parse_expr(0)?
        Ok(MatchArm { id: this.id(), span: this.sp(start), pattern, test, guard, body })
    }

    /// After an arm: `,`, a newline, or the closing `}`.
    fun end_arm(&mut this, end: int) -> Result[void, Sync] {
        if this.at(",") {
            this.skip()
            return Ok()
        }
        if this.i >= end || this.nl() {
            return Ok()
        }
        let found = describe(this.cur())
        this.fail("E_UNEXPECTED_TOKEN", "expected `,` or a newline after the arm, found ${found}")
    }

    fun parse_select(&mut this) -> Result[Expr, Sync] {
        let start = this.advance()
        if !this.at("{") {
            let found = describe(this.cur())
            return this.fail("E_UNEXPECTED_TOKEN", "expected `{` after `select`, found ${found}")
        }
        if this.nl() {
            this.report_brace_newline("the `{` of `select` goes on the same line")
        }
        let open = this.advance()
        let end = this.closer_index(open)
        var st = SelectState {}
        let saved = this.enter(true)
        for this.i < end && !this.at("EOF") {
            if this.at(",") || this.at(";") {
                this.skip()
                continue
            }
            let arm_start = this.i
            st.saw_arm = true
            if let Err(e) = this.select_entry(st, end) {
                this.sync_from(arm_start, end, e.at, "comma")
            }
        }
        this.leave(saved)
        this.jump_to(end)
        let _ = this.expect("}")?
        if !st.saw_arm {
            this.report_at("E_SELECT_EMPTY", "a `select` needs at least one arm", start.span)
        }
        Ok(this.mk(start.span, Select { arms: st.arms, else_branch: st.else_body }))
    }

    fun select_entry(&mut this, st: &mut SelectState, end: int) -> Result[void, Sync] {
        if this.at("else") {
            let tok = this.advance()
            if st.else_tok.is_some() {
                this.report_at("E_SELECT_ELSE_NOT_LAST", "a `select` has at most one `else` arm, and it comes last", tok.span)
            }
            let _ = this.expect("=>")?
            let body = this.parse_expr(0)?
            if st.else_body.is_none() {
                st.else_body = Some(Box(body))
            }
            st.else_tok = Some(tok.span)
        } else {
            if let Some(et) = st.else_tok {
                if !st.else_reported {
                    this.report_at("E_SELECT_ELSE_NOT_LAST", "the `else` arm of a `select` must come last", et)
                    st.else_reported = true
                }
            }
            st.arms.push(this.parse_select_arm(end)?)
        }
        this.end_arm(end)
    }

    fun parse_select_arm(&mut this, end: int) -> Result[SelectArm, Sync] {
        let start = this.cur_span()
        var pattern: Pattern? = None
        if this.select_arm_has_pattern(end) {
            pattern = Some(this.parse_pattern()?)
            let _ = this.expect("=")?
        }
        let e = this.parse_expr(0)?
        let _ = this.expect("=>")?
        let body = this.parse_expr(0)?
        Ok(SelectArm { id: this.id(), span: this.sp(start), pattern, expr: e, body })
    }

    /// `pattern = expr => body` iff a depth-0 `=` comes before the arm's `=>` (spec §4.9).
    fun select_arm_has_pattern(&this, end: int) -> bool {
        var k = this.i
        for k < end {
            let tok = &this.t[k]
            if (k > this.i && tok.nl_before) || tok.kind == "=>" || tok.kind == "," {
                return false
            }
            if tok.kind == "=" {
                return true
            }
            k = this.skip_index(k)
        }
        false
    }

    // ---- patterns ----

    fun mk_pat(&mut this, start: Span, kind: PatternKind) -> Pattern {
        Pattern { id: this.id(), span: this.sp(start), kind }
    }

    pub fun parse_pattern(&mut this) -> Result[Pattern, Sync] {
        let start = this.cur_span()
        let first = this.parse_pattern_alt()?
        if !this.at("|") {
            return Ok(first)
        }
        var alts = [first]
        for this.eat("|") {
            alts.push(this.parse_pattern_alt()?)
        }
        Ok(this.mk_pat(start, POr(alts)))
    }

    fun parse_pattern_alt(&mut this) -> Result[Pattern, Sync] {
        let start_tok = this.cur()
        let start = start_tok.span
        match start_tok.kind {
            "_" => {
                this.skip()
                Ok(this.mk_pat(start, PWild))
            }
            "mut" => {
                this.skip()
                let name = this.ident_name("a binding name")?
                Ok(this.mk_pat(start, PBind { name, is_mut: true }))
            }
            "-" | "Int" | "Float" | "String" | "RawString" | "Char" | "true" | "false" | "nil" => {
                let lit = this.parse_pattern_literal()?
                this.maybe_range_pattern(start, lit)
            }
            ".." | "..=" => {
                this.skip()
                let end = this.parse_pattern_literal()?
                Ok(this.mk_pat(start, PRange { op: start_tok.kind.clone(), start: None, end: Some(Box(end)) }))
            }
            "t(" => {
                this.skip()
                let saved = this.enter(false)
                let list = this.pattern_list(")")
                this.leave(saved)
                let t(elems, rest) = list?
                this.jump_to(this.closer_index(start_tok))
                let _ = this.expect(")")?
                Ok(this.mk_pat(start, PTuple { elems, rest }))
            }
            "(" => {
                this.report("E_BARE_TUPLE", "tuple patterns are written `t(a, b)`")
                this.skip()
                let saved = this.enter(false)
                let list = this.pattern_list(")")
                this.leave(saved)
                let t(elems, rest) = list?
                this.jump_to(this.closer_index(start_tok))
                let _ = this.expect(")")?
                if elems.len() == 1 && !rest {
                    return Ok(elems[0].clone())
                }
                Ok(this.mk_pat(start, PTuple { elems, rest }))
            }
            "r{" => {
                let t(fields, rest) = this.pattern_fields()?
                Ok(this.mk_pat(start, PStruct { path: None, fields, rest }))
            }
            "Ident" | "Self" => {
                var path = [if start_tok.kind == "Self" { "Self" } else { text_of(start_tok) }]
                this.skip()
                for this.at(".") && this.peek(1).kind == "Ident" {
                    this.skip()
                    path.push(text_of(this.advance()))
                }
                if this.at("(") && !this.nl() {
                    let open = this.advance()
                    let saved = this.enter(false)
                    let list = this.pattern_list(")")
                    this.leave(saved)
                    let t(elems, rest) = list?
                    this.jump_to(this.closer_index(open))
                    let _ = this.expect(")")?
                    return Ok(this.mk_pat(start, PCall { path, args: elems, rest }))
                }
                let is_constructor = path.len() > 1 || is_upper(path[0])
                if is_constructor && this.at("{") && !this.nl() {
                    let t(fields, rest) = this.pattern_fields()?
                    return Ok(this.mk_pat(start, PStruct { path: Some(path), fields, rest }))
                }
                if !is_constructor {
                    return Ok(this.mk_pat(start, PBind { name: path[0].clone(), is_mut: false }))
                }
                Ok(this.mk_pat(start, PPath(path)))
            }
            _ => {
                if is_keyword(start_tok.kind) && !is_reserved(start_tok.kind) {
                    this.report("E_KEYWORD_AS_IDENT", "`${start_tok.kind}` is a keyword and can't be used as a binding name")
                    this.skip()
                    return Ok(this.mk_pat(start, PBind { name: start_tok.kind.clone(), is_mut: false }))
                }
                this.fail("E_INVALID_PATTERN", "expected a pattern, found ${describe(start_tok)}")
            }
        }
    }

    fun parse_pattern_literal(&mut this) -> Result[Expr, Sync] {
        let start = this.cur_span()
        if this.at("-") {
            this.skip()
            let k = this.kind()
            if k != "Int" && k != "Float" {
                return this.fail("E_INVALID_PATTERN", "expected a number after `-` in a pattern")
            }
            let inner = this.parse_primary()?
            return Ok(this.mk(start, Unary { op: "-", expr: Box(inner) }))
        }
        if !pattern_literal(this.kind()) {
            let found = describe(this.cur())
            return this.fail("E_INVALID_PATTERN", "expected a literal, found ${found}")
        }
        this.parse_primary()
    }

    fun maybe_range_pattern(&mut this, start: Span, lit: Expr) -> Result[Pattern, Sync] {
        if !this.at("..") && !this.at("..=") {
            return Ok(this.mk_pat(start, PLit(Box(lit))))
        }
        let op = this.advance().kind
        let tok = this.cur()
        let has_end = (pattern_literal(tok.kind) || tok.kind == "-") && !tok.nl_before
        var end: Box[Expr]? = None
        if has_end {
            end = Some(Box(this.parse_pattern_literal()?))
        }
        if end.is_none() && op == "..=" {
            return this.fail("E_INVALID_PATTERN", "`..=` needs an upper bound")
        }
        Ok(this.mk_pat(start, PRange { op, start: Some(Box(lit)), end }))
    }

    fun pattern_list(&mut this, close: &str) -> Result[t(Vec[Pattern], bool), Sync] {
        var elems = [] as Vec[Pattern]
        var rest = false
        for !this.at(close) && !this.at("EOF") {
            if this.at("..") {
                this.skip()
                rest = true
            } else {
                elems.push(this.parse_pattern()?)
            }
            if !this.eat(",") {
                break
            }
        }
        Ok(t(elems, rest))
    }

    fun pattern_fields(&mut this) -> Result[t(Vec[PatField], bool), Sync] {
        let open = this.advance()
        let saved = this.enter(true)
        let list = this.pattern_field_list()
        this.leave(saved)
        let fields = list?
        this.jump_to(this.closer_index(open))
        let _ = this.expect("}")?
        Ok(fields)
    }

    fun pattern_field_list(&mut this) -> Result[t(Vec[PatField], bool), Sync] {
        var fields = [] as Vec[PatField]
        var rest = false
        for !this.at("}") && !this.at("EOF") {
            if this.at("..") {
                this.skip()
                rest = true
            } else {
                let start = this.cur_span()
                let name = this.ident_name("a field name")?
                var pattern: Pattern? = None
                if this.eat(":") {
                    pattern = Some(this.parse_pattern()?)
                }
                fields.push(PatField { id: this.id(), span: this.sp(start), name, pattern })
            }
            if this.eat(",") {
                continue
            }
            if this.at("}") || this.nl() {
                continue
            }
            let found = describe(this.cur())
            return this.fail("E_UNEXPECTED_TOKEN", "expected `,` or `}` in the pattern, found ${found}")
        }
        Ok(t(fields, rest))
    }
}

/// The state of a `select` while its arms are parsed.
type SelectState = {
    arms: Vec[SelectArm] = []
    else_body: Box[Expr]? = None
    else_tok: Span? = None
    else_reported: bool = false
    saw_arm: bool = false
}
