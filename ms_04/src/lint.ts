// Pass 9: lints (spec §18.4). Warnings, never errors unless a project denies them: each lint can be
// set to `allow`, `warn` or `deny` in mod.ms (`lint.setup(_{ … })`) or on the command line.
//
// They run after the front end and mechanism selection, on code without errors, one function body
// at a time (plus the type graph for L_SHARED_CYCLE). Two come from earlier passes:
// L_SHADOWED_VARIANT (the checker sees the lookup) and L_SUMMARY_WIDENED (pass 6 hits the cap).
//
// Order inside a body is approximated by source position, plus loops: a use inside a loop counts
// as coming after every point of that loop.

import { diag, type Diagnostic } from "./diagnostic.ts";
import type * as H from "./hir.ts";
import { pathOf } from "./hir.ts";
import type { Sym } from "./resolve.ts";
import type { Summary } from "./effects.ts";
import type { MechanismResult } from "./mechanism.ts";
import { patternLocals } from "./mechanism.ts";
import type { LintSettings } from "./loader.ts";
import * as T from "./types.ts";
import type { Ty } from "./types.ts";

export type Level = "allow" | "warn" | "deny";

/** Every lint and its default level (§18.4). */
export const LINTS: Record<string, Level> = {
    L_IMPLICIT_COPY: "warn",
    L_VIEW_FORCED_COPY: "warn",
    L_TASK_SEES_SNAPSHOT: "warn",
    L_DIVERGED_COPIES: "warn",
    L_SHARED_CYCLE: "warn",
    L_SUMMARY_WIDENED: "warn",
    L_NESTED_LOCK: "warn",
    L_SELF_WAIT: "warn",
    L_SHADOWED_VARIANT: "warn",
    L_INT_NOT_PORTABLE: "warn",
    L_BIGINT_ON_JS: "warn",
};

export interface LintInput {
    hir: H.Program;
    summaries: Map<H.Fun, Summary>;
    mechanisms: MechanismResult;
    /** findings of earlier passes (L_SHADOWED_VARIANT, L_SUMMARY_WIDENED) */
    earlier: Diagnostic[];
    /** files whose code is linted (not the prelude, not std) */
    isUser: (file: string) => boolean;
    target: "js" | "native";
}

/** The level of each lint: defaults, then mod.ms, then the command line (later wins). */
export function lintLevels(...settings: LintSettings[]): Map<string, Level> {
    const out = new Map(Object.entries(LINTS));
    for (const s of settings) {
        for (const c of s.allow) out.set(c, "allow");
        for (const c of s.warn) out.set(c, "warn");
        for (const c of s.deny) out.set(c, "deny");
        if (s.strict) for (const [c, l] of out) if (l === "warn") out.set(c, "deny");
    }
    return out;
}

