// HIR (spec §0.3 step 5, §15): the lowered program. A typed expression tree with the sugar removed,
// so the passes after it (effect summaries, the access check, mechanism selection) and the back
// ends handle a small core:
//
// - **Places.** Every read, write and `*` argument names a place: a root (a local, a parameter,
//   `this`, a global, or a computed value) and a path of fields, tuple indices and elements.
//   `place` renders it as an access path, `u.tags[*]`, truncated to 4 segments (§9.5).
// - Every expression carries its type; every name points at its symbol or its mangled name.
// - Calls are resolved: a function or method by name (`app.models.User.rename`), with each argument's
//   mode (`read`, or `write` for a `*T` parameter / `*this` receiver) and the type arguments the
//   callee's witnesses need (§15.4). Interface and bound calls are `dyncall`; unknown members of
//   packages that aren't loaded are `extern`.
// - `?`, `or`, `??`, `?.` and `if let` are `match`es with explicit `return`; `ok` / `fail` patterns
//   match either an Option or a Result. Truthiness is an explicit `truthy` test. Inferred variants
//   are qualified. Struct literals list every field (defaults filled in). Variadic arguments are
//   packed into a Vec. Operators on named types are method calls.
// - `for x in e` stays a `foreach` (its iterable is read as `e[*]`); other loops are `loop`.

import type { Sym } from "./resolve.ts";
import type { Ty } from "./types.ts";

export type Span = { start: number; end: number };

export interface Program {
    types: TypeDef[];
    funs: Fun[];
    globals: Global[];
}

export interface FieldDef {
    name: string;
    mode: "shared" | "once" | null;
}

export type TypeDef =
    | { kind: "struct"; name: string; fields: FieldDef[]; identity: boolean; unique: boolean }
    | { kind: "union"; name: string; variants: { name: string; fields: string[]; positional: boolean }[] }
    | { kind: "inter"; name: string; methods: string[] };

export interface Local {
    sym: Sym;
    name: string;
    ty: Ty;
    mutable: boolean;
    /** `shared var` (§10) */
    shared: boolean;
}

export interface Fun {
    /** mangled: `main`, `User.new`, `app.models.User.rename`, `prelude.Vec.push` */
    name: string;
    params: Local[];
    /** `x: *T` per parameter */
    modes: ("read" | "write")[];
    self: Local | null;
    selfMode: "read" | "write" | null;
    ret: Ty;
    async: boolean;
    /** null: an extern or interface signature */
    body: Block | null;
    /** a std function whose body is `_builtin()`: provided by the runtime */
    builtin: boolean;
    extern: string | null;
    /** every generic parameter in scope: the type's or impl's, then its own */
    generics: Sym[];
    /** the generics it needs at run time, per back end (§15.4); set by `computeWitnesses` */
    witnesses: { js: Sym[]; native: Sym[] };
    file: string;
    span: Span;
}

export interface Global {
    name: string;
    sym: Sym;
    ty: Ty;
    value: Expr;
    /** a top-level `var`: implicitly shared (§10.4) */
    mutable: boolean;
}

export interface Block {
    stmts: Stmt[];
    value: Expr | null;
}

export type Stmt =
    | { k: "let"; pattern: Pattern; value: Expr; else: Block | null }
    | { k: "expr"; expr: Expr };

// ---- places --------------------------------------------------------------------------------------

export type Root =
    | { k: "local"; local: Sym; name: string }
    | { k: "global"; name: string; sym: Sym }
    | { k: "value"; expr: Expr };

export type Seg =
    | { k: "field"; name: string; mode: "shared" | "once" | null }
    | { k: "tuple"; index: number }
    /** an element; `key` is the literal index or key when there is one (`items[0]`, `m["a"]`) */
    | { k: "elem"; index: Expr; key: string | null; map: boolean };

export interface Place {
    root: Root;
    segs: Seg[];
}

/** An argument: read (a value), or passed to a `*T` parameter (a place the callee may write). */
export type Arg = { mode: "read"; expr: Expr } | { mode: "write"; place: Place; ty: Ty };

export type Callee =
    | { k: "fn"; name: string }
    /** a method of an interface, a bound or a type the checker couldn't see: dispatch on the receiver */
    | { k: "dyn"; method: string }
    /** a generated method (`to_str`, `eq`, `hash`, `clone`, `same_fields`, `weak`) */
    | { k: "auto"; method: string }
    /** a static of a generic parameter, through its witness (`T.default()`) */
    | { k: "witness"; param: Sym; method: string };

type E<K extends string, F = object> = { k: K; ty: Ty; span: Span } & F;

