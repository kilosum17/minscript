// The MinScript AST (spec §12), ported from minscript/src/ast.ts. Purely syntactic: no names are
// resolved and no types are known.
//
// - Recursive types go through `Box` (spec §7.3); lists are `Vec`.
// - Every node has a `span` (first to last token) and an `id`, unique in its file: later passes key
//   their side tables by id (the TypeScript passes key them by object identity).
// - Field names that are keywords get another name: `ty` (type), `is_mut`, `is_async`, `is_await`,
//   `else_branch`.
package ast

import "app.lexer.{Span}"

pub type File = {
    pub id: int
    pub span: Span
    /// `package app.users` → ["app", "users"]
    pub package_path: Vec[string]
    pub imports: Vec[Import]
    pub items: Vec[Item]
}

pub type Import = { pub id: int, pub span: Span, pub path: string, pub is_pub: bool, pub alias: string? }

pub union Item = {
    Fun(FunDecl)
    TypeDef(TypeDecl)
    Union(UnionDecl)
    Inter(InterDecl)
    Impl(ImplDecl)
    Let(LetDecl)
    Extern(ExternDecl)
}

pub type GenericParam = { pub id: int, pub span: Span, pub name: string, pub bounds: Vec[Type] }

pub type Param = { pub id: int, pub span: Span, pub name: string, pub is_mut: bool, pub variadic: bool, pub ty: Type }

pub type FunDecl = {
    pub id: int
    pub span: Span
    pub is_pub: bool
    pub is_async: bool
    pub name: string
    pub generics: Vec[GenericParam]
    /// "this", "&this", "&mut this" or "mut this"
    pub receiver: string?
    pub params: Vec[Param]
    pub ret: Type?
    /// None: a signature (in `inter` or `extern`)
    pub body: Block?
}

pub type Field = { pub id: int, pub span: Span, pub is_pub: bool, pub name: string, pub ty: Type, pub default: Expr? }

pub type TypeDecl = {
    pub id: int
    pub span: Span
    pub is_pub: bool
    pub name: string
    pub generics: Vec[GenericParam]
    /// `type X: A, B = …`
    pub impls: Vec[Type]
    pub body: TypeBody
}

/// `{ fields; methods }`, or an alias / literal union / record type.
pub union TypeBody = {
    Struct(StructBody)
    Alias(Type)
}

pub type StructBody = { pub id: int, pub span: Span, pub fields: Vec[Field], pub methods: Vec[FunDecl] }

pub type Variant = {
    pub id: int
    pub span: Span
    pub name: string
    /// `Mpesa(string)`
    pub tuple: Vec[Type]?
    /// `Card { number: string }`
    pub fields: Vec[Field]?
}

pub type UnionDecl = {
    pub id: int
    pub span: Span
    pub is_pub: bool
    pub name: string
    pub generics: Vec[GenericParam]
    pub impls: Vec[Type]
    pub variants: Vec[Variant]
    pub methods: Vec[FunDecl]
}

pub type InterDecl = {
    pub id: int
    pub span: Span
    pub is_pub: bool
    pub name: string
    pub generics: Vec[GenericParam]
    /// `inter A[T]: B[T] = …`
    pub supers: Vec[Type]
    /// None when declared as a composition
    pub methods: Vec[FunDecl]?
    pub composition: Type?
}

pub type ImplDecl = {
    pub id: int
    pub span: Span
    pub generics: Vec[GenericParam]
    /// empty for an inherent impl
    pub interfaces: Vec[Type]
    pub target: Type
    pub methods: Vec[FunDecl]
}

pub type LetDecl = { pub id: int, pub span: Span, pub is_pub: bool, pub name: string, pub ty: Type?, pub value: Expr }

pub type ExternDecl = { pub id: int, pub span: Span, pub abi: string, pub funs: Vec[FunDecl] }

// ---- types --------------------------------------------------------------------------------------

pub type Type = { pub id: int, pub span: Span, pub kind: TypeKind }

pub union TypeKind = {
    /// `Vec[int]`, `models.User`, `Self`
    TName { path: Vec[string], args: Vec[Type] }
    /// `T?`
    TOption(Box[Type])
    /// `&T`, `&mut T`
    TRef { is_mut: bool, inner: Box[Type] }
    /// `*T`, `*mut T`
    TPtr { is_mut: bool, inner: Box[Type] }
    /// `t(A, B)`
    TTuple(Vec[Type])
    /// `r{ x: f64 }`
    TRecord(Vec[Field])
    /// `(A) -> B` (wrapped in TRef for `&(A) -> B`)
    TFn { params: Vec[Type], ret: Box[Type] }
    /// `TypeOf(default_config)`
    TTypeOf(Vec[string])
    /// `"Admin"`, `404`, `true`
    TLiteral(Literal)
    /// `"A" | "B"`
    TUnion(Vec[Type])
    /// `Reader & Writer`
    TIntersection(Vec[Type])
    TError
}

pub union Literal = {
    LitStr(string)
    LitInt(string)
    LitBool(bool)
}

// ---- statements ---------------------------------------------------------------------------------

pub type Block = { pub id: int, pub span: Span, pub stmts: Vec[Stmt] }

pub union Stmt = {
    Let(LetStmt)
    ExprStmt(ExprStmtNode)
}

pub type LetStmt = {
    pub id: int
    pub span: Span
    /// var / :==
    pub mutable: bool
    /// := / :==
    pub short: bool
    pub pattern: Pattern
    pub ty: Type?
    pub value: Expr
    /// `let pat = e else { … }`
    pub else_branch: Block?
}

pub type ExprStmtNode = { pub id: int, pub span: Span, pub expr: Expr, pub semi: bool }

