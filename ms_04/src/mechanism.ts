// Pass 8: mechanism selection (spec §15.2). One function body at a time, with the callees' effect
// summaries and the callees' owned parameters:
//
// - Every read of a whole local or parameter is tagged: `copy` (a Copy type), `view` (only lent:
//   an operand, a receiver, an argument to a borrowed parameter), or, where the value is handed
//   over (bound, stored, returned, passed to an owned parameter), `move` when it is the last use of
//   the binding on every path (a backward liveness scan) and `share` otherwise.
// - **Owned parameters.** A parameter whose value the body moves is owned: callers hand it over (a
//   move or a share), never lend it. Every other parameter is borrowed and callers pass a view.
//   Ownership depends on the callees' ownership, so it is computed to a fixpoint over the program;
//   it only grows. Parameters stay borrowed when callers can't be known statically: functions used
//   as values, interface methods (the runtime calls some directly), closure parameters and
//   receivers. An `async fn` owns all of its parameters: its task outlives the call.
// - **Copy-on-write placement.** A write to a local's value checks uniqueness first (`$rt.u` on
//   JS), unless the local is proven unique: every value it holds is a fresh literal and it is never
//   shared. Checks below the root are kept.
// - **Heap promotion.** A local whose buffer is reached by a `keeps` (passed to a parameter the
//   callee keeps, or captured by a closure that escapes) is allocated on the heap.
//
// The JS back end reads `tags` (a share sets the shared bit; a move or a view doesn't, §16.2) and
// `unique`. Native back ends will read `heap` too.

import type * as H from "./hir.ts";
import type { Sym } from "./resolve.ts";
import type { Summary } from "./effects.ts";
import * as T from "./types.ts";
import type { Ty } from "./types.ts";

export type Mechanism = "move" | "share" | "view" | "copy";

export interface MechanismResult {
    /** the mechanism of each read of a whole local or parameter, and of each read with a path that is handed over (`share`) */
    tags: Map<H.Expr, Mechanism>;
    /** per function, the indices of its owned parameters */
    owned: Map<H.Fun, Set<number>>;
    /** locals whose writes need no uniqueness check at the root */
    unique: Set<Sym>;
    /** locals that live on the heap: reached by a `keeps` */
    heap: Set<Sym>;
    /** writes per function, with whether the root is checked (for `ms mech`) and the locals live after it (for lints) */
    writes: Map<H.Fun, { span: H.Span; path: string; checked: boolean; live: Set<Sym> }[]>;
    /** rounds of the ownership fixpoint (1: nothing new after the first) */
    rounds: number;
}

export function selectMechanisms(p: H.Program, summaries: Map<H.Fun, Summary>): MechanismResult {
    return new Mechanisms(p, summaries).run();
}

const isCopy = (t: Ty) => {
    const x = T.prune(t);
    return x.k === "prim" || x.k === "lit" || x.k === "never";
};

