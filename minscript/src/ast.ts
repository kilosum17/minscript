// MinScript AST (spec §12). Purely syntactic: no names are resolved and no types are known.
// Every node has a `kind` and a `span` covering its first to last token.

import type { Span } from "./token.ts"

type N<K extends string, F = {}> = { kind: K, span: Span } & F

// ---- file and items ---------------------------------------------------------------------------

export type File = N<"File", {
    package: string[]            // `package app.users` → ["app", "users"]
    imports: Import[]
    items: Item[]
}>

export type Import = N<"Import", { path: string, pub: boolean, alias: string | null }>

export type Item = FunDecl | TypeDecl | UnionDecl | InterDecl | ImplDecl | LetDecl | ExternDecl

export type GenericParam = N<"GenericParam", { name: string, bounds: Type[] }>

export type Receiver = "this" | "&this" | "&mut this" | "mut this"

export type Param = N<"Param", { name: string, mut: boolean, variadic: boolean, type: Type }>

export type FunDecl = N<"FunDecl", {
    pub: boolean
    async: boolean
    name: string
    generics: GenericParam[]
    receiver: Receiver | null
    params: Param[]
    ret: Type | null
    body: Block | null           // null: a signature (in `inter` or `extern`)
}>

export type Field = N<"Field", { pub: boolean, name: string, type: Type, default: Expr | null }>

export type TypeDecl = N<"TypeDecl", {
    pub: boolean
    name: string
    generics: GenericParam[]
    impls: Type[]                // `type X: A, B = …`
    body: StructBody | Type      // `{ fields; methods }` or an alias / literal union / record type
}>

export type StructBody = N<"StructBody", { fields: Field[], methods: FunDecl[] }>

export type Variant = N<"Variant", {
    name: string
    tuple: Type[] | null         // `Mpesa(string)`
    fields: Field[] | null       // `Card { number: string }`
}>

export type UnionDecl = N<"UnionDecl", {
    pub: boolean
    name: string
    generics: GenericParam[]
    impls: Type[]
    variants: Variant[]
    methods: FunDecl[]
}>

export type InterDecl = N<"InterDecl", {
    pub: boolean
    name: string
    generics: GenericParam[]
    supers: Type[]               // `inter A[T]: B[T] = …`
    methods: FunDecl[] | null    // null when declared as a composition
    composition: Type | null     // `inter ReadWriter = Reader & Writer`
}>

export type ImplDecl = N<"ImplDecl", {
    generics: GenericParam[]
    interfaces: Type[]           // empty for an inherent impl
    target: Type
    methods: FunDecl[]
}>

export type LetDecl = N<"LetDecl", { pub: boolean, name: string, type: Type | null, value: Expr }>

export type ExternDecl = N<"ExternDecl", { abi: string, funs: FunDecl[] }>

// ---- types ------------------------------------------------------------------------------------

export type Type =
    | N<"TName", { path: string[], args: Type[] }>                 // `Vec[int]`, `models.User`, `Self`
    | N<"TOption", { inner: Type }>                                // `T?`
    | N<"TRef", { mut: boolean, inner: Type }>                     // `&T`, `&mut T`
    | N<"TPtr", { mut: boolean, inner: Type }>                     // `*T`, `*mut T`
    | N<"TTuple", { elems: Type[] }>                               // `t(A, B)`
    | N<"TRecord", { fields: Field[] }>                            // `r{ x: f64 }`
    | N<"TFn", { params: Type[], ret: Type }>                      // `(A) -> B` (wrap in TRef for `&(A) -> B`)
    | N<"TTypeOf", { path: string[] }>                             // `TypeOf(default_config)`
    | N<"TLiteral", { value: string | bigint | boolean }>          // `"Admin"`, `404`, `true`
    | N<"TUnion", { members: Type[] }>                             // `"A" | "B"`
    | N<"TIntersection", { members: Type[] }>                      // `Reader & Writer`
    | N<"TError">

// ---- statements -------------------------------------------------------------------------------

export type Block = N<"Block", { stmts: Stmt[] }>

export type Stmt =
    | N<"Let", {
        mutable: boolean         // var / :==
        short: boolean           // := / :==
        pattern: Pattern
        type: Type | null
        value: Expr
        else: Block | null       // `let pat = e else { … }`
    }>
    | N<"ExprStmt", { expr: Expr, semi: boolean }>

// ---- expressions ------------------------------------------------------------------------------

export type Spread = N<"Spread", { expr: Expr }>
export type RecordField = N<"RecordField", { key: string, value: Expr | null }>   // value null: shorthand `r{ name }`
export type MapEntry = N<"MapEntry", { key: Expr, value: Expr }>
export type Capture = N<"Capture", { name: string, mode: "move" | "ref" | "mut" }>
export type ClosureParam = N<"ClosureParam", { name: string, mut: boolean, type: Type | null }>
export type MatchArm = N<"MatchArm", {
    pattern: Pattern | null      // null in a subject-less match (except `_`)
    test: Expr | null            // subject-less match: the condition
    guard: Expr | null
    body: Expr
}>
export type SelectArm = N<"SelectArm", { pattern: Pattern | null, expr: Expr, body: Expr }>
export type LetCond = N<"LetCond", { pattern: Pattern, value: Expr }>