// ---- expressions --------------------------------------------------------------------------------

pub type Expr = { pub id: int, pub span: Span, pub kind: ExprKind }

/// An element of a list literal or an argument list: a value, or `...spread`.
pub union Elem = {
    EValue(Expr)
    ESpread { span: Span, expr: Expr }
}

/// A field of a record / struct literal: `key: value`, the shorthand `key`, or `...spread`.
pub union RecordItem = {
    RField(RecordField)
    RSpread { span: Span, expr: Expr }
}

/// value None: the shorthand `r{ name }`
pub type RecordField = { pub id: int, pub span: Span, pub key: string, pub value: Expr? }

pub union MapItem = {
    MEntry(MapEntry)
    MSpread { span: Span, expr: Expr }
}

pub type MapEntry = { pub id: int, pub span: Span, pub key: Expr, pub value: Expr }

/// "move", "ref" or "mut"
pub type Capture = { pub id: int, pub span: Span, pub name: string, pub mode: string }

pub type ClosureParam = { pub id: int, pub span: Span, pub name: string, pub is_mut: bool, pub ty: Type? }

pub type MatchArm = {
    pub id: int
    pub span: Span
    /// None in a subject-less match (except `_`)
    pub pattern: Pattern?
    /// subject-less match: the condition
    pub test: Expr?
    pub guard: Expr?
    pub body: Expr
}

pub type SelectArm = { pub id: int, pub span: Span, pub pattern: Pattern?, pub expr: Expr, pub body: Expr }

pub type LetCond = { pub id: int, pub span: Span, pub pattern: Pattern, pub value: Box[Expr] }

/// An `if` condition: an expression, or `let pattern = value`.
pub union Cond = {
    CExpr(Box[Expr])
    CLet(LetCond)
}

pub union TemplatePart = {
    Text(string)
    Interp(Expr)
}

pub union ExprKind = {
    Ident(string)
    This
    /// decimal digits
    Int(string)
    Float(f64)
    Str { value: string, raw: bool }
    Template(Vec[TemplatePart])
    Char(string)
    Bool(bool)
    Nil
    Paren(Box[Expr])
    VecLit(Vec[Elem])
    ArrayLit(Vec[Elem])
    TupleLit(Vec[Elem])
    RecordLit(Vec[RecordItem])
    MapLit(Vec[MapItem])
    SetLit(Vec[Elem])
    /// `_{ … }`
    Inferred(Vec[RecordItem])
    /// type: a path, possibly with `.[T]`
    StructLit { ty: Box[Expr], fields: Vec[RecordItem] }
    /// captures None: `#{`; params None: no header (implicit `it`)
    Closure { captures: Vec[Capture]?, params: Vec[ClosureParam]?, ret: Type?, body: Block }
    /// op: "-", "!", "&", "&mut", "*"
    Unary { op: string, expr: Box[Expr] }
    Await(Box[Expr])
    Binary { op: string, left: Box[Expr], right: Box[Expr] }
    Assign { op: string, target: Box[Expr], value: Box[Expr] }
    /// op: ".." or "..=" (not `Range`: an unqualified pattern name resolves through the prelude first, spec §6)
    RangeExpr { op: string, start: Box[Expr]?, end: Box[Expr]? }
    As { expr: Box[Expr], ty: Type }
    Or { expr: Box[Expr], name: string?, name_span: Span?, rhs: Box[Expr] }
    /// index: a tuple index (`t.0`)
    Member { object: Box[Expr], name: string, index: bool }
    /// `x?.name`
    OptMember { object: Box[Expr], name: string, index: bool }
    Call { callee: Box[Expr], args: Vec[Elem] }
    IndexExpr { object: Box[Expr], index: Box[Expr] }
    /// `f.[T]`
    GenericApply { target: Box[Expr], args: Vec[Type] }
    /// postfix `?`
    Try(Box[Expr])
    /// else_branch: a Block expression, or a nested If
    If { cond: Cond, then: Block, else_branch: Box[Expr]? }
    Match { subject: Box[Expr]?, arms: Vec[MatchArm] }
    Select { arms: Vec[SelectArm], else_branch: Box[Expr]? }
    /// form: "infinite", "cond", "let" or "in"; expr: the condition, the let value, or the iterable
    For { label: string?, form: string, is_await: bool, pattern: Pattern?, pattern2: Pattern?, expr: Box[Expr]?, body: Block }
    BlockExpr(Block)
    Unsafe(Block)
    Recover(Block)
    Return(Box[Expr]?)
    Break { label: string?, value: Box[Expr]? }
    Continue(string?)
    Error
}

// ---- patterns -----------------------------------------------------------------------------------

/// pattern None: the shorthand
pub type PatField = { pub id: int, pub span: Span, pub name: string, pub pattern: Pattern? }

pub type Pattern = { pub id: int, pub span: Span, pub kind: PatternKind }

pub union PatternKind = {
    PWild
    PBind { name: string, is_mut: bool }
    /// Int / Float / Str / Char / Bool / Nil (with `-`)
    PLit(Box[Expr])
    PRange { op: string, start: Box[Expr]?, end: Box[Expr]? }
    /// `None`, `Payment.Cash`
    PPath(Vec[string])
    /// `Ok(v)`
    PCall { path: Vec[string], args: Vec[Pattern], rest: bool }
    /// path None: `r{ … }`
    PStruct { path: Vec[string]?, fields: Vec[PatField], rest: bool }
    /// `t(a, b, ..)`
    PTuple { elems: Vec[Pattern], rest: bool }
    POr(Vec[Pattern])
    PError
}
