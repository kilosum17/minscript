// The JS runtime for MinScript programs (spec §14.2). Generated code imports this module as `$rt`
// and calls std functions through `$rt.std["Vec.push"]`.
//
// Representations:
//   struct  { $t: "User", id: 1, name: "Ted" }          record  { id: 1 }       tuple / Vec / Array / Slice  JS array
//   variant { $t: "Shape", $v: "Square", $f: [2] }      Option / Result: the same (`None` is shared)
//   Map / Set  MsMap / MsSet (structural keys)          i64 / u64  BigInt; other numbers  number
//   unit  undefined      panic  a thrown `Panic`      Promise  JS Promise
//
// Not yet on JS (spec §14.2): overflow checks, exact wrapping of i8…u32, cooperative cancel of tasks.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as childProcess from "node:child_process"
import * as cryptoModule from "node:crypto"
import * as fsPromises from "node:fs/promises"

type Any = any

// ---- output -----------------------------------------------------------------------------------

let output: (line: string) => void = (line) => { console.log(line) }
let captured = false
export function setOutput(fn: (line: string) => void): void { output = fn; captured = true }
export function resetOutput(): void { output = (line) => { console.log(line) }; captured = false }

// ---- panics -----------------------------------------------------------------------------------

export class Panic extends Error {
    readonly kind: string
    constructor(kind: string, message: string) {
        super(message)
        this.kind = kind
    }
}

export function panic(message: string, kind = "User"): never {
    throw new Panic(kind, message)
}

/** The MinScript `Panic` value for a caught JS exception (recover, `.catch`). */
export function panicValue(e: unknown): Any {
    const kind = e instanceof Panic ? e.kind : "User"
    const message = e instanceof Error ? e.message : String(e)
    return { $t: "std.Panic", message, file: "", line: 0, trace: e instanceof Error ? e.stack ?? "" : "", kind: { $t: "std.PanicKind", $v: kind, $f: [] } }
}

// ---- values -----------------------------------------------------------------------------------

export const None: Any = Object.freeze({ $t: "std.Option", $v: "None", $f: [] })
export const Some = (v: Any): Any => ({ $t: "std.Option", $v: "Some", $f: [v] })
export const Ok = (v: Any): Any => ({ $t: "std.Result", $v: "Ok", $f: [v] })
export const Err = (e: Any): Any => ({ $t: "std.Result", $v: "Err", $f: [e] })
export const opt = (v: Any): Any => (v === undefined ? None : Some(v))

/** Some(_) / Ok(_): truthiness (spec §4.7) and the `ok` pattern. */
export function isOk(v: Any): boolean {
    return v !== null && typeof v === "object" ? v.$v === "Some" || v.$v === "Ok" : Boolean(v)
}

/** A variant constructor used as a function value (`items.map(Some)`). */
export function ctor(union: string, variant: string): (...args: Any[]) => Any {
    return (...args: Any[]) => ({ $t: union, $v: variant, $f: args })
}

/** `x.0` on a tuple (array) or a variant's payload. */
export function idx(o: Any, i: number): Any {
    if (Array.isArray(o)) return o[i]
    if (o && o.$f) return o.$f[i]
    return o?.[i]
}

// ---- type registry (filled in by generated code) ----------------------------------------------

type TypeInfo = { kind: "struct" | "union", fields: Any, methods: Record<string, Function>, interfaces: string[], floats: Set<string>, shapes: Record<string, Shape>, defaults: Record<string, () => Any> }
const types = new Map<string, TypeInfo>()
const interDefaults = new Map<string, Record<string, Function>>()

/** `floats`: fields printed as floats (`r` for a struct, `Circle.r` / `Rect.0` for a variant). */
export function defType(name: string, kind: "struct" | "union", fields: Any, methods: Record<string, Function>, interfaces: string[], floats: string[] = [], shapes: Record<string, Shape> = {}, defaults: Record<string, () => Any> = {}): void {
    types.set(name, { kind, fields, methods, interfaces, floats: new Set(floats), shapes, defaults })
}

export function defInter(name: string, defaults: Record<string, Function>): void {
    interDefaults.set(name, defaults)
}

// ---- equality, hashing, cloning, printing (auto-generated interfaces, spec §9.7) ---------------

export function eq(a: Any, b: Any): boolean {
    if (a === b) return true
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
    const user = a.$t ? types.get(a.$t)?.methods["eq"] : undefined
    if (user) return Boolean(user(a, b))
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => eq(x, b[i]))
    if (a instanceof MsMap) return b instanceof MsMap && a.size === b.size && [...a.inner].every(([k, [, v]]) => b.inner.has(k) && eq(v, b.inner.get(k)![1]))
    if (a instanceof MsSet) return b instanceof MsSet && a.size === b.size && [...a.inner.keys()].every((k) => b.inner.has(k))
    if (a.$v !== undefined) return a.$t === b.$t && a.$v === b.$v && eq(a.$f, b.$f)
    const ka = Object.keys(a), kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => eq(a[k], b[k]))
}

/** A stable key for structural Map / Set keys. */
export function hashKey(v: Any): Any {
    if (v === null || typeof v !== "object") return typeof v === "bigint" ? `${v}n` : v
    return "\u0000" + toStr(v)
}

export function clone(v: Any): Any {
    if (v === null || typeof v !== "object") return v
    if (Array.isArray(v)) return v.map(clone)
    if (v instanceof MsMap) { const m = new MsMap(); for (const [k, x] of v.entries()) m.set(clone(k), clone(x)); return m }
    if (v instanceof MsSet) { const s = new MsSet(); for (const k of v.values()) s.add(clone(k)); return s }
    if (v instanceof Ref || v instanceof Topic || v instanceof Queue || v instanceof Signal || v instanceof Promise) return v   // handles
    if (v.$v !== undefined) return v === None ? None : { $t: v.$t, $v: v.$v, $f: v.$f.map(clone) }
    const out: Any = {}
    for (const k of Object.keys(v)) out[k] = clone(v[k])
    return out
}

function quote(v: Any, float = false): string {
    if (float && typeof v === "number") return toStrF(v)
    return typeof v === "string" ? JSON.stringify(v) : toStr(v)
}

export function toStr(v: Any): string {
    if (v === undefined) return "t()"
    if (v === null) return "nil"
    switch (typeof v) {
        case "string": return v
        case "number": case "boolean": return String(v)
        case "bigint": return String(v)
        case "function": return "<fn>"
    }
    if (v.$t) {
        const user = types.get(v.$t)?.methods["to_str"]
        if (user) return String(user(v))
    }
    if (Array.isArray(v)) return `[${v.map((x: Any) => quote(x)).join(", ")}]`
    if (v instanceof MsMap) return `m{ ${[...v.entries()].map(([k, x]) => `${quote(k)}: ${quote(x)}`).join(", ")} }`
    if (v instanceof MsSet) return `s{ ${[...v.values()].map((x: Any) => quote(x)).join(", ")} }`
    if (v instanceof Ref) return `Ref(${quote(v.v)})`
    if (v instanceof Promise) return "Promise"
    const name = (t: string) => (t.startsWith("std.") ? t.slice(4) : t)
    if (v.$v !== undefined) {
        if (v.$f.length === 0) return v.$v
        const info = types.get(v.$t)
        const names: string[] | null = info?.fields?.[v.$v] ?? null
        const isFloat = (n: string) => info?.floats.has(`${v.$v}.${n}`) ?? false
        if (names && names.length > 0 && names[0] !== "0") return `${v.$v} { ${names.map((n, i) => `${n}: ${quote(v.$f[i], isFloat(n))}`).join(", ")} }`
        return `${v.$v}(${v.$f.map((x: Any, i: number) => quote(x, isFloat(`${i}`))).join(", ")})`
    }
    const floats = v.$t ? types.get(v.$t)?.floats : undefined
    const keys = Object.keys(v).filter((k) => k !== "$t")
    const body = keys.map((k) => `${k}: ${quote(v[k], floats?.has(k) ?? false)}`).join(", ")
    return v.$t ? `${name(v.$t)} { ${body} }` : `r{ ${body} }`
}

