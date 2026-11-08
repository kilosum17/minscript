// HIR: the lowered program (spec §14). A typed expression tree with the sugar removed, so a back
// end only handles a small core:
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

import type { Sym } from "./resolve.ts"
import type { Span } from "./token.ts"
import type { Ty } from "./types.ts"

export type Program = {
    types: TypeDef[]
    funs: Fun[]
    globals: Global[]
}

// float: printed as `1.0`; shape / default: for builtins that build the struct from data (`json.parse`)
export type FieldDef = { name: string, optional: boolean, float?: boolean, shape?: Shape, default?: Expr }

/** The structure of a type, for builtins that build values from plain data (`json.parse.[User]`). */
/** The structure of a type, for builtins that build values from plain data (`json.parse.[User]`), and
 *  as a *type witness* (spec §14.1): a function that needs a generic parameter at run time gets its
 *  shape as a hidden argument. `p` is a primitive; `param` (HIR only) is a generic parameter of the
 *  enclosing function, i.e. its own witness. */
export type Shape =
    | { s: string } | { vec: Shape | null } | { opt: Shape | null } | { map: Shape | null } | { f: true } | { i64: true }
    | { p: string } | { param: Sym }

export type TypeDef =
    | { kind: "struct", name: string, fields: FieldDef[], interfaces: string[] }
    | { kind: "union", name: string, variants: { name: string, fields: FieldDef[], positional: boolean }[], interfaces: string[] }
    | { kind: "inter", name: string, methods: string[] }

export type Local = { sym: Sym, ty: Ty, mutable: boolean }

export type Fun = {
    name: string                  // `main`, `User.new`, `Shape.area`
    params: Local[]
    self: Local | null            // the receiver, passed first
    ret: Ty
    async: boolean
    body: Block | null            // null: extern
    extern: string | null         // the ABI of an extern function
    builtin?: boolean             // a std function whose body is `_builtin()`: provided by the back end's runtime
    file?: string                 // the source file, for panic locations (`src/main.ms`; std files as `std/…`)
    generics?: Sym[]              // every generic parameter in scope: the type's or impl's, then its own
    witnesses?: Sym[]             // the generics it needs at run time (hidden parameters, after the others); set by `computeWitnesses`
    span: Span
}

export type Global = { name: string, ty: Ty, value: Expr }

export type Block = { stmts: Stmt[], value: Expr | null }

export type Stmt =
    | { k: "let", local: Local, value: Expr }
    | { k: "expr", expr: Expr }

type E<K extends string, F = {}> = { k: K, ty: Ty, span: Span } & F

export type Spread = { k: "spread", expr: Expr }

export type Expr =
    | E<"lit", { value: bigint | number | string | boolean | null }>    // null: the unit value `t()`
    | E<"char", { value: string }>
    | E<"local", { sym: Sym }>
    | E<"global", { name: string }>
    | E<"fn", { name: string }>                                          // a function (or variant constructor) as a value
    | E<"call", { fn: string, args: Expr[], shapes?: (Shape | null)[], witnessArgs?: [Sym, Shape | null][] }>   // shapes: a builtin's type arguments; witnessArgs: the callee's generics as instantiated here
    | E<"copy", { expr: Expr }>                                          // a copy of a `Copy` record / tuple read from a place (value semantics)
    | E<"wstatic", { witness: Shape | null, method: string, args: Expr[] }>   // `T.default()`: a static of a generic parameter, through its witness                          // a resolved function; methods take the receiver first
    | E<"dyncall", { recv: Expr, method: string, args: Expr[] }>       // dispatch on the receiver: interfaces, bounds, auto methods, unknown types
    | E<"callvalue", { callee: Expr, args: Expr[] }>                   // calling a closure or function value
    | E<"extern", { path: string, args: Expr[] | null, typeArgs?: string[] }>   // a member of a std package without signatures yet (`json.parse`); `.[T]` names
    | E<"struct", { type: string, fields: { name: string, value: Expr }[] }>
    | E<"variant", { union: string, variant: string, fields: Expr[] }>   // payload in declaration order
    | E<"record", { fields: { name: string, value: Expr }[] }>
    | E<"tuple", { elems: Expr[] }>
    | E<"vec", { elems: (Expr | Spread)[] }>
    | E<"array", { elems: (Expr | Spread)[] }>
    | E<"set", { elems: (Expr | Spread)[] }>
    | E<"map", { entries: ({ key: Expr, value: Expr } | Spread)[] }>
    | E<"range", { start: Expr | null, end: Expr | null, inclusive: boolean }>
    | E<"field", { object: Expr, name: string }>                       // struct / record field, or tuple element ("0", "1", …)
    | E<"index", { object: Expr, index: Expr, map: boolean }>
    | E<"unary", { op: "neg" | "not" | "bitnot" | "deref", expr: Expr }>
    | E<"binary", { op: string, left: Expr, right: Expr }>
    | E<"and", { left: Expr, right: Expr }>
    | E<"or", { left: Expr, right: Expr }>
    | E<"truthy", { expr: Expr, of: "option" | "result" }>               // Some(_) / Ok(_) → true
    | E<"concat", { parts: Expr[] }>                                   // string concatenation
    | E<"tostr", { expr: Expr, shape?: Shape }>                         // shape: where the value's floats are (`Vec[f64]` prints `[1.0]`)
    | E<"widen", { expr: Expr }>                                       // int → i64 / u64
    | E<"cast", { expr: Expr, to: Ty }>                                // numeric / pointer `as` cast
    | E<"assign", { target: Expr, op: string, value: Expr }>
    | E<"if", { cond: Expr, then: Block, else: Block | null }>
    | E<"match", { subject: Expr, arms: Arm[] }>
    | E<"loop", { label: string | null, body: Block, step: Block | null }>
    | E<"break", { label: string | null, value: Expr | null }>
    | E<"continue", { label: string | null }>
    | E<"return", { value: Expr | null }>
    | E<"block", { block: Block }>
    | E<"closure", { params: Local[], captures: { sym: Sym, mode: "move" | "ref" | "mut" }[], body: Block }>
    | E<"await", { expr: Expr }>
    | E<"select", { arms: { wait: Expr, pattern: Pattern, body: Expr }[], else: Expr | null }>
    | E<"recover", { body: Block }>                                     // → Result[T, Panic]
    | E<"unsupported", { what: string }>

export type Arm = { pattern: Pattern, guard: Expr | null, body: Expr }

export type Pattern =
    | { k: "wild" }
    | { k: "bind", local: Local }
    | { k: "lit", value: bigint | number | string | boolean | null }
    | { k: "range", start: bigint | number | string | null, end: bigint | number | string | null, inclusive: boolean }
    | { k: "variant", union: string, variant: string, fields: Pattern[] }   // payload in declaration order; union "?" when unknown
    | { k: "ok", value: Pattern }                                       // `Some(v)` or `Ok(v)`: success of an Option / Result
    | { k: "fail", payload: Pattern }                                   // `None` or `Err(e)` (the payload is the error; wild for None)
    | { k: "fields", fields: { name: string, pattern: Pattern }[] }        // struct or record
    | { k: "tuple", elems: Pattern[] }
    | { k: "or", alts: Pattern[] }
