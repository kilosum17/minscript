// The MinScript AST (spec §2–§8, grammar §19). Purely syntactic: no names are resolved and no
// types are known. Every node has a `kind` and a byte `span`. Later passes keep their results in
// side tables keyed by node, so the tree is never modified after parsing.

export type Span = { start: number; end: number };

interface Node {
    span: Span;
}

// ---- files and items ---------------------------------------------------------------------------

export interface File extends Node {
    kind: "File";
    package: string[];
    imports: Import[];
    items: Item[];
}

export interface Import extends Node {
    kind: "Import";
    isPub: boolean;
    path: string;
    alias: string | null;
}

export interface Attribute extends Node {
    kind: "Attribute";
    name: string;
    args: AttrArg[];
}

export interface AttrArg extends Node {
    name: string;
    paths: string[];
}

export type Item = FnDecl | TypeDecl | UnionDecl | InterDecl | ImplDecl | LetDecl | VarDecl | ExternDecl;

export interface GenericParam extends Node {
    name: string;
    bounds: Type[];
}

export interface Param extends Node {
    name: string;
    /** `x: *T` */
    star: boolean;
    variadic: boolean;
    type: Type;
}

export interface FnDecl extends Node {
    kind: "Fn";
    attrs: Attribute[];
    isPub: boolean;
    isAsync: boolean;
    name: string;
    generics: GenericParam[];
    receiver: "this" | "*this" | null;
    params: Param[];
    /** `-> *T` */
    retStar: boolean;
    ret: Type | null;
    /** null: a signature (in `inter` or `extern`) */
    body: Block | null;
}

export interface Field extends Node {
    kind: "Field";
    attrs: Attribute[];
    isPub: boolean;
    mode: "shared" | "once" | null;
    name: string;
    type: Type;
    default: Expr | null;
}

export type TypeMember = Field | FnDecl;

export interface TypeDecl extends Node {
    kind: "TypeDecl";
    attrs: Attribute[];
    isPub: boolean;
    name: string;
    generics: GenericParam[];
    impls: Type[];
    /** nominal body, or null for an alias */
    members: TypeMember[] | null;
    alias: Type | null;
}

export interface Variant extends Node {
    kind: "Variant";
    name: string;
    /** `A(T, U)` */
    tuple: Type[] | null;
    /** `A { x: T }` */
    fields: Field[] | null;
}

export interface UnionDecl extends Node {
    kind: "UnionDecl";
    attrs: Attribute[];
    isPub: boolean;
    name: string;
    generics: GenericParam[];
    impls: Type[];
    members: (Variant | FnDecl)[];
}

export interface InterDecl extends Node {
    kind: "InterDecl";
    attrs: Attribute[];
    isPub: boolean;
    name: string;
    generics: GenericParam[];
    supers: Type[];
    /** body methods, or null for an alias */
    methods: FnDecl[] | null;
    alias: Type | null;
}

export interface ImplDecl extends Node {
    kind: "ImplDecl";
    attrs: Attribute[];
    generics: GenericParam[];
    inters: Type[];
    target: Type;
    methods: FnDecl[];
}

export interface LetDecl extends Node {
    kind: "LetDecl";
    attrs: Attribute[];
    isPub: boolean;
    name: string;
    type: Type | null;
    value: Expr;
}

export interface VarDecl extends Node {
    kind: "VarDecl";
    attrs: Attribute[];
    isPub: boolean;
    shared: boolean;
    name: string;
    type: Type | null;
    value: Expr;
}

export interface ExternDecl extends Node {
    kind: "ExternDecl";
    attrs: Attribute[];
    abi: string;
    fns: FnDecl[];
}

// ---- types -------------------------------------------------------------------------------------

export type Type =
    | NamedType | OptionalType | TupleType | RecordType | FnType | UnionType | InterType | TypeOfType | LiteralType
    | ErrorType;

export interface NamedType extends Node {
    kind: "TName";
    path: string[];
    args: Type[];
}
export interface OptionalType extends Node {
    kind: "TOptional";
    inner: Type;
}
export interface TupleType extends Node {
    kind: "TTuple";
    elems: Type[];
}
export interface RecordType extends Node {
    kind: "TRecord";
    fields: { name: string; type: Type; span: Span }[];
}
export interface FnType extends Node {
    kind: "TFn";
    params: { star: boolean; type: Type }[];
    ret: Type;
}
/** literal union: `"A" | "B"` (right of `type X =`) */
export interface UnionType extends Node {
    kind: "TUnion";
    alts: Type[];
}
/** `A & B` */
export interface InterType extends Node {
    kind: "TInter";
    parts: Type[];
}
export interface TypeOfType extends Node {
    kind: "TTypeOf";
    path: string[];
}
export interface LiteralType extends Node {
    kind: "TLit";
    value: string | bigint | boolean;
}
export interface ErrorType extends Node {
    kind: "TError";
}