/** to_str of a float: `2.0`, not `2` (the type is known where this is emitted). */
export function toStrF(v: number): string {
    return Number.isInteger(v) && Number.isFinite(v) ? v.toFixed(1) : String(v)
}

// ---- numbers ----------------------------------------------------------------------------------

export function idiv(a: number, b: number): number {
    if (b === 0) panic("division by zero", "Overflow")
    return Math.trunc(a / b)
}
export function irem(a: number, b: number): number {
    if (b === 0) panic("division by zero", "Overflow")
    return a % b
}
export function bdiv(a: bigint, b: bigint): bigint {
    if (b === 0n) panic("division by zero", "Overflow")
    return a / b
}
export function brem(a: bigint, b: bigint): bigint {
    if (b === 0n) panic("division by zero", "Overflow")
    return a % b
}

// ---- collections ------------------------------------------------------------------------------

export function at(v: Any[], i: number): Any {
    if (i < 0 || i >= v.length || !Number.isInteger(i)) panic(`index ${i} out of bounds (length ${v.length})`, "OutOfBounds")
    return v[i]
}

export function setAt(v: Any[], i: number, x: Any): void {
    if (i < 0 || i >= v.length || !Number.isInteger(i)) panic(`index ${i} out of bounds (length ${v.length})`, "OutOfBounds")
    v[i] = x
}

export class MsMap {
    readonly inner = new Map<Any, [Any, Any]>()
    get size(): number { return this.inner.size }
    get(k: Any): Any { return this.inner.get(hashKey(k))?.[1] }
    has(k: Any): boolean { return this.inner.has(hashKey(k)) }
    set(k: Any, v: Any): Any {
        const h = hashKey(k)
        const prev = this.inner.get(h)
        this.inner.set(h, [k, v])
        return prev === undefined ? None : Some(prev[1])
    }
    delete(k: Any): Any {
        const h = hashKey(k)
        const prev = this.inner.get(h)
        this.inner.delete(h)
        return prev === undefined ? None : Some(prev[1])
    }
    *entries(): Generator<[Any, Any]> { for (const [, kv] of this.inner) yield kv }
    [Symbol.iterator](): Generator<[Any, Any]> { return this.entries() }
}

export class MsSet {
    readonly inner = new Map<Any, Any>()
    get size(): number { return this.inner.size }
    has(v: Any): boolean { return this.inner.has(hashKey(v)) }
    add(v: Any): boolean { const h = hashKey(v); const had = this.inner.has(h); this.inner.set(h, v); return !had }
    delete(v: Any): boolean { return this.inner.delete(hashKey(v)) }
    *values(): Generator<Any> { yield* this.inner.values() }
    [Symbol.iterator](): Generator<Any> { return this.values() }
}

export function mapOf(entries: [Any, Any][]): MsMap {
    const m = new MsMap()
    for (const [k, v] of entries) m.set(k, v)
    return m
}

export function setOf(values: Any[]): MsSet {
    const s = new MsSet()
    for (const v of values) s.add(v)
    return s
}

/** Entries of a Map for `m{ ...other }`. */
export function entries(m: MsMap): [Any, Any][] {
    return [...m.entries()]
}

export function mapGet(m: MsMap, k: Any): Any {
    if (!m.has(k)) panic(`key ${quote(k)} is not in the map`, "MissingKey")
    return m.get(k)
}

export class Range {
    readonly start: Any
    readonly end: Any
    readonly inclusive: boolean
    constructor(start: Any, end: Any, inclusive: boolean) { this.start = start; this.end = end; this.inclusive = inclusive }
    contains(v: Any): boolean { return (this.start == null || v >= this.start) && (this.end == null || (this.inclusive ? v <= this.end : v < this.end)) }
}
export const range = (a: Any, b: Any, inclusive: boolean) => new Range(a, b, inclusive)

/** A MinScript iterator over a JS iterable: `next()` returns an Option. */
export class Iter {
    private readonly it: Iterator<Any>
    constructor(src: Iterable<Any>) { this.it = src[Symbol.iterator]() }
    next(): Any { const r = this.it.next(); return r.done ? None : Some(r.value) }
    map(f: Function): Iter { const self = this; return new Iter((function* () { for (;;) { const n = self.next(); if (!isOk(n)) return; yield f(n.$f[0]) } })()) }
    filter(f: Function): Iter { const self = this; return new Iter((function* () { for (;;) { const n = self.next(); if (!isOk(n)) return; if (f(n.$f[0])) yield n.$f[0] } })()) }
    collect(): Any[] { const out: Any[] = []; for (;;) { const n = this.next(); if (!isOk(n)) return out; out.push(n.$f[0]) } }
}

function rangeValues(r: Range): Iterable<Any> {
    return (function* () {
        const one = typeof r.start === "bigint" ? 1n : 1
        for (let i = r.start; r.inclusive ? i <= r.end : i < r.end; i = i + (one as Any)) yield i
    })()
}

// ---- shared state (spec §9.9) -----------------------------------------------------------------

/** A mutable cell passed to callbacks taking `&mut T` (the closure writes the new value back). */
export type Cell = { v: Any }

export class Ref {
    v: Any
    constructor(v: Any) { this.v = v }
}

export class Weak {
    readonly ref: Ref
    constructor(ref: Ref) { this.ref = ref }
}

// ---- tasks and communication (spec §9.6, §9.10) ------------------------------------------------

/** A wait that `select` can cancel; if the value already arrived, `cancel` gives it back. */
type Cancellable = Promise<Any> & { $cancel?: () => void }

const settled = new WeakMap<Promise<Any>, { done: boolean, value?: Any, error?: unknown }>()
function track<T>(p: Promise<T>): Promise<T> {
    if (!settled.has(p)) {
        settled.set(p, { done: false })
        p.then((value) => settled.set(p, { done: true, value }), (error) => settled.set(p, { done: true, error }))
    }
    return p
}

function waiter<T>(onCancel: (resolve: (v: T) => void) => void, giveBack: (v: T) => void): { promise: Cancellable, resolve: (v: T) => void } {
    let resolveFn!: (v: T) => void
    let state: "pending" | "done" | "cancelled" = "pending"
    let value: T
    const promise = new Promise<T>((r) => { resolveFn = r }) as Cancellable
    const resolve = (v: T) => {
        if (state !== "pending") return
        state = "done"
        value = v
        resolveFn(v)
    }
    promise.$cancel = () => {
        if (state === "pending") { state = "cancelled"; onCancel(resolve) }
        else if (state === "done") { state = "cancelled"; giveBack(value) }
    }
    return { promise, resolve }
}

