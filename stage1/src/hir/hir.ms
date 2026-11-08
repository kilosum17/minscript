// HIR: the lowered program (spec §14), ported from minscript/src/hir.ts. A typed expression tree with
// the sugar removed, so a back end only handles a small core:
// - every expression carries its type, every name points at its symbol;
// - every function, method and static is called by its resolved (mangled) name; interface and
//   generic-bound calls are explicit dynamic calls; unknown std package members are `extern`;
// - all `for` forms are `loop` (with a `step` block run by `continue`, like C's `for`);
// - `?`, `or`, `??`, `?.`, `if let` and `let … else` are `match`, with explicit `return`; `ok` / `fail`
//   patterns match either an Option or a Result, so they work even when the type is unknown;
// - truthiness is an explicit `truthy` test; inferred variants are qualified `variant` nodes;
// - struct literals list every field (defaults filled in); variadic arguments are packed into a slice;
// - int → i64 / u64 is an explicit `widen` (number → BigInt on JS).
//
// Names: user items keep their names (`main`, `User.new`); std items are prefixed (`std.Vec.push`).
//
// Stage 0's node kinds (`k: "call"`) are the variants of `HKind` (`KCall`); its patterns are `HPat`
// (`Q…`). A local carries its symbol (temporaries made by lowering have negative ids) and the name
// the dump shows.
package hir

import "app.lexer.{Span}"
import "app.check.{Ty}"

pub type Program = {
    pub types: Vec[HType] = []
    pub funs: Vec[HFun] = []
    pub globals: Vec[HGlobal] = []
    /// how many temporaries lowering made (their symbols are -1 … -temps): the next package continues
    pub temps: int = 0
}

/// The structure of a type, for builtins that build values from plain data (`json.parse.[User]`), and
/// as a type witness (spec §14.1). `SParam` is a generic parameter of the enclosing function.
pub union Shape = {
    SStruct(string)
    SVec(Box[Shape]?)
    SOpt(Box[Shape]?)
    SMap(Box[Shape]?)
    SFloat
    SI64
    SPrim(string)
    SParam(int)
}

/// float: printed as `1.0`; shape / default: for builtins that build the struct from data
pub type FieldDef = { pub name: string, pub optional: bool, pub float: bool = false, pub shape: Shape?, pub default: HExpr? }

pub type VariantDef = { pub name: string, pub fields: Vec[FieldDef], pub positional: bool }

/// A type definition (not `TypeDef`: that name is the AST's item variant, and an unqualified pattern
/// name resolves to a type first, spec §6)
pub union HType = {
    TDStruct { name: string, fields: Vec[FieldDef], interfaces: Vec[string] }
    TDUnion { name: string, variants: Vec[VariantDef], interfaces: Vec[string] }
    TDInter { name: string, methods: Vec[string] }
}

/// A local binding: its symbol (negative: a temporary of lowering), its name as the dump shows it.
pub type HLocal = { pub sym: int, pub name: string, pub ty: Ty, pub mutable: bool }

pub type HFun = {
    /// `main`, `User.new`, `Shape.area`
    pub name: string
    pub params: Vec[HLocal]
    /// the receiver, passed first
    pub recv: HLocal?
    pub ret: Ty
    pub is_async: bool
    /// None: extern
    pub body: HBlock?
    /// the ABI of an extern function
    pub abi: string?
    /// a std function whose body is `_builtin()`: provided by the back end's runtime
    pub builtin: bool = false
    /// the source file, for panic locations
    pub file: string?
    /// every generic parameter in scope: the type's or impl's, then its own
    pub generics: Vec[int] = []
    /// the generics it needs at run time (hidden parameters, after the others); set by `compute_witnesses`
    pub witnesses: Vec[int] = []
    pub span: Span
}

pub type HGlobal = { pub name: string, pub ty: Ty, pub value: HExpr }

pub type HBlock = { pub stmts: Vec[HStmt] = [], pub value: Box[HExpr]? }

pub union HStmt = {
    HLet { local: HLocal, value: HExpr }
    HDo(HExpr)
}

/// A literal value (stage 0: bigint | number | string | boolean | null); integers are decimal strings.
pub union HLit = {
    LNum(f64)
    LBig(string)
    LStr(string)
    LBool(bool)
    /// the unit value `t()`
    LUnit
}

pub type HExpr = { pub ty: Ty, pub span: Span, pub kind: HKind }

pub union HElem = {
    HValue(HExpr)
    HSpread(HExpr)
}

pub type HField = { pub name: string, pub value: HExpr }