/** Runs every lint and applies the levels: `allow` drops a finding, `deny` makes it an error. */
export function lint(input: LintInput, levels: Map<string, Level> = lintLevels()): Diagnostic[] {
    const l = new Linter(input);
    l.run();
    const out: Diagnostic[] = [];
    const seen = new Set<string>();
    for (const d of [...input.earlier, ...l.out]) {
        const level = levels.get(d.code) ?? "warn";
        if (level === "allow" || (d.file && !input.isUser(d.file))) continue;
        const key = `${d.file}:${d.start}:${d.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...d, severity: level === "deny" ? "error" : "warning" });
    }
    return out;
}

// ---- helpers -------------------------------------------------------------------------------------

const COLLECTIONS = new Set(["Vec", "Map", "Set"]);

function named(t: Ty): { name: string; args: Ty[]; sym: Sym } | null {
    const p = T.prune(t);
    return p.k === "named" ? { name: p.sym.name, args: p.args, sym: p.sym } : null;
}
const isCollection = (t: Ty) => {
    const n = named(t);
    return !!n && n.sym.pkg === "prelude" && COLLECTIONS.has(n.name);
};
const isCopy = (t: Ty) => {
    const p = T.prune(t);
    return p.k === "prim" || p.k === "lit" || p.k === "never";
};
const isBig = (t: Ty) => {
    const p = T.prune(t);
    return p.k === "prim" && (p.name === "i64" || p.name === "u64");
};

function pathText(p: H.Place): string {
    return pathOf(p, 99);
}

const rootOf = (path: string) => path.split(/[.[]/)[0]!;

/** `.items[*].qty` → segments (element indices are placeholders: only their kind matters here). */
function parseSegs(rest: string): H.Seg[] {
    const out: H.Seg[] = [];
    for (const m of rest.matchAll(/\.([A-Za-z_0-9]+)|\[([^\]]*)\]/g)) {
        if (m[1] !== undefined) out.push(/^\d+$/.test(m[1]) ? { k: "tuple", index: Number(m[1]) } : { k: "field", name: m[1], mode: null });
        else out.push({ k: "elem", index: { k: "lit", ty: T.UNKNOWN, span: { start: 0, end: 0 }, value: null }, key: m[2] === "*" ? null : m[2]!, map: false });
    }
    return out;
}

/** Whether two access paths overlap: one is a prefix of the other (`[*]` matches any element). */
function overlaps(a: string, b: string): boolean {
    const split = (p: string) => p.match(/[^.[\]]+|\[[^\]]*\]/g) ?? [];
    const x = split(a);
    const y = split(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const p = x[i]!;
        const q = y[i]!;
        if (p === q || (p.startsWith("[") && q.startsWith("[") && (p === "[*]" || q === "[*]"))) continue;
        return false;
    }
    return true;
}

/** Sub-expressions in evaluation order, into nested blocks; into closure bodies when `closures`. */
function children(e: H.Expr, f: (e: H.Expr) => void, closures: boolean): void {
    const place = (p: H.Place) => {
        if (p.root.k === "value") f(p.root.expr);
        for (const s of p.segs) if (s.k === "elem") f(s.index);
    };
    const arg = (a: H.Arg) => (a.mode === "read" ? f(a.expr) : place(a.place));
    const block = (b: H.Block) => {
        for (const s of b.stmts) {
            if (s.k === "let") {
                f(s.value);
                if (s.else) block(s.else);
            } else f(s.expr);
        }
        if (b.value) f(b.value);
    };
    switch (e.k) {
        case "read": return place(e.place);
        case "assign": f(e.value); return place(e.place);
        case "call": if (e.recv) arg(e.recv); e.args.forEach(arg); return;
        case "callvalue": f(e.fn); e.args.forEach(arg); return;
        case "extern": e.args?.forEach(f); return;
        case "struct": case "record": e.fields.forEach((x) => f(x.value)); return;
        case "variant": e.fields.forEach(f); return;
        case "tuple": e.elems.forEach(f); return;
        case "vec": case "array": case "set": e.elems.forEach((x) => f(x.k === "spread" ? x.expr : x)); return;
        case "map": e.entries.forEach((en) => ("k" in en ? f(en.expr) : (f(en.key), f(en.value)))); return;
        case "range": if (e.start) f(e.start); if (e.end) f(e.end); return;
        case "unary": case "tostr": case "cast": case "await": case "truthy": return f(e.expr);
        case "binary": case "and": case "or": f(e.left); f(e.right); return;
        case "concat": e.parts.forEach(f); return;
        case "if": f(e.cond); block(e.then); if (e.else) block(e.else); return;
        case "match": f(e.subject); e.arms.forEach((a) => (a.guard && f(a.guard), f(a.body))); return;
        case "loop": return block(e.body);
        case "foreach": f(e.iterable); return block(e.body);
        case "break": case "return": if (e.value) f(e.value); return;
        case "block": return block(e.block);
        case "select": e.arms.forEach((a) => (f(a.wait), f(a.body))); if (e.else) f(e.else); return;
        case "recover": return block(e.body);
        case "lock": e.places.forEach(place); return block(e.body);
        case "closure": if (closures) block(e.body); return;
        default: return;
    }
}

function eachInBlock(b: H.Block, f: (e: H.Expr) => void): void {
    for (const s of b.stmts) {
        if (s.k === "let") {
            f(s.value);
            if (s.else) eachInBlock(s.else, f);
        } else f(s.expr);
    }
    if (b.value) f(b.value);
}

/** Every expression of a body, depth first in evaluation order, with the loops around it. */
function walk(b: H.Block, f: (e: H.Expr, loops: H.Expr[], inClosure: boolean) => void): void {
    const loops: H.Expr[] = [];
    let closure = 0;
    const visit = (e: H.Expr) => {
        f(e, loops, closure > 0);
        const isLoop = e.k === "loop" || e.k === "foreach";
        if (isLoop) loops.push(e);
        if (e.k === "closure") closure++;
        children(e, visit, true);
        if (e.k === "closure") closure--;
        if (isLoop) loops.pop();
    };
    eachInBlock(b, visit);
}

// ---- the lints -----------------------------------------------------------------------------------

/** Where a local is written (the write's span and the place's path). */
interface Write {
    span: H.Span;
    place: H.Place;
    /** the access path written: the place, extended by the callee's summary for a `*` argument */
    path: string;
    /** the types of the buffers the write goes through, root first */
    buffers: Ty[];
    loops: H.Expr[];
}

class Linter {
    readonly in: LintInput;
    readonly out: Diagnostic[] = [];
    readonly funs = new Map<string, H.Fun>();
    readonly structs = new Map<string, H.TypeDef & { kind: "struct" }>();
    readonly bySym = new Map<Sym, H.TypeDef & { kind: "struct" }>();
    f!: H.Fun;

    constructor(input: LintInput) {
        this.in = input;
        for (const f of input.hir.funs) this.funs.set(f.name, f);
        for (const t of input.hir.types) {
            if (t.kind !== "struct") continue;
            this.structs.set(t.name, t);
            if (t.sym) this.bySym.set(t.sym, t);
        }
    }

    report(code: string, message: string, span: H.Span, file: string, fix?: string): void {
        this.out.push({ ...diag(code, message, span.start, span.end, fix), file });
    }

    run(): void {
        for (const f of this.in.hir.funs) {
            if (!f.body || !this.in.isUser(f.file)) continue;
            this.f = f;
            this.body(f, f.body);
        }
        this.sharedCycles();
    }

    // ---- per body --------------------------------------------------------------------------

    body(f: H.Fun, b: H.Block): void {
        const locals = new Map<Sym, H.Local>();
        for (const l of [...f.params, ...(f.self ? [f.self] : [])]) locals.set(l.sym, l);
        const lets: { local: H.Local; value: H.Expr; loops: H.Expr[] }[] = [];
        const reads = new Map<Sym, { span: H.Span; loops: H.Expr[] }[]>();
        const writes = new Map<Sym, Write[]>();
        const stores = new Map<Sym, H.Span[]>();
        const tasks: { call: H.Expr & { k: "call" }; loops: H.Expr[] }[] = [];
        const awaited = new Set<H.Expr>();
        const foreachs: { e: H.Expr & { k: "foreach" }; loops: H.Expr[] }[] = [];
        const closes = new Map<Sym, H.Span[]>();
        const subscribes = new Map<Sym, Sym>();

        const addWrite = (p: H.Place, span: H.Span, loops: H.Expr[], leafTy: Ty | null, through?: { callee: H.Fun | undefined; param: string }) => {
            if (p.root.k !== "local") return;
            const list = writes.get(p.root.local) ?? [];
            const rootTy = locals.get(p.root.local)?.ty ?? T.UNKNOWN;
            const sum = through?.callee ? this.in.summaries.get(through.callee) : undefined;
            const deeper = sum ? [...sum.writes].filter((w) => rootOf(w) === through!.param).map((w) => w.slice(through!.param.length)) : [];
            if (deeper.length === 0) {
                list.push({ span, place: p, path: pathText(p), buffers: this.buffers(rootTy, p, leafTy), loops: [...loops] });
            } else {
                // what the callee writes through the argument: `other.at_mut(k)` writes `other.items[*]`
                for (const rest of deeper) {
                    const segs = [...p.segs, ...parseSegs(rest)];
                    const q: H.Place = { root: p.root, segs };
                    // the written path's own buffer counts too: `push` writes [this], the Vec itself
                    const bufs = this.buffers(rootTy, q, null);
                    bufs.push(q.segs.reduce((t, sg) => this.segTy(t, sg), rootTy));
                    list.push({ span, place: p, path: pathText(q), buffers: bufs, loops: [...loops] });
                }
            }
            writes.set(p.root.local, list);
        };
        const stmtLets = (blk: H.Block, loops: H.Expr[]) => {
            for (const s of blk.stmts) {
                if (s.k === "let") {
                    for (const l of patternLocals(s.pattern)) locals.set(l.sym, l);
                    if (s.pattern.k === "bind") lets.push({ local: s.pattern.local, value: s.value, loops: [...loops] });
                }
            }
        };
        stmtLets(b, []);
        walk(b, (e, loops) => {
            for (const blk of blocksOf(e)) stmtLets(blk, [...loops, ...(e.k === "loop" || e.k === "foreach" ? [e] : [])]);
            if (e.k === "match") for (const a of e.arms) for (const l of patternLocals(a.pattern)) locals.set(l.sym, l);
            if (e.k === "foreach") {
                for (const l of patternLocals(e.item)) locals.set(l.sym, l);
                foreachs.push({ e, loops: [...loops] });
            }
            if (e.k === "closure") for (const l of e.params) locals.set(l.sym, l);
            if (e.k === "await") {
                const mark = (x: H.Expr) => {
                    awaited.add(x);
                    children(x, mark, false);
                };
                mark(e.expr);
            }
            if (e.k === "read" && e.place.root.k === "local") {
                const list = reads.get(e.place.root.local) ?? [];
                list.push({ span: e.span, loops: [...loops] });
                reads.set(e.place.root.local, list);
            }
            if (e.k === "assign" && e.place.segs.length > 0) addWrite(e.place, e.span, loops, null);
            // a write through a write view: `other.at_mut(k).qty = 0` writes `other.items[*].qty`
            if (e.k === "assign" && e.place.root.k === "value" && e.place.root.expr.k === "call") {
                const c = e.place.root.expr;
                const callee = c.callee.k === "fn" ? this.funs.get(c.callee.name) : undefined;
                const sum = callee?.retMode === "write" ? this.in.summaries.get(callee) : undefined;
                const through = (place: H.Place, param: string) => {
                    for (const v of sum?.returnsView ?? []) {
                        if (rootOf(v) !== param) continue;
                        addWrite({ root: place.root, segs: [...place.segs, ...parseSegs(v.slice(param.length)), ...e.place.segs] }, e.span, loops, null);
                    }
                };
                if (c.recv?.mode === "write") through(c.recv.place, "this");
                c.args.forEach((a, i) => a.mode === "write" && through(a.place, callee?.params[i]?.name ?? ""));
            }
            if (e.k === "call") {
                const callee = e.callee.k === "fn" ? this.funs.get(e.callee.name) : undefined;
                if (e.recv?.mode === "write") addWrite(e.recv.place, e.span, loops, e.recv.ty, { callee, param: "this" });
                e.args.forEach((a, i) => a.mode === "write" && addWrite(a.place, e.span, loops, a.ty, { callee, param: callee?.params[i]?.name ?? "" }));
                if (e.async || callee?.async) tasks.push({ call: e, loops: [...loops] });
                // stores: a whole local passed to a parameter the callee keeps
                const sum = callee ? this.in.summaries.get(callee) : undefined;
                e.args.forEach((a, i) => {
                    const name = callee?.params[i]?.name;
                    if (a.mode === "read" && name && sum && [...sum.keeps].some((k) => rootOf(k) === name)) this.store(stores, a.expr);
                });
                const method = e.callee.k === "fn" ? e.callee.name.slice(e.callee.name.lastIndexOf(".") + 1) : e.callee.k === "dyn" ? e.callee.method : "";
                const recvTy = e.recv ? (e.recv.mode === "read" ? e.recv.expr.ty : e.recv.ty) : T.UNKNOWN;
                const handle = named(recvTy);
                if (handle && handle.sym.pkg === "prelude" && (handle.name === "Topic" || handle.name === "Queue") && e.recv?.mode === "read") {
                    const r = e.recv.expr;
                    if (method === "close" && r.k === "read" && r.place.root.k === "local" && r.place.segs.length === 0) {
                        const list = closes.get(r.place.root.local) ?? [];
                        list.push(e.span);
                        closes.set(r.place.root.local, list);
                    }
                }
            }
            if (e.k === "struct" || e.k === "record") for (const x of e.fields) this.store(stores, x.value);
            if (e.k === "variant") for (const x of e.fields) this.store(stores, x);
            if (e.k === "vec" || e.k === "set") for (const x of e.elems) if (x.k !== "spread") this.store(stores, x);
            if (e.k === "assign" && e.place.segs.length > 0) this.store(stores, e.value);
            this.expression(e, loops);
        });
        // a subscription bound from `t.subscribe()`
        for (const l of lets) {
            const v = l.value;
            if (v.k === "call" && v.recv?.mode === "read" && v.recv.expr.k === "read" && v.recv.expr.place.root.k === "local" && v.recv.expr.place.segs.length === 0) {
                const method = v.callee.k === "fn" ? v.callee.name.slice(v.callee.name.lastIndexOf(".") + 1) : "";
                const h = named(v.recv.expr.ty);
                if (method === "subscribe" && h && h.sym.pkg === "prelude" && (h.name === "Topic" || h.name === "Queue")) subscribes.set(l.local.sym, v.recv.expr.place.root.local);
            }
        }

        const usedAfter = (uses: { span: H.Span; loops: H.Expr[] }[] | undefined, at: H.Span, loops: H.Expr[], defLoops: H.Expr[]) =>
            (uses ?? []).some((u) => u.span.start > at.end || loops.some((lp) => !defLoops.includes(lp) && u.loops.includes(lp)));

        this.implicitCopies(lets, writes, locals);
        this.viewForcedCopies(lets, writes, reads, foreachs, usedAfter);
        this.taskSnapshots(tasks, awaited, writes, locals);
        this.divergedCopies(stores, writes);
        this.selfWaits(foreachs, subscribes, closes);
    }

    store(stores: Map<Sym, H.Span[]>, e: H.Expr): void {
        if (e.k !== "read" || e.place.root.k !== "local" || e.place.segs.length > 0 || isCopy(e.ty)) return;
        const list = stores.get(e.place.root.local) ?? [];
        if (!list.some((s) => s.start === e.span.start)) list.push(e.span);
        stores.set(e.place.root.local, list);
    }

    /** The types of the buffers a write to `p` goes through: the root, then each prefix, then the leaf for a method or `*` write. */
    buffers(rootTy: Ty, p: H.Place, leafTy: Ty | null): Ty[] {
        const out: Ty[] = [rootTy];
        let t = rootTy;
        for (const s of p.segs) {
            t = this.segTy(t, s);
            out.push(t);
        }
        if (leafTy === null) out.pop(); // an assignment writes the containers, not the leaf
        else if (p.segs.length > 0) out[out.length - 1] = leafTy;
        return out;
    }

    segTy(t: Ty, s: H.Seg): Ty {
        const n = named(t);
        const p = T.prune(t);
        if (s.k === "tuple") return p.k === "tuple" ? p.elems[s.index] ?? T.UNKNOWN : T.UNKNOWN;
        if (s.k === "elem") return n && n.sym.pkg === "prelude" ? (n.name === "Map" ? n.args[1] : n.args[0]) ?? T.UNKNOWN : T.UNKNOWN;
        if (p.k === "record") return p.fields.find((f) => f.name === s.name)?.ty ?? T.UNKNOWN;
        if (!n) return T.UNKNOWN;
        const def = this.bySym.get(n.sym);
        return def?.fields.find((f) => f.name === s.name)?.ty ?? T.UNKNOWN;
    }

    // ---- L_IMPLICIT_COPY ---------------------------------------------------------------------

    /**
     * A write to a collection reached from a local that may be shared: the local shares its source
     * (the source is used again) or holds an owned parameter the caller may still be using.
     */
    implicitCopies(lets: { local: H.Local; value: H.Expr }[], writes: Map<Sym, Write[]>, locals: Map<Sym, H.Local>): void {
        const tags = this.in.mechanisms.tags;
        const owned = new Set([...(this.in.mechanisms.owned.get(this.f) ?? [])].map((i) => this.f.params[i]!.sym));
        const why = new Map<Sym, string>();
        // fixpoint over chains of moves: `var a = p; var b = a` makes `b` maybe-shared too
        for (let round = 0; round < 4; round++) {
            for (const l of lets) {
                if (why.has(l.local.sym) || !l.local.mutable || l.local.shared) continue;
                const v = l.value;
                if (v.k !== "read" || v.place.root.k !== "local") continue;
                const src = v.place.root;
                const tag = tags.get(v);
                const isParam = this.f.params.some((x) => x.sym === src.local) && v.place.segs.length === 0;
                if (tag === "share" && !isParam) why.set(l.local.sym, `\`${l.local.name}\` shares \`${pathText(v.place)}\`, which is used again`);
                else if ((tag === "share" && isParam) || (tag === "move" && owned.has(src.local))) why.set(l.local.sym, `\`${l.local.name}\` holds the parameter \`${src.name}\`, which the caller may still use`);
                else if (tag === "move" && why.has(src.local)) why.set(l.local.sym, why.get(src.local)!.replace(/^`[^`]*`/, `\`${l.local.name}\``));
            }
        }
        for (const [sym, reason] of why) {
            const local = locals.get(sym);
            for (const w of writes.get(sym) ?? []) {
                const i = w.buffers.findIndex(isCollection);
                if (i < 0) continue;
                const buf = i === 0 ? local?.name ?? "" : pathText({ root: w.place.root, segs: w.place.segs.slice(0, i) });
                this.report("L_IMPLICIT_COPY", `this write may copy \`${buf}\`: ${reason}`, w.span, this.f.file,
                    "drop the other use, write through a `*T` parameter, or make the value `shared`");
            }
        }
    }

    // ---- L_VIEW_FORCED_COPY ------------------------------------------------------------------

    /** A write to a local while a view of it is still used: the view keeps the old buffer, the write copies. */
    viewForcedCopies(
        lets: { local: H.Local; value: H.Expr; loops: H.Expr[] }[],
        writes: Map<Sym, Write[]>,
        reads: Map<Sym, { span: H.Span; loops: H.Expr[] }[]>,
        foreachs: { e: H.Expr & { k: "foreach" }; loops: H.Expr[] }[],
        usedAfter: (uses: { span: H.Span; loops: H.Expr[] }[] | undefined, at: H.Span, loops: H.Expr[], defLoops: H.Expr[]) => boolean,
    ): void {
        const tags = this.in.mechanisms.tags;
        // a view's root follows moves: `var other = t` moves `t`, so a view of `t` is a view of `other`
        const movedInto = new Map<Sym, Sym>();
        for (const l of lets) {
            const v = l.value;
            if (v.k === "read" && v.place.root.k === "local" && v.place.segs.length === 0 && tags.get(v) === "move") movedInto.set(v.place.root.local, l.local.sym);
        }
        const nameOf = new Map<Sym, string>();
        for (const l of lets) nameOf.set(l.local.sym, l.local.name);
        for (const [s, ws] of writes) for (const w of ws) if (w.place.root.k === "local") nameOf.set(s, w.place.root.name);
        const follow = (s: Sym) => {
            const seen = new Set<Sym>();
            const out = [s];
            while (movedInto.has(s) && !seen.has(s)) {
                seen.add(s);
                s = movedInto.get(s)!;
                out.push(s);
            }
            return out;
        };
        for (const l of lets) {
            const view = this.viewOf(l.value);
            if (!view) continue;
            for (const owner of follow(view.root)) {
                const viewPath = view.path.replace(/^[^.[]*/, nameOf.get(owner) ?? "");
                for (const w of writes.get(owner) ?? []) {
                    if (!overlaps(viewPath, w.path)) continue;
                    if (w.span.start < l.value.span.end && !w.loops.some((lp) => !l.loops.includes(lp))) continue;
                    if (!usedAfter(reads.get(l.local.sym), w.span, w.loops, l.loops)) continue;
                    this.report("L_VIEW_FORCED_COPY", `this write copies \`${pathText(w.place)}\`: \`${l.local.name}\`, a view of it, is still used below and keeps the old value`, w.span, this.f.file,
                        `finish with \`${l.local.name}\` before the write, or make it its own value`);
                }
            }
        }
        // `for x in items { items.push(x) }`: the loop reads a view of `items` while the body writes it
        for (const { e } of foreachs) {
            const it = e.iterable;
            if (it.k !== "read" || it.place.root.k !== "local") continue;
            for (const w of writes.get(it.place.root.local) ?? []) {
                if (!w.loops.includes(e)) continue;
                this.report("L_VIEW_FORCED_COPY", `this write copies \`${pathText(w.place)}\` while the loop iterates over \`${pathText(it.place)}\`: the loop keeps seeing the old value`, w.span, this.f.file,
                    "collect the changes and apply them after the loop");
            }
        }
    }

    /** What a value is a view of: a read with a path, or a call that returns a view of an argument's path. */
    viewOf(e: H.Expr): { root: Sym; path: string } | null {
        if (e.k === "read") {
            const viewTy = !isCopy(e.ty) || (T.prune(e.ty).k === "prim" && (T.prune(e.ty) as { name: string }).name === "str");
            return e.place.root.k === "local" && e.place.segs.length > 0 && viewTy ? { root: e.place.root.local, path: pathText(e.place) } : null;
        }
        if (e.k === "match") return this.viewOf(e.subject);
        if (e.k === "block" && e.block.value && e.block.stmts.length === 0) return this.viewOf(e.block.value);
        if (e.k === "call") {
            const callee = e.callee.k === "fn" ? this.funs.get(e.callee.name) : undefined;
            const sum = callee ? this.in.summaries.get(callee) : undefined;
            if (!sum || sum.returnsView.size === 0) return null;
            const from = (x: H.Expr, param: string): { root: Sym; path: string } | null => {
                if (x.k !== "read" || x.place.root.k !== "local") return null;
                const v = [...sum.returnsView].find((p) => rootOf(p) === param);
                return v === undefined ? null : { root: x.place.root.local, path: pathText(x.place) + v.slice(param.length) };
            };
            if (e.recv?.mode === "read") {
                const r = from(e.recv.expr, "this");
                if (r) return r;
            }
            for (let i = 0; i < e.args.length; i++) {
                const a = e.args[i]!;
                const r = a.mode === "read" ? from(a.expr, callee!.params[i]?.name ?? "") : null;
                if (r) return r;
            }
        }
        return null;
    }

    // ---- L_TASK_SEES_SNAPSHOT ----------------------------------------------------------------

    /**
     * A closure handed to a task not awaited in its statement reads a captured `var` that this
     * function writes afterwards: the closure captured a copy (§9.9), so the task sees the old value.
     * (Passing a non-Copy `var` itself to a detached task is E_VIEW_ACROSS_TASK; passing a Copy value
     * is an explicit snapshot, like `handle(conn, next_id)`.)
     */
    taskSnapshots(tasks: { call: H.Expr & { k: "call" }; loops: H.Expr[] }[], awaited: Set<H.Expr>, writes: Map<Sym, Write[]>, locals: Map<Sym, H.Local>): void {
        for (const { call, loops } of tasks) {
            if (awaited.has(call)) continue;
            for (const a of call.args) {
                if (a.mode !== "read" || a.expr.k !== "closure") continue;
                for (const cap of a.expr.captures) {
                    const local = locals.get(cap.sym);
                    if (!local || !local.mutable || local.shared || cap.mode === "write") continue;
                    const later = (writes.get(local.sym) ?? []).some((w) => w.span.start > call.span.end || loops.some((lp) => w.loops.includes(lp)));
                    if (!later && !this.reassignedAfter(local.sym, call.span.end)) continue;
                    this.report("L_TASK_SEES_SNAPSHOT", `the task's closure captured a copy of \`${local.name}\`: the writes this function makes to it afterwards won't reach the task`, a.expr.span, this.f.file, `shared var ${local.name}`);
                }
            }
        }
    }

    reassignedAfter(sym: Sym, after: number): boolean {
        let found = false;
        walk(this.f.body!, (e) => {
            if (!found && e.k === "assign" && e.place.root.k === "local" && e.place.root.local === sym && e.place.segs.length === 0 && e.span.start > after) found = true;
        });
        return found;
    }

    // ---- L_DIVERGED_COPIES -------------------------------------------------------------------

    /** A non-shared field written after the value was stored in two places: neither copy sees it. */
    divergedCopies(stores: Map<Sym, H.Span[]>, writes: Map<Sym, Write[]>): void {
        for (const [sym, spans] of stores) {
            if (spans.length < 2) continue;
            const second = [...spans].sort((a, b) => a.start - b.start)[1]!;
            for (const w of writes.get(sym) ?? []) {
                const first = w.place.segs[0];
                if (w.span.start < second.end || !first || first.k !== "field" || first.mode === "shared") continue;
                const name = w.place.root.k === "local" ? w.place.root.name : "";
                this.report("L_DIVERGED_COPIES", `\`${name}\` was stored in two places before this write: the write changes neither of them`, w.span, this.f.file,
                    `write before storing, or make \`${first.name}\` a \`shared\` field`);
            }
        }
    }

    // ---- L_SELF_WAIT -------------------------------------------------------------------------

    /** `for await x in sub` where this task closes `sub`'s topic or queue only after the loop. */
    selfWaits(foreachs: { e: H.Expr & { k: "foreach" } }[], subscribes: Map<Sym, Sym>, closes: Map<Sym, H.Span[]>): void {
        for (const { e } of foreachs) {
            if (e.of !== "async" || e.iterable.k !== "read" || e.iterable.place.root.k !== "local") continue;
            const handle = subscribes.get(e.iterable.place.root.local);
            if (!handle) continue;
            const cs = closes.get(handle) ?? [];
            if (cs.length === 0 || cs.some((c) => c.start < e.span.end)) continue;
            this.report("L_SELF_WAIT", "this loop ends only when its topic or queue is closed, and this task closes it only after the loop: it waits on itself", e.span, this.f.file,
                "close it before the loop, or iterate in another task");
        }
    }

    // ---- per expression: locks and integers ----------------------------------------------------

    expression(e: H.Expr, _loops: H.Expr[]): void {
        if (e.k === "lock") {
            const inner = (x: H.Expr): void => {
                if (x.k === "lock") {
                    this.report("L_NESTED_LOCK", "a `lock` inside another `lock`: two tasks taking them in opposite orders deadlock", x.span, this.f.file, "lock both places in one block: `lock a, b { … }`");
                    return;
                }
                if (x.k !== "closure") children(x, inner, false);
            };
            eachInBlock(e.body, inner);
        }
        if (e.k === "lit" && typeof e.value === "bigint") {
            const p = T.prune(e.ty);
            if (p.k === "prim" && p.name === "int" && (e.value > 2147483647n || e.value < -2147483648n)) {
                this.report("L_INT_NOT_PORTABLE", `${e.value} doesn't fit in 32 bits, and \`int\` is 32-bit on JS and WASM`, e.span, this.f.file, `${e.value} as i64`);
            }
        }
        if (this.in.target === "js" && (e.k === "binary" || (e.k === "assign" && e.op !== "=" && e.op !== "??=")) && isBig(e.k === "binary" ? e.ty : e.value.ty)) {
            const op = e.k === "binary" ? e.op : e.op.slice(0, -1);
            if (["+", "-", "*", "/", "%", "<<", ">>", "&", "|", "^"].includes(op)) {
                this.report("L_BIGINT_ON_JS", `\`${T.show(e.k === "binary" ? e.ty : e.value.ty)}\` arithmetic lowers to BigInt on JS, which is much slower than \`int\``, e.span, this.f.file, "use `int` where values fit in 32 bits");
            }
        }
    }

    // ---- L_SHARED_CYCLE ----------------------------------------------------------------------

    /**
     * A type that can reach itself through a field written after construction: a `shared` field or
     * a `once` field (an identity value's plain fields are fixed at construction, so they can't close
     * a cycle). `Weak[T]` breaks the edge.
     */
    sharedCycles(): void {
        // edges: struct → structs its fields reach, through containers and value types; marked when mutable
        const reach = (t: Ty, out: Set<H.TypeDef & { kind: "struct" }>, depth = 0): void => {
            if (depth > 8) return;
            const n = named(t);
            const p = T.prune(t);
            if (p.k === "tuple") return p.elems.forEach((x) => reach(x, out, depth + 1));
            if (p.k === "record") return p.fields.forEach((x) => reach(x.ty, out, depth + 1));
            if (!n) return;
            if (n.sym.pkg === "prelude" && n.name === "Weak") return;
            const def = this.bySym.get(n.sym);
            if (def) out.add(def);
            for (const a of n.args) reach(a, out, depth + 1);
        };
        const reported = new Set<string>();
        for (const t of this.in.hir.types) {
            if (t.kind !== "struct" || !this.in.isUser(t.file)) continue;
            for (const f of t.fields) {
                if (f.mode !== "shared" && f.mode !== "once") continue;
                const start = new Set<H.TypeDef & { kind: "struct" }>();
                reach(f.ty, start);
                // can `t` be reached again from what this field holds?
                const seen = new Set<H.TypeDef & { kind: "struct" }>();
                const stack = [...start];
                let cycle = false;
                while (stack.length && !cycle) {
                    const x = stack.pop()!;
                    if (x === t) cycle = true;
                    if (seen.has(x)) continue;
                    seen.add(x);
                    for (const g of x.fields) {
                        const next = new Set<H.TypeDef & { kind: "struct" }>();
                        reach(g.ty, next);
                        stack.push(...next);
                    }
                }
                const key = `${t.name}.${f.name}`;
                if (!cycle || reported.has(key)) continue;
                reported.add(key);
                const short = t.name.split(".").pop()!;
                this.report("L_SHARED_CYCLE", `\`${short}.${f.name}\` is a ${f.mode} field that can lead back to a \`${short}\`: a cycle through it is never freed under refcounting`, f.span, t.file,
                    `hold the back-reference as \`Weak[…]\` (§12.4)`);
            }
        }
    }
}

function blocksOf(e: H.Expr): H.Block[] {
    switch (e.k) {
        case "if": return [e.then, ...(e.else ? [e.else] : [])];
        case "loop": case "foreach": return [e.body];
        case "block": return [e.block];
        case "recover": case "lock": return [e.body];
        case "closure": return [e.body];
        default: return [];
    }
}
