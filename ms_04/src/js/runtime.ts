// The JS runtime (spec §16): what compiled programs call into. Generated code imports nothing
// else, so a compiled program runs without the compiler.
//
// - Values: structs and union variants are instances of generated classes; records, tuples and
//   collections are runtime classes; Option and Result are `Some` / `None` / `Ok` / `Err` here.
// - Copy-on-write (§16.2): `s(x)` marks a value shared when a second holder appears; `u(x)` gives
//   a unique copy before a write (shallow; the copy's children become shared). Identity values
//   and strings are never copied.
// - `shared` bindings and fields, and `*T` arguments, are cells `{ v }` (§10.1).
// - Integers: `int` and the 8–32 bit types are JS numbers with overflow checks; `i64` / `u64` are
//   BigInt (§16.1). Strings are JS strings with UTF-8 byte offsets.
// - Tasks (§11): every async function runs as a task; `cancel()` is cooperative and wakes the
//   task at its `await`. Std waits (`Sub.next`, `time.after`, …) are cancel-safe for `select`.

import { AsyncLocalStorage } from "node:async_hooks";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---- Option and Result ---------------------------------------------------------------------------

export class Some {
    v: Any;
    constructor(v: Any) {
        this.v = v;
    }
}
export class NoneC {}
export class Ok {
    v: Any;
    constructor(v: Any) {
        this.v = v;
    }
}
export class Err {
    e: Any;
    constructor(e: Any) {
        this.e = e;
    }
}
for (const [C, name, union] of [[Some, "Some", "Option"], [NoneC, "None", "Option"], [Ok, "Ok", "Result"], [Err, "Err", "Result"]] as const) {
    Object.assign(C.prototype, { $v: name, $u: union });
}
export const None = new NoneC();
export const some = (v: Any) => new Some(v);
export const ok = (v: Any) => new Ok(v);
export const err = (e: Any) => new Err(e);
/** `Some(_)` / `Ok(_)` */
export const isOk = (x: Any) => x instanceof Some || x instanceof Ok;
/** an unset `once` field reads as None (§12.2) */
export const opt = (x: Any) => (x === undefined ? None : new Some(x));

// ---- generated classes the runtime needs -----------------------------------------------------------

const classes = new Map<string, Any>();
export function reg(name: string, c: Any): void {
    classes.set(name, c);
}

export function classOf(name: string): Any {
    return classes.get(name);
}

/** An instance of a generated struct class, from its fields by name (extra keys are kept: hidden state). */
export function make(name: string, fields: Record<string, Any>): Any {
    const C = classes.get(name);
    if (!C) return { ...fields };
    const o = new C(...(C.prototype.$f as string[]).map((f) => fields[f]));
    for (const k of Object.keys(fields)) if (!(C.prototype.$f as string[]).includes(k)) o[k] = fields[k];
    return o;
}

export function variant(union: string, name: string, ...fields: Any[]): Any {
    const C = classes.get(`${union}.${name}`);
    return C ? new C(...fields) : { $u: union, $v: name };
}

// ---- panics --------------------------------------------------------------------------------------

export class MsPanic extends Error {
    panic: Any;
    constructor(panic: Any) {
        super(panic.message);
        this.panic = panic;
    }
}

let curFile = "";
let curLine = 0;
/** The source position of the statement running now (generated at each statement of user code). */
export function pos(file: string, line: number): void {
    curFile = file;
    curLine = line;
}

export function makePanic(kind: string, message: string): Any {
    const P = classes.get("prelude.Panic");
    const k = variant("prelude.PanicKind", kind);
    const trace = `  at ${curFile}:${curLine}`;
    return P ? new P(message, curFile, curLine, trace, k) : { message, file: curFile, line: curLine, trace, kind: k };
}

export function panic(kind: string, message: string): never {
    throw new MsPanic(makePanic(kind, message));
}

/** What `recover` catches: an MinScript panic, or a JS error the runtime turns into one. */
export function caught(e: Any): Any {
    if (e instanceof MsPanic) return e.panic;
    if (e instanceof RangeError && /call stack/.test(e.message)) return makePanic("User", "stack overflow");
    return makePanic("User", String(e?.message ?? e));
}

// ---- integers (§13.1, §16.1) -----------------------------------------------------------------------

const RANGES: Record<string, [number, number]> = {
    i8: [-128, 127], i16: [-32768, 32767], i32: [-2147483648, 2147483647], int: [-2147483648, 2147483647],
    isize: [-2147483648, 2147483647], u8: [0, 255], u16: [0, 65535], u32: [0, 4294967295], usize: [0, 4294967295],
};
const BIG: Record<string, [bigint, bigint]> = { i64: [-(2n ** 63n), 2n ** 63n - 1n], u64: [0n, 2n ** 64n - 1n] };
const BITS: Record<string, number> = { i8: 8, i16: 16, i32: 32, int: 32, isize: 32, u8: 8, u16: 16, u32: 32, usize: 32, i64: 64, u64: 64 };
const typeName = (t: string) => (t === "int" || t === "isize" ? "i32" : t === "usize" ? "u32" : t);

/** An integer result: panics when it doesn't fit its type (always, in every build). */
export function chk(x: Any, t: string): Any {
    if (typeof x === "bigint") {
        const [lo, hi] = BIG[t] ?? BIG.i64!;
        if (x < lo || x > hi) panic("Overflow", `arithmetic overflow: ${x} doesn't fit in ${t}`);
        return x;
    }
    const [lo, hi] = RANGES[t] ?? RANGES.i32!;
    if (x < lo || x > hi || !Number.isFinite(x)) panic("Overflow", `arithmetic overflow: ${x} doesn't fit in ${typeName(t)}`);
    return x;
}

export function div(a: Any, b: Any, t: string): Any {
    if (b === 0 || b === 0n) panic("Overflow", "division by zero");
    if (typeof a === "bigint") return chk(a / b, t);
    return chk(Math.trunc(a / b), t);
}

export function rem(a: Any, b: Any, t: string): Any {
    if (b === 0 || b === 0n) panic("Overflow", "division by zero");
    return a % b;
}

/** Wraps an integer to the width of `t` (two's complement). */
export function wrap(x: Any, t: string): Any {
    const bits = BITS[t] ?? 32;
    const signed = !t.startsWith("u");
    if (bits === 64) {
        const b = typeof x === "bigint" ? x : BigInt(Math.trunc(x));
        return signed ? BigInt.asIntN(64, b) : BigInt.asUintN(64, b);
    }
    const n = typeof x === "bigint" ? Number(BigInt.asIntN(64, x) & 0xffffffffn) : x;
    if (bits === 32) return signed ? n | 0 : n >>> 0;
    const m = n & ((1 << bits) - 1);
    return signed && m >= 1 << (bits - 1) ? m - (1 << bits) : m;
}

