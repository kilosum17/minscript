package syntax

// The MinScript AST (spec §2–§8, grammar §19), the shape of the TypeScript compiler's src/ast.ts.
// Purely syntactic: no names are resolved and no types are known.
//
// Each kind of node is a struct with a span and a `k` union saying which kind it is: one span per
// node instead of one per variant, and `match e.k { Binary { op, .. } => … }` reads the kind.
// Fields the TypeScript AST calls `type` / `else` / `package` are `ty` / `els` / `pkg` here: keywords can't be field
// names. The values are plain values (no `Identity` yet): the parser builds a tree and nothing
// refers to a node by identity until name resolution, which will need side tables or identity.

pub type Span {
    pub start: int
    pub end: int
}

// ---- files and items ---------------------------------------------------------------------------

pub type File {
    pub pkg: Vec[str]
    pub imports: Vec[Import]
    pub items: Vec[Item]
    pub span: Span
}

pub type Import {
    pub is_pub: bool
    pub path: str
    pub alias: str?
    pub span: Span
}

pub type Attribute {
    pub name: str
    pub args: Vec[AttrArg]
    pub span: Span
}

pub type AttrArg {
    pub name: str
    pub paths: Vec[str]
    pub span: Span
}

pub type GenericParam {
    pub name: str
    pub bounds: Vec[Type]
    pub span: Span
}

pub type Param {
    pub name: str
    /// `x: *T`
    pub star: bool
    pub variadic: bool
    pub ty: Type
    pub span: Span
}

pub type FnDecl {
    pub attrs: Vec[Attribute]
    pub is_pub: bool
    pub is_async: bool
    pub name: str
    pub generics: Vec[GenericParam]
    /// "this", "*this", or None
    pub receiver: str?
    pub params: Vec[Param]
    /// `-> *T`
    pub ret_star: bool
    pub ret: Type?
    /// None: a signature (in `inter` or `extern`)
    pub body: Block?
    pub span: Span
}

pub type FieldDecl {
    pub attrs: Vec[Attribute]
    pub is_pub: bool
    /// "shared", "once", or None
    pub mode: str?
    pub name: str
    pub ty: Type
    pub default: Expr?
    pub span: Span
}

pub union Member {
    MField(FieldDecl)
    MFn(FnDecl)
}

pub type Variant {
    pub name: str
    /// `A(T, U)`
    pub tuple: Vec[Type]?
    /// `A { x: T }`
    pub fields: Vec[FieldDecl]?
    pub span: Span
}

pub union UnionMember {
    UVariant(Variant)
    UFn(FnDecl)
}

pub type Item {
    pub k: ItemKind
    pub span: Span
}

pub union ItemKind {
    IFn(FnDecl)
    TypeDecl { attrs: Vec[Attribute], is_pub: bool, name: str, generics: Vec[GenericParam], impls: Vec[Type], members: Vec[Member]?, alias: Type? }
    UnionDecl { attrs: Vec[Attribute], is_pub: bool, name: str, generics: Vec[GenericParam], impls: Vec[Type], members: Vec[UnionMember] }
    InterDecl { attrs: Vec[Attribute], is_pub: bool, name: str, generics: Vec[GenericParam], supers: Vec[Type], methods: Vec[FnDecl]?, alias: Type? }
    ImplDecl { attrs: Vec[Attribute], generics: Vec[GenericParam], inters: Vec[Type], target: Type, methods: Vec[FnDecl] }
    LetDecl { attrs: Vec[Attribute], is_pub: bool, name: str, ty: Type?, value: Expr }
    VarDecl { attrs: Vec[Attribute], is_pub: bool, shared: bool, name: str, ty: Type?, value: Expr }
    ExternDecl { attrs: Vec[Attribute], abi: str, fns: Vec[FnDecl] }
}

// ---- types -------------------------------------------------------------------------------------

pub type Type {
    pub k: TypeKind
    pub span: Span
}

pub union LitValue {
    LStr(str)
    /// decimal digits
    LInt(str)
    LBool(bool)
}

pub type TField {
    pub name: str
    pub ty: Type
    pub span: Span
}

/// `T` or `*T`, as a parameter of a function type.
pub type ModeType {
    pub star: bool
    pub ty: Type
}

pub union TypeKind {
    TName { path: Vec[str], args: Vec[Type] }
    TOptional { inner: Type }
    TTuple { elems: Vec[Type] }
    TRecord { fields: Vec[TField] }
    TFn { params: Vec[ModeType], ret: Type }
    /// literal union: `"A" | "B"` (right of `type X =`)
    TUnion { alts: Vec[Type] }
    /// `A & B`
    TInter { parts: Vec[Type] }
    TTypeOf { path: Vec[str] }
    TLit { value: LitValue }
    TError
}

// ---- statements --------------------------------------------------------------------------------

pub type Stmt {
    pub k: StmtKind
    pub span: Span
}

