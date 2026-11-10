// Types for the checker (spec §7, §13.1, §13.5).
//
// `unknown` is the gradual type: members of packages that aren't loaded, names left unresolved,
// and the results of earlier errors. It is compatible with everything and never produces a
// diagnostic, so one mistake doesn't cascade and missing std packages don't cause false errors.
//
// v0.4 has no borrow types: a parameter's mode (`*T`) is recorded on the function type, not on `T`.

import type { Sym } from "./resolve.ts";

export const INT_TYPES = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "isize", "usize", "int"] as const;
export const FLOAT_TYPES = ["f32", "f64"] as const;
export type PrimName = (typeof INT_TYPES)[number] | (typeof FLOAT_TYPES)[number] | "bool" | "char" | "str" | "void";

export type Var = { k: "var"; id: number; ref: Ty | null; lit: "int" | "float" | null };

export type FnParam = { ty: Ty; star: boolean };

export type Ty =
    | { k: "prim"; name: PrimName }
    | { k: "never" }
    | { k: "unknown" }
    /** struct, union or interface, the prelude's Vec, Option, Promise… included */
    | { k: "named"; sym: Sym; args: Ty[] }
    /** a generic parameter, inside its declaration */
    | { k: "param"; sym: Sym }
    | Var
    | { k: "tuple"; elems: Ty[] }
    /** fields sorted by name */
    | { k: "record"; fields: RecordField[] }
    | { k: "fn"; params: FnParam[]; ret: Ty; async: boolean }
    /** a literal type: `"Admin"`, `404`, `true` */
    | { k: "lit"; value: string | bigint | boolean }
    /** a literal union: `"A" | "B"` */
    | { k: "union"; members: Ty[] }
    /** a type used as a value: `User` in `User.new()`, `Payment` in `Payment.Cash` */
    | { k: "meta"; ty: Ty }
    /** an imported package used as a value */
    | { k: "package"; sym: Sym };

export type RecordField = { name: string; ty: Ty; optional: boolean };

export const UNKNOWN: Ty = { k: "unknown" };
export const NEVER: Ty = { k: "never" };
export const prim = (name: PrimName): Ty => ({ k: "prim", name });
export const VOID = prim("void");
export const BOOL = prim("bool");
export const INT = prim("int");
export const F64 = prim("f64");
export const STR = prim("str");
export const CHAR = prim("char");
export const U8 = prim("u8");
export const U64 = prim("u64");

/** Follows bound inference variables. */
export function prune(t: Ty): Ty {
    while (t.k === "var" && t.ref !== null) t = t.ref;
    return t;
}

export const isInt = (t: Ty): boolean => t.k === "prim" && (INT_TYPES as readonly string[]).includes(t.name);
export const isFloat = (t: Ty): boolean => t.k === "prim" && (t.name === "f32" || t.name === "f64");
export const isNumeric = (t: Ty): boolean => isInt(t) || isFloat(t);
/** unknown, an unbound variable, or never: nothing can be said about it */
export const isOpen = (t: Ty): boolean => {
    const p = prune(t);
    return p.k === "unknown" || p.k === "never" || (p.k === "var" && p.lit === null);
};

/** Range of each integer type, for literals (§1.5: out-of-range literals are errors). */
export const INT_RANGE: Readonly<Record<string, readonly [bigint, bigint]>> = {
    i8: [-(2n ** 7n), 2n ** 7n - 1n], i16: [-(2n ** 15n), 2n ** 15n - 1n], i32: [-(2n ** 31n), 2n ** 31n - 1n],
    i64: [-(2n ** 63n), 2n ** 63n - 1n], isize: [-(2n ** 63n), 2n ** 63n - 1n],
    u8: [0n, 2n ** 8n - 1n], u16: [0n, 2n ** 16n - 1n], u32: [0n, 2n ** 32n - 1n], u64: [0n, 2n ** 64n - 1n], usize: [0n, 2n ** 64n - 1n],
    int: [-(2n ** 63n), 2n ** 63n - 1n],
};

/** Implicit lossless widening (§13.1): `from` converts to `to` without `as`. */
export function widens(from: PrimName, to: PrimName): boolean {
    if (from === to) return true;
    if (from === "int") return to === "i64";
    if (to === "f64") return ["i8", "i16", "i32", "u8", "u16", "u32", "f32"].includes(from);
    const bits: Record<string, number> = { i8: 8, i16: 16, i32: 32, i64: 64, u8: 8, u16: 16, u32: 32, u64: 64 };
    const a = bits[from];
    const b = bits[to];
    if (a === undefined || b === undefined) return false;
    const signed = (n: string) => n.startsWith("i");
    if (signed(from) === signed(to)) return b > a;
    return !signed(from) && signed(to) && b >= 2 * a; // uN → i(2N)
}