export type Expr =
    | N<"Ident", { name: string }>
    | N<"This">
    | N<"Int", { value: bigint }>
    | N<"Float", { value: number }>
    | N<"Str", { value: string, raw: boolean }>
    | N<"Template", { parts: (string | Expr)[] }>
    | N<"Char", { value: string }>
    | N<"Bool", { value: boolean }>
    | N<"Nil">
    | N<"Paren", { expr: Expr }>
    | N<"Vec", { elems: (Expr | Spread)[] }>
    | N<"Array", { elems: (Expr | Spread)[] }>
    | N<"Tuple", { elems: (Expr | Spread)[] }>
    | N<"Record", { fields: (RecordField | Spread)[] }>
    | N<"Map", { entries: (MapEntry | Spread)[] }>
    | N<"Set", { elems: (Expr | Spread)[] }>
    | N<"Inferred", { fields: (RecordField | Spread)[] }>             // `_{ … }`
    | N<"StructLit", { type: Expr, fields: (RecordField | Spread)[] }>   // type: a path, possibly with `.[T]`
    | N<"Closure", {
        captures: Capture[] | null     // null: `#{`, otherwise `#[…]{`
        params: ClosureParam[] | null  // null: no header (implicit `it`)
        ret: Type | null
        body: Block
    }>
    | N<"Unary", { op: "-" | "!" | "&" | "&mut" | "*", expr: Expr }>
    | N<"Await", { expr: Expr }>
    | N<"Binary", { op: string, left: Expr, right: Expr }>
    | N<"Assign", { op: string, target: Expr, value: Expr }>
    | N<"Range", { op: ".." | "..=", start: Expr | null, end: Expr | null }>
    | N<"As", { expr: Expr, type: Type }>
    | N<"Or", { expr: Expr, name: string | null, nameSpan: Span | null, rhs: Expr }>
    | N<"Member", { object: Expr, name: string | number }>             // number: tuple index `t.0`
    | N<"OptMember", { object: Expr, name: string | number }>          // `x?.name`
    | N<"Call", { callee: Expr, args: (Expr | Spread)[] }>
    | N<"Index", { object: Expr, index: Expr }>
    | N<"GenericApply", { target: Expr, args: Type[] }>               // `f.[T]`
    | N<"Try", { expr: Expr }>                                          // postfix `?`
    | N<"If", { cond: Expr | LetCond, then: Block, else: Block | Expr | null }>   // else: Block or nested If
    | N<"Match", { subject: Expr | null, arms: MatchArm[] }>
    | N<"Select", { arms: SelectArm[], else: Expr | null }>
    | N<"For", {
        label: string | null
        form: "infinite" | "cond" | "let" | "in"
        await: boolean               // `for await x in e`
        pattern: Pattern | null      // let / in
        pattern2: Pattern | null     // `for item, idx in …`
        expr: Expr | null            // cond, the let value, or the iterable
        body: Block
    }>
    | N<"Block", { stmts: Stmt[] }>
    | N<"Unsafe", { body: Block }>
    | N<"Recover", { body: Block }>
    | N<"Return", { value: Expr | null }>
    | N<"Break", { label: string | null, value: Expr | null }>
    | N<"Continue", { label: string | null }>
    | N<"Error">

// ---- patterns ---------------------------------------------------------------------------------

export type PatField = N<"PatField", { name: string, pattern: Pattern | null }>   // pattern null: shorthand

export type Pattern =
    | N<"PWild">
    | N<"PBind", { name: string, mut: boolean }>
    | N<"PLit", { value: Expr }>                                       // Int / Float / Str / Char / Bool / Nil (with `-`)
    | N<"PRange", { op: ".." | "..=", start: Expr | null, end: Expr | null }>
    | N<"PPath", { path: string[] }>                                   // `None`, `Payment.Cash`
    | N<"PCall", { path: string[], args: Pattern[], rest: boolean }>   // `Ok(v)`
    | N<"PStruct", { path: string[] | null, fields: PatField[], rest: boolean }>   // path null: `r{ … }`
    | N<"PTuple", { elems: Pattern[], rest: boolean }>                 // `t(a, b, ..)`
    | N<"POr", { alts: Pattern[] }>
    | N<"PError">

export type Node = File | Import | Item | Type | Stmt | Expr | Pattern | StructBody | Variant | Field | Param | GenericParam
    | Spread | RecordField | MapEntry | Capture | ClosureParam | MatchArm | SelectArm | LetCond | PatField
