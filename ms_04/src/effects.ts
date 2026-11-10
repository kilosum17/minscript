// Effect summaries (spec §9.5, pass 6 of §15.1). For every function: which paths of its parameters
// it reads, writes, keeps (stores beyond the call), consumes (a Unique parameter moved or mutated),
// returns views of, which function parameters it invokes and with what, and whether it suspends.
//
// Functions are summarised bottom-up over the call graph, one strongly connected component at a
// time, so callees are summarised before their callers. Inside a recursive component a worklist
// re-evaluates a member when a callee's summary grew; summaries only grow and paths have at most
// 4 segments, so this terminates. A member re-evaluated more than `cap` times widens the paths it
// is still adding to their first segment and reports L_SUMMARY_WIDENED.
//
// Locals that alias a parameter (`x := p.items`, a `for` item, a pattern binding, a write view
// returned by `-> *T`) carry their source paths, so effects through them land on the parameter.
// Copies don't propagate writes: `var c = base; c.tags.push(t)` writes a copy, not `base` (§9.1).

import { diag, type Diagnostic } from "./diagnostic.ts";
import type * as H from "./hir.ts";
import { PATH_DEPTH } from "./hir.ts";
import type { Sym } from "./resolve.ts";
import * as T from "./types.ts";
import type { Ty } from "./types.ts";

export interface Summary {
    reads: Set<string>;
    writes: Set<string>;
    keeps: Set<string>;
    consumes: Set<string>;
    returnsView: Set<string>;
    /** function parameters it calls, with the paths it passes: `f(this.stock.items[*])` */
    invokes: Set<string>;
    awaits: boolean;
}

export interface EffectsResult {
    summaries: Map<H.Fun, Summary>;
    diagnostics: Diagnostic[];
    /** the largest number of times one function was evaluated (1 without recursion) */
    maxEvaluations: number;
}

export interface EffectsOptions {
    /** evaluations of one member of a recursive component before its growing paths widen (§15.1) */
    cap?: number;
}

const empty = (): Summary => ({
    reads: new Set(), writes: new Set(), keeps: new Set(), consumes: new Set(), returnsView: new Set(), invokes: new Set(), awaits: false,
});

const SETS = ["reads", "writes", "keeps", "consumes", "returnsView", "invokes"] as const;

export function computeEffects(p: H.Program, opts: EffectsOptions = {}): EffectsResult {
    return new Effects(p, opts.cap ?? 32).run();
}

// ---- paths -------------------------------------------------------------------------------------

const splitCache = new Map<string, string[]>();