export class Sub {
    buffer: Any[] = []
    waiters: ((v: Any) => void)[] = []
    lost = 0
    closed = false
    readonly cap: number
    readonly onTake: (() => void) | null
    readonly giveBackTo: ((v: Any) => void) | null
    constructor(cap: number, onTake: (() => void) | null = null, giveBackTo: ((v: Any) => void) | null = null) {
        this.cap = cap
        this.onTake = onTake
        this.giveBackTo = giveBackTo
    }
    deliver(v: Any): void {
        const w = this.waiters.shift()
        if (w) { w(Some(v)); return }
        this.buffer.push(v)
        if (this.buffer.length > this.cap) { this.buffer.shift(); this.lost++ }
    }
    close(): void {
        this.closed = true
        for (const w of this.waiters.splice(0)) w(None)
    }
    next(): Cancellable {
        if (this.buffer.length > 0) {
            const v = this.buffer.shift()
            this.onTake?.()
            const p = Promise.resolve(Some(v)) as Cancellable
            p.$cancel = () => { this.buffer.unshift(v) }
            return p
        }
        if (this.closed) return Promise.resolve(None) as Cancellable
        const { promise, resolve } = waiter<Any>(
            (r) => { this.waiters = this.waiters.filter((w) => w !== r) },
            (v) => { if (isOk(v)) (this.giveBackTo ?? ((x: Any) => this.buffer.unshift(x)))(v.$f[0]) },
        )
        this.waiters.push(resolve)
        return promise
    }
    try_next(): Any {
        if (this.buffer.length === 0) return None
        this.onTake?.()
        return Some(this.buffer.shift())
    }
    missed(): number { const n = this.lost; this.lost = 0; return n }
}

export class Topic {
    readonly subs = new Set<Sub>()
    readonly buffer: number
    readonly replay: number
    readonly history: Any[] = []
    closed = false
    constructor(buffer = 64, replay = 0) { this.buffer = buffer; this.replay = replay }
    publish(v: Any): number {
        if (this.closed) return 0
        for (const s of this.subs) s.deliver(clone(v))
        if (this.replay > 0) { this.history.push(v); if (this.history.length > this.replay) this.history.shift() }
        return this.subs.size
    }
    subscribe(): Sub {
        const s = new Sub(this.buffer)
        for (const v of this.history) s.deliver(clone(v))
        if (this.closed) s.close()
        else this.subs.add(s)
        return s
    }
    close(): void {
        this.closed = true
        for (const s of this.subs) s.close()
        this.subs.clear()
    }
}

export class Queue {
    readonly items: Any[] = []
    readonly subs: Sub[] = []
    readonly capacity: number
    readonly blocked: { v: Any, resolve: (r: Any) => void }[] = []
    closed = false
    constructor(capacity = 1024) { this.capacity = capacity }
    private handOff(v: Any): boolean {
        // the subscriber that has waited longest
        let best: Sub | null = null
        for (const s of this.subs) if (s.waiters.length > 0 && best === null) best = s
        if (best === null) return false
        best.waiters.shift()!(Some(v))
        return true
    }
    try_publish(v: Any): Any {
        if (this.closed) return Err({ $t: "std.PublishError", $v: "Closed", $f: [v] })
        if (this.handOff(v)) return Ok(undefined)
        if (this.items.length >= this.capacity) return Err({ $t: "std.PublishError", $v: "Full", $f: [v] })
        this.items.push(v)
        return Ok(undefined)
    }
    publish(v: Any): Promise<Any> {
        const r = this.try_publish(v)
        if (isOk(r) || r.$f[0].$v === "Closed") return Promise.resolve(r)
        return new Promise((resolve) => this.blocked.push({ v, resolve }))
    }
    taken(): void {
        while (this.blocked.length > 0 && this.items.length < this.capacity) {
            const b = this.blocked.shift()!
            this.items.push(b.v)
            b.resolve(Ok(undefined))
        }
    }
    subscribe(): Sub {
        const q = this
        const s = new Sub(Number.MAX_SAFE_INTEGER, () => q.taken(), (v) => q.items.unshift(v))
        // a queue subscriber reads from the shared queue
        s.next = function (): Cancellable {
            if (q.items.length > 0) {
                const v = q.items.shift()
                q.taken()
                const p = Promise.resolve(Some(v)) as Cancellable
                p.$cancel = () => { q.items.unshift(v) }
                return p
            }
            if (q.closed) return Promise.resolve(None) as Cancellable
            const { promise, resolve } = waiter<Any>(
                (r) => { s.waiters = s.waiters.filter((w) => w !== r) },
                (v) => { if (isOk(v)) q.items.unshift(v.$f[0]) },
            )
            s.waiters.push(resolve)
            return promise
        }
        s.try_next = function (): Any {
            if (q.items.length === 0) return None
            const v = q.items.shift()
            q.taken()
            return Some(v)
        }
        this.subs.push(s)
        return s
    }
    close(): void {
        this.closed = true
        for (const s of this.subs) s.close()
        for (const b of this.blocked.splice(0)) b.resolve(Err({ $t: "std.PublishError", $v: "Closed", $f: [b.v] }))
    }
}

export class Signal {
    v: Any
    version = 0
    readonly watchers = new Set<Watcher>()
    constructor(v: Any) { this.v = v }
    set(v: Any): void {
        if (eq(v, this.v)) return
        this.v = v
        this.version++
        for (const w of this.watchers) w.wake()
    }
}

export class Watcher {
    readonly signal: Signal
    seen: number
    private wakers: (() => void)[] = []
    constructor(signal: Signal) { this.signal = signal; this.seen = signal.version }
    wake(): void { for (const w of this.wakers.splice(0)) w() }
    next(): Cancellable {
        if (this.signal.version !== this.seen) {
            this.seen = this.signal.version
            return Promise.resolve(Some(clone(this.signal.v))) as Cancellable
        }
        const { promise, resolve } = waiter<Any>((r) => { this.wakers = this.wakers.filter((w) => w !== wake); void r }, () => { this.seen = -1 })
        const wake = () => { this.seen = this.signal.version; resolve(Some(clone(this.signal.v))) }
        this.wakers.push(wake)
        return promise
    }
}

/**
 * `select` (spec §4.9): waits for the first of several Promises. When several are ready, one is
 * chosen at random; the losers are cancelled (a value they already took is given back).
 */
export class Selector {
    private readonly ps: Cancellable[]
    private readonly enabled: boolean[]
    private readonly hasElse: boolean
    constructor(ps: Promise<Any>[], hasElse: boolean) {
        this.ps = ps.map((p) => track(p) as Cancellable)
        this.enabled = ps.map(() => true)
        this.hasElse = hasElse
    }
    disable(i: number): void { this.enabled[i] = false }
    async next(): Promise<[number, Any]> {
        const live = this.ps.map((p, i) => i).filter((i) => this.enabled[i])
        if (live.length === 0) {
            if (this.hasElse) return [-1, undefined]
            panic("every `select` arm is disabled and there is no `else`", "SelectExhausted")
        }
        await Promise.resolve()          // let already-settled promises report
        let ready = live.filter((i) => settled.get(this.ps[i]!)?.done)
        if (ready.length === 0 && this.hasElse) { this.cancelAll(-1); return [-1, undefined] }
        if (ready.length === 0) {
            await Promise.race(live.map((i) => this.ps[i]!.then(() => undefined, () => undefined)))
            await Promise.resolve()
            ready = live.filter((i) => settled.get(this.ps[i]!)?.done)
        }
        const i = ready[Math.floor(Math.random() * ready.length)]!
        const s = settled.get(this.ps[i]!)!
        if (s.error !== undefined) { this.cancelAll(i); throw s.error }
        return [i, s.value]
    }
    /** The chosen arm runs: cancel the others (cancel-safe waits give their value back). */
    done(chosen: number): void { this.cancelAll(chosen) }
    private cancelAll(except: number): void {
        this.ps.forEach((p, i) => { if (i !== except) p.$cancel?.() })
    }
}

export function after(ms: number): Cancellable {
    let timer: ReturnType<typeof setTimeout> | null = null
    const p = new Promise<Any>((r) => { timer = setTimeout(() => r(undefined), Number(ms)) }) as Cancellable
    p.$cancel = () => { if (timer) clearTimeout(timer) }
    return p
}