pub union HEntry = {
    HPair { key: HExpr, value: HExpr }
    HEntrySpread(HExpr)
}

pub type HCapture = { pub sym: int, pub name: string, pub mode: string }

pub type HArm = { pub pattern: HPat, pub guard: HExpr?, pub body: HExpr }

pub type HSelectArm = { pub wait: HExpr, pub pattern: HPat, pub body: HExpr }

pub union HKind = {
    KLit(HLit)
    KChar(string)
    KLocal { sym: int, name: string }
    KGlobal(string)
    /// a function (or variant constructor) as a value
    KFn(string)
    /// shapes: a builtin's type arguments; witness_args: the callee's generics as instantiated here
    KCall { callee: string, args: Vec[HExpr], shapes: Vec[Shape?]?, witness_args: Vec[t(int, Shape?)] }
    /// a copy of a `Copy` record / tuple read from a place (value semantics)
    KCopy(Box[HExpr])
    /// `T.default()`: a static of a generic parameter, through its witness
    KWstatic { witness: Shape?, method: string, args: Vec[HExpr] }
    /// dispatch on the receiver: interfaces, bounds, auto methods, unknown types
    KDyncall { recv: Box[HExpr], method: string, args: Vec[HExpr] }
    /// calling a closure or function value
    KCallValue { callee: Box[HExpr], args: Vec[HExpr] }
    /// a member of a std package without signatures yet (`json.parse`); `.[T]` names
    KExtern { path: string, args: Vec[HExpr]?, type_args: Vec[string]? }
    KStruct { type_name: string, fields: Vec[HField] }
    /// payload in declaration order
    KVariant { union_name: string, variant: string, fields: Vec[HExpr] }
    KRecord(Vec[HField])
    KTuple(Vec[HExpr])
    KVec(Vec[HElem])
    KArray(Vec[HElem])
    KSet(Vec[HElem])
    KMap(Vec[HEntry])
    KRange { start: Box[HExpr]?, end: Box[HExpr]?, inclusive: bool }
    /// struct / record field, or tuple element ("0", "1", …)
    KField { object: Box[HExpr], name: string }
    KIndex { object: Box[HExpr], index: Box[HExpr], map: bool }
    /// op: "neg", "not", "bitnot", "deref"
    KUnary { op: string, expr: Box[HExpr] }
    KBinary { op: string, left: Box[HExpr], right: Box[HExpr] }
    KAnd { left: Box[HExpr], right: Box[HExpr] }
    KOr { left: Box[HExpr], right: Box[HExpr] }
    /// Some(_) / Ok(_) → true; of: "option" or "result"
    KTruthy { expr: Box[HExpr], of: string }
    /// string concatenation
    KConcat(Vec[HExpr])
    /// shape: where the value's floats are (`Vec[f64]` prints `[1.0]`)
    KToStr { expr: Box[HExpr], shape: Shape? }
    /// int → i64 / u64
    KWiden(Box[HExpr])
    /// numeric / pointer `as` cast
    KCast { expr: Box[HExpr], to: Ty }
    KAssign { target: Box[HExpr], op: string, value: Box[HExpr] }
    KIf { cond: Box[HExpr], then: HBlock, else_block: HBlock? }
    KMatch { subject: Box[HExpr], arms: Vec[HArm] }
    KLoop { label: string?, body: HBlock, step: HBlock? }
    KBreak { label: string?, value: Box[HExpr]? }
    KContinue(string?)
    KReturn(Box[HExpr]?)
    KBlock(HBlock)
    /// mode: "move", "ref" or "mut"
    KClosure { params: Vec[HLocal], captures: Vec[HCapture], body: HBlock }
    KAwait(Box[HExpr])
    KSelect { arms: Vec[HSelectArm], else_expr: Box[HExpr]? }
    /// → Result[T, Panic]
    KRecover(HBlock)
    KUnsupported(string)
}

pub type HPatField = { pub name: string, pub pattern: HPat }

pub union HPat = {
    QWild
    QBind(HLocal)
    QLit(HLit)
    QRange { start: HLit?, end: HLit?, inclusive: bool }
    /// payload in declaration order; union "?" when unknown
    QVariant { union_name: string, variant: string, fields: Vec[HPat] }
    /// `Some(v)` or `Ok(v)`: success of an Option / Result
    QOk(Box[HPat])
    /// `None` or `Err(e)` (the payload is the error; wild for None)
    QFail(Box[HPat])
    /// struct or record
    QFields(Vec[HPatField])
    QTuple(Vec[HPat])
    QOr(Vec[HPat])
}
