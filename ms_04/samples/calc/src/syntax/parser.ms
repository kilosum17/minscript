package syntax

pub type ParseError {
    pub msg: str
    pub span: Span
}

type Parser {
    tokens: Vec[Token]
    pos: int = 0
    errors: Vec[ParseError] = []

    /// A view of the current token (returns_view [this.tokens[*]]): a pointer into the Vec, no copy.
    fn peek(this) -> Token { this.tokens[this.pos] }

    /// Writes [this.pos] only. The returned view is of `this.tokens`, a disjoint path, so callers
    /// may hold it while they call other `*this` methods that write `errors` (§9.5 paths).
    fn bump(*this) -> Token {
        tok := this.peek()
        if this.pos < this.tokens.len() - 1 { this.pos += 1 }
        tok
    }

    fn at(this, p: Punct) -> bool {
        match this.peek().kind {
            Punct(q) => q == p
            _ => false
        }
    }

    fn error(*this, msg: str) {
        span := this.peek().span
        this.errors.push(ParseError { msg, span })
    }

    fn expect(*this, p: Punct) {
        if this.at(p) {
            this.bump()
            return
        }
        this.error("expected `${p}`, found `${this.peek().text}`")
    }

    fn ident(*this) -> Ident? {
        tok := this.bump()
        let Some(name) = tok.name else {
            this.error("expected a name, found `${tok.text}`")
            return None
        }
        Some(Ident { name, span: tok.span })        // `decl` is a once field: left unset here
    }

    /// Skips to the next line after an error, so one mistake gives one diagnostic.
    fn sync(*this) {
        for {
            match this.bump().kind {
                Newline | Eof => break
                _ => {}
            }
        }
    }

    // ---- statements --------------------------------------------------------------------------

    fn stmt(*this) -> Stmt? {
        match this.peek().kind {
            Let => {
                this.bump()
                name := this.ident()?
                this.expect("=")
                Some(LetStmt(LetDecl { name, value: this.expr(0)? }))
            }
            Fn => {
                this.bump()
                name := this.ident()?
                this.expect("(")
                var params = [] as Vec[Ident]
                for !this.at(")") {
                    params.push(this.ident()?)
                    if !this.at(",") { break }
                    this.bump()
                }
                this.expect(")")
                this.expect("=")
                Some(FnStmt(FnDecl { name, params, body: this.expr(0)? }))
            }
            Print => {
                this.bump()
                Some(PrintStmt(this.expr(0)?))
            }
            _ => Some(PrintStmt(this.expr(0)?))      // a bare expression prints too
        }
    }

    // ---- expressions: Pratt parsing ----------------------------------------------------------

    fn expr(*this, min: int) -> Expr? {
        var left = this.atom()?
        for {
            let Punct(op) = this.peek().kind else { break }
            p := prec(op)
            if p <= min { break }
            this.bump()
            right := this.expr(p)?
            span := left.span().to(right.span())
            // `left` moves into the new node (its last use), then the binding is reused
            left = Bin(Binary { op, left, right, span })
        }
        Some(left)
    }

    fn atom(*this) -> Expr? {
        tok := this.bump()                          // a view, held across `this.error(...)` below
        match tok.kind {
            Num => {
                let v = tok.text.to_float() or {
                    this.error("bad number `${tok.text}`")
                    return None
                }
                Some(Num(NumLit { value: v, span: tok.span }))
            }
            Name => {
                id := Ident { name: tok.name ?? sym(tok.text), span: tok.span }
                if !this.at("(") { return Some(Var(id)) }
                this.bump()
                var args = [] as Vec[Expr]
                for !this.at(")") {
                    args.push(this.expr(0)?)
                    if !this.at(",") { break }
                    this.bump()
                }
                end := this.peek().span
                this.expect(")")
                Some(Call(CallExpr { callee: id, args, span: tok.span.to(end) }))
            }
            Punct("-") => {
                operand := this.expr(2)?               // binds tighter than * and /
                Some(Neg(Unary { operand, span: tok.span.to(operand.span()) }))
            }
            Punct("(") => {
                inner := this.expr(0)?
                this.expect(")")
                Some(inner)
            }
            _ => {
                this.error("expected an expression, found `${tok.text}`")
                None
            }
        }
    }
}

fn prec(op: Punct) -> int {
    match op {
        "+" | "-" => 1
        "*" | "/" => 2
        _ => 0
    }
}

/// Takes the tokens by value: this is their last use in the caller, so they move in (§9.1).
pub fn parse(tokens: Vec[Token]) -> t(Vec[Stmt], Vec[ParseError]) {
    var p = Parser { tokens }
    var stmts = [] as Vec[Stmt]
    for p.peek().kind != Eof {
        if p.peek().kind == Newline {
            p.bump()
            continue
        }
        if let Some(s) = p.stmt() { stmts.push(s) } else { p.sync() }
    }
    t(stmts, p.errors)
}