// ---- dynamic dispatch -------------------------------------------------------------------------

/** `recv.method(args)` when the receiver's type isn't known statically (interfaces, bounds, unknown). */
export function dyn(recv: Any, method: string, args: Any[]): Any {
    if (recv !== null && typeof recv === "object" && typeof recv.$t === "string") {
        const t = recv.$t as string
        const info = types.get(t)
        const own = info?.methods[method]
        if (own) return own(recv, ...args)
        if (t.startsWith("std.")) {
            const key = `${t.slice(4)}.${method}`
            if (key in stdTable) return stdTable[key](recv, ...args)
        }
        for (const i of info?.interfaces ?? []) {
            const d = interDefaults.get(i)?.[method]
            if (d) return d(recv, ...args)
        }
    }
    if (recv !== null && recv !== undefined && typeof recv[method] === "function" && !(recv instanceof Promise) && !Array.isArray(recv)) {
        return recv[method](...args)
    }
    const kind = typeof recv === "string" ? "string" : Array.isArray(recv) ? "Vec" : recv instanceof MsMap ? "Map" : recv instanceof MsSet ? "Set"
        : recv instanceof Promise ? "Promise" : recv instanceof Range ? "Range" : recv instanceof Ref ? "Ref" : recv instanceof Sub ? "Sub"
        : recv instanceof Signal ? "Signal" : recv instanceof Topic ? "Topic" : recv instanceof Queue ? "Queue" : null
    const f = kind ? std[`${kind}.${method}`] : undefined
    if (f) return f(recv, ...args)
    switch (method) {
        case "to_str": return toStr(recv)
        case "clone": return clone(recv)
        case "eq": return eq(recv, args[0])
        case "hash": return hashKey(recv)
    }
    panic(`no method \`${method}\` on ${toStr(recv)}`)
}

// ---- std ----------------------------------------------------------------------------------------

const unwrapOr = (v: Any, fallback: Any) => (isOk(v) ? v.$f[0] : typeof fallback === "function" ? fallback() : fallback)
const cmp = (a: Any, b: Any) => (a < b ? -1 : a > b ? 1 : 0)
const ordering = (n: number) => ({ $t: "std.Ordering", $v: n < 0 ? "Less" : n > 0 ? "Greater" : "Equal", $f: [] })
const fromOrdering = (o: Any) => (o.$v === "Less" ? -1 : o.$v === "Greater" ? 1 : 0)

function log(prefix: string) {
    return (_self: Any, args: Any[]) => printLine(prefix + args.map(toStr).join(" "))
}