/** `this.items[*].name` → ["this", ".items", "[*]", ".name"] */
function split(path: string): string[] {
    let m = splitCache.get(path);
    if (!m) {
        m = path.match(/^[^.[]+|\.[^.[]+|\[[^\]]*\]/g) ?? [path];
        splitCache.set(path, m);
    }
    return m;
}

function extend(path: string, segs: string[], depth: number): string {
    const parts = split(path);
    const all = [...parts, ...segs];
    return all.slice(0, 1 + Math.min(depth, all.length - 1)).join("");
}

function truncate(path: string, depth: number): string {
    return extend(path, [], depth);
}

/** `a` covers `b`: a prefix of it, `[*]` matching any element. */
function covers(a: string, b: string): boolean {
    const x = split(a);
    const y = split(b);
    if (x.length > y.length || x[0] !== y[0]) return false;
    for (let i = 1; i < x.length; i++) {
        if (x[i] === y[i]) continue;
        if (x[i] === "[*]" && y[i]!.startsWith("[")) continue;
        return false;
    }
    return true;
}

/** Drops the paths another path of the set already covers. */
function normalize(set: Set<string>): Set<string> {
    if (set.size < 2) return set;
    // group by root: only paths with the same root can cover each other
    const byRoot = new Map<string, string[]>();
    for (const p of set) {
        const r = split(p)[0]!;
        const list = byRoot.get(r);
        if (list) list.push(p);
        else byRoot.set(r, [p]);
    }
    const out = new Set<string>();
    for (const xs of byRoot.values()) {
        xs.sort((a, b) => split(a).length - split(b).length);
        const kept: string[] = [];
        for (const b of xs) if (!kept.some((a) => covers(a, b))) kept.push(b);
        for (const k of kept) out.add(k);
    }
    return out;
}

function segOf(s: H.Seg): string {
    if (s.k === "field") return "." + s.name;
    if (s.k === "tuple") return "." + s.index;
    return s.key !== null ? `[${s.key}]` : "[*]";
}

const isCopy = (t: Ty): boolean => {
    const p = T.prune(t);
    return (p.k === "prim" && p.name !== "str") || (p.k === "lit" && typeof p.value !== "string") || p.k === "never";
};

// ---- sources -----------------------------------------------------------------------------------

/** What a value derives from: views of parameter paths, shares it holds, a write view. */
interface Src {
    views: Set<string>;
    holds: Set<string>;
    write: boolean;
}

const none = (): Src => ({ views: new Set(), holds: new Set(), write: false });

function merge(into: Src, from: Src): boolean {
    let changed = false;
    for (const v of from.views) if (!into.views.has(v)) (into.views.add(v), (changed = true));
    for (const v of from.holds) if (!into.holds.has(v)) (into.holds.add(v), (changed = true));
    if (from.write && !into.write) (into.write = true), (changed = true);
    return changed;
}

const all = (s: Src): Set<string> => new Set([...s.views, ...s.holds]);

// ---- the pass ----------------------------------------------------------------------------------

interface CallSite {
    callee: H.Fun;
    /** callee parameter name (or "this") → caller paths it is bound to */
    bases: Map<string, Set<string>>;
    /** the same, for writes: only places a write reaches (a `*` argument through a copy writes the copy) */
    writeBases: Map<string, Set<string>>;
    /** an async call whose promise isn't awaited where it is made: the task keeps its arguments */
    detached: boolean;
    /** every place the callee may write is one of these locals: what it keeps stays in them */
    intoLocals: Sym[] | null;
    /** callee parameter → the caller's own parameter passed to it directly (for `invokes`) */
    forwarded: Map<string, string>;
}

class Effects {
    readonly p: H.Program;
    readonly cap: number;
    readonly byName = new Map<string, H.Fun>();
    readonly summaries = new Map<H.Fun, Summary>();
    readonly diagnostics: Diagnostic[] = [];
    maxEvaluations = 0;

    constructor(p: H.Program, cap: number) {
        this.p = p;
        this.cap = cap;
        for (const f of p.funs) this.byName.set(f.name, f);
    }

    run(): EffectsResult {
        for (const scc of this.sccs()) this.component(scc);
        return { summaries: this.summaries, diagnostics: this.diagnostics, maxEvaluations: this.maxEvaluations };
    }

    /** Tarjan's algorithm: components come out callees first. */
    sccs(): H.Fun[][] {
        const edges = new Map<H.Fun, H.Fun[]>();
        for (const f of this.p.funs) {
            const out: H.Fun[] = [];
            if (f.body) visitBlock(f.body, (e) => {
                if (e.k === "call" && e.callee.k === "fn") {
                    const g = this.byName.get(e.callee.name);
                    if (g) out.push(g);
                }
            });
            edges.set(f, out);
        }
        let index = 0;
        const idx = new Map<H.Fun, number>();
        const low = new Map<H.Fun, number>();
        const onStack = new Set<H.Fun>();
        const stack: H.Fun[] = [];
        const result: H.Fun[][] = [];
        const strong = (v: H.Fun) => {
            idx.set(v, index);
            low.set(v, index);
            index++;
            stack.push(v);
            onStack.add(v);
            for (const w of edges.get(v) ?? []) {
                if (!idx.has(w)) {
                    strong(w);
                    low.set(v, Math.min(low.get(v)!, low.get(w)!));
                } else if (onStack.has(w)) {
                    low.set(v, Math.min(low.get(v)!, idx.get(w)!));
                }
            }
            if (low.get(v) === idx.get(v)) {
                const scc: H.Fun[] = [];
                let w: H.Fun;
                do {
                    w = stack.pop()!;
                    onStack.delete(w);
                    scc.push(w);
                } while (w !== v);
                result.push(scc);
            }
        };
        for (const f of this.p.funs) if (!idx.has(f)) strong(f);
        return result;
    }

    component(scc: H.Fun[]): void {
        const members = new Set(scc);
        for (const f of scc) this.summaries.set(f, empty());
        const recursive = scc.length > 1 || scc.some((f) => this.callsSelf(f));
        if (!recursive) {
            this.summaries.set(scc[0]!, this.evaluate(scc[0]!, PATH_DEPTH));
            this.maxEvaluations = Math.max(this.maxEvaluations, 1);
            return;
        }
        // the worklist: a member is re-evaluated when a callee in the component grew
        const callers = new Map<H.Fun, Set<H.Fun>>();
        for (const f of scc) {
            if (!f.body) continue;
            visitBlock(f.body, (e) => {
                if (e.k !== "call" || e.callee.k !== "fn") return;
                const g = this.byName.get(e.callee.name);
                if (g && members.has(g)) callers.set(g, (callers.get(g) ?? new Set()).add(f));
            });
        }
        const evaluations = new Map<H.Fun, number>();
        const queue = [...scc];
        const queued = new Set(scc);
        let widened = false;
        while (queue.length > 0) {
            const f = queue.shift()!;
            queued.delete(f);
            const n = (evaluations.get(f) ?? 0) + 1;
            evaluations.set(f, n);
            this.maxEvaluations = Math.max(this.maxEvaluations, n);
            const old = this.summaries.get(f)!;
            if (n > this.cap && !widened) {
                widened = true;
                this.diagnostics.push({
                    ...diag("L_SUMMARY_WIDENED", `the recursive functions ${scc.map((x) => x.name).join(", ")} didn't converge in ${this.cap} rounds: paths still growing were widened`, f.span.start, f.span.end),
                    file: f.file,
                });
            }
            const next = this.evaluate(f, PATH_DEPTH);
            const merged = this.mergeSummary(old, next, widened ? 1 : PATH_DEPTH);
            if (this.grew(old, merged)) {
                this.summaries.set(f, merged);
                for (const c of callers.get(f) ?? []) if (!queued.has(c)) (queue.push(c), queued.add(c));
            }
        }
    }

    callsSelf(f: H.Fun): boolean {
        let found = false;
        if (f.body) visitBlock(f.body, (e) => {
            if (e.k === "call" && e.callee.k === "fn" && e.callee.name === f.name) found = true;
        });
        return found;
    }

    /** old ∪ new; paths new in this round are truncated to `depth` segments (widening). */
    mergeSummary(old: Summary, next: Summary, depth: number): Summary {
        const out = empty();
        out.awaits = old.awaits || next.awaits;
        for (const k of SETS) {
            for (const v of old[k]) out[k].add(v);
            for (const v of next[k]) if (!old[k].has(v)) out[k].add(k === "invokes" ? v : truncate(v, depth));
            out[k] = normalize(out[k]);
        }
        return out;
    }

    grew(a: Summary, b: Summary): boolean {
        if (a.awaits !== b.awaits) return true;
        return SETS.some((k) => b[k].size !== a[k].size || [...b[k]].some((v) => !a[k].has(v)));
    }

    // ---- one function -------------------------------------------------------------------------

    evaluate(f: H.Fun, depth: number): Summary {
        if (!f.body) return this.declared(f);
        return new FunctionEffects(this, f, depth).run();
    }

    /** A function without a body: what its modes and `#[effects]` attribute say (§9.5). */
    declared(f: H.Fun): Summary {
        const s = empty();
        const params: [string, "read" | "write", H.Local][] = f.params.map((l, i) => [l.name, f.modes[i]!, l]);
        if (f.self) params.unshift(["this", f.selfMode ?? "read", f.self]);
        for (const [name, mode, l] of params) {
            s.reads.add(name);
            if (mode === "write") s.writes.add(name);
            // an extern without the attribute keeps every non-Copy argument (§9.5)
            if (f.extern !== null && !f.effectsAttr && !isCopy(l.ty)) s.keeps.add(name);
        }
        for (const k of f.effectsAttr?.keeps ?? []) s.keeps.add(k);
        for (const k of f.effectsAttr?.consumes ?? []) s.consumes.add(k);
        for (const k of f.effectsAttr?.returnsView ?? []) s.returnsView.add(k);
        s.awaits = f.async;
        return s;
    }

    summary(f: H.Fun): Summary {
        return this.summaries.get(f) ?? empty();
    }
}

/** The effects of one function body, with the current summaries of its callees. */
class FunctionEffects {
    readonly e: Effects;
    readonly f: H.Fun;
    readonly depth: number;
    readonly params = new Map<Sym, { name: string; write: boolean; unique: boolean }>();
    readonly aliases = new Map<Sym, Src>();
    readonly out = empty();
    readonly calls: CallSite[] = [];
    readonly result = none();

    constructor(e: Effects, f: H.Fun, depth: number) {
        this.e = e;
        this.f = f;
        this.depth = depth;
        f.params.forEach((l, i) => this.params.set(l.sym, { name: l.name, write: f.modes[i] === "write", unique: !!l.unique }));
        if (f.self) this.params.set(f.self.sym, { name: "this", write: f.selfMode === "write", unique: !!f.self.unique });
    }

    run(): Summary {
        const body = this.f.body!;
        // aliases are flow-insensitive: iterate the bindings until their sources settle
        for (let i = 0; i < 6 && this.bindings(body); i++);
        this.calls.length = 0;
        this.block(body);
        if (body.value) merge(this.result, this.src(body.value));
        // substitute the callees' summaries
        for (const c of this.calls) this.substitute(c);
        // the result is a view of, or holds shares of, these paths: the caller decides whether it keeps it
        for (const v of all(this.result)) this.out.returnsView.add(v);
        // a Unique parameter moved or mutated is consumed (§9.2)
        for (const { name, unique } of this.params.values()) {
            if (!unique) continue;
            const touched = [...this.out.keeps, ...this.out.writes].some((x) => split(x)[0] === name);
            if (touched) this.out.consumes.add(name);
        }
        this.out.awaits ||= this.f.async && this.suspends(body);
        for (const k of SETS) this.out[k] = normalize(new Set([...this.out[k]].map((v) => (k === "invokes" ? v : truncate(v, this.depth)))));
        return this.out;
    }

    suspends(b: H.Block): boolean {
        let found = false;
        visitBlock(b, (x) => {
            if (x.k === "await" || x.k === "select" || (x.k === "foreach" && x.of === "async")) found = true;
        });
        return found;
    }

    // ---- aliases ------------------------------------------------------------------------------

    /** One pass over the bindings; true if some local's sources grew. */
    bindings(b: H.Block): boolean {
        let changed = false;
        const bind = (p: H.Pattern, s: Src) => {
            switch (p.k) {
                case "bind": {
                    if (this.params.has(p.local.sym)) return;
                    const cur = this.aliases.get(p.local.sym) ?? none();
                    if (merge(cur, s)) changed = true;
                    this.aliases.set(p.local.sym, cur);
                    return;
                }
                case "variant": p.fields.forEach((x) => bind(x, s)); return;
                case "ok": return bind(p.value, s);
                case "fail": return bind(p.payload, s);
                case "fields": p.fields.forEach((x) => bind(x.pattern, s)); return;
                case "tuple": p.elems.forEach((x) => bind(x, s)); return;
                case "or": p.alts.forEach((x) => bind(x, s)); return;
                default: return;
            }
        };
        const elem = (s: Src): Src => ({ views: new Set([...s.views].map((v) => extend(v, ["[*]"], PATH_DEPTH))), holds: s.holds, write: false });
        visitBlock(b, (x) => {
            if (x.k === "match") for (const a of x.arms) bind(a.pattern, this.src(x.subject));
            if (x.k === "foreach") {
                const s = this.src(x.iterable);
                bind(x.item, elem(s));
                if (x.second) bind(x.second, x.of === "map" ? elem(s) : none());
            }
            if (x.k === "select") for (const a of x.arms) bind(a.pattern, this.src(a.wait));
            if (x.k === "assign" && x.place.root.k === "local" && !this.params.has(x.place.root.local)) {
                // `x = v` rebinds; `x.f = v` stores into the local: either way `x` now holds `v`'s sources
                const cur = this.aliases.get(x.place.root.local) ?? none();
                const s = this.src(x.value);
                if (merge(cur, x.place.segs.length === 0 ? s : { views: new Set(), holds: all(s), write: false })) changed = true;
                this.aliases.set(x.place.root.local, cur);
            }
            if (x.k === "call" && x.callee.k === "fn") {
                // `out.push(v)` with a local `out`: the callee keeps `v` in the local, not beyond the call
                const callee = this.e.byName.get(x.callee.name);
                if (!callee) return;
                const site = this.site(callee, x);
                if (!site.intoLocals) return;
                const kept = this.subst(this.e.summary(callee).keeps, site.bases);
                for (const l of site.intoLocals) {
                    const cur = this.aliases.get(l) ?? none();
                    if (merge(cur, { views: new Set(), holds: kept, write: false })) changed = true;
                    this.aliases.set(l, cur);
                }
            }
        }, (s) => {
            if (s.k === "let") bind(s.pattern, this.src(s.value));
        });
        return changed;
    }

    /** What a place is a view of, and whether a write to it reaches a parameter. */
    placeSrc(p: H.Place): Src & { writable: boolean } {
        let base: Src;
        let writable = false;
        if (p.root.k === "local") {
            const param = this.params.get(p.root.local);
            if (param) {
                base = { views: new Set([param.name]), holds: new Set(), write: param.write };
                writable = param.write;
            } else {
                const a = this.aliases.get(p.root.local) ?? none();
                base = { views: new Set(a.views), holds: new Set(a.holds), write: a.write };
                writable = a.write;
            }
        } else if (p.root.k === "value") {
            base = this.src(p.root.expr);
            writable = base.write;
        } else {
            base = none();
        }
        for (const s of p.segs) {
            base.views = new Set([...base.views].map((v) => extend(v, [segOf(s)], PATH_DEPTH)));
            // shared and once fields do their own synchronisation: writable through a read view
            if (s.k === "field" && s.mode !== null && base.views.size > 0) writable = true;
        }
        return { ...base, writable };
    }

    /** The sources of a value (§9.6): what it is a view of, and what it holds shares of. */
    src(e: H.Expr): Src {
        // a Copy value is a bit copy, unless it is a write view (`-> *int`), which points into its source
        const writeView = e.k === "call" && e.callee.k === "fn" && this.e.byName.get(e.callee.name)?.retMode === "write";
        if (isCopy(e.ty) && !writeView) return none();
        switch (e.k) {
            case "read": {
                const s = this.placeSrc(e.place);
                return { views: s.views, holds: s.holds, write: false };
            }
            case "call": {
                const callee = e.callee.k === "fn" ? this.e.byName.get(e.callee.name) : undefined;
                if (callee) {
                    const site = this.site(callee, e);
                    const sum = this.e.summary(callee);
                    return { views: this.subst(sum.returnsView, site.bases), holds: new Set(), write: callee.retMode === "write" };
                }
                return this.opaque([...(e.recv ? [e.recv] : []), ...e.args]);
            }
            case "callvalue":
                return this.opaque(e.args);
            case "extern":
                return this.opaque((e.args ?? []).map((x) => ({ mode: "read" as const, expr: x })));
            case "struct": case "record":
                return this.holding(e.fields.map((x) => x.value));
            case "variant":
                return this.holding(e.fields);
            case "tuple":
                return this.holding(e.elems);
            case "vec": case "array": case "set":
                return this.holding(e.elems.map((x) => (x.k === "spread" ? x.expr : x)));
            case "map":
                return this.holding(e.entries.flatMap((en) => ("k" in en ? [en.expr] : [en.key, en.value])));
            case "closure": {
                const s = none();
                for (const c of e.captures) {
                    const param = this.params.get(c.sym);
                    if (param) s.holds.add(param.name);
                    else for (const v of all(this.aliases.get(c.sym) ?? none())) s.holds.add(v);
                }
                return s;
            }
            case "match": {
                const s = none();
                for (const a of e.arms) merge(s, this.src(a.body));
                return s;
            }
            case "if": {
                const s = none();
                if (e.then.value) merge(s, this.src(e.then.value));
                if (e.else?.value) merge(s, this.src(e.else.value));
                return s;
            }
            case "block":
                return e.block.value ? this.src(e.block.value) : none();
            case "recover":
                return e.body.value ? this.src(e.body.value) : none();
            case "await":
                return this.src(e.expr);
            default:
                return none();
        }
    }

    /** A composite value holds shares of what its parts are (§9.6). */
    holding(parts: H.Expr[]): Src {
        const s = none();
        for (const p of parts) for (const v of all(this.src(p))) s.holds.add(v);
        return s;
    }

    /** A call the summaries can't see into: its result may be a view of any argument. */
    opaque(args: H.Arg[]): Src {
        const s = none();
        for (const a of args) {
            const src = a.mode === "read" ? this.src(a.expr) : this.placeSrc(a.place);
            for (const v of all(src)) (s.views.add(v), s.holds.add(v));
        }
        return s;
    }

    /** The caller paths each callee parameter is bound to at a call. */
    site(callee: H.Fun, e: H.Expr & { k: "call" }): CallSite {
        const bases = new Map<string, Set<string>>();
        const writeBases = new Map<string, Set<string>>();
        const add = (name: string, a: H.Arg) => {
            if (a.mode === "write") {
                const s = this.placeSrc(a.place);
                bases.set(name, all(s));
                writeBases.set(name, s.writable ? new Set(s.views) : new Set());
            } else {
                // a read argument: only writes to its `shared` / `once` fields can reach the caller
                const s = all(this.src(a.expr));
                bases.set(name, s);
                writeBases.set(name, s);
            }
        };
        if (e.recv && callee.self) add("this", e.recv);
        e.args.forEach((a, i) => {
            const p = callee.params[i];
            if (p) add(p.name, a);
        });
        const targets = [...(e.recv ? [e.recv] : []), ...e.args].filter((a): a is H.Arg & { mode: "write" } => a.mode === "write");
        const locals = targets.map((a) => (a.place.root.k === "local" && !this.params.has(a.place.root.local) && !this.aliases.get(a.place.root.local)?.write ? a.place.root.local : null));
        const intoLocals = targets.length > 0 && locals.every((l) => l !== null) ? (locals as Sym[]) : null;
        const forwarded = new Map<string, string>();
        e.args.forEach((a, i) => {
            const p = callee.params[i];
            if (!p || a.mode !== "read" || a.expr.k !== "read" || a.expr.place.root.k !== "local" || a.expr.place.segs.length > 0) return;
            const own = this.params.get(a.expr.place.root.local);
            if (own) forwarded.set(p.name, own.name);
        });
        return { callee, bases, writeBases, detached: false, intoLocals, forwarded };
    }

    subst(paths: Set<string>, bases: Map<string, Set<string>>): Set<string> {
        const out = new Set<string>();
        for (const p of paths) {
            const [root, ...rest] = split(p);
            for (const b of bases.get(root!) ?? []) out.add(extend(b, rest, PATH_DEPTH));
        }
        return out;
    }

    substitute(c: CallSite): void {
        const s = this.e.summary(c.callee);
        for (const v of this.subst(s.reads, c.bases)) this.out.reads.add(v);
        if (!c.intoLocals) for (const v of this.subst(s.keeps, c.bases)) this.out.keeps.add(v);
        for (const k of ["writes", "consumes"] as const) for (const v of this.subst(s[k], c.writeBases)) this.out[k].add(v);
        for (const inv of s.invokes) {
            const m = /^([^(]+)\((.*)\)$/.exec(inv);
            if (!m) continue;
            // only a function parameter of ours, passed straight through, is invoked on our behalf;
            // a closure literal argument is analysed in place (§9.5)
            const target = c.forwarded.get(m[1]!);
            if (!target) continue;
            const args = m[2] ? m[2].split(", ").map((a) => {
                const star = a.startsWith("*") ? "*" : "";
                return star + ([...this.subst(new Set([a.replace(/^\*/, "")]), c.bases)].join(" | ") || "_");
            }) : [];
            this.out.invokes.add(`${target}(${args.join(", ")})`);
        }
        if (c.detached) for (const b of c.bases.values()) for (const v of b) this.out.keeps.add(v);
    }

    // ---- the walk -----------------------------------------------------------------------------

    block(b: H.Block): void {
        for (const s of b.stmts) {
            if (s.k === "let") {
                this.expr(s.value, false);
                if (s.else) this.block(s.else);
            } else this.expr(s.expr, false);
        }
        if (b.value) this.expr(b.value, false);
    }

    readPlace(p: H.Place): void {
        const s = this.placeSrc(p);
        for (const v of all(s)) this.out.reads.add(v);
        this.placeParts(p);
    }

    placeParts(p: H.Place): void {
        if (p.root.k === "value") this.expr(p.root.expr, false);
        for (const s of p.segs) if (s.k === "elem") this.expr(s.index, false);
    }

    writePlace(p: H.Place): void {
        const s = this.placeSrc(p);
        if (s.writable) for (const v of s.views) this.out.writes.add(v);
    }

    /** `awaited`: the expression is the operand of `await` (or a `select` arm). */
    expr(e: H.Expr, awaited: boolean): void {
        switch (e.k) {
            case "read":
                return this.readPlace(e.place);
            case "assign": {
                this.writePlace(e.place);
                // assigning a write view (`n := inv.at_mut(k); n = 5`) writes what it points into
                if (e.place.root.k === "local" && e.place.segs.length === 0) {
                    const a = this.aliases.get(e.place.root.local);
                    if (a?.write) for (const v of a.views) this.out.writes.add(v);
                }
                if (e.op !== "=") this.readPlace(e.place);
                else this.placeParts(e.place);
                this.expr(e.value, false);
                // storing a value anywhere but a plain local keeps what it holds (§9.6)
                const own = e.place.root.k === "local" && !this.params.has(e.place.root.local) && !this.aliases.get(e.place.root.local)?.write;
                if (!own) for (const v of all(this.src(e.value))) this.out.keeps.add(v);
                return;
            }
            case "call": {
                const args = [...(e.recv ? [e.recv] : []), ...e.args];
                for (const a of args) this.arg(a);
                const callee = e.callee.k === "fn" ? this.e.byName.get(e.callee.name) : undefined;
                if (callee) {
                    const site = this.site(callee, e);
                    site.detached = e.async && !awaited;
                    this.calls.push(site);
                    return;
                }
                // through an interface, a bound or a generated method: whole parameters (§9.5)
                for (const a of args) {
                    if (a.mode === "write") for (const v of this.placeSrc(a.place).views) this.out.writes.add(v);
                }
                if (e.callee.k === "dyn") for (const a of e.args) if (a.mode === "read" && !isCopy(a.expr.ty)) for (const v of all(this.src(a.expr))) this.out.keeps.add(v);
                return;
            }
            case "callvalue": {
                for (const a of e.args) this.arg(a);
                this.expr(e.fn, false);
                for (const a of e.args) if (a.mode === "write") for (const v of this.placeSrc(a.place).views) this.out.writes.add(v);
                // calling a function parameter: the caller's closure literal is analysed in place
                if (e.fn.k === "read" && e.fn.place.root.k === "local" && e.fn.place.segs.length === 0) {
                    const param = this.params.get(e.fn.place.root.local);
                    if (param) {
                        const args = e.args.map((a) => {
                            const s = a.mode === "write" ? this.placeSrc(a.place) : this.src(a.expr);
                            const paths = [...all(s)].map((v) => truncate(v, this.depth));
                            return (a.mode === "write" ? "*" : "") + (paths.join(" | ") || "_");
                        });
                        this.out.invokes.add(`${param.name}(${args.join(", ")})`);
                    }
                }
                return;
            }
            case "extern":
                for (const a of e.args ?? []) {
                    this.expr(a, false);
                    if (!isCopy(a.ty)) for (const v of all(this.src(a))) this.out.keeps.add(v);
                }
                return;
            case "await":
                return this.expr(e.expr, true);
            case "select":
                for (const a of e.arms) {
                    this.expr(a.wait, true);
                    this.expr(a.body, false);
                }
                if (e.else) this.expr(e.else, false);
                return;
            case "foreach": {
                this.expr(e.iterable, false);
                if (e.of === "async" && e.iterable.k === "read") {
                    // `for await x in sub` advances the subscription: a write (§5.3)
                    for (const v of this.placeSrc(e.iterable.place).views) this.out.writes.add(v);
                }
                return this.block(e.body);
            }
            case "return":
                if (e.value) {
                    this.expr(e.value, false);
                    merge(this.result, this.src(e.value));
                }
                return;
            case "lock":
                for (const p of e.places) this.readPlace(p);
                return this.block(e.body);
            default:
                return this.children(e);
        }
    }

    arg(a: H.Arg): void {
        if (a.mode === "read") this.expr(a.expr, false);
        else this.placeParts(a.place);
    }

    children(e: H.Expr): void {
        const sub = (x: H.Expr | H.Spread | null) => {
            if (x) this.expr(x.k === "spread" ? x.expr : x, false);
        };
        switch (e.k) {
            case "struct": case "record": e.fields.forEach((x) => sub(x.value)); return;
            case "variant": e.fields.forEach(sub); return;
            case "tuple": e.elems.forEach(sub); return;
            case "vec": case "array": case "set": e.elems.forEach(sub); return;
            case "map": e.entries.forEach((en) => ("k" in en ? sub(en) : (sub(en.key), sub(en.value)))); return;
            case "range": sub(e.start); sub(e.end); return;
            case "unary": case "tostr": case "cast": case "truthy": return sub(e.expr);
            case "binary": case "and": case "or": sub(e.left); sub(e.right); return;
            case "concat": e.parts.forEach(sub); return;
            case "if": sub(e.cond); this.block(e.then); if (e.else) this.block(e.else); return;
            case "match": sub(e.subject); e.arms.forEach((a) => (sub(a.guard), sub(a.body))); return;
            case "loop": return this.block(e.body);
            case "break": return sub(e.value);
            case "block": return this.block(e.block);
            case "closure": return this.block(e.body);
            case "recover": return this.block(e.body);
            default: return;
        }
    }
}

/** Visits every expression (and every statement, with `stmt`) of a block. */
function visitBlock(b: H.Block, f: (e: H.Expr) => void, stmt?: (s: H.Stmt) => void): void {
    for (const s of b.stmts) {
        stmt?.(s);
        if (s.k === "let") {
            visitExpr(s.value, f, stmt);
            if (s.else) visitBlock(s.else, f, stmt);
        } else visitExpr(s.expr, f, stmt);
    }
    if (b.value) visitExpr(b.value, f, stmt);
}

function visitExpr(e: H.Expr, f: (e: H.Expr) => void, stmt?: (s: H.Stmt) => void): void {
    f(e);
    const sub = (x: H.Expr | H.Spread | null) => {
        if (x) visitExpr(x.k === "spread" ? x.expr : x, f, stmt);
    };
    const place = (p: H.Place) => {
        if (p.root.k === "value") sub(p.root.expr);
        for (const s of p.segs) if (s.k === "elem") sub(s.index);
    };
    const arg = (a: H.Arg) => (a.mode === "read" ? sub(a.expr) : place(a.place));
    switch (e.k) {
        case "read": return place(e.place);
        case "assign": place(e.place); return sub(e.value);
        case "call": if (e.recv) arg(e.recv); e.args.forEach(arg); return;
        case "callvalue": sub(e.fn); e.args.forEach(arg); return;
        case "extern": e.args?.forEach(sub); return;
        case "struct": case "record": e.fields.forEach((x) => sub(x.value)); return;
        case "variant": e.fields.forEach(sub); return;
        case "tuple": e.elems.forEach(sub); return;
        case "vec": case "array": case "set": e.elems.forEach(sub); return;
        case "map": e.entries.forEach((en) => ("k" in en ? sub(en) : (sub(en.key), sub(en.value)))); return;
        case "range": sub(e.start); sub(e.end); return;
        case "unary": case "tostr": case "cast": case "await": case "truthy": return sub(e.expr);
        case "binary": case "and": case "or": sub(e.left); sub(e.right); return;
        case "concat": e.parts.forEach(sub); return;
        case "if": sub(e.cond); visitBlock(e.then, f, stmt); if (e.else) visitBlock(e.else, f, stmt); return;
        case "match": sub(e.subject); e.arms.forEach((a) => (sub(a.guard), sub(a.body))); return;
        case "loop": return visitBlock(e.body, f, stmt);
        case "foreach": sub(e.iterable); return visitBlock(e.body, f, stmt);
        case "break": case "return": return sub(e.value);
        case "block": return visitBlock(e.block, f, stmt);
        case "closure": return visitBlock(e.body, f, stmt);
        case "select": e.arms.forEach((a) => (sub(a.wait), sub(a.body))); return sub(e.else);
        case "recover": return visitBlock(e.body, f, stmt);
        case "lock": e.places.forEach(place); return visitBlock(e.body, f, stmt);
        default: return;
    }
}

// ---- dump ----------------------------------------------------------------------------------------

/** One line per function: `name  reads [..] writes [..] …` (the `.effects` format). */
export function showSummary(s: Summary): string {
    const parts: string[] = [];
    const list = (label: string, set: Set<string>) => {
        if (set.size > 0) parts.push(`${label} [${[...set].sort().join(", ")}]`);
    };
    list("reads", s.reads);
    list("writes", s.writes);
    list("keeps", s.keeps);
    list("consumes", s.consumes);
    list("returns_view", s.returnsView);
    list("invokes", s.invokes);
    if (s.awaits) parts.push("awaits");
    return parts.length > 0 ? parts.join("  ") : "pure";
}