export function shl(a: Any, b: Any, t: string): Any {
    const bits = BITS[t] ?? 32;
    if (Number(b) >= bits || Number(b) < 0) panic("Overflow", `shift by ${b} is past the width of ${typeName(t)}`);
    if (bits === 64) return wrap(BigInt(a) << BigInt(b), t);
    return wrap(Number(a) * 2 ** Number(b), t);
}

export function shr(a: Any, b: Any, t: string): Any {
    const bits = BITS[t] ?? 32;
    if (Number(b) >= bits || Number(b) < 0) panic("Overflow", `shift by ${b} is past the width of ${typeName(t)}`);
    if (bits === 64) return BigInt(a) >> BigInt(b);
    return Math.floor(Number(a) / 2 ** Number(b));
}

export function bitnot(x: Any, t: string): Any {
    return wrap(typeof x === "bigint" ? ~x : ~x, t);
}

const FLOATS = new Set(["f32", "f64"]);

/** `x as T` between numbers (§3.3): integers wrap; floats to integers truncate and saturate. */
export function cast(x: Any, from: string, to: string): Any {
    if (FLOATS.has(to)) return typeof x === "bigint" ? Number(x) : x;
    if (to === "char") return String.fromCodePoint(Number(x));
    if (from === "char") x = (x as string).codePointAt(0) ?? 0;
    if (from === "bool") x = x ? 1 : 0;
    if (FLOATS.has(from)) {
        if (Number.isNaN(x)) return BITS[to] === 64 ? 0n : 0;
        const t = Math.trunc(x);
        if (BITS[to] === 64) {
            const [lo, hi] = BIG[to]!;
            if (!Number.isFinite(t)) return t > 0 ? hi : lo;
            const b = BigInt(t);
            return b < lo ? lo : b > hi ? hi : b;
        }
        const [lo, hi] = RANGES[to] ?? RANGES.i32!;
        return t < lo ? lo : t > hi ? hi : t;
    }
    return wrap(x, to);
}

export const big = (x: Any) => (typeof x === "bigint" ? x : BigInt(x));

// ---- copy-on-write (§16.2) -------------------------------------------------------------------------

/** A second holder appears: mark the value shared. */
export function s(x: Any): Any {
    if (x !== null && typeof x === "object" && !x.$id && !(x instanceof Cell)) x.$s = true;
    return x;
}

/** Before a write: a unique version of `x` (itself, or a shallow copy if shared). */
export function u(x: Any): Any {
    if (x === null || typeof x !== "object" || !x.$s || x.$id) return x;
    return copy(x);
}

/** Run-time counters, for `ms run --stats` and the mechanism tests. */
export const stats = { copies: 0 };

function copy(x: Any): Any {
    stats.copies++;
    let c: Any;
    if (x instanceof Vec || x instanceof Tup) {
        c = x instanceof Vec ? new Vec() : new Tup();
        for (const e of x) c.push(s(e));
    } else if (x instanceof MsMap) {
        c = new MsMap();
        for (const [k, [kk, v]] of x.m) c.m.set(k, [kk, s(v)]);
    } else if (x instanceof MsSet) {
        c = new MsSet();
        for (const [k, v] of x.m) c.m.set(k, v);
    } else {
        c = Object.create(Object.getPrototypeOf(x));
        for (const k of Object.keys(x)) if (k !== "$s") c[k] = s(x[k]);
    }
    return c;
}

/** A `shared` cell, or a box for a `*T` argument (§10.1). */
export class Cell {
    v: Any;
    constructor(v: Any) {
        this.v = v;
    }
}
export const cell = (v: Any) => new Cell(v);

// ---- collections ---------------------------------------------------------------------------------

export class Vec extends Array<Any> {
    $s?: boolean;
}
export class Tup extends Array<Any> {
    $s?: boolean;
}
export class Rec {
    [k: string]: Any;
}
export function vec(...xs: Any[]): Vec {
    const v = new Vec();
    for (const x of xs) v.push(x);
    return v;
}
export function tup(...xs: Any[]): Tup {
    const v = new Tup();
    for (const x of xs) v.push(x);
    return v;
}
export function rec(fields: Record<string, Any>): Rec {
    return Object.assign(new Rec(), fields);
}
/** `...xs` in a literal */
export function spread(x: Any): Any[] {
    if (x instanceof MsMap) return [...x.m.values()].map(([k, v]) => tup(k, v));
    if (x instanceof MsSet) return [...x.m.values()];
    return [...x];
}

export function idx(a: Any, i: Any): Any {
    const n = Number(i);
    if (!Number.isInteger(n) || n < 0 || n >= a.length) panic("OutOfBounds", `index ${i} out of bounds (length ${a.length})`);
    return a[n];
}
export function vset(a: Any, i: Any, v: Any): void {
    idx(a, i);
    a[Number(i)] = v;
}

/** A key: primitives, symbols and identity values as themselves; other values by their structure. */
function key(k: Any): Any {
    if (k === null || typeof k !== "object" || k.$id) return k;
    return "\u0000" + keyText(k);
}

/** A value's structure as text, for map keys: an identity value is its pointer (§12.1), never its fields. */
function keyText(v: Any): string {
    if (v === undefined || v === null) return "()";
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v !== "object") return String(v);
    if (v.$id) return `#${objId(v)}`;
    if (v instanceof Cell) return keyText(v.v);
    if (v instanceof WithShape) return keyText(v.v);
    if (v instanceof SymbolC) return `sym:${v.text}`;
    if (v instanceof Some) return `Some(${keyText(v.v)})`;
    if (v === None) return "None";
    if (v instanceof Ok) return `Ok(${keyText(v.v)})`;
    if (v instanceof Err) return `Err(${keyText(v.e)})`;
    if (v instanceof Array) return `[${v.map(keyText).join(",")}]`;
    if (v instanceof MsMap) return `m{${[...v.m.keys()].map((k) => (typeof k === "string" ? k : String(k))).sort().map((k) => `${k}:${keyText(v.m.get(k)![1])}`).join(",")}}`;
    if (v instanceof MsSet) return `s{${[...v.m.keys()].map(String).sort().join(",")}}`;
    const proto = Object.getPrototypeOf(v);
    const fields: string[] = proto?.$f ?? Object.keys(v).filter((k) => k !== "$s").sort();
    const tag = proto?.$v !== undefined ? `${proto.$u}.${proto.$v}` : proto?.$t ?? "r";
    return `${tag}(${fields.map((f) => keyText(v[f])).join(",")})`;
}