/** Std functions by name (`"Vec.push"`); generated code calls `$rt.std[name]`. */
const stdTable: Record<string, Any> = {
    _builtin: () => panic("builtin called"),
    panic: (msg: string) => panic(msg),
    assert: (cond: boolean, msg: string) => { if (!cond) panic(msg, "User") },
    log: { $t: "std.Log" },
    "Log.println": log(""), "Log.print": (_self: Any, args: Any[]) => { stdTable["io.print"](args) }, "Log.info": log(""), "Log.debug": log(""),
    "Log.warn": log("warn: "), "Log.error": log("error: "),

    // Option / Result
    "Option.is_some": isOk, "Option.is_none": (o: Any) => !isOk(o),
    "Option.unwrap": (o: Any) => (isOk(o) ? o.$f[0] : panic("unwrap of None", "Unwrap")),
    "Option.expect": (o: Any, m: string) => (isOk(o) ? o.$f[0] : panic(m, "Unwrap")),
    "Option.or": unwrapOr,
    "Option.map": (o: Any, f: Function) => (isOk(o) ? Some(f(o.$f[0])) : None),
    "Option.and_then": (o: Any, f: Function) => (isOk(o) ? f(o.$f[0]) : None),
    "Option.ok_or": (o: Any, e: Any) => (isOk(o) ? Ok(o.$f[0]) : Err(e)),
    "Option.filter": (o: Any, f: Function) => (isOk(o) && f(o.$f[0]) ? o : None),
    "Result.is_ok": isOk, "Result.is_err": (r: Any) => !isOk(r),
    "Result.unwrap": (r: Any) => (isOk(r) ? r.$f[0] : panic(`unwrap of Err(${quote(r.$f[0])})`, "Unwrap")),
    "Result.expect": (r: Any, m: string) => (isOk(r) ? r.$f[0] : panic(m, "Unwrap")),
    "Result.unwrap_err": (r: Any) => (!isOk(r) ? r.$f[0] : panic("unwrap_err of Ok", "Unwrap")),
    "Result.ok": (r: Any) => (isOk(r) ? Some(r.$f[0]) : None),
    "Result.err": (r: Any) => (!isOk(r) ? Some(r.$f[0]) : None),
    "Result.or": unwrapOr,
    "Result.map": (r: Any, f: Function) => (isOk(r) ? Ok(f(r.$f[0])) : r),
    "Result.map_err": (r: Any, f: Function) => (isOk(r) ? r : Err(f(r.$f[0]))),
    "Result.and_then": (r: Any, f: Function) => (isOk(r) ? f(r.$f[0]) : r),

    // Vec
    "Vec.new": () => [], "Vec.with_capacity": () => [],
    "Vec.len": (v: Any[]) => v.length, "Vec.is_empty": (v: Any[]) => v.length === 0,
    "Vec.get": (v: Any[], i: number) => opt(v[i]), "Vec.at": (v: Any[], i: number) => opt(v.at(i)),
    "Vec.first": (v: Any[]) => opt(v[0]), "Vec.last": (v: Any[]) => opt(v[v.length - 1]),
    "Vec.contains": (v: Any[], x: Any) => v.some((y) => eq(x, y)),
    "Vec.index_of": (v: Any[], x: Any) => { const i = v.findIndex((y) => eq(x, y)); return i < 0 ? None : Some(i) },
    "Vec.push": (v: Any[], x: Any) => { v.push(x) },
    "Vec.pop": (v: Any[]) => opt(v.pop()),
    "Vec.insert": (v: Any[], i: number, x: Any) => { v.splice(i, 0, x) },
    "Vec.remove": (v: Any[], i: number) => { at(v, i); return v.splice(i, 1)[0] },
    "Vec.clear": (v: Any[]) => { v.length = 0 },
    "Vec.extend": (v: Any[], o: Any[]) => { v.push(...o) },
    "Vec.sort": (v: Any[]) => { v.sort(cmp) },
    "Vec.sort_by": (v: Any[], f: Function) => { v.sort((a, b) => fromOrdering(f(a, b))) },
    "Vec.reverse": (v: Any[]) => { v.reverse() },
    "Vec.iter": (v: Any[]) => new Iter(v), "Vec.iter_mut": (v: Any[]) => new Iter(v),
    "Vec.map": (v: Any[], f: Function) => v.map((x, i) => f(x, i)),
    "Vec.filter": (v: Any[], f: Function) => v.filter((x, i) => f(x, i)),
    "Vec.find": (v: Any[], f: Function) => { const i = v.findIndex((x, j) => f(x, j)); return i < 0 ? None : Some(v[i]) },
    "Vec.any": (v: Any[], f: Function) => v.some((x, i) => f(x, i)),
    "Vec.all": (v: Any[], f: Function) => v.every((x, i) => f(x, i)),
    "Vec.count": (v: Any[], f: Function) => v.filter((x, i) => f(x, i)).length,
    "Vec.for_each": (v: Any[], f: Function) => { v.forEach((x, i) => f(x, i)) },
    "Vec.fold": (v: Any[], init: Any, f: Function) => v.reduce((a, x) => f(a, x), init),
    "Vec.reduce": (v: Any[], init: Any, f: Function) => v.reduce((a, x) => f(a, x), init),
    "Vec.sum": (v: Any[]) => v.reduce((a, x) => a + x, typeof v[0] === "bigint" ? 0n : 0),
    "Vec.join": (v: Any[], sep: string) => v.map(toStr).join(sep),
    "Vec.max": (v: Any[]) => (v.length === 0 ? None : Some(v.reduce((a, x) => (x > a ? x : a)))),
    "Vec.min": (v: Any[]) => (v.length === 0 ? None : Some(v.reduce((a, x) => (x < a ? x : a)))),
    "Vec.take": (v: Any[], n: number) => v.slice(0, n), "Vec.skip": (v: Any[], n: number) => v.slice(n),
    "Vec.to_vec": (v: Any[]) => [...v],
    "Array.len": (v: Any[]) => v.length, "Array.get": (v: Any[], i: number) => opt(v[i]), "Array.iter": (v: Any[]) => new Iter(v), "Array.to_vec": (v: Any[]) => [...v],
    "Slice.len": (v: Any[]) => v.length, "Slice.is_empty": (v: Any[]) => v.length === 0, "Slice.get": (v: Any[], i: number) => opt(v[i]),
    "Slice.iter": (v: Any[]) => new Iter(v), "Slice.to_vec": (v: Any[]) => [...v],

    // Map / Set / Range
    "Map.new": () => new MsMap(), "Map.len": (m: MsMap) => m.size, "Map.is_empty": (m: MsMap) => m.size === 0,
    "Map.get": (m: MsMap, k: Any) => (m.has(k) ? Some(m.get(k)) : None), "Map.has": (m: MsMap, k: Any) => m.has(k),
    "Map.insert": (m: MsMap, k: Any, v: Any) => m.set(k, v), "Map.remove": (m: MsMap, k: Any) => m.delete(k),
    "Map.clear": (m: MsMap) => { m.inner.clear() },
    "Map.keys": (m: MsMap) => [...m.entries()].map(([k]) => k), "Map.values": (m: MsMap) => [...m.entries()].map(([, v]) => v),
    "Map.iter": (m: MsMap) => new Iter(m.entries()),
    "Set.new": () => new MsSet(), "Set.len": (s: MsSet) => s.size, "Set.is_empty": (s: MsSet) => s.size === 0,
    "Set.has": (s: MsSet, v: Any) => s.has(v), "Set.insert": (s: MsSet, v: Any) => s.add(v), "Set.remove": (s: MsSet, v: Any) => s.delete(v),
    "Set.iter": (s: MsSet) => new Iter(s.values()),
    "Range.contains": (r: Range, v: Any) => r.contains(v),
    "Range.len": (r: Range) => Math.max(0, Number(r.end) - Number(r.start) + (r.inclusive ? 1 : 0)),
    "Range.iter": (r: Range) => new Iter(rangeValues(r)),
    "Range.rev": (r: Range) => new Iter([...rangeValues(r)].reverse()),

    // strings (lengths are in UTF-16 units on JS for now)
    "string.len": (s: string) => s.length, "string.is_empty": (s: string) => s.length === 0,
    "string.trim": (s: string) => s.trim(), "string.substring": (s: string, a: number, b: number) => s.substring(a, b),
    "string.strip_prefix": (s: string, p: string) => (s.startsWith(p) ? s.slice(p.length) : s),
    "string.strip_suffix": (s: string, p: string) => (p !== "" && s.endsWith(p) ? s.slice(0, -p.length) : s),
    "string.try_strip_prefix": (s: string, p: string) => (s.startsWith(p) ? Some(s.slice(p.length)) : None),
    "string.try_strip_suffix": (s: string, p: string) => (s.endsWith(p) ? Some(s.slice(0, s.length - p.length)) : None),
    "string.split": (s: string, sep: string) => s.split(sep), "string.lines": (s: string) => s.split(/\r?\n/),
    "string.contains": (s: string, x: string) => s.includes(x),
    "string.starts_with": (s: string, x: string) => s.startsWith(x), "string.ends_with": (s: string, x: string) => s.endsWith(x),
    "string.replace": (s: string, a: string, b: string) => s.split(a).join(b),
    "string.to_lower": (s: string) => s.toLowerCase(), "string.to_upper": (s: string) => s.toUpperCase(),
    "string.to_int": (s: string) => (/^\s*[+-]?\d+\s*$/.test(s) ? Ok(Number.parseInt(s, 10)) : Err(`not an integer: ${JSON.stringify(s)}`)),
    "string.to_float": (s: string) => { const n = Number(s); return s.trim() !== "" && Number.isFinite(n) ? Ok(n) : Err(`not a number: ${JSON.stringify(s)}`) },
    "string.bytes": (s: string) => [...new TextEncoder().encode(s)], "string.chars": (s: string) => [...s],
    "string.to_str": (s: string) => s,

    // Promise
    "Promise.new": () => { let r!: (v: Any) => void; const p = new Promise((res) => { r = res }); return [p, { $t: "std.Resolver", resolve: r }] },
    "Promise.all": (ps: Promise<Any>[]) => Promise.all(ps),
    "Promise.then": (p: Promise<Any>, f: Function) => p.then((v) => { f(v); return v }),
    "Promise.catch": (p: Promise<Any>, f: Function) => p.catch((e) => { f(panicValue(e)) }),
    "Promise.ignore": (p: Promise<Any>) => { p.catch((e) => output(`error: task failed: ${e instanceof Error ? e.message : String(e)}`)) },
    "Promise.timeout": (p: Promise<Any>, ms: number) => Promise.race([p.then(Ok), after(ms).then(() => Err({ $t: "std.Timeout" }))]),
    "Promise.cancel": (p: Cancellable) => { p.$cancel?.() },       // tasks can't be cancelled on JS yet (spec §14.2)
    "Promise.is_done": (p: Promise<Any>) => { track(p); return settled.get(p)?.done ?? false },
    "Resolver.resolve": (r: Any, v: Any) => { r.resolve(v) },

    // shared state
    "Ref.new": (v: Any) => new Ref(v), "Ref.get": (r: Ref) => clone(r.v), "Ref.set": (r: Ref, v: Any) => { r.v = v },
    "Ref.read": (r: Ref, f: Function) => f(r.v),
    "Ref.update": (r: Ref, f: Function) => { const cell: Cell = { v: r.v }; const out = f(cell); r.v = cell.v; return out },
    "Ref.reset": (r: Ref, v: Any) => { r.v = v }, "Ref.weak": (r: Ref) => new Weak(r),
    "Weak.upgrade": (w: Weak) => Some(w.ref),
    "Box.new": (v: Any) => ({ $t: "std.Box", v }), "Box.get": (b: Any) => b.v, "Box.set": (b: Any, v: Any) => { b.v = v },

    // communication
    "Topic.new": () => new Topic(), "Topic.with": (o: Any) => new Topic(o.buffer ?? 64, o.replay ?? 0),
    "Topic.publish": (t: Topic, v: Any) => t.publish(v), "Topic.subscribe": (t: Topic) => t.subscribe(),
    "Topic.subscribers": (t: Topic) => t.subs.size, "Topic.close": (t: Topic) => { t.close() },
    "Queue.new": () => new Queue(), "Queue.with": (o: Any) => new Queue(o.capacity ?? 1024),
    "Queue.publish": (q: Queue, v: Any) => q.publish(v), "Queue.try_publish": (q: Queue, v: Any) => q.try_publish(v),
    "Queue.publish_timeout": (q: Queue, v: Any, ms: number) => Promise.race([q.publish(v), after(ms).then(() => Err({ $t: "std.PublishError", $v: "Full", $f: [v] }))]),
    "Queue.subscribe": (q: Queue) => q.subscribe(), "Queue.len": (q: Queue) => q.items.length, "Queue.close": (q: Queue) => { q.close() },
    "Sub.next": (s: Sub) => s.next(), "Sub.try_next": (s: Sub) => s.try_next(), "Sub.missed": (s: Sub) => s.missed(),
    "Signal.new": (v: Any) => new Signal(v), "Signal.get": (s: Signal) => clone(s.v),
    "Signal.read": (s: Signal, f: Function) => f(s.v), "Signal.set": (s: Signal, v: Any) => { s.set(v) },
    "Signal.update": (s: Signal, f: Function) => { const cell: Cell = { v: clone(s.v) }; const out = f(cell); s.set(cell.v); return out },
    "Signal.watch": (s: Signal) => { const w = new Watcher(s); s.watchers.add(w); return w },
    "Watcher.next": (w: Watcher) => w.next(),
    "Iterator.next": (it: Iter) => it.next(), "Iterator.map": (it: Iter, f: Function) => it.map(f),
    "Iterator.filter": (it: Iter, f: Function) => it.filter(f), "Iterator.collect": (it: Iter) => it.collect(),
}