export type Spread = { k: "spread"; expr: Expr };

export type Expr =
    | E<"lit", { value: bigint | number | string | boolean | null }> // null: the unit value `t()`
    | E<"char", { value: string }>
    | E<"read", { place: Place }>
    | E<"assign", { place: Place; op: string; value: Expr }>
    | E<"fnref", { name: string }> // a function or constructor used as a value
    | E<"call", { callee: Callee; recv: Arg | null; args: Arg[]; witnessArgs: [Sym, Ty][]; async: boolean }>
    | E<"callvalue", { fn: Expr; args: Arg[] }>
    | E<"extern", { path: string; args: Expr[] | null }> // a member of a package that isn't loaded
    | E<"struct", { type: string; fields: { name: string; value: Expr }[] }>
    | E<"variant", { union: string; variant: string; fields: Expr[] }> // payload in declaration order
    | E<"record", { fields: { name: string; value: Expr }[] }>
    | E<"tuple", { elems: Expr[] }>
    | E<"vec", { elems: (Expr | Spread)[] }>
    | E<"array", { elems: (Expr | Spread)[] }>
    | E<"set", { elems: (Expr | Spread)[] }>
    | E<"map", { entries: ({ key: Expr; value: Expr } | Spread)[] }>
    | E<"range", { start: Expr | null; end: Expr | null; inclusive: boolean }>
    | E<"unary", { op: "neg" | "not" | "bitnot"; expr: Expr }>
    | E<"binary", { op: string; left: Expr; right: Expr }>
    | E<"and", { left: Expr; right: Expr }>
    | E<"or", { left: Expr; right: Expr }>
    | E<"truthy", { expr: Expr; of: "option" | "result" }>
    | E<"concat", { parts: Expr[] }>
    | E<"tostr", { expr: Expr }>
    | E<"cast", { expr: Expr; to: Ty }>
    | E<"if", { cond: Expr; then: Block; else: Block | null }>
    | E<"match", { subject: Expr; arms: Arm[] }>
    | E<"loop", { label: string | null; body: Block }>
    | E<"foreach", { label: string | null; item: Pattern; second: Pattern | null; iterable: Expr; of: "vec" | "map" | "range" | "iter" | "async"; body: Block }>
    | E<"break", { label: string | null; value: Expr | null }>
    | E<"continue", { label: string | null }>
    | E<"return", { value: Expr | null }>
    | E<"block", { block: Block }>
    | E<"closure", { params: Local[]; modes: ("read" | "write")[]; captures: Capture[]; body: Block }>
    | E<"await", { expr: Expr }>
    | E<"select", { arms: { wait: Expr; pattern: Pattern; body: Expr }[]; else: Expr | null }>
    | E<"recover", { body: Block }>
    | E<"lock", { places: Place[]; body: Block }>
    | E<"unsupported", { what: string }>;

/** A captured outer local, and whether the closure body writes it. */
export interface Capture {
    sym: Sym;
    name: string;
    mode: "read" | "write";
}

export interface Arm {
    pattern: Pattern;
    guard: Expr | null;
    body: Expr;
}

export type Pattern =
    | { k: "wild" }
    | { k: "bind"; local: Local }
    | { k: "lit"; value: bigint | number | string | boolean | null }
    | { k: "range"; start: bigint | number | string; end: bigint | number | string; inclusive: boolean }
    /** union "?" when the union isn't known (an unknown scrutinee) */
    | { k: "variant"; union: string; variant: string; fields: Pattern[] }
    /** `Some(v)` / `Ok(v)`: the success of an Option or a Result */
    | { k: "ok"; value: Pattern }
    /** `None` / `Err(e)`: the payload is the error (wild for None) */
    | { k: "fail"; payload: Pattern }
    | { k: "fields"; fields: { name: string; pattern: Pattern }[] }
    | { k: "tuple"; elems: Pattern[] }
    | { k: "or"; alts: Pattern[] };

// ---- access paths --------------------------------------------------------------------------------

/** Paths keep at most this many segments (§9.5); longer ones are truncated, which only widens them. */
export const PATH_DEPTH = 4;

/** The access path of a place: `u.tags[*]`, `items[0]`, `this.state`; `<value>` for computed roots. */
export function pathOf(p: Place, depth = PATH_DEPTH): string {
    let out = p.root.k === "value" ? "<value>" : p.root.name;
    for (const s of p.segs.slice(0, depth)) {
        if (s.k === "field") out += "." + s.name;
        else if (s.k === "tuple") out += "." + s.index;
        else out += s.key !== null ? `[${s.key}]` : "[*]";
    }
    return out;
}