export class MsMap {
    m = new Map<Any, [Any, Any]>();
    $s?: boolean;
}
export class MsSet {
    m = new Map<Any, Any>();
    $s?: boolean;
}
export function map(...entries: [Any, Any][]): MsMap {
    const m = new MsMap();
    for (const [k, v] of entries) m.m.set(key(k), [k, v]);
    return m;
}
export function set(...xs: Any[]): MsSet {
    const m = new MsSet();
    for (const x of xs) m.m.set(key(x), x);
    return m;
}
export function mget(m: MsMap, k: Any): Any {
    const e = m.m.get(key(k));
    if (!e) panic("MissingKey", `key ${show(k, null, true)} is missing`);
    return e[1];
}
export function mset(m: MsMap, k: Any, v: Any): void {
    m.m.set(key(k), [k, v]);
}

export class Range {
    start: Any;
    end: Any;
    inclusive: boolean;
    constructor(start: Any, end: Any, inclusive: boolean) {
        this.start = start;
        this.end = end;
        this.inclusive = inclusive;
    }
    *[Symbol.iterator](): Generator<Any> {
        const one = typeof this.start === "bigint" ? 1n : 1;
        for (let i = this.start; this.inclusive ? i <= this.end : i < this.end; i = i + one) yield i;
    }
}
export const range = (a: Any, b: Any, inclusive: boolean) => new Range(a ?? 0, b ?? Infinity, inclusive);

/** `for x in e` over anything iterable: Vec, Set, Range, or an iterator object with `next`. */
export function* iter(x: Any): Generator<Any> {
    if (x instanceof MsSet) return yield* x.m.values();
    if (x instanceof MsMap) {
        for (const [k, v] of x.m.values()) yield tup(k, v);
        return;
    }
    if (x && typeof x[Symbol.iterator] === "function") return yield* x;
    if (x && typeof x.next === "function") {
        for (;;) {
            const n = x.next();
            if (!(n instanceof Some)) return;
            yield n.v;
        }
    }
}

// ---- strings: UTF-8 byte offsets (§7.3, §16.1) -----------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf8 = (s: string) => enc.encode(s);

function sub(s: string, a: number, b: number): string {
    const bytes = utf8(s);
    a = Math.max(0, Math.min(a, bytes.length));
    b = Math.max(a, Math.min(b, bytes.length));
    const inside = (i: number) => i < bytes.length && (bytes[i]! & 0xc0) === 0x80;
    if (inside(a) || inside(b)) panic("OutOfBounds", `byte offset ${inside(a) ? a : b} is inside a character`);
    return dec.decode(bytes.subarray(a, b));
}

// ---- printing (§13.2) ------------------------------------------------------------------------------

/**
 * `to_str`. `shape` says where floats are (JS can't tell `5.0` from `5`): "f", or { e } for
 * elements, { k, v } for maps, { t: [...] } for tuples, { r: {...} } for records, { ok, err }.
 */
export function show(v: Any, shape: Any = null, nested = false): string {
    const sh = shape ?? null;
    if (v === undefined || v === null) return "t()";
    if (typeof v === "string") return nested ? JSON.stringify(v) : v;
    if (typeof v === "number") {
        if (sh === "f") return Number.isInteger(v) && Math.abs(v) < 1e21 ? `${v}.0` : String(v);
        return String(v);
    }
    if (typeof v === "bigint" || typeof v === "boolean") return String(v);
    if (typeof v === "function") return "<fn>";
    if (v instanceof Cell) return show(v.v, sh, nested);
    if (v instanceof WithShape) return show(v.v, v.shape, nested);
    if (v instanceof Some) return `Some(${show(v.v, sh?.e, true)})`;
    if (v === None) return "None";
    if (v instanceof Ok) return `Ok(${show(v.v, sh?.ok, true)})`;
    if (v instanceof Err) return `Err(${show(v.e, sh?.err, true)})`;
    if (v instanceof Vec) return `[${v.map((x) => show(x, sh?.e, true)).join(", ")}]`;
    if (v instanceof Tup) return `t(${v.map((x, i) => show(x, sh?.t?.[i], true)).join(", ")})`;
    if (v instanceof MsMap) return `m{ ${[...v.m.values()].map(([k, x]) => `${show(k, sh?.k, true)}: ${show(x, sh?.v, true)}`).join(", ")} }`.replace("m{  }", "m{}");
    if (v instanceof MsSet) return `s{ ${[...v.m.values()].map((x) => show(x, sh?.e, true)).join(", ")} }`.replace("s{  }", "s{}");
    if (v instanceof Range) return `${show(v.start)}${v.inclusive ? "..=" : ".."}${v.end === Infinity ? "" : show(v.end)}`;
    if (v instanceof Rec) {
        const keys = Object.keys(v).filter((k) => k !== "$s").sort();
        return keys.length === 0 ? "r{}" : `r{ ${keys.map((k) => `${k}: ${show(v[k], sh?.r?.[k], true)}`).join(", ")} }`;
    }
    if (v instanceof SymbolC) return v.text;
    const user = v.to_str;
    if (typeof user === "function") return user.call(v);
    const proto = Object.getPrototypeOf(v);
    if (proto?.$v !== undefined) {
        const fields: string[] = proto.$f ?? [];
        const shapes = proto.$sh ?? {};
        if (fields.length === 0) return proto.$v;
        if (proto.$pos) return `${proto.$v}(${fields.map((f: string) => show(v[f], shapes[f], true)).join(", ")})`;
        return `${proto.$v} { ${fields.map((f: string) => `${f}: ${show(v[f], shapes[f], true)}`).join(", ")} }`;
    }
    if (proto?.$t !== undefined) {
        const fields: string[] = proto.$f ?? [];
        const shapes = proto.$sh ?? {};
        if (fields.length === 0) return `${proto.$t} {}`;
        return `${proto.$t} { ${fields.map((f: string) => `${f}: ${show(v[f], shapes[f], true)}`).join(", ")} }`;
    }
    return String(v);
}

/** A value passed as an interface value with the shape of its static type (floats). */
export class WithShape {
    v: Any;
    shape: Any;
    constructor(v: Any, shape: Any) {
        this.v = v;
        this.shape = shape;
    }
}
export const sh = (v: Any, shape: Any) => new WithShape(v, shape);
const unshape = (v: Any) => (v instanceof WithShape ? v.v : v);

// ---- equality, hashing, ordering -------------------------------------------------------------------

export function eq(a: Any, b: Any): boolean {
    a = unshape(a);
    b = unshape(b);
    if (a === b) return true;
    if (typeof a === "bigint" || typeof b === "bigint") return typeof a !== "object" && typeof b !== "object" && BigInt(a) === BigInt(b);
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    if (a.$id || b.$id) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (a instanceof Cell) return eq(a.v, b.v);
    if (a instanceof Array) return a.length === b.length && a.every((x: Any, i: number) => eq(x, b[i]));
    if (a instanceof MsMap) return a.m.size === b.m.size && [...a.m].every(([k, [, v]]) => b.m.has(k) && eq(v, b.m.get(k)[1]));
    if (a instanceof MsSet) return a.m.size === b.m.size && [...a.m.keys()].every((k) => b.m.has(k));
    const ka = Object.keys(a).filter((k) => k !== "$s");
    return ka.every((k) => eq(a[k], b[k]));
}