export const std: Record<string, Function> & Record<string, Any> = new Proxy(stdTable, {
    get(target: Any, name: string | symbol) {
        if (typeof name === "symbol" || name in target) return target[name]
        // methods every value has (`string.clone`, `Vec.eq`): the structural defaults
        const method = name.slice(name.lastIndexOf(".") + 1)
        if (method === "clone") return clone
        if (method === "to_str") return toStr
        if (method === "eq") return eq
        return (..._args: Any[]) => panic(`\`${String(name)}\` is not available on the JS back end yet`)
    },
})

// ---- std packages (std/*/*.ms: functions whose body is `_builtin()`) ----------------------------

const stdErr = (pkg: string, message: string, extra: Record<string, Any> = {}) => ({ $t: `std.${pkg}.Error`, ...extra, message })
const fsErr = (path: string, e: unknown) => Err(stdErr("fs", e instanceof Error ? (e as NodeJS.ErrnoException).code ?? e.message : String(e), { path }))

let programArgs: string[] = []
let evaluatingConfig = false
/** While mod.ms's `config()` runs, scripts can't execute (E_SCRIPT_IN_EVAL, spec §17.3). */
export function setEvaluating(on: boolean): void { evaluatingConfig = on }
/** The program's command-line arguments (`env.args()`), after the file name. */
export function setArgs(args: string[]): void { programArgs = args }

// stdin, line by line (`io.read_line`); stdin only keeps the process alive while someone is waiting
const stdin = { lines: [] as string[], waiting: [] as ((l: string) => void)[], closed: false, started: false }
function readLine(): Promise<string> {
    if (!stdin.started) {
        stdin.started = true
        import("node:readline").then(({ createInterface }) => {
            const rl = createInterface({ input: process.stdin, terminal: false })
            rl.on("line", (l) => { const w = stdin.waiting.shift(); if (w) w(l); else stdin.lines.push(l); if (stdin.waiting.length === 0) process.stdin.unref() })
            rl.on("close", () => { stdin.closed = true; for (const w of stdin.waiting.splice(0)) w("") })
        })
    }
    const l = stdin.lines.shift()
    if (l !== undefined) return Promise.resolve(l)
    if (stdin.closed) return Promise.resolve("")
    process.stdin.ref()
    return new Promise((r) => stdin.waiting.push(r))
}

let pendingPrint = ""
const printLine = (text: string) => { output(pendingPrint + text); pendingPrint = "" }

Object.assign(stdTable, {
    // io, log
    "io.println": (args: Any[]) => printLine(args.map(toStr).join(" ")),
    // without a newline: straight to stdout, or (when output is captured, in tests) kept for the next line
    "io.print": (args: Any[]) => { if (captured) pendingPrint += args.map(toStr).join(" "); else process.stdout.write(args.map(toStr).join(" ")) },
    "io.eprintln": (args: Any[]) => printLine("error: " + args.map(toStr).join(" ")),
    "io.read_line": readLine,
    "log.println": (args: Any[]) => printLine(args.map(toStr).join(" ")), "log.print": (args: Any[]) => printLine(args.map(toStr).join(" ")),
    "log.info": (args: Any[]) => printLine(args.map(toStr).join(" ")), "log.debug": (args: Any[]) => printLine(args.map(toStr).join(" ")),
    "log.warn": (args: Any[]) => printLine("warn: " + args.map(toStr).join(" ")), "log.error": (args: Any[]) => printLine("error: " + args.map(toStr).join(" ")),

    // time, runtime
    "time.after": after,
    "time.sleep": (ms: number) => after(ms),
    "time.now": () => BigInt(Date.now()),
    "runtime.yield": () => new Promise((r) => setTimeout(r, 0)),

    // env
    "env.get": (k: string) => opt(process.env[k]),
    "env.set": (k: string, v: string) => { process.env[k] = v },
    "env.args": () => [...programArgs],

    // math
    "math.abs": (x: Any) => (x < 0 ? -x : x),
    "math.min": (a: Any, b: Any) => (b < a ? b : a), "math.max": (a: Any, b: Any) => (b > a ? b : a),
    "math.sqrt": Math.sqrt, "math.pow": Math.pow, "math.floor": Math.floor, "math.ceil": Math.ceil,
    "math.round": Math.round, "math.sin": Math.sin, "math.cos": Math.cos,

    // json
    "json.parse": (text: string, shapes?: (Shape | null)[]) => {
        let v: Any
        try { v = JSON.parse(text) } catch (e) { return Err(stdErr("json", e instanceof Error ? e.message : String(e))) }
        try { return Ok(fromJson(v, shapes?.[0] ?? null, "")) } catch (e) {
            if (e instanceof JsonShapeError) return Err(stdErr("json", e.message))
            throw e
        }
    },
    "json.stringify": (v: Any) => JSON.stringify(toJson(v)),
    "json.to_value": (v: Any) => jsonValue(toJson(v)),
    "json.from_value": (v: Any, shapes?: (Shape | null)[]) => {
        try { return Ok(fromJson(toJson(v), shapes?.[0] ?? null, "")) } catch (e) {
            if (e instanceof JsonShapeError) return Err(stdErr("json", e.message))
            throw e
        }
    },

    "testing.clock": () => BigInt(Date.now()),

    // build (mod.ms)
    "build.current_target": () => {
        const os = ({ linux: "Linux", darwin: "MacOs", win32: "Windows", android: "Android" } as Record<string, string>)[process.platform] ?? "Other"
        return { $t: "std.build.Target", os: { $t: "std.build.Os", $v: os, $f: [] }, arch: process.arch, back_end: "js" }
    },
    "build.run": (cmd: string) => {
        if (evaluatingConfig) panic(`E_SCRIPT_IN_EVAL: \`run(${JSON.stringify(cmd)})\` while mod.ms is being evaluated; scripts only run from \`ms run <name>\``, "User")
        const r = childProcess.spawnSync(cmd, { shell: true, stdio: "inherit" })
        if (r.error) return Err(r.error.message)
        return r.status === 0 ? Ok(undefined) : Err(`\`${cmd}\` failed with exit code ${r.status ?? "?"}`)
    },

    // fs (every operation is async)
    "fs.read_file": async (path: string) => { try { return Ok([...await fsp().readFile(path)]) } catch (e) { return fsErr(path, e) } },
    "fs.read_text": async (path: string) => { try { return Ok(await fsp().readFile(path, "utf8")) } catch (e) { return fsErr(path, e) } },
    "fs.write_file": async (path: string, data: number[]) => { try { await fsp().writeFile(path, Uint8Array.from(data)); return Ok(undefined) } catch (e) { return fsErr(path, e) } },
    "fs.write_text": async (path: string, text: string) => { try { await fsp().writeFile(path, text); return Ok(undefined) } catch (e) { return fsErr(path, e) } },
    "fs.stat": async (path: string) => {
        try {
            const st = await fsp().stat(path)
            return Ok({ $t: "std.fs.Stat", size: BigInt(st.size), dir: st.isDirectory(), modified: BigInt(Math.floor(st.mtimeMs)) })
        } catch (e) { return fsErr(path, e) }
    },
    "fs.exists": async (path: string) => { try { await fsp().stat(path); return true } catch { return false } },
    "fs.list_dir": async (path: string) => { try { return Ok((await fsp().readdir(path)).sort()) } catch (e) { return fsErr(path, e) } },
    "fs.walk_dir": async (path: string) => {
        try {
            const entries = await fsp().readdir(path, { recursive: true, withFileTypes: true })
            return Ok(entries.filter((d) => d.isFile()).map((d) => `${d.parentPath}/${d.name}`.replace(/\/+/g, "/")).sort())
        } catch (e) { return fsErr(path, e) }
    },
    "fs.create_dir": async (path: string) => { try { await fsp().mkdir(path, { recursive: true }); return Ok(undefined) } catch (e) { return fsErr(path, e) } },
    "fs.remove": async (path: string) => { try { await fsp().rm(path, { recursive: true }); return Ok(undefined) } catch (e) { return fsErr(path, e) } },

    // crypto: AES-256-GCM, key from scrypt(password, salt); output = salt(16) | nonce(12) | tag(16) | ciphertext
    "crypto.encrypt_aes_gcm": (data: number[], password: string) => {
        const c = nodeCrypto()
        const salt = c.randomBytes(16), nonce = c.randomBytes(12)
        const cipher = c.createCipheriv("aes-256-gcm", c.scryptSync(password, salt, 32), nonce)
        const body = Buffer.concat([cipher.update(Uint8Array.from(data)), cipher.final()])
        return [...Buffer.concat([salt, nonce, cipher.getAuthTag(), body])]
    },
    "crypto.decrypt_aes_gcm": (data: number[], password: string) => {
        const c = nodeCrypto()
        const buf = Buffer.from(Uint8Array.from(data))
        if (buf.length < 44) return Err("data too short to be encrypted")
        try {
            const decipher = c.createDecipheriv("aes-256-gcm", c.scryptSync(password, buf.subarray(0, 16), 32), buf.subarray(16, 28))
            decipher.setAuthTag(buf.subarray(28, 44))
            return Ok([...Buffer.concat([decipher.update(buf.subarray(44)), decipher.final()])])
        } catch {
            return Err("wrong password, or the data is corrupted")
        }
    },
    "crypto.sha256": (data: number[]) => nodeCrypto().createHash("sha256").update(Uint8Array.from(data)).digest("hex"),
    "crypto.random_bytes": (n: number) => [...nodeCrypto().randomBytes(n)],
})