const rootOf = (path: string) => path.split(/[.[]/)[0]!;

type Ctx = "view" | "transfer" | "keep";

class Mechanisms {
    readonly p: H.Program;
    readonly summaries: Map<H.Fun, Summary>;
    readonly funs = new Map<string, H.Fun>();
    readonly owned = new Map<H.Fun, Set<number>>();
    /** functions whose parameters stay borrowed */
    readonly pinned = new Set<H.Fun>();

    constructor(p: H.Program, summaries: Map<H.Fun, Summary>) {
        this.p = p;
        this.summaries = summaries;
        for (const f of p.funs) this.funs.set(f.name, f);
        const interMethods = new Set(p.types.flatMap((t) => (t.kind === "inter" ? t.methods : [])));
        const asValues = new Set<string>();
        const visit = (e: H.Expr) => {
            if (e.k === "fnref") asValues.add(e.name);
            eachChild(e, visit, true);
        };
        for (const f of p.funs) if (f.body) visitBlock(f.body, visit);
        for (const g of p.globals) visit(g.value);
        for (const f of p.funs) {
            const method = f.name.slice(f.name.lastIndexOf(".") + 1);
            if (!f.body || f.builtin || asValues.has(f.name) || (f.self && interMethods.has(method))) this.pinned.add(f);
        }
    }

    run(): MechanismResult {
        for (const f of this.p.funs) {
            const s = new Set<number>();
            if (f.async && !this.pinned.has(f)) f.params.forEach((_, i) => f.modes[i] === "read" && s.add(i));
            const sum = this.summaries.get(f);
            if (f.builtin || (!f.body && sum)) {
                // a builtin owns what it keeps or consumes
                f.params.forEach((l, i) => {
                    if (sum && [...sum.keeps, ...sum.consumes].some((x) => rootOf(x) === l.name)) s.add(i);
                });
            }
            this.owned.set(f, s);
        }
        const order = this.postorder();
        let rounds = 0;
        let last: FunctionMechanisms[] = [];
        for (;;) {
            rounds++;
            let changed = false;
            last = [];
            for (const f of order) {
                if (!f.body) continue;
                const fm = new FunctionMechanisms(this, f);
                fm.run();
                last.push(fm);
                if (this.pinned.has(f)) continue;
                const own = this.owned.get(f)!;
                for (const i of fm.movedParams) {
                    if (!own.has(i)) {
                        own.add(i);
                        changed = true;
                    }
                }
            }
            if (!changed || rounds > 50) break;
        }
        const out: MechanismResult = { tags: new Map(), owned: this.owned, unique: new Set(), heap: new Set(), writes: new Map(), rounds };
        for (const fm of last) {
            for (const [k, v] of fm.tags) out.tags.set(k, v);
            for (const s of fm.uniqueLocals()) out.unique.add(s);
            for (const s of fm.heap) out.heap.add(s);
            out.writes.set(fm.f, [...fm.writes.values()].map((w) => ({ span: w.span, path: w.path, checked: !(w.root && out.unique.has(w.root)), live: w.live })));
        }
        return out;
    }

    /** Callees before callers (cycles broken anywhere), so most of the fixpoint settles in one round. */
    postorder(): H.Fun[] {
        const seen = new Set<H.Fun>();
        const out: H.Fun[] = [];
        const callees = (f: H.Fun): H.Fun[] => {
            const xs: H.Fun[] = [];
            const visit = (e: H.Expr) => {
                if (e.k === "call" && e.callee.k === "fn") {
                    const g = this.funs.get(e.callee.name);
                    if (g) xs.push(g);
                }
                eachChild(e, visit, true);
            };
            if (f.body) visitBlock(f.body, visit);
            return xs;
        };
        const stack: [H.Fun, H.Fun[], number][] = [];
        for (const root of this.p.funs) {
            if (seen.has(root)) continue;
            seen.add(root);
            stack.push([root, callees(root), 0]);
            while (stack.length) {
                const top = stack[stack.length - 1]!;
                if (top[2] < top[1].length) {
                    const g = top[1][top[2]++]!;
                    if (!seen.has(g)) {
                        seen.add(g);
                        stack.push([g, callees(g), 0]);
                    }
                } else {
                    out.push(top[0]);
                    stack.pop();
                }
            }
        }
        return out;
    }

    /** How an argument passed to parameter `i` of `callee` is handed over. */
    argCtx(callee: H.Fun | null, i: number): Ctx {
        if (!callee) return "transfer";
        if (this.keeps(callee, i)) return "keep";
        return this.owned.get(callee)?.has(i) ? "transfer" : "view";
    }

    keeps(callee: H.Fun, i: number): boolean {
        const name = callee.params[i]?.name;
        const sum = this.summaries.get(callee);
        return !!name && !!sum && [...sum.keeps].some((x) => rootOf(x) === name);
    }
}

interface LoopTarget {
    label: string | null;
    after: Set<Sym>;
    head: Set<Sym>;
}

class FunctionMechanisms {
    readonly m: Mechanisms;
    readonly f: H.Fun;
    readonly tags = new Map<H.Expr, Mechanism>();
    readonly movedParams = new Set<number>();
    readonly heap = new Set<Sym>();
    /** keyed by position: a loop body is walked once per fixpoint round */
    readonly writes = new Map<string, { span: H.Span; path: string; root: Sym | null; live: Set<Sym> }>();
    /** locals that may be moved: declared in the body (or owned-candidate parameters), not aliased */
    readonly movable = new Set<Sym>();
    readonly paramIndex = new Map<Sym, number>();
    /** for the uniqueness proof: locals with a definition that isn't a fresh literal, or a read that shares */
    readonly notUnique = new Set<Sym>();
    readonly declared = new Set<Sym>();
    loops: LoopTarget[] = [];
    /** locals that must stay live here (captured by a closure, live after an enclosing `recover`) */
    pins: Set<Sym>[] = [];
    live = new Set<Sym>();

    constructor(m: Mechanisms, f: H.Fun) {
        this.m = m;
        this.f = f;
    }

    run(): void {
        const captured = new Set<Sym>();
        const cells = new Set<Sym>();
        const views = new Set<Sym>();
        const declare = (p: H.Pattern) => {
            for (const l of patternLocals(p)) {
                this.declared.add(l.sym);
                if (l.shared) cells.add(l.sym);
            }
        };
        const visit = (e: H.Expr) => {
            if (e.k === "closure") {
                for (const c of e.captures) captured.add(c.sym);
                for (const l of e.params) cells.add(l.sym); // closure parameters are never moved
            }
            // a local bound by a pattern holds part of another value: never provably unique
            const bound = (p: H.Pattern) => {
                declare(p);
                for (const l of patternLocals(p)) this.notUnique.add(l.sym);
            };
            if (e.k === "match") for (const a of e.arms) bound(a.pattern);
            if (e.k === "foreach") {
                bound(e.item);
                if (e.second) bound(e.second);
            }
            if (e.k === "select") for (const a of e.arms) bound(a.pattern);
            eachChild(e, visit, false);
        };
        const stmts = (b: H.Block) => {
            for (const s of b.stmts) {
                if (s.k === "let") {
                    declare(s.pattern);
                    if (s.pattern.k === "bind" && s.value.k === "call" && s.value.callee.k === "fn" && this.m.funs.get(s.value.callee.name)?.retMode === "write") views.add(s.pattern.local.sym);
                }
            }
        };
        const all = (e: H.Expr) => {
            for (const b of blocksIn(e)) stmts(b);
            eachChild(e, all, false);
        };
        stmts(this.f.body!);
        visitBlock(this.f.body!, visit);
        visitBlock(this.f.body!, all);
        for (const s of this.declared) if (!captured.has(s) && !cells.has(s) && !views.has(s)) this.movable.add(s);
        if (!this.m.pinned.has(this.f)) {
            this.f.params.forEach((l, i) => {
                if (this.f.modes[i] === "read" && !l.shared && !captured.has(l.sym)) {
                    this.movable.add(l.sym);
                    this.paramIndex.set(l.sym, i);
                }
            });
        }
        for (const s of captured) this.notUnique.add(s);
        for (const s of cells) this.notUnique.add(s);
        this.live = new Set();
        this.block(this.f.body!, "transfer");
        // owned parameters from the final tags (an early loop round may tag a move that later shares)
        for (const [e, tag] of this.tags) {
            if (tag === "move" && e.k === "read" && e.place.root.k === "local" && this.paramIndex.has(e.place.root.local)) this.movedParams.add(this.paramIndex.get(e.place.root.local)!);
        }
    }

    uniqueLocals(): Sym[] {
        return [...this.declared].filter((s) => !this.notUnique.has(s));
    }

    pinned(s: Sym): boolean {
        return this.pins.some((p) => p.has(s));
    }

    // ---- the backward walk: `this.live` is the set live after the node, and becomes the set before it

    block(b: H.Block, ctx: Ctx): void {
        if (b.value) this.expr(b.value, ctx);
        for (let i = b.stmts.length - 1; i >= 0; i--) this.stmt(b.stmts[i]!);
    }

    stmt(s: H.Stmt): void {
        if (s.k === "expr") return this.expr(s.expr, "view");
        const after = new Set(this.live);
        for (const l of patternLocals(s.pattern)) after.delete(l.sym);
        let before = after;
        if (s.else) {
            this.live = new Set(this.live);
            this.block(s.else, "view");
            before = union(after, this.live);
        }
        this.live = before;
        const defs = patternLocals(s.pattern);
        for (const l of defs) if (!isFresh(s.value) || s.pattern.k !== "bind") this.notUnique.add(l.sym);
        this.expr(s.value, "transfer");
    }

    use(sym: Sym, e: H.Expr | null, whole: boolean, ctx: Ctx, ty: Ty): void {
        if (e) {
            let tag: Mechanism;
            if (isCopy(ty)) tag = "copy";
            else if (ctx === "view") tag = "view";
            else if (whole && !this.live.has(sym) && this.movable.has(sym) && !this.pinned(sym)) tag = "move";
            else tag = "share";
            if (whole || tag === "share") this.tags.set(e, tag);
            if (whole && tag === "share") this.notUnique.add(sym);
            if (ctx === "keep" && !isCopy(ty)) this.heap.add(sym);
        }
        this.live.add(sym);
    }

    place(p: H.Place, e: H.Expr | null, ctx: Ctx, ty: Ty): void {
        for (let i = p.segs.length - 1; i >= 0; i--) {
            const s = p.segs[i]!;
            if (s.k === "elem") this.expr(s.index, "view");
        }
        if (p.root.k === "local") this.use(p.root.local, e, p.segs.length === 0, ctx, ty);
        else if (p.root.k === "value") this.expr(p.root.expr, "view");
        else if (e && ctx !== "view" && !isCopy(ty)) this.tags.set(e, "share");
    }

    /** A place written (or passed to `*T`): a use of its root, with a uniqueness check. */
    written(p: H.Place, span: H.Span): void {
        const path = H_path(p);
        // what is live after the write: a loop body walked again at the fixpoint widens it
        const key = `${span.start}:${path}`;
        const live = new Set([...(this.writes.get(key)?.live ?? []), ...this.live]);
        this.writes.set(key, { span, path, root: p.root.k === "local" ? p.root.local : null, live });
        this.place(p, null, "view", T.UNKNOWN);
    }

    expr(e: H.Expr, ctx: Ctx): void {
        switch (e.k) {
            case "lit": case "char": case "fnref": case "unsupported":
                return;
            case "read":
                return this.place(e.place, e, ctx, e.ty);
            case "assign": {
                const p = e.place;
                if (p.segs.length === 0 && p.root.k === "local" && e.op === "=") {
                    this.live.delete(p.root.local);
                    if (!isFresh(e.value)) this.notUnique.add(p.root.local);
                } else if (p.segs.length === 0 && p.root.k === "local") {
                    this.live.add(p.root.local);
                } else {
                    this.written(p, e.span);
                }
                return this.expr(e.value, p.segs.length === 0 && p.root.k === "local" ? "transfer" : "keep");
            }
            case "call": {
                const callee = e.callee.k === "fn" ? this.m.funs.get(e.callee.name) ?? null : null;
                const auto = e.callee.k === "auto";
                const sum = callee ? this.m.summaries.get(callee) : undefined;
                // a lent local the result may still point into can't be proven unique
                const lent = (x: H.Expr, name: string) => {
                    if (x.k !== "read" || x.place.root.k !== "local" || x.place.segs.length > 0) return;
                    // on JS a callee with a body may also set the shared bit (a `for` loop's snapshot)
                    if (!auto && (!sum || !callee?.builtin || [...sum.returnsView].some((v) => rootOf(v) === name))) this.notUnique.add(x.place.root.local);
                };
                for (let i = e.args.length - 1; i >= 0; i--) {
                    const a = e.args[i]!;
                    if (a.mode === "write") this.written(a.place, e.span);
                    else {
                        this.expr(a.expr, auto ? "view" : this.m.argCtx(callee, i));
                        lent(a.expr, callee?.params[i]?.name ?? "");
                    }
                }
                if (e.recv) {
                    if (e.recv.mode === "write") this.written(e.recv.place, e.span);
                    else {
                        this.expr(e.recv.expr, e.callee.k === "auto" && e.callee.method === "clone" ? "transfer" : "view");
                        lent(e.recv.expr, "this");
                    }
                }
                return;
            }
            case "callvalue":
                for (let i = e.args.length - 1; i >= 0; i--) {
                    const a = e.args[i]!;
                    if (a.mode === "write") this.written(a.place, e.span);
                    else this.expr(a.expr, "transfer");
                }
                return this.expr(e.fn, "view");
            case "extern":
                for (const a of [...(e.args ?? [])].reverse()) this.expr(a, "keep");
                return;
            case "struct": case "record":
                for (const f of [...e.fields].reverse()) this.expr(f.value, ctx === "keep" ? "keep" : "transfer");
                return;
            case "variant":
                for (const x of [...e.fields].reverse()) this.expr(x, ctx === "keep" ? "keep" : "transfer");
                return;
            case "tuple":
                for (const x of [...e.elems].reverse()) this.expr(x, ctx === "keep" ? "keep" : "transfer");
                return;
            case "vec": case "array": case "set":
                for (const x of [...e.elems].reverse()) this.expr(x.k === "spread" ? x.expr : x, x.k === "spread" ? "view" : ctx === "keep" ? "keep" : "transfer");
                return;
            case "map":
                for (const en of [...e.entries].reverse()) {
                    if ("k" in en) this.expr(en.expr, "view");
                    else {
                        this.expr(en.value, "transfer");
                        this.expr(en.key, "transfer");
                    }
                }
                return;
            case "range":
                if (e.end) this.expr(e.end, "view");
                if (e.start) this.expr(e.start, "view");
                return;
            case "unary": case "truthy": case "tostr": case "cast": case "await":
                return this.expr(e.expr, "view");
            case "binary":
                this.expr(e.right, "view");
                return this.expr(e.left, "view");
            case "and": case "or": {
                const after = new Set(this.live);
                this.expr(e.right, "view");
                this.live = union(this.live, after);
                return this.expr(e.left, "view");
            }
            case "concat":
                for (const x of [...e.parts].reverse()) this.expr(x, "view");
                return;
            case "if": {
                const after = this.live;
                this.live = new Set(after);
                this.block(e.then, ctx);
                const t = this.live;
                this.live = new Set(after);
                if (e.else) this.block(e.else, ctx);
                this.live = union(t, this.live);
                return this.expr(e.cond, "view");
            }
            case "match": {
                const after = this.live;
                let all = new Set<Sym>();
                for (const arm of e.arms) {
                    this.live = new Set(after);
                    this.expr(arm.body, ctx);
                    if (arm.guard) {
                        // a failing guard falls through to the next arms: approximate with `after`
                        this.live = union(this.live, after);
                        this.expr(arm.guard, "view");
                    }
                    for (const l of patternLocals(arm.pattern)) this.live.delete(l.sym);
                    all = union(all, this.live);
                }
                this.live = all;
                return this.expr(e.subject, "view");
            }
            case "block":
                return this.block(e.block, ctx);
            case "loop":
                return this.loop(e.label, this.live, (head) => {
                    this.live = new Set(head);
                    this.block(e.body, "view");
                });
            case "foreach": {
                const after = this.live;
                const items = [...patternLocals(e.item), ...(e.second ? patternLocals(e.second) : [])];
                this.loop(e.label, after, (head) => {
                    this.live = new Set(head);
                    this.block(e.body, "view");
                    for (const l of items) this.live.delete(l.sym);
                    this.live = union(this.live, after);
                });
                // the loop iterates a snapshot (a share)
                if (e.iterable.k === "read" && e.iterable.place.root.k === "local") this.notUnique.add(e.iterable.place.root.local);
                return this.expr(e.iterable, "view");
            }
            case "break": {
                const t = this.target(e.label);
                this.live = new Set(t?.after ?? []);
                if (e.value) this.expr(e.value, "transfer");
                return;
            }
            case "continue":
                this.live = new Set(this.target(e.label)?.head ?? []);
                return;
            case "return":
                this.live = new Set();
                if (e.value) this.expr(e.value, "transfer");
                return;
            case "closure": {
                const escapes = ctx === "keep";
                for (const c of e.captures) {
                    if (escapes) this.heap.add(c.sym);
                    this.live.add(c.sym);
                }
                // its body: captured locals stay live throughout, its parameters are never moved
                const saved = this.live;
                const savedLoops = this.loops;
                this.loops = [];
                this.pins.push(new Set(e.captures.map((c) => c.sym)));
                this.live = new Set();
                this.block(e.body, "transfer");
                this.pins.pop();
                this.loops = savedLoops;
                this.live = saved;
                return;
            }
            case "select": {
                const after = this.live;
                let all = e.else ? (this.live = new Set(after), this.expr(e.else, ctx), this.live) : new Set<Sym>();
                for (const a of e.arms) {
                    this.live = new Set(after);
                    this.expr(a.body, ctx);
                    for (const l of patternLocals(a.pattern)) this.live.delete(l.sym);
                    all = union(all, this.live);
                }
                this.live = all;
                for (const a of [...e.arms].reverse()) this.expr(a.wait, "view");
                return;
            }
            case "recover": {
                // a panic leaves the body from any point: what is live after it can't move inside
                const after = this.live;
                this.pins.push(new Set(after));
                this.live = new Set(after);
                this.block(e.body, "transfer");
                this.pins.pop();
                this.live = union(this.live, after);
                return;
            }
            case "lock":
                this.block(e.body, ctx);
                for (const p of [...e.places].reverse()) this.place(p, null, "view", T.UNKNOWN);
                return;
        }
    }

    target(label: string | null): LoopTarget | undefined {
        if (label === null) return this.loops[this.loops.length - 1];
        for (let i = this.loops.length - 1; i >= 0; i--) if (this.loops[i]!.label === label) return this.loops[i];
        return undefined;
    }

    /** A loop to its fixpoint: `body(head)` walks the body from `head` (live at the loop's start). */
    loop(label: string | null, after: Set<Sym>, body: (head: Set<Sym>) => void): void {
        let head = new Set<Sym>();
        for (let round = 0; round < 64; round++) {
            const t: LoopTarget = { label, after: new Set(after), head };
            this.loops.push(t);
            body(head);
            this.loops.pop();
            const next = union(head, this.live);
            if (next.size === head.size) {
                this.live = next;
                return;
            }
            head = next;
        }
        this.live = head;
    }
}

// ---- helpers -------------------------------------------------------------------------------------

function union<T>(a: Set<T>, b: Set<T>): Set<T> {
    const out = new Set(a);
    for (const x of b) out.add(x);
    return out;
}

/** A fresh value: a literal of a collection, struct, record, tuple or variant. */
function isFresh(e: H.Expr): boolean {
    return e.k === "struct" || e.k === "vec" || e.k === "array" || e.k === "set" || e.k === "map" || e.k === "record" || e.k === "tuple" || e.k === "variant" || e.k === "lit";
}

function H_path(p: H.Place): string {
    let out = p.root.k === "value" ? "<value>" : p.root.name;
    for (const s of p.segs) out += s.k === "field" ? `.${s.name}` : s.k === "tuple" ? `.${s.index}` : s.key !== null ? `[${s.key}]` : "[*]";
    return out;
}

export function patternLocals(p: H.Pattern): H.Local[] {
    switch (p.k) {
        case "bind": return [p.local];
        case "ok": return patternLocals(p.value);
        case "fail": return patternLocals(p.payload);
        case "variant": return p.fields.flatMap(patternLocals);
        case "fields": return p.fields.flatMap((f) => patternLocals(f.pattern));
        case "tuple": return p.elems.flatMap(patternLocals);
        case "or": return p.alts.flatMap(patternLocals);
        default: return [];
    }
}

function visitBlock(b: H.Block, f: (e: H.Expr) => void): void {
    for (const s of b.stmts) {
        if (s.k === "let") {
            f(s.value);
            if (s.else) visitBlock(s.else, f);
        } else f(s.expr);
    }
    if (b.value) f(b.value);
}

function blocksIn(e: H.Expr): H.Block[] {
    switch (e.k) {
        case "if": return [e.then, ...(e.else ? [e.else] : [])];
        case "loop": case "foreach": return [e.body];
        case "block": return [e.block];
        case "recover": case "lock": return [e.body];
        default: return [];
    }
}

/** Direct sub-expressions, including those in nested blocks; into closure bodies when `closures`. */
function eachChild(e: H.Expr, f: (e: H.Expr) => void, closures: boolean): void {
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
        case "assign": place(e.place); return f(e.value);
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

// ---- `ms mech` ---------------------------------------------------------------------------------

/**
 * One function's mechanisms, for `ms mech` and the golden tests: its owned parameters, then each
 * handed-over or lent read of a whole local (`line:col name mechanism`), each read with a path that
 * is shared, each write (`checked` when it tests its root's uniqueness first, `unique` when the root is proven
 * unique),
 * and the heap-promoted locals. `line` maps an offset to `line:col`.
 */
export function showMechanisms(f: H.Fun, r: MechanismResult, line: (offset: number) => string): string[] {
    const out: string[] = [];
    const own = [...(r.owned.get(f) ?? [])].map((i) => f.params[i]!.name);
    out.push(`${f.name}${own.length ? `  owned [${own.join(", ")}]` : ""}`);
    const rows: [number, string][] = [];
    const heap = new Set<string>();
    const visit = (e: H.Expr) => {
        if (e.k === "read") {
            const tag = r.tags.get(e);
            if (tag && tag !== "copy" && e.place.root.k !== "value") {
                rows.push([e.span.start, `${line(e.span.start)}  ${H_path(e.place)}  ${tag}`]);
            }
            if (e.place.root.k === "local" && r.heap.has(e.place.root.local)) heap.add(e.place.root.name);
        }
        eachChild(e, visit, true);
    };
    if (f.body) visitBlock(f.body, visit);
    for (const w of r.writes.get(f) ?? []) rows.push([w.span.start, `${line(w.span.start)}  write ${w.path}  ${w.checked ? "checked" : "unique"}`]);
    rows.sort((a, b) => a[0] - b[0]);
    for (const [, s] of rows) out.push(`  ${s}`);
    if (heap.size) out.push(`  heap [${[...heap].sort().join(", ")}]`);
    return out;
}