// ---- statements --------------------------------------------------------------------------------

export type Stmt = LetStmt | VarStmt | ShortDecl | ExprStmt;

export interface LetStmt extends Node {
    kind: "LetStmt";
    pattern: Pattern;
    type: Type | null;
    value: Expr;
    else: Block | null;
}

export interface VarStmt extends Node {
    kind: "VarStmt";
    shared: boolean;
    name: string;
    type: Type | null;
    value: Expr;
}

/** `x := e` / `x :== e` */
export interface ShortDecl extends Node {
    kind: "ShortDecl";
    name: string;
    mutable: boolean;
    value: Expr;
}

export interface ExprStmt extends Node {
    kind: "ExprStmt";
    expr: Expr;
    /** written with a trailing `;` */
    semi: boolean;
}

export interface Block extends Node {
    kind: "Block";
    stmts: Stmt[];
}

// ---- expressions -------------------------------------------------------------------------------

export type Expr =
    | Ident | This | SelfExpr | IntLit | FloatLit | StrLit | Template | CharLit | ByteLit | BoolLit | NilLit
    | VecLit | ArrayLit | TupleLit | RecordLit | InferredLit | StructLit | MapLit | SetLit | Closure
    | Paren | Unary | Await | Binary | Assign | Range | As | Or | Call | Index | Member | GenericApply | Try
    | If | Match | Select | Lock | For | Block | Unsafe | Recover | Return | Break | Continue | ErrorExpr;

export interface Ident extends Node {
    kind: "Ident";
    name: string;
}
export interface This extends Node {
    kind: "This";
}
export interface SelfExpr extends Node {
    kind: "SelfExpr";
}
export interface IntLit extends Node {
    kind: "Int";
    value: bigint;
}
export interface FloatLit extends Node {
    kind: "Float";
    value: number;
}
export interface StrLit extends Node {
    kind: "Str";
    value: string;
    raw: boolean;
    multiline: boolean;
}
export interface Template extends Node {
    kind: "Template";
    /** parts.length === exprs.length + 1 */
    parts: string[];
    exprs: Expr[];
    multiline: boolean;
}
export interface CharLit extends Node {
    kind: "Char";
    value: string;
}
export interface ByteLit extends Node {
    kind: "Byte";
    value: number;
}
export interface BoolLit extends Node {
    kind: "Bool";
    value: boolean;
}
export interface NilLit extends Node {
    kind: "Nil";
}

/** An element of a Vec / array / tuple / set literal, or a call argument: `...xs` spreads. */
export interface Elem extends Node {
    spread: boolean;
    value: Expr;
}

export interface VecLit extends Node {
    kind: "Vec";
    elems: Elem[];
}
export interface ArrayLit extends Node {
    kind: "Array";
    elems: Elem[];
}
export interface TupleLit extends Node {
    kind: "Tuple";
    elems: Elem[];
}
export interface SetLit extends Node {
    kind: "Set";
    elems: Elem[];
}

/** `name: value`, `name` (shorthand), `"key": value` (records only), `...base` */
export type RecItem =
    | { kind: "Field"; name: string; quoted: boolean; value: Expr | null; span: Span }
    | { kind: "Spread"; value: Expr; span: Span };

export interface RecordLit extends Node {
    kind: "Record";
    items: RecItem[];
}
export interface InferredLit extends Node {
    kind: "Inferred";
    items: RecItem[];
}
export interface StructLit extends Node {
    kind: "Struct";
    /** the type: an Ident, Member chain or GenericApply over one */
    type: Expr;
    items: RecItem[];
}

export type MapEntry =
    | { kind: "Entry"; key: Expr; value: Expr; span: Span }
    | { kind: "Spread"; value: Expr; span: Span };

export interface MapLit extends Node {
    kind: "Map";
    entries: MapEntry[];
}

export interface ClosureParam extends Node {
    name: string;
    isVar: boolean;
    star: boolean;
    type: Type | null;
}

export interface Closure extends Node {
    kind: "Closure";
    /** null: no header (uses `it`) */
    params: ClosureParam[] | null;
    ret: Type | null;
    body: Stmt[];
}