export function hash(x: Any): Any {
    const k = key(x);
    const str = typeof k === "string" ? k : typeof k === "object" ? String(objId(k)) : String(k);
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return BigInt(h >>> 0);
}

const ids = new WeakMap<object, number>();
let nextId = 1;
function objId(o: object): number {
    let i = ids.get(o);
    if (!i) ids.set(o, (i = nextId++));
    return i;
}

/** `<` on comparable values (numbers, strings, chars; others by `partial_cmp`). */
export function cmp(a: Any, b: Any): number {
    a = unshape(a);
    b = unshape(b);
    if (typeof a === "object" && a !== null && typeof a.partial_cmp === "function") {
        const o = a.partial_cmp(b);
        const v = o instanceof Some ? o.v : o;
        return v?.$v === "Less" ? -1 : v?.$v === "Greater" ? 1 : 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
}

// ---- dynamic dispatch ------------------------------------------------------------------------------

const defaults = new Map<string, Any>();
/** A default method of an interface, used when a type doesn't define it. */
export function defaultMethod(name: string, f: Any): void {
    if (!defaults.has(name)) defaults.set(name, f);
}

/** A method call on a value whose type is an interface, a bound or unknown. */
export function dyn(x: Any, name: string, ...args: Any[]): Any {
    const v = unshape(x);
    if (v !== null && typeof v === "object" && typeof v[name] === "function") return v[name](...args);
    switch (name) {
        case "to_str": return show(x);
        case "eq": case "same_fields": return eq(v, args[0]);
        case "hash": return hash(v);
        case "clone": return s(v);
        case "partial_cmp": return some(variant("prelude.Ordering", ["Less", "Equal", "Greater"][cmp(v, args[0]) + 1]!));
    }
    // operators of the primitive types, called through `Plus` / `Minus` / … on a generic `T`
    if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") {
        const o = unshape(args[0]);
        const n: Any = v;
        switch (name) {
            case "plus": return n + o;
            case "minus": return n - o;
            case "times": return n * o;
            case "divide":
                if (typeof v === "bigint" && o === 0n) panic("Overflow", "division by zero");
                return typeof v === "number" && Number.isInteger(v) && Number.isInteger(o) ? (o === 0 ? panic("Overflow", "division by zero") : Math.trunc(n / o)) : n / o;
            case "remainder": return n % o;
            case "neg": return -n;
        }
    }
    const b = typeof v === "string" ? builtins[`prelude.str.${name}`] ?? userPrims.get(`prelude.str.${name}`)
        : typeof v === "number" ? builtins[`prelude.int.${name}`] ?? userPrims.get(`prelude.int.${name}`) : undefined;
    if (b) return b(v, ...args);
    const d = defaults.get(name);
    if (d) return d(v, ...args);
    return panic("User", `no method \`${name}\` on ${show(v, null, true)}`);
}

const userPrims = new Map<string, Any>();
/** Prelude methods of primitive types written in MinScript (`str.trim`), for dynamic calls. */
export function prim(name: string, f: Any): void {
    userPrims.set(name, f);
}

// ---- tasks (§11.1) ---------------------------------------------------------------------------------

/** A MinScript Promise: a running task, or a std wait that `select` can cancel. */
export class MsPromise {
    p: Promise<Any>;
    done = false;
    task: Task | null = null;
    /** a cancel-safe wait: stop waiting, giving back a value already taken */
    giveBack: (() => void) | null = null;
    constructor(p: Promise<Any>) {
        this.p = p;
        p.then(() => (this.done = true), () => (this.done = true));
        p.catch(() => {}); // a task nobody awaits ends silently
    }
}

class Task {
    cancelled = false;
    private wakeUp: ((e: Any) => void) | null = null;
    cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        this.wakeUp?.(new MsPanic(makePanic("Cancelled", "the task was cancelled")));
    }
    /** Waits for `p`; a cancel wakes the task with a `Cancelled` panic. */
    wait(p: Promise<Any>, onCancel: (() => void) | null): Promise<Any> {
        return new Promise((resolve, reject) => {
            this.wakeUp = (e) => {
                this.wakeUp = null;
                onCancel?.();
                reject(e);
            };
            p.then((v) => {
                if (this.wakeUp) (this.wakeUp = null), resolve(v);
            }, (e) => {
                if (this.wakeUp) (this.wakeUp = null), reject(e);
            });
        });
    }
}

const current = new AsyncLocalStorage<Task>();

/** Calling an `async fn`: the task starts now and runs until its first `await`. */
export function spawn(body: () => Promise<Any>): MsPromise {
    const t = new Task();
    const p = new MsPromise(current.run(t, body));
    p.task = t;
    return p;
}

/** `await x` (§3.1, §11.1). */
export async function aw(x: Any): Promise<Any> {
    const t = current.getStore();
    if (t?.cancelled) throw new MsPanic(makePanic("Cancelled", "the task was cancelled"));
    const p = x instanceof MsPromise ? x.p : Promise.resolve(x);
    const v = t ? await t.wait(p, x instanceof MsPromise ? x.giveBack : null) : await p;
    if (t?.cancelled) throw new MsPanic(makePanic("Cancelled", "the task was cancelled"));
    return v;
}

/** A cancel-safe wait. `start(resolve)` returns how to stop waiting and give back what it took. */
export function waitFor(start: (resolve: (v: Any) => void) => () => void): MsPromise {
    let stop: () => void = () => {};
    const p = new MsPromise(new Promise((resolve) => (stop = start(resolve))));
    p.giveBack = () => stop();
    return p;
}

export function after(ms: Any): MsPromise {
    return waitFor((resolve) => {
        const id = setTimeout(() => resolve(undefined), Number(ms));
        return () => clearTimeout(id);
    });
}

/**
 * `select` (§4.9): the first ready arm; several ready at once: one at random. A refutable pattern
 * that doesn't match disables its arm. The losing std waits are cancelled (cancel-safe: a value
 * they took goes back); losing tasks keep running (§4.9 point 6).
 */