pub union StmtKind {
    LetStmt { pattern: Pattern, ty: Type?, value: Expr, els: Block? }
    VarStmt { shared: bool, name: str, ty: Type?, value: Expr }
    /// `x := e` / `x :== e`
    ShortDecl { name: str, mutable: bool, value: Expr }
    /// `semi`: written with a trailing `;`
    ExprStmt { expr: Expr, semi: bool }
}

pub type Block {
    pub stmts: Vec[Stmt]
    pub span: Span
}

// ---- expressions -------------------------------------------------------------------------------

pub type Expr {
    pub k: ExprKind
    pub span: Span
}

/// An element of a Vec / array / tuple / set literal, or a call argument: `...xs` spreads.
pub type Elem {
    pub spread: bool
    pub value: Expr
    pub span: Span
}

/// `name: value`, `name` (shorthand), `"key": value` (records only), `...base`
pub union RecItem {
    RField { name: str, quoted: bool, value: Expr?, span: Span }
    RSpread { value: Expr, span: Span }
}

pub union MapEntry {
    MEntry { key: Expr, value: Expr, span: Span }
    MSpread { value: Expr, span: Span }
}

pub type ClosureParam {
    pub name: str
    pub is_var: bool
    pub star: bool
    pub ty: Type?
    pub span: Span
}

pub type Arm {
    /// None in a subject-less match: `cond => body`
    pub pattern: Pattern?
    pub guard: Expr?
    /// subject-less match: the condition
    pub cond: Expr?
    pub body: Expr
    pub span: Span
}

pub type SelectArm {
    pub pattern: Pattern?
    pub expr: Expr
    pub body: Expr
    pub span: Span
}

pub union ExprKind {
    Ident { name: str }
    This
    SelfExpr
    /// decimal digits
    Int { value: str }
    Float { value: f64 }
    Str { value: str, raw: bool, multiline: bool }
    /// `parts.len() == exprs.len() + 1`
    Template { parts: Vec[str], exprs: Vec[Expr], multiline: bool }
    Char { value: str }
    Byte { value: int }
    Bool { value: bool }
    Nil
    VecLit { elems: Vec[Elem] }
    ArrayLit { elems: Vec[Elem] }
    TupleLit { elems: Vec[Elem] }
    SetLit { elems: Vec[Elem] }
    Record { items: Vec[RecItem] }
    Inferred { items: Vec[RecItem] }
    /// `ty`: an Ident, Member chain or GenericApply over one
    Struct { ty: Expr, items: Vec[RecItem] }
    MapLit { entries: Vec[MapEntry] }
    /// `params`: None when there is no header (`it`)
    Closure { params: Vec[ClosureParam]?, ret: Type?, body: Vec[Stmt] }
    Paren { expr: Expr }
    Unary { op: str, operand: Expr }
    Await { operand: Expr }
    Binary { op: str, left: Expr, right: Expr }
    Assign { op: str, target: Expr, value: Expr }
    Range { inclusive: bool, start: Expr?, end: Expr? }
    As { expr: Expr, ty: Type }
    /// `or e => …` names the error `name`
    Or { expr: Expr, name: str?, rhs: Expr }
    Call { callee: Expr, args: Vec[Elem] }
    Index { target: Expr, index: Expr }
    /// `name`: a name, or a tuple index ("0")
    MemberE { target: Expr, name: str, optional: bool }
    GenericApply { target: Expr, args: Vec[Type] }
    Try { expr: Expr }
    /// `pattern`: `if let pattern = cond`; `els`: a Block or an If
    If { pattern: Pattern?, cond: Expr, then: Block, els: Expr? }
    Match { subject: Expr?, arms: Vec[Arm] }
    Select { arms: Vec[SelectArm], els: Expr? }
    Lock { places: Vec[Expr], body: Block }
    /// `form`: "infinite", "cond", "let" or "in"; `pattern2`: the second pattern of `for a, b in`
    For { label: str?, form: str, is_await: bool, pattern: Pattern?, pattern2: Pattern?, expr: Expr?, body: Block }
    BlockE(Block)
    Unsafe { body: Block }
    Recover { body: Block }
    Return { value: Expr? }
    Break { label: str?, value: Expr? }
    Continue { label: str? }
    ErrorE
}

// ---- patterns ----------------------------------------------------------------------------------

pub type Pattern {
    pub k: PatternKind
    pub span: Span
}

pub type FieldPat {
    pub name: str
    /// None: shorthand binding (`{ name }`, `{ var name }`)
    pub pattern: Pattern?
    pub is_var: bool
    pub span: Span
}

pub union PatternKind {
    PWild
    PBind { name: str, is_var: bool }
    PLit { value: Expr }
    PRange { start: Expr, end: Expr, inclusive: bool }
    /// `A(x, y)` (`args`) or `A { x, .. }` (`fields`)
    PCtor { path: Vec[str], args: Vec[Pattern]?, fields: Vec[FieldPat]?, rest: bool }
    PTuple { elems: Vec[Pattern], rest: bool }
    PRecord { fields: Vec[FieldPat], rest: bool }
    POr { alts: Vec[Pattern] }
    PError
}