const fsp = () => fsPromises
const nodeCrypto = () => cryptoModule

// ---- std.net.ws: WebSockets (RFC 6455) ----------------------------------------------------------
// The server is a small implementation over node:http; the client is Node's global WebSocket.

const WS = "std.net.ws"
const wsErr = (message: string) => Err(stdErr("net.ws", message))
const wsMsg = (variant: "Text" | "Binary" | "Close", ...f: Any[]) => ({ $t: `${WS}.Message`, $v: variant, $f: f })

/** Resources a program opened (servers, sockets): closed when the program ends. */
const openResources = new Set<{ close(): void }>()
export function closeResources(): void {
    for (const r of [...openResources]) { try { r.close() } catch { /* already closed */ } }
    openResources.clear()
}

/** A queue whose `take` is cancel-safe: a value that loses a `select` goes back to the front. */
class Inbox {
    items: Any[] = []
    waiters: ((v: Any) => void)[] = []
    closedWith: Any = null
    push(v: Any): void {
        const w = this.waiters.shift()
        if (w) w(v); else this.items.push(v)
    }
    close(final: Any): void {
        if (this.closedWith !== null) return
        this.closedWith = final
        for (const w of this.waiters.splice(0)) w(final)
    }
    take(): Cancellable {
        if (this.items.length > 0) {
            const v = this.items.shift()
            const p = Promise.resolve(v) as Cancellable
            p.$cancel = () => { this.items.unshift(v) }
            return p
        }
        if (this.closedWith !== null) return Promise.resolve(this.closedWith) as Cancellable
        const { promise, resolve } = waiter<Any>(
            (r) => { this.waiters = this.waiters.filter((w) => w !== r) },
            (v) => { if (v !== this.closedWith) this.items.unshift(v) },
        )
        this.waiters.push(resolve)
        return promise
    }
}

type WsConn = { inbox: Inbox, send(msg: Any): Promise<Any>, close(): void }

function serverConn(socket: import("node:net").Socket): WsConn {
    const inbox = new Inbox()
    let buf = Buffer.alloc(0)
    let fragments: Buffer[] = []
    let fragOpcode = 0
    let open = true
    const frame = (opcode: number, payload: Buffer) => {
        const len = payload.length
        const head = len < 126 ? Buffer.from([0x80 | opcode, len])
            : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
            : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b })()])
        return Buffer.concat([head, payload])
    }
    const conn: WsConn = {
        inbox,
        send: (msg: Any) => {
            if (!open || socket.destroyed) return Promise.resolve(wsErr("connection closed"))
            if (msg.$v === "Close") { conn.close(); return Promise.resolve(Ok(undefined)) }
            const data = msg.$v === "Text" ? Buffer.from(msg.$f[0], "utf8") : Buffer.from(Uint8Array.from(msg.$f[0]))
            return new Promise((r) => socket.write(frame(msg.$v === "Text" ? 1 : 2, data), (e) => r(e ? wsErr(e.message) : Ok(undefined))))
        },
        close: () => {
            if (!open) return
            open = false
            if (!socket.destroyed) socket.end(frame(8, Buffer.alloc(0)))
            inbox.close(Ok(wsMsg("Close")))
            openResources.delete(conn)
        },
    }
    openResources.add(conn)
    socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
            if (buf.length < 2) return
            const fin = (buf[0]! & 0x80) !== 0, opcode = buf[0]! & 0x0f, masked = (buf[1]! & 0x80) !== 0
            let len = buf[1]! & 0x7f, at = 2
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4 }
            else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10 }
            const maskAt = at
            if (masked) at += 4
            if (buf.length < at + len) return
            const payload = Buffer.from(buf.subarray(at, at + len))
            if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= buf[maskAt + (i & 3)]!
            buf = buf.subarray(at + len)
            if (opcode === 8) { conn.close(); return }
            if (opcode === 9) { socket.write(frame(10, payload)); continue }
            if (opcode === 10) continue
            if (opcode !== 0) { fragOpcode = opcode; fragments = [] }
            fragments.push(payload)
            if (!fin) continue
            const data = Buffer.concat(fragments)
            fragments = []
            inbox.push(Ok(fragOpcode === 1 ? wsMsg("Text", data.toString("utf8")) : wsMsg("Binary", [...data])))
        }
    })
    socket.on("close", () => { open = false; inbox.close(Ok(wsMsg("Close"))); openResources.delete(conn) })
    socket.on("error", () => { open = false; inbox.close(wsErr("connection reset")) })
    return conn
}

