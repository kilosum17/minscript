// Types for the MinScript checker (spec §7, §9.5).
//
// `unknown` is the gradual type: it comes from std packages that have no signatures yet (`json.parse`)
// and from earlier errors. It is compatible with everything and never produces a diagnostic, so one
// mistake doesn't cascade and missing std signatures don't cause false errors.
//
// Borrows (`&T`, `&mut T`) are kept in types, but are transparent for compatibility: call sites never
// write `&` (spec §9.2), and whether a borrow is valid is the ownership pass's job.

import type { Sym } from "./resolve.ts"

export const INT_TYPES = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "isize", "usize", "int"] as const
export const FLOAT_TYPES = ["f32", "f64"] as const
export type PrimName = (typeof INT_TYPES)[number] | (typeof FLOAT_TYPES)[number] | "bool" | "char" | "string" | "str" | "void"

export type Ty =
    | { k: "prim", name: PrimName }
    | { k: "never" }
    | { k: "unknown" }
    | { k: "named", sym: Sym, args: Ty[] }             // struct, union, interface (including the prelude's Vec, Option…)
    | { k: "param", sym: Sym }                           // a generic parameter, inside its declaration
    | { k: "var", id: number, ref: Ty | null, lit: "int" | "float" | null }   // inference variable
    | { k: "tuple", elems: Ty[] }                        // never empty: `t()` is void
    | { k: "record", fields: RecordField[] }             // sorted by name
    | { k: "fn", params: Ty[], ret: Ty, async: boolean }
    | { k: "ref", mut: boolean, inner: Ty }
    | { k: "ptr", mut: boolean, inner: Ty }
    | { k: "lit", value: string | bigint | boolean }     // a literal type: `"Admin"`, `404`
    | { k: "union", members: Ty[] }                      // literal union: `"A" | "B"`
    | { k: "meta", ty: Ty }                              // a type used as a value: `User.new`, `Payment.Cash`
    | { k: "package", name: string, sym?: Sym }          // an imported package used as a value: `json` (sym.target: its resolution)

export type RecordField = { name: string, ty: Ty, optional: boolean }

export const UNKNOWN: Ty = { k: "unknown" }
export const NEVER: Ty = { k: "never" }
export const VOID: Ty = { k: "prim", name: "void" }
export const BOOL: Ty = { k: "prim", name: "bool" }
export const INT: Ty = { k: "prim", name: "int" }
export const F64: Ty = { k: "prim", name: "f64" }
export const STRING: Ty = { k: "prim", name: "string" }
export const CHAR: Ty = { k: "prim", name: "char" }
export const prim = (name: PrimName): Ty => ({ k: "prim", name })

/** Follows bound inference variables. */
export function prune(t: Ty): Ty {
    while (t.k === "var" && t.ref !== null) t = t.ref
    return t
}

/** Removes borrows: `&mut &T` → `T`. */
export function strip(t: Ty): Ty {
    t = prune(t)
    while (t.k === "ref") t = prune(t.inner)
    return t
}

export const isInt = (t: Ty): boolean => t.k === "prim" && (INT_TYPES as readonly string[]).includes(t.name)
export const isFloat = (t: Ty): boolean => t.k === "prim" && (t.name === "f32" || t.name === "f64")
export const isNumeric = (t: Ty): boolean => isInt(t) || isFloat(t)
export const isStringy = (t: Ty): boolean => t.k === "prim" && (t.name === "string" || t.name === "str")

/** Range of each integer type, used for literals (spec §1.5: out-of-range literals are errors). */
export const INT_RANGE: Readonly<Record<string, readonly [bigint, bigint]>> = {
    i8: [-(2n ** 7n), 2n ** 7n - 1n], i16: [-(2n ** 15n), 2n ** 15n - 1n], i32: [-(2n ** 31n), 2n ** 31n - 1n],
    i64: [-(2n ** 63n), 2n ** 63n - 1n], isize: [-(2n ** 63n), 2n ** 63n - 1n],
    u8: [0n, 2n ** 8n - 1n], u16: [0n, 2n ** 16n - 1n], u32: [0n, 2n ** 32n - 1n], u64: [0n, 2n ** 64n - 1n], usize: [0n, 2n ** 64n - 1n],
    int: [-(2n ** 63n), 2n ** 63n - 1n],    // platform width; L_INT_NOT_PORTABLE covers values outside i32
}