export function show(t: Ty): string {
    t = prune(t);
    switch (t.k) {
        case "prim": return t.name;
        case "never": return "never";
        case "unknown": return "unknown";
        case "named":
            if (t.sym.name === "Option" && t.sym.pkg === "prelude" && t.args.length === 1) return `${show(t.args[0]!)}?`;
            return t.args.length === 0 ? t.sym.name : `${t.sym.name}[${t.args.map(show).join(", ")}]`;
        case "param": return t.sym.name;
        case "var": return t.lit === "int" ? "{integer}" : t.lit === "float" ? "{float}" : "_";
        case "tuple": return `t(${t.elems.map(show).join(", ")})`;
        case "record": return `r{ ${t.fields.map((f) => `${f.name}: ${show(f.ty)}`).join(", ")} }`;
        case "fn": return `${t.async ? "async " : ""}(${t.params.map((p) => (p.star ? "*" : "") + show(p.ty)).join(", ")}) -> ${show(t.ret)}`;
        case "lit": return typeof t.value === "string" ? JSON.stringify(t.value) : String(t.value);
        case "union": return t.members.map(show).join(" | ");
        case "meta": return `type ${show(t.ty)}`;
        case "package": return `package ${t.sym.name}`;
    }
}

/** Substitutes generic parameters. */
export function subst(t: Ty, env: ReadonlyMap<Sym, Ty>): Ty {
    if (env.size === 0) return t;
    t = prune(t);
    switch (t.k) {
        case "param": return env.get(t.sym) ?? t;
        case "named": return t.args.length === 0 ? t : { k: "named", sym: t.sym, args: t.args.map((a) => subst(a, env)) };
        case "tuple": return { k: "tuple", elems: t.elems.map((e) => subst(e, env)) };
        case "record": return { k: "record", fields: t.fields.map((f) => ({ ...f, ty: subst(f.ty, env) })) };
        case "fn": return { k: "fn", params: t.params.map((p) => ({ star: p.star, ty: subst(p.ty, env) })), ret: subst(t.ret, env), async: t.async };
        case "union": return { k: "union", members: t.members.map((m) => subst(m, env)) };
        case "meta": return { k: "meta", ty: subst(t.ty, env) };
        default: return t;
    }
}

export function occurs(v: Var, t: Ty): boolean {
    t = prune(t);
    if (t === v) return true;
    switch (t.k) {
        case "named": return t.args.some((a) => occurs(v, a));
        case "tuple": return t.elems.some((e) => occurs(v, e));
        case "record": return t.fields.some((f) => occurs(v, f.ty));
        case "fn": return t.params.some((p) => occurs(v, p.ty)) || occurs(v, t.ret);
        case "meta": return occurs(v, t.ty);
        default: return false;
    }
}

/** The unbound inference variables of a type. */
export function freeVars(t: Ty, out: Set<Var> = new Set()): Set<Var> {
    t = prune(t);
    switch (t.k) {
        case "var": out.add(t); break;
        case "named": for (const a of t.args) freeVars(a, out); break;
        case "tuple": for (const e of t.elems) freeVars(e, out); break;
        case "record": for (const f of t.fields) freeVars(f.ty, out); break;
        case "fn": for (const p of t.params) freeVars(p.ty, out); freeVars(t.ret, out); break;
        default: break;
    }
    return out;
}

/** Replaces every inference variable by what it is bound to (unbound literal variables default). */
export function zonk(t: Ty): Ty {
    t = prune(t);
    switch (t.k) {
        case "var": return t.lit === "int" ? INT : t.lit === "float" ? F64 : t;
        case "named": return t.args.length === 0 ? t : { k: "named", sym: t.sym, args: t.args.map(zonk) };
        case "tuple": return { k: "tuple", elems: t.elems.map(zonk) };
        case "record": return { k: "record", fields: t.fields.map((f) => ({ ...f, ty: zonk(f.ty) })) };
        case "fn": return { k: "fn", params: t.params.map((p) => ({ star: p.star, ty: zonk(p.ty) })), ret: zonk(t.ret), async: t.async };
        case "meta": return { k: "meta", ty: zonk(t.ty) };
        default: return t;
    }
}