export interface Paren extends Node {
    kind: "Paren";
    expr: Expr;
}
export interface Unary extends Node {
    kind: "Unary";
    op: "-" | "!";
    operand: Expr;
}
export interface Await extends Node {
    kind: "Await";
    operand: Expr;
}
export interface Binary extends Node {
    kind: "Binary";
    op: string;
    left: Expr;
    right: Expr;
}
export interface Assign extends Node {
    kind: "Assign";
    op: string;
    target: Expr;
    value: Expr;
}
export interface Range extends Node {
    kind: "Range";
    inclusive: boolean;
    start: Expr | null;
    end: Expr | null;
}
export interface As extends Node {
    kind: "As";
    expr: Expr;
    type: Type;
}
export interface Or extends Node {
    kind: "Or";
    expr: Expr;
    /** `or e => …` */
    name: string | null;
    rhs: Expr;
}
export interface Call extends Node {
    kind: "Call";
    callee: Expr;
    args: Elem[];
}
export interface Index extends Node {
    kind: "Index";
    target: Expr;
    index: Expr;
}
export interface Member extends Node {
    kind: "Member";
    target: Expr;
    /** a name, or a tuple index ("0") */
    name: string;
    optional: boolean;
}
export interface GenericApply extends Node {
    kind: "GenericApply";
    target: Expr;
    args: Type[];
}
export interface Try extends Node {
    kind: "Try";
    expr: Expr;
}

export interface If extends Node {
    kind: "If";
    /** `if let pattern = cond` */
    pattern: Pattern | null;
    cond: Expr;
    then: Block;
    else: Block | If | null;
}

export interface Arm extends Node {
    /** null in a subject-less match: `cond => body` */
    pattern: Pattern | null;
    guard: Expr | null;
    /** subject-less match: the condition */
    cond: Expr | null;
    body: Expr;
}

export interface Match extends Node {
    kind: "Match";
    subject: Expr | null;
    arms: Arm[];
}

export interface SelectArm extends Node {
    pattern: Pattern | null;
    expr: Expr;
    body: Expr;
}

export interface Select extends Node {
    kind: "Select";
    arms: SelectArm[];
    else: Expr | null;
}

export interface Lock extends Node {
    kind: "Lock";
    places: Expr[];
    body: Block;
}

export interface For extends Node {
    kind: "For";
    label: string | null;
    form: "infinite" | "cond" | "let" | "in";
    isAwait: boolean;
    /** "let": the pattern; "in": the item pattern */
    pattern: Pattern | null;
    /** "in": the index / value pattern of `for a, b in` */
    pattern2: Pattern | null;
    /** "cond": the condition; "let" / "in": the scrutinee / iterable */
    expr: Expr | null;
    body: Block;
}

export interface Unsafe extends Node {
    kind: "Unsafe";
    body: Block;
}
export interface Recover extends Node {
    kind: "Recover";
    body: Block;
}
export interface Return extends Node {
    kind: "Return";
    value: Expr | null;
}
export interface Break extends Node {
    kind: "Break";
    label: string | null;
    value: Expr | null;
}
export interface Continue extends Node {
    kind: "Continue";
    label: string | null;
}
export interface ErrorExpr extends Node {
    kind: "Error";
}

// ---- patterns ----------------------------------------------------------------------------------

export type Pattern = PWild | PBind | PLit | PRange | PCtor | PTuple | PRecord | POr | PError;

export interface PWild extends Node {
    kind: "PWild";
}
export interface PBind extends Node {
    kind: "PBind";
    name: string;
    isVar: boolean;
}
export interface PLit extends Node {
    kind: "PLit";
    value: Expr;
}
export interface PRange extends Node {
    kind: "PRange";
    start: Expr;
    end: Expr;
    inclusive: boolean;
}
export interface FieldPat extends Node {
    name: string;
    /** null: shorthand binding (`{ name }`, `{ var name }`) */
    pattern: Pattern | null;
    isVar: boolean;
}
export interface PCtor extends Node {
    kind: "PCtor";
    path: string[];
    /** `A(x, y)` */
    args: Pattern[] | null;
    /** `A { x, .. }` */
    fields: FieldPat[] | null;
    rest: boolean;
}
export interface PTuple extends Node {
    kind: "PTuple";
    elems: Pattern[];
    rest: boolean;
}
export interface PRecord extends Node {
    kind: "PRecord";
    fields: FieldPat[];
    rest: boolean;
}
export interface POr extends Node {
    kind: "POr";
    alts: Pattern[];
}
export interface PError extends Node {
    kind: "PError";
}