export function select(waits: Any[], tests: ((v: Any) => boolean)[], hasElse: boolean): MsPromise {
    const ps = waits.map((w) => (w instanceof MsPromise ? w : new MsPromise(Promise.resolve(w))));
    const settled = ps.map(() => null as null | { ok: boolean; v: Any });
    ps.forEach((p, i) => p.p.then((v) => (settled[i] = { ok: true, v }), (e) => (settled[i] = { ok: false, v: e })));
    const enabled = ps.map(() => true);
    const cancelOthers = (keep: number) => ps.forEach((p, i) => i !== keep && p.giveBack?.());
    const run = async (): Promise<Any> => {
        for (;;) {
            const live = enabled.map((e, i) => (e ? i : -1)).filter((i) => i >= 0);
            if (live.length === 0) {
                if (hasElse) return tup(-1, undefined);
                panic("SelectExhausted", "every `select` arm is disabled and there is no `else`");
            }
            await Promise.resolve();
            let ready = live.filter((i) => settled[i] !== null);
            if (ready.length === 0 && hasElse) {
                cancelOthers(-1);
                return tup(-1, undefined);
            }
            if (ready.length === 0) {
                await Promise.race(live.map((i) => ps[i]!.p.then(() => {}, () => {})));
                await Promise.resolve();
                ready = live.filter((i) => settled[i] !== null);
            }
            const i = ready[Math.floor(Math.random() * ready.length)]!;
            const r = settled[i]!;
            if (!r.ok) {
                cancelOthers(i);
                throw r.v;
            }
            if (!tests[i]!(r.v)) {
                enabled[i] = false;
                continue;
            }
            cancelOthers(i);
            return tup(i, r.v);
        }
    };
    const p = new MsPromise(run());
    p.giveBack = () => cancelOthers(-1);
    return p;
}

// ---- Topic, Queue, Signal (§11.3) ------------------------------------------------------------------

class Waiters {
    list: ((v: Any) => void)[] = [];
    add(f: (v: Any) => void): () => void {
        this.list.push(f);
        return () => {
            this.list = this.list.filter((x) => x !== f);
        };
    }
}

class TopicState {
    subs: SubState[] = [];
    open = true;
    buffer: number;
    constructor(buffer: number) {
        this.buffer = buffer;
    }
}

class QueueState {
    items: Any[] = [];
    open = true;
    capacity: number;
    takers = new Waiters();
    space = new Waiters();
    constructor(capacity: number) {
        this.capacity = capacity;
    }
}

class SubState {
    items: Any[] = [];
    missed = 0;
    waiters = new Waiters();
    topic: TopicState | null;
    queue: QueueState | null;
    constructor(topic: TopicState | null, queue: QueueState | null) {
        this.topic = topic;
        this.queue = queue;
    }
    closed(): boolean {
        return this.topic ? !this.topic.open : !this.queue!.open;
    }
    take(): Any {
        const from = this.topic ? this.items : this.queue!.items;
        if (from.length === 0) return undefined;
        const v = from.shift();
        this.queue?.space.list.shift()?.(undefined);
        return v;
    }
    putBack(v: Any): void {
        (this.topic ? this.items : this.queue!.items).unshift(v);
    }
    next(): MsPromise {
        return waitFor((resolve) => {
            let taken: Any = undefined;
            let has = false;
            const give = (v: Any) => {
                has = true;
                taken = v;
                resolve(some(v));
            };
            const now = this.take();
            if (now !== undefined) {
                give(now);
                return () => has && this.putBack(taken);
            }
            if (this.closed()) {
                resolve(None);
                return () => {};
            }
            const waiters = this.queue ? this.queue.takers : this.waiters;
            const off = waiters.add((v) => (v === CLOSED ? resolve(None) : give(v)));
            return () => {
                off();
                if (has) this.putBack(taken);
            };
        });
    }
}

const CLOSED = Symbol("closed");

class SignalState {
    v: Any;
    version = 0;
    watchers = new Waiters();
    constructor(v: Any) {
        this.v = v;
    }
}

// ---- symbols and weak references (§12.3, §12.4) ----------------------------------------------------

export class SymbolC {
    text: string;
    constructor(text: string) {
        this.text = text;
    }
}
(SymbolC.prototype as Any).$id = true;
const symbols = new Map<string, SymbolC>();

// ---- builtins: the `_builtin()` functions of the prelude and std, by name --------------------------

const strFns = {
    len: (s: string) => utf8(s).length,
    substring: (s: string, a: Any, b: Any) => sub(s, Number(a), Number(b)),
    byte_at: (s: string, i: Any) => {
        const b = utf8(s);
        const n = Number(i);
        if (n < 0 || n >= b.length) panic("OutOfBounds", `byte ${i} out of bounds (length ${b.length})`);
        return b[n]!;
    },
    find: (s: string, needle: string, from: Any) => {
        const b = utf8(s);
        const n = utf8(needle);
        outer: for (let i = Number(from); i + n.length <= b.length; i++) {
            for (let j = 0; j < n.length; j++) if (b[i + j] !== n[j]) continue outer;
            return some(i);
        }
        return None;
    },
    to_lower: (s: string) => s.toLowerCase(),
    to_upper: (s: string) => s.toUpperCase(),
    to_float: (s: string) => {
        const t = s.trim();
        const v = Number(t);
        return t !== "" && !Number.isNaN(v) ? ok(v) : err(`not a number: "${s}"`);
    },
    bytes: (s: string) => vec(...utf8(s)),
    chars: (s: string) => vec(...Array.from(s)),
    detach: (s: string) => s,
};

const intFns = (t: string) => ({
    wrapping_add: (a: Any, b: Any) => wrap(t.endsWith("64") ? big(a) + big(b) : a + b, t),
    wrapping_sub: (a: Any, b: Any) => wrap(t.endsWith("64") ? big(a) - big(b) : a - b, t),
    wrapping_mul: (a: Any, b: Any) => wrap(t.endsWith("64") ? big(a) * big(b) : a * b, t),
    saturating_add: (a: Any, b: Any) => sat(t.endsWith("64") ? big(a) + big(b) : a + b, t),
    saturating_sub: (a: Any, b: Any) => sat(t.endsWith("64") ? big(a) - big(b) : a - b, t),
    saturating_mul: (a: Any, b: Any) => sat(t.endsWith("64") ? big(a) * big(b) : a * b, t),
    checked_add: (a: Any, b: Any) => checked(t.endsWith("64") ? big(a) + big(b) : a + b, t),
    checked_sub: (a: Any, b: Any) => checked(t.endsWith("64") ? big(a) - big(b) : a - b, t),
    checked_mul: (a: Any, b: Any) => checked(t.endsWith("64") ? big(a) * big(b) : a * b, t),
});

function sat(x: Any, t: string): Any {
    if (typeof x === "bigint") {
        const [lo, hi] = BIG[t]!;
        return x < lo ? lo : x > hi ? hi : x;
    }
    const [lo, hi] = RANGES[t] ?? RANGES.i32!;
    return x < lo ? lo : x > hi ? hi : x;
}

function checked(x: Any, t: string): Any {
    try {
        return some(chk(x, t));
    } catch {
        return None;
    }
}

const LOG = (prefix: string, stream: "out" | "err") => (_log: Any, args: Any) => {
    const line = [...args].map((a: Any) => show(a)).join(" ");
    (stream === "out" ? process.stdout : process.stderr).write(prefix + line + "\n");
};