function clientConn(url: string): Promise<Any> {
    return new Promise((resolve) => {
        let sock: Any
        try { sock = new (globalThis as Any).WebSocket(url) } catch (e) { resolve(wsErr(e instanceof Error ? e.message : String(e))); return }
        sock.binaryType = "arraybuffer"
        const inbox = new Inbox()
        let opened = false
        const conn: WsConn = {
            inbox,
            send: async (msg: Any) => {
                if (sock.readyState !== 1) return wsErr("connection closed")
                if (msg.$v === "Close") { conn.close(); return Ok(undefined) }
                sock.send(msg.$v === "Text" ? msg.$f[0] : Uint8Array.from(msg.$f[0]))
                return Ok(undefined)
            },
            close: () => { try { sock.close() } catch { /* closed */ } inbox.close(Ok(wsMsg("Close"))); openResources.delete(conn) },
        }
        sock.onopen = () => { opened = true; openResources.add(conn); resolve(Ok({ $t: `${WS}.Connection`, conn })) }
        sock.onmessage = (e: Any) => inbox.push(Ok(typeof e.data === "string" ? wsMsg("Text", e.data) : wsMsg("Binary", [...new Uint8Array(e.data)])))
        sock.onclose = () => { inbox.close(Ok(wsMsg("Close"))); openResources.delete(conn) }
        sock.onerror = () => { if (!opened) resolve(wsErr(`could not connect to ${url}`)); else inbox.close(wsErr("connection error")) }
    })
}

let httpModule: typeof import("node:http") | null = null
const http = async () => (httpModule ??= await import("node:http"))

Object.assign(stdTable, {
    "net.ws.listen": async (host: string, port: number) => {
        const h = await http()
        const accepted = new Inbox()
        const srv = h.createServer((_req, res) => { res.writeHead(426).end("WebSocket only") })
        const server = { $t: `${WS}.Server`, accepted, port: () => (srv.address() as import("node:net").AddressInfo).port, close: () => { srv.close(); accepted.close(wsErr("server closed")); openResources.delete(server) } }
        srv.on("upgrade", (req, socket) => {
            const key = req.headers["sec-websocket-key"]
            if (typeof key !== "string") { socket.destroy(); return }
            const accept = cryptoModule.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
            accepted.push(Ok({ $t: `${WS}.Connection`, conn: serverConn(socket as import("node:net").Socket) }))
        })
        return await new Promise((resolve) => {
            srv.once("error", (e) => resolve(wsErr(`cannot listen on ${host}:${port}: ${e.message}`)))
            srv.listen(port, host, () => { openResources.add(server); resolve(Ok(server)) })
        })
    },
    "net.ws.connect": (url: string) => clientConn(url),
    "net.ws.Server.accept": (s: Any) => s.accepted.take(),
    "net.ws.Server.close": (s: Any) => { s.close() },
    "net.ws.Server.port": (s: Any) => s.port(),
    "net.ws.Connection.split": (c: Any) => [{ $t: `${WS}.Reader`, conn: c.conn }, { $t: `${WS}.Writer`, conn: c.conn }],
    "net.ws.Reader.receive": (r: Any) => r.conn.inbox.take(),
    "net.ws.Writer.send": (w: Any, msg: Any) => w.conn.send(msg),
})

// ---- JSON ↔ values ------------------------------------------------------------------------------

/** The structure of a type (src/hir.ts `Shape`), so plain JSON data can become MinScript values. */
type Shape = { s: string } | { vec: Shape | null } | { opt: Shape | null } | { map: Shape | null } | { f: true } | { i64: true }

class JsonShapeError extends Error {}

const jsonValue = (v: Any): Any => {
    const V = (variant: string, ...f: Any[]) => ({ $t: "std.json.Value", $v: variant, $f: f })
    if (v === null) return V("Null")
    if (typeof v === "boolean") return V("Bool", v)
    if (typeof v === "number") return V("Number", v)
    if (typeof v === "string") return V("Str", v)
    if (Array.isArray(v)) return V("Array", v.map(jsonValue))
    const m = new MsMap()
    for (const [k, x] of Object.entries(v)) m.set(k, jsonValue(x))
    return V("Object", m)
}

/** Plain JSON data → a value of the given shape (`json.parse.[User]`): tags structs, makes Options. */
function fromJson(v: Any, shape: Shape | null, at: string): Any {
    const where = at === "" ? "" : ` at \`${at}\``
    if (shape !== null && "opt" in shape) return v === null || v === undefined ? None : Some(fromJson(v, shape.opt, at))
    if (v === undefined) throw new JsonShapeError(`missing field${where}`)
    if (shape === null) return v
    if ("f" in shape) { if (typeof v !== "number") throw new JsonShapeError(`expected a number${where}`); return v }
    if ("i64" in shape) { if (typeof v !== "number") throw new JsonShapeError(`expected a number${where}`); return BigInt(Math.trunc(v)) }
    if ("vec" in shape) {
        if (!Array.isArray(v)) throw new JsonShapeError(`expected an array${where}`)
        return v.map((x, i) => fromJson(x, shape.vec, `${at}[${i}]`))
    }
    if ("map" in shape) {
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw new JsonShapeError(`expected an object${where}`)
        const m = new MsMap()
        for (const [k, x] of Object.entries(v)) m.set(k, fromJson(x, shape.map, at === "" ? k : `${at}.${k}`))
        return m
    }
    if (shape.s === "std.json.Value") return jsonValue(v)
    const info = types.get(shape.s)
    if (info === undefined) return v          // an alias (`Role = "Admin" | …`) or a type without fields
    if (info?.kind === "union") {
        // `"Unit"` or `{ "Variant": [fields…] }` (what `stringify` writes)
        const [name, payload] = typeof v === "string" ? [v, []] : v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 ? Object.entries(v)[0]! : [null, null]
        if (name === null || !(name in info.fields)) throw new JsonShapeError(`expected a variant of \`${shape.s}\`${where}`)
        return { $t: shape.s, $v: name, $f: Array.isArray(payload) ? payload : [payload] }
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new JsonShapeError(`expected an object${where}`)
    if (info?.kind !== "struct") return { $t: shape.s, ...v }
    const out: Any = { $t: shape.s }
    for (const f of info.fields as string[]) {
        const d = info.defaults[f]
        out[f] = v[f] === undefined && d ? d() : fromJson(v[f], info.shapes[f] ?? null, at === "" ? f : `${at}.${f}`)
    }
    return out
}

export function toJson(v: Any): Any {
    if (v === undefined) return null
    if (typeof v === "bigint") return Number(v)
    if (v === null || typeof v !== "object") return v
    if (Array.isArray(v)) return v.map(toJson)
    if (v instanceof MsMap) return Object.fromEntries([...v.entries()].map(([k, x]) => [toStr(k), toJson(x)]))
    if (v.$t === "std.json.Value") return v.$v === "Null" ? null : v.$v === "Array" ? v.$f[0].map(toJson) : toJson(v.$f[0])
    if (v.$v !== undefined) {
        if (v.$v === "None") return null
        if (v.$v === "Some") return toJson(v.$f[0])
        return v.$f.length === 0 ? v.$v : { [v.$v]: v.$f.map(toJson) }
    }
    const out: Any = {}
    for (const k of Object.keys(v)) if (k !== "$t") out[k] = toJson(v[k])
    return out
}

// ---- external packages (opaque: `extern:acme.http.get`) ------------------------------------------

const externs: Record<string, Any> = {}

export function ext(path: string): Any {
    const f = externs[path]
    if (f !== undefined) return f
    const pkg = path.split(".").slice(0, -1).join(".")
    return (..._args: Any[]) => panic(`\`${path}\`: the package \`${pkg}\` isn't loaded (registry and git dependencies aren't fetched yet; a \`path:\` dependency in mod.ms is)`)
}