/** Implicit lossless widening (spec §9.5): `from` converts to `to` without `as`. */
export function widens(from: PrimName, to: PrimName): boolean {
    if (from === to) return true
    const order: Record<string, number> = { i8: 8, i16: 16, i32: 32, i64: 64, u8: 8, u16: 16, u32: 32, u64: 64 }
    const signed = (n: string) => n.startsWith("i")
    if (from === "int") return to === "i64"
    if (to === "f64") return from === "i32" || from === "u32" || from === "f32" || from === "i16" || from === "i8" || from === "u16" || from === "u8"
    const a = order[from], b = order[to]
    if (a === undefined || b === undefined) return false
    if (signed(from) === signed(to)) return b > a
    return !signed(from) && signed(to) && b >= 2 * a      // uN → i(2N)
}

export function show(t: Ty): string {
    t = prune(t)
    switch (t.k) {
        case "prim": return t.name
        case "never": return "never"
        case "unknown": return "unknown"
        case "named": {
            if (t.sym.name === "Option" && t.sym.std && t.args.length === 1) return `${show(t.args[0]!)}?`
            return t.args.length === 0 ? t.sym.name : `${t.sym.name}[${t.args.map(show).join(", ")}]`
        }
        case "param": return t.sym.name
        case "var": return t.lit === "int" ? "{integer}" : t.lit === "float" ? "{float}" : "_"
        case "tuple": return `t(${t.elems.map(show).join(", ")})`
        case "record": return `r{ ${t.fields.map((f) => `${f.name}: ${show(f.ty)}`).join(", ")} }`
        case "fn": return `(${t.params.map(show).join(", ")}) -> ${show(t.ret)}`
        case "ref": return `&${t.mut ? "mut " : ""}${show(t.inner)}`
        case "ptr": return `*${t.mut ? "mut " : ""}${show(t.inner)}`
        case "lit": return typeof t.value === "string" ? JSON.stringify(t.value) : String(t.value)
        case "union": return t.members.map(show).join(" | ")
        case "meta": return `type ${show(t.ty)}`
        case "package": return `package ${t.name}`
    }
}

/** Substitutes generic parameters. */
export function subst(t: Ty, env: Map<Sym, Ty>): Ty {
    if (env.size === 0) return t
    t = prune(t)
    switch (t.k) {
        case "param": return env.get(t.sym) ?? t
        case "named": return t.args.length === 0 ? t : { k: "named", sym: t.sym, args: t.args.map((a) => subst(a, env)) }
        case "tuple": return { k: "tuple", elems: t.elems.map((e) => subst(e, env)) }
        case "record": return { k: "record", fields: t.fields.map((f) => ({ ...f, ty: subst(f.ty, env) })) }
        case "fn": return { k: "fn", params: t.params.map((p) => subst(p, env)), ret: subst(t.ret, env), async: t.async }
        case "ref": return { k: "ref", mut: t.mut, inner: subst(t.inner, env) }
        case "ptr": return { k: "ptr", mut: t.mut, inner: subst(t.inner, env) }
        case "union": return { k: "union", members: t.members.map((m) => subst(m, env)) }
        case "meta": return { k: "meta", ty: subst(t.ty, env) }
        default: return t
    }
}

export function occurs(v: Ty & { k: "var" }, t: Ty): boolean {
    t = prune(t)
    if (t === v) return true
    switch (t.k) {
        case "named": return t.args.some((a) => occurs(v, a))
        case "tuple": return t.elems.some((e) => occurs(v, e))
        case "record": return t.fields.some((f) => occurs(v, f.ty))
        case "fn": return t.params.some((p) => occurs(v, p)) || occurs(v, t.ret)
        case "ref": case "ptr": return occurs(v, t.inner)
        default: return false
    }
}

/** Collects the unbound inference variables of a type. */
export function freeVars(t: Ty, out: Set<Ty & { k: "var" }> = new Set()): Set<Ty & { k: "var" }> {
    t = prune(t)
    switch (t.k) {
        case "var": out.add(t); break
        case "named": for (const a of t.args) freeVars(a, out); break
        case "tuple": for (const e of t.elems) freeVars(e, out); break
        case "record": for (const f of t.fields) freeVars(f.ty, out); break
        case "fn": for (const p of t.params) freeVars(p, out); freeVars(t.ret, out); break
        case "ref": case "ptr": freeVars(t.inner, out); break
        default: break
    }
    return out
}