export const builtins: Record<string, Any> = {
    "prelude._builtin": () => panic("User", "a `_builtin()` body was called"),
    "prelude.panic": (msg: string) => panic("User", msg),
    "prelude._panic_kind": (kind: Any, msg: string) => panic(kind?.$v ?? "User", msg),
    "prelude.sym": (text: string) => {
        let s = symbols.get(text);
        if (!s) symbols.set(text, (s = new SymbolC(text)));
        return s;
    },
    "prelude.Symbol.text": (s: SymbolC) => s.text,
    "prelude.Weak.upgrade": (w: Any) => {
        const v = w.ref?.deref();
        return v === undefined ? None : some(v);
    },

    "prelude.Option.or": (o: Any, f: Any) => (o instanceof Some ? o.v : typeof f === "function" ? f() : f),
    "prelude.Result.or": (r: Any, f: Any) => (r instanceof Ok ? r.v : typeof f === "function" ? f() : f),

    "prelude.Vec.with_capacity": () => new Vec(),
    "prelude.Vec.len": (v: Vec) => v.length,
    "prelude.Vec.get": (v: Vec, i: Any) => (Number(i) >= 0 && Number(i) < v.length ? some(s(v[Number(i)])) : None),
    "prelude.Vec.push": (v: Vec, x: Any) => void v.push(x),
    "prelude.Vec.pop": (v: Vec) => (v.length > 0 ? some(v.pop()) : None),
    "prelude.Vec.insert": (v: Vec, i: Any, x: Any) => {
        if (Number(i) < 0 || Number(i) > v.length) panic("OutOfBounds", `index ${i} out of bounds (length ${v.length})`);
        v.splice(Number(i), 0, x);
    },
    "prelude.Vec.remove": (v: Vec, i: Any) => {
        idx(v, i);
        return v.splice(Number(i), 1)[0];
    },
    "prelude.Vec.truncate": (v: Vec, n: Any) => void (v.length = Math.min(v.length, Number(n))),
    "prelude.Vec.swap": (v: Vec, i: Any, j: Any) => {
        const a = idx(v, i);
        v[Number(i)] = idx(v, j);
        v[Number(j)] = a;
    },
    "prelude.Vec.drain": (v: Vec) => {
        const out = vec(...v);
        v.length = 0;
        return out;
    },
    "prelude.Vec.sort_by": (v: Vec, f: Any) => {
        const sorted = [...v].sort((a, b) => {
            const o = f(a, b);
            return o?.$v === "Less" ? -1 : o?.$v === "Greater" ? 1 : 0;
        });
        sorted.forEach((x, i) => (v[i] = x));
    },
    "prelude.Vec.at_mut": (v: Vec, i: Any) => {
        const x = u(idx(v, i));
        v[Number(i)] = x;
        return x;
    },
    "prelude.Vec.iter": (v: Vec) => iterator(s(v)),
    "prelude.Array.len": (v: Any) => v.length,
    "prelude.Array.get": (v: Any, i: Any) => (Number(i) >= 0 && Number(i) < v.length ? some(s(v[Number(i)])) : None),
    "prelude.Array.iter": (v: Any) => iterator(s(v)),
    "prelude.Slice.len": (v: Any) => v.length,
    "prelude.Slice.get": (v: Any, i: Any) => (Number(i) >= 0 && Number(i) < v.length ? some(s(v[Number(i)])) : None),
    "prelude.Slice.iter": (v: Any) => iterator(s(v)),

    "prelude.Map.new": () => new MsMap(),
    "prelude.Map.len": (m: MsMap) => m.m.size,
    "prelude.Map.get": (m: MsMap, k: Any) => {
        const e = m.m.get(key(k));
        return e ? some(s(e[1])) : None;
    },
    "prelude.Map.has": (m: MsMap, k: Any) => m.m.has(key(k)),
    "prelude.Map.insert": (m: MsMap, k: Any, v: Any) => {
        const old = m.m.get(key(k));
        m.m.set(key(k), [k, v]);
        return old ? some(old[1]) : None;
    },
    "prelude.Map.remove": (m: MsMap, k: Any) => {
        const old = m.m.get(key(k));
        m.m.delete(key(k));
        return old ? some(old[1]) : None;
    },
    "prelude.Map.clear": (m: MsMap) => m.m.clear(),
    "prelude.Map.drain": (m: MsMap) => {
        const out = new MsMap();
        for (const [k, e] of m.m) out.m.set(k, e);
        m.m.clear();
        return out;
    },
    "prelude.Map.entry": (m: MsMap, k: Any, v: Any) => {
        const kk = key(k);
        if (!m.m.has(kk)) m.m.set(kk, [k, v]);
        const e = m.m.get(kk)!;
        e[1] = u(e[1]);
        return e[1];
    },
    "prelude.Map.iter": (m: MsMap) => iterator([...m.m.values()].map(([k, v]) => tup(k, v))),
    "prelude.Set.new": () => new MsSet(),
    "prelude.Set.len": (m: MsSet) => m.m.size,
    "prelude.Set.has": (m: MsSet, x: Any) => m.m.has(key(x)),
    "prelude.Set.insert": (m: MsSet, x: Any) => {
        const had = m.m.has(key(x));
        m.m.set(key(x), x);
        return !had;
    },
    "prelude.Set.remove": (m: MsSet, x: Any) => m.m.delete(key(x)),
    "prelude.Set.iter": (m: MsSet) => iterator([...m.m.values()]),
    "prelude.Range.contains": (r: Range, x: Any) => x >= r.start && (r.inclusive ? x <= r.end : x < r.end),
    "prelude.Range.len": (r: Range) => Math.max(0, Number(r.end) - Number(r.start) + (r.inclusive ? 1 : 0)),
    "prelude.Range.iter": (r: Range) => iterator([...r]),
    "prelude.Range.rev": (r: Range) => iterator([...r].reverse()),

    "prelude.PMap.new": () => new MsMap(),
    "prelude.PMap.with": (m: MsMap, k: Any, v: Any) => {
        const c = new MsMap();
        for (const [kk, e] of m.m) c.m.set(kk, e);
        c.m.set(key(k), [k, v]);
        return c;
    },
    "prelude.PMap.without": (m: MsMap, k: Any) => {
        const c = new MsMap();
        for (const [kk, e] of m.m) if (kk !== key(k)) c.m.set(kk, e);
        return c;
    },
    "prelude.PMap.get": (m: MsMap, k: Any) => {
        const e = m.m.get(key(k));
        return e ? some(s(e[1])) : None;
    },
    "prelude.PMap.has": (m: MsMap, k: Any) => m.m.has(key(k)),
    "prelude.PMap.len": (m: MsMap) => m.m.size,
    "prelude.PMap.iter": (m: MsMap) => iterator([...m.m.values()].map(([k, v]) => tup(k, v))),

    "prelude.Promise.new": () => {
        let resolve: (v: Any) => void = () => {};
        const p = new MsPromise(new Promise((r) => (resolve = r)));
        return tup(p, { resolve });
    },
    "prelude.Resolver.resolve": (r: Any, v: Any) => r.resolve(v),
    "prelude.Promise.all": (ps: Any) => new MsPromise(Promise.all([...ps].map((p: Any) => (p instanceof MsPromise ? p.p : p))).then((xs) => vec(...xs))),
    "prelude.all": (ps: Any) => new MsPromise(Promise.all([...ps].map((p: Any) => (p instanceof MsPromise ? p.p : p))).then((xs) => tup(...xs))),
    "prelude.race": (ps: Any) => new MsPromise(Promise.race([...ps].map((p: Any) => (p instanceof MsPromise ? p.p : p)))),
    "prelude.Promise.then": (p: MsPromise, f: Any) => new MsPromise(p.p.then((v) => (f(v), v))),
    "prelude.Promise.catch": (p: MsPromise, f: Any) => new MsPromise(p.p.catch((e) => f(caught(e)))),
    "prelude.Promise.ignore": (p: MsPromise) => {
        p.p.catch((e) => {
            const pn = caught(e);
            if (pn.kind?.$v !== "Cancelled") process.stderr.write(`panic in an ignored task: ${pn.message}\n${pn.trace}\n`);
        });
    },
    "prelude.Promise.timeout": (p: MsPromise, ms: Any) => {
        const t = after(ms);
        return new MsPromise(Promise.race([p.p.then((v) => ok(v)), t.p.then(() => err(variantOrObj("prelude.Timeout")))]));
    },
    "prelude.Promise.cancel": (p: MsPromise) => {
        p.task?.cancel();
        p.giveBack?.();
    },
    "prelude.Promise.is_done": (p: MsPromise) => p.done,

    "prelude.Topic.new": () => ({ $topic: new TopicState(64) }),
    "prelude.Topic.with": (o: Any) => ({ $topic: new TopicState(Number(o?.buffer ?? 64)) }),
    "prelude.Topic.publish": (t: Any, v: Any) => {
        const st: TopicState = t.$topic;
        if (!st.open) return 0;
        for (const sub of st.subs) {
            const w = sub.waiters.list.shift();
            if (w) w(s(v));
            else {
                sub.items.push(s(v));
                if (sub.items.length > st.buffer) (sub.items.shift(), sub.missed++);
            }
        }
        return st.subs.length;
    },
    "prelude.Topic.subscribe": (t: Any) => {
        const sub = new SubState(t.$topic, null);
        t.$topic.subs.push(sub);
        return { $sub: sub };
    },
    "prelude.Topic.subscribers": (t: Any) => t.$topic.subs.length,
    "prelude.Topic.close": (t: Any) => {
        const st: TopicState = t.$topic;
        st.open = false;
        for (const sub of st.subs) for (const w of sub.waiters.list.splice(0)) w(CLOSED);
    },
    "prelude.Queue.new": () => ({ $queue: new QueueState(1024) }),
    "prelude.Queue.with": (o: Any) => ({ $queue: new QueueState(Number(o?.capacity ?? 1024)) }),
    "prelude.Queue.publish": (q: Any, v: Any) => {
        const st: QueueState = q.$queue;
        const put = (): Any => {
            if (!st.open) return err(variant("prelude.PublishError", "Closed", v));
            const w = st.takers.list.shift();
            if (w) w(v);
            else st.items.push(v);
            return ok(undefined);
        };
        if (!st.open || st.items.length < st.capacity || st.takers.list.length > 0) return new MsPromise(Promise.resolve(put()));
        return waitFor((resolve) => st.space.add(() => resolve(put())));
    },
    "prelude.Queue.try_publish": (q: Any, v: Any) => {
        const st: QueueState = q.$queue;
        if (!st.open) return err(variant("prelude.PublishError", "Closed", v));
        if (st.items.length >= st.capacity && st.takers.list.length === 0) return err(variant("prelude.PublishError", "Full", v));
        const w = st.takers.list.shift();
        if (w) w(v);
        else st.items.push(v);
        return ok(undefined);
    },
    "prelude.Queue.subscribe": (q: Any) => ({ $sub: new SubState(null, q.$queue) }),
    "prelude.Queue.len": (q: Any) => q.$queue.items.length,
    "prelude.Queue.close": (q: Any) => {
        const st: QueueState = q.$queue;
        st.open = false;
        for (const w of st.takers.list.splice(0)) w(CLOSED);
    },
    "prelude.Sub.next": (sb: Any) => sb.$sub.next(),
    "prelude.Sub.try_next": (sb: Any) => {
        const v = sb.$sub.take();
        return v === undefined ? None : some(v);
    },
    "prelude.Sub.missed": (sb: Any) => {
        const n = sb.$sub.missed;
        sb.$sub.missed = 0;
        return n;
    },
    "prelude.Signal.new": (v: Any) => ({ $signal: new SignalState(v) }),
    "prelude.Signal.get": (sg: Any) => sg.$signal.v,
    "prelude.Signal.set": (sg: Any, v: Any) => {
        const st: SignalState = sg.$signal;
        if (eq(st.v, v)) return;
        st.v = v;
        st.version++;
        for (const w of st.watchers.list.splice(0)) w(undefined);
    },
    "prelude.Signal.update": (sg: Any, f: Any) => {
        const st: SignalState = sg.$signal;
        const box = new Cell(u(st.v));
        const r = f(box);
        if (!eq(st.v, box.v)) {
            st.v = box.v;
            st.version++;
            for (const w of st.watchers.list.splice(0)) w(undefined);
        }
        return r;
    },
    "prelude.Signal.watch": (sg: Any) => ({ $watch: { signal: sg.$signal as SignalState, seen: sg.$signal.version as number } }),
    "prelude.Watcher.next": (w: Any) => {
        const st = w.$watch;
        return waitFor((resolve) => {
            if (st.signal.version !== st.seen) {
                st.seen = st.signal.version;
                resolve(some(st.signal.v));
                return () => {};
            }
            return st.signal.watchers.add(() => {
                st.seen = st.signal.version;
                resolve(some(st.signal.v));
            });
        });
    },

    "prelude.Log.println": LOG("", "out"),
    "prelude.Log.print": (_l: Any, args: Any) => process.stdout.write([...args].map((a: Any) => show(a)).join(" ")),
    "prelude.Log.info": LOG("", "out"),
    "prelude.Log.debug": LOG("debug: ", "err"),
    "prelude.Log.warn": LOG("warning: ", "err"),
    "prelude.Log.error": LOG("error: ", "err"),

    "std.time.after": (ms: Any) => after(ms),
    "std.time.sleep": (ms: Any) => spawn(async () => aw(after(ms))),
    "std.time.now": () => BigInt(Date.now()),
};

