package syntax

// AST nodes are identity types (spec §11.1): one heap object each, immutable after construction,
// hashed by pointer, and recursive without `Box` (an identity value is already a pointer).
// Passes never mutate a node; they fill `once` fields (§11.2) or keep side tables keyed by node.

pub union Expr {
    Num(NumLit)
    Var(Ident)
    Neg(Unary)
    Bin(Binary)
    Call(CallExpr)

    pub fn span(this) -> Span {
        match this {
            Num(n) => n.span
            Var(id) => id.span
            Neg(u) => u.span
            Bin(b) => b.span
            Call(c) => c.span
        }
    }
}

pub type NumLit: Identity {
    pub value: f64
    pub span: Span
}

/// One occurrence of a name. The resolver sets `decl` exactly once; the evaluator reads it.
pub type Ident: Identity {
    pub name: Symbol
    pub span: Span
    pub once decl: Decl            // reads as `Decl?`: None until the resolver has run
}

pub type Unary: Identity {
    pub operand: Expr
    pub span: Span
}

pub type Binary: Identity {
    pub op: Punct
    pub left: Expr
    pub right: Expr
    pub span: Span
}

pub type CallExpr: Identity {
    pub callee: Ident
    pub args: Vec[Expr]
    pub span: Span
}

pub type LetDecl: Identity {
    pub name: Ident
    pub value: Expr
}

pub type FnDecl: Identity {
    pub name: Ident
    pub params: Vec[Ident]
    pub body: Expr
}

pub union Stmt {
    LetStmt(LetDecl)
    FnStmt(FnDecl)
    PrintStmt(Expr)
}

/// What a name refers to. Every payload is an identity value, so a `Decl` hashes by pointer and
/// `Map[Decl, int]` needs no ids.
pub union Decl {
    Global(LetDecl)
    Func(FnDecl)
    Param(Ident)                   // the parameter's own Ident node
}