for (const [name, f] of Object.entries(strFns)) builtins[`prelude.str.${name}`] = f;
for (const t of ["int", "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "isize", "usize"]) {
    for (const [name, f] of Object.entries(intFns(t))) builtins[`prelude.${t}.${name}`] = f;
}

function variantOrObj(name: string): Any {
    const C = classes.get(name);
    return C ? new C() : {};
}

/** A prelude Iterator over a snapshot of values. */
function iterator(xs: Any[]): Any {
    let i = 0;
    const it: Any = {
        next: () => (i < xs.length ? some(s(xs[i++])) : None),
        map: (f: Any) => iterator(xs.slice(i).map((x) => f(s(x)))),
        filter: (f: Any) => iterator(xs.slice(i).filter((x) => f(s(x))).map(s)),
        collect: () => vec(...xs.slice(i).map(s)),
        [Symbol.iterator]: function* () {
            while (i < xs.length) yield s(xs[i++]);
        },
    };
    return it;
}

/** The runtime function for a `_builtin()` body; one that isn't written yet panics when called. */
export function builtin(name: string): Any {
    const f = builtins[name];
    if (f) return f;
    return (..._args: Any[]) => panic("User", `the builtin \`${name}\` is not implemented on the JS back end yet`);
}

export function weak(x: Any): Any {
    return { ref: new WeakRef(x) };
}

/** A once field write (§12.2): the first one sets it, a second panics. */
export function setOnce(o: Any, f: string, v: Any): void {
    if (o[f] !== undefined) panic("AlreadySet", `\`${f}\` is a once field and was already set`);
    o[f] = v;
}

/** A top-level `let`: initialised once, on first use (§10.4). */
// ---- type descriptors and witness tables (§15.4) ---------------------------------------------------
// A descriptor: `{ p: "int" }`, `{ n: "Point", a: [...] }`, `{ t: [...] }`, `{ r: {...} }`; inside a
// class's `$ft`, `{ g: i }` is the type's i-th generic parameter. `null`: not known.

export type Desc = { p: string } | { n: string; a: Desc[] } | { t: Desc[] } | { r: Record<string, Desc> } | { g: number } | null;

/** `{ g: i }` replaced by the i-th argument. */
export function substDesc(d: Desc, args: Desc[]): Desc {
    if (d === null) return null;
    if ("g" in d) return args[d.g] ?? null;
    if ("n" in d) return { n: d.n, a: d.a.map((x) => substDesc(x, args)) };
    if ("t" in d) return { t: d.t.map((x) => substDesc(x, args)) };
    if ("r" in d) return { r: Object.fromEntries(Object.entries(d.r).map(([k, x]) => [k, substDesc(x, args)])) };
    return d;
}

/** A witness table: the type's descriptor, and its default. */
export function wt(d: Desc): Any {
    return { d, def: () => defaultOf(d) };
}

const statics = new Map<string, Record<string, Any>>();
/** `Point.default`: a type's static method, for `T.default()` through a witness. */
export function defStatic(type: string, name: string, f: Any): void {
    const m = statics.get(type) ?? {};
    m[name] = f;
    statics.set(type, m);
}

/** `T.method(args)` for a generic parameter `T`, through the witness its caller passed. */
export function wstatic(w: Any, method: string, args: Any[]): Any {
    const d: Desc = w?.d ?? null;
    if (d !== null && "n" in d) {
        const f = statics.get(d.n)?.[method];
        if (f) return f(...args);
    }
    if (method === "default") return defaultOf(d);
    return panic("User", `no static \`${method}\` on ${describe(d)}`);
}

export function describe(d: Desc): string {
    if (d === null) return "a type not known at run time";
    if ("p" in d) return d.p;
    if ("n" in d) return d.a.length ? `${d.n.replace(/^prelude\./, "")}[${d.a.map(describe).join(", ")}]` : d.n.replace(/^prelude\./, "");
    if ("t" in d) return `t(${d.t.map(describe).join(", ")})`;
    if ("r" in d) return `r{ ${Object.entries(d.r).map(([k, x]) => `${k}: ${describe(x)}`).join(", ")} }`;
    return "a generic parameter";
}

const BIG_TYPES = new Set(["i64", "u64"]);

/** The default of a type: zero, "", false, empty collections, None; a struct of its fields' defaults. */
export function defaultOf(d: Desc): Any {
    if (d === null) return panic("User", "the default of a type that isn't known at run time");
    if ("p" in d) {
        if (BIG_TYPES.has(d.p)) return 0n;
        if (d.p === "str") return "";
        if (d.p === "bool") return false;
        if (d.p === "char") return "\0";
        if (d.p === "void") return undefined;
        return 0;
    }
    if ("t" in d) return tup(...d.t.map(defaultOf));
    if ("r" in d) return rec(Object.fromEntries(Object.entries(d.r).map(([k, x]) => [k, defaultOf(x)])));
    if (!("n" in d)) return null;
    switch (d.n) {
        case "prelude.Vec": case "prelude.Array": case "prelude.Slice": case "prelude.PVec": return vec();
        case "prelude.Map": case "prelude.PMap": return map();
        case "prelude.Set": return set();
        case "prelude.Option": return None;
    }
    const own = statics.get(d.n)?.default;
    if (own) return own();
    const C = classes.get(d.n);
    if (!C) return panic("User", `\`${describe(d)}\` has no default (it isn't a struct, and implements no \`default\`)`);
    const proto = C.prototype;
    const fields: Record<string, Any> = {};
    for (const f of proto.$f as string[]) {
        const v = proto.$def?.[f] ? proto.$def[f]() : (proto.$once ?? []).includes(f) ? undefined : defaultOf(substDesc(proto.$ft?.[f] ?? null, d.a));
        fields[f] = (proto.$cells ?? []).includes(f) ? cell(v) : v;
    }
    return make(d.n, fields);
}

export function lazy(init: () => Any): () => Any {
    let done = false;
    let v: Any;
    return () => {
        if (!done) {
            v = init();
            done = true;
        }
        return v;
    };
}

/** `runtime.exit(code)`: ends the program. Not an Error, so `recover` doesn't catch it. */
export class ExitRequest {
    code: number;
    constructor(code: number) {
        this.code = code;
    }
}
export const exitRequest = (code: number) => new ExitRequest(code);

/** Runs a compiled program's `main`: prints an uncaught panic; the exit code (101 after a panic). */
export async function runMain(main: () => Any): Promise<{ code: number; value: Any }> {
    try {
        let r = main();
        if (r instanceof MsPromise) r = await r.p;
        return { code: 0, value: r };
    } catch (e) {
        if (e instanceof ExitRequest) return { code: e.code, value: undefined };
        const p = caught(e);
        process.stderr.write(`panic: ${p.message}\n${p.trace}\n`);
        return { code: 101, value: undefined };
    }
}
