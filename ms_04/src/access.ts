// The access check (spec §9–§11, pass 7 of §15): local rules over one function body, using the
// callees' effect summaries. It reports
// - E_ASSIGN_IMMUTABLE / E_WRITE_TO_IMMUTABLE: writing, or passing to `*T` / `*this`, what isn't
//   writable (a `let` / `:=` binding, a `T` parameter, a read-mode closure parameter);
// - E_OVERLAPPING_ACCESS: two arguments of one call overlap on a path the callee writes (§9.4);
// - E_ACCESS_DURING_WRITE_VIEW: using an overlapping path while a write view is live (§9.7);
// - E_USE_AFTER_MOVE: using a moved `Unique` value (§9.2);
// - E_CONCURRENT_OVERLAP: tasks of one statement (`all(…)`, `race(…)`, `select`) overlap on a
//   written path (§11.2); E_VIEW_ACROSS_TASK: an async call with a `*` argument, or a view of a
//   value someone may write, not awaited in its statement;
// - E_AWAIT_IN_LOCK (§10.1), E_WRITE_TO_CAPTURED_COPY (§10.3), E_USE_OF_POISONED (§13.3).
//
// Writes through `shared` cells and `once` fields are never conflicts: the cell synchronises.

import { diag, type Diagnostic } from "./diagnostic.ts";
import type { Summary } from "./effects.ts";
import type * as H from "./hir.ts";
import type { Sym } from "./resolve.ts";
import * as T from "./types.ts";
import type { Ty } from "./types.ts";

export function checkAccess(p: H.Program, summaries: Map<H.Fun, Summary>): Diagnostic[] {
    const ctx = new Context(p, summaries);
    for (const f of p.funs) if (f.body) new FunctionCheck(ctx, f).run();
    return ctx.diagnostics;
}

class Context {
    readonly p: H.Program;
    readonly summaries: Map<H.Fun, Summary>;
    readonly byName = new Map<string, H.Fun>();
    readonly structs = new Map<Sym, H.TypeDef & { kind: "struct" }>();
    readonly globals = new Map<string, H.Global>();
    readonly diagnostics: Diagnostic[] = [];
    readonly seen = new Set<string>();

    constructor(p: H.Program, summaries: Map<H.Fun, Summary>) {
        this.p = p;
        this.summaries = summaries;
        for (const f of p.funs) this.byName.set(f.name, f);
        for (const t of p.types) if (t.kind === "struct" && t.sym) this.structs.set(t.sym, t);
        for (const g of p.globals) this.globals.set(g.name, g);
    }

    report(code: string, message: string, file: string, at: H.Span, fix?: string): void {
        const key = `${file}:${at.start}:${code}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        const d = diag(code, message, at.start, Math.max(at.end, at.start), fix);
        d.file = file;
        this.diagnostics.push(d);
    }
}

// ---- paths -------------------------------------------------------------------------------------

/** A caller-side path: a root (a local's symbol id, or a global) and segments. */
interface Path {
    root: string;
    name: string;
    segs: string[];
    /** passes through a `shared` / `once` field, or is rooted in a shared cell */
    shared: boolean;
}

/** Paths overlap when one is a prefix of the other, `[*]` matching any element (§9.5). */
function overlap(a: Path, b: Path): boolean {
    if (a.root !== b.root) return false;
    const n = Math.min(a.segs.length, b.segs.length);
    for (let i = 0; i < n; i++) {
        const x = a.segs[i]!;
        const y = b.segs[i]!;
        if (x === y) continue;
        if ((x === "[*]" && y.startsWith("[")) || (y === "[*]" && x.startsWith("["))) continue;
        return false;
    }
    return true;
}

const show = (p: Path) => p.name + p.segs.join("");

function splitPath(path: string): string[] {
    return path.match(/^[^.[]+|\.[^.[]+|\[[^\]]*\]/g) ?? [path];
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

/** What we know of each local of the function being checked. */
interface LocalInfo {
    local: H.Local;
    kind: "param" | "this" | "let" | "closure-param";
    mutable: boolean;
    /** bound to a write view returned by `-> *T` (§9.7) */
    writeView: Path[] | null;
}

class FunctionCheck {
    readonly c: Context;
    readonly f: H.Fun;
    readonly locals = new Map<Sym, LocalInfo>();
    /** Unique locals moved so far (flow-sensitive), with where */
    moved = new Map<Sym, H.Span>();
    /** mutable locals left half-updated by a caught panic (§13.3) */
    poisoned = new Set<Sym>();
    lockDepth = 0;

    constructor(c: Context, f: H.Fun) {
        this.c = c;
        this.f = f;
        f.params.forEach((l, i) => this.locals.set(l.sym, { local: l, kind: "param", mutable: f.modes[i] === "write", writeView: null }));
        if (f.self) this.locals.set(f.self.sym, { local: f.self, kind: "this", mutable: f.selfMode === "write", writeView: null });
    }

    report(code: string, message: string, at: H.Span, fix?: string): void {
        this.c.report(code, message, this.f.file, at, fix);
    }

    run(): void {
        this.declare(this.f.body!);
        this.block(this.f.body!, false);
    }

    // ---- locals -------------------------------------------------------------------------------

    /** Records every local bound in the body: mutability, write views. */
    declare(b: H.Block): void {
        const bind = (p: H.Pattern, value: H.Expr | null) => {
            switch (p.k) {
                case "bind": {
                    const wv = value ? this.writeViewOf(value) : null;
                    if (!this.locals.has(p.local.sym)) this.locals.set(p.local.sym, { local: p.local, kind: "let", mutable: p.local.mutable, writeView: wv });
                    return;
                }
                case "variant": p.fields.forEach((x) => bind(x, null)); return;
                case "ok": return bind(p.value, null);
                case "fail": return bind(p.payload, null);
                case "fields": p.fields.forEach((x) => bind(x.pattern, null)); return;
                case "tuple": p.elems.forEach((x) => bind(x, null)); return;
                case "or": p.alts.forEach((x) => bind(x, null)); return;
                default: return;
            }
        };
        walkBlock(b, (e) => {
            if (e.k === "match") for (const a of e.arms) bind(a.pattern, null);
            if (e.k === "foreach") {
                bind(e.item, null);
                if (e.second) bind(e.second, null);
            }
            if (e.k === "select") for (const a of e.arms) bind(a.pattern, null);
            if (e.k === "closure") {
                e.params.forEach((l, i) => this.locals.set(l.sym, { local: l, kind: "closure-param", mutable: l.mutable || e.modes[i] === "write", writeView: null }));
            }
        }, (s) => {
            if (s.k === "let") bind(s.pattern, s.value);
        });
    }

    /** The paths a call's result is a write view of (its callee's `returns_view`, substituted). */
    writeViewOf(e: H.Expr): Path[] | null {
        if (e.k !== "call" || e.callee.k !== "fn") return null;
        const callee = this.c.byName.get(e.callee.name);
        if (!callee || callee.retMode !== "write") return null;
        const sum = this.c.summaries.get(callee);
        const out: Path[] = [];
        for (const rv of sum?.returnsView ?? []) out.push(...this.substitute(rv, callee, e));
        return out;
    }

    /** A callee's path (`this.items[*]`) in the caller's terms, through the call's arguments. */
    substitute(path: string, callee: H.Fun, e: H.Expr & { k: "call" }): Path[] {
        const [root, ...rest] = splitPath(path);
        let arg: H.Arg | null = null;
        if (root === "this") arg = e.recv;
        else {
            const i = callee.params.findIndex((p) => p.name === root);
            if (i >= 0) arg = e.args[i] ?? null;
        }
        if (!arg) return [];
        const base = arg.mode === "write" ? this.path(arg.place) : arg.expr.k === "read" ? this.path(arg.expr.place) : null;
        if (!base) return [];
        const ty = arg.mode === "write" ? arg.ty : arg.expr.ty;
        return [{ ...base, segs: [...base.segs, ...rest], shared: base.shared || this.throughShared(ty, rest) }];
    }

    /** Whether field segments, walked from a value of type `ty`, pass a `shared` / `once` field. */
    throughShared(ty: Ty, segs: string[]): boolean {
        let t = T.prune(ty);
        for (const s of segs) {
            if (!s.startsWith(".")) {
                t = t.k === "named" ? T.prune(t.args[t.args.length - 1] ?? T.UNKNOWN) : T.UNKNOWN;
                continue;
            }
            if (t.k !== "named") return false;
            const def = this.c.structs.get(t.sym);
            const field = def?.fields.find((f) => f.name === s.slice(1));
            if (!field) return false;
            if (field.mode !== null) return true;
            t = T.prune(field.ty);
        }
        return false;
    }

    /** A place's path in the caller; null for a computed root (a temporary: nothing to conflict with). */
    path(p: H.Place): Path | null {
        if (p.root.k === "value") return null;
        let shared = false;
        let root: string;
        let name: string;
        if (p.root.k === "local") {
            const info = this.locals.get(p.root.local);
            root = `#${p.root.local.id}`;
            name = p.root.name;
            if (info?.local.shared) shared = true;
            // a write view stands for what it points into
            if (info?.writeView && info.writeView.length === 1) {
                const wv = info.writeView[0]!;
                return { ...wv, segs: [...wv.segs, ...p.segs.map(segOf)], shared: wv.shared || shared || p.segs.some((s) => s.k === "field" && s.mode !== null) };
            }
        } else {
            root = `@${p.root.name}`;
            name = p.root.name;
            shared = this.c.globals.get(p.root.name)?.mutable ?? false; // a top-level var is shared (§10.4)
        }
        if (p.segs.some((s) => s.k === "field" && s.mode !== null)) shared = true;
        return { root, name, segs: p.segs.map(segOf), shared };
    }

    // ---- writability --------------------------------------------------------------------------

    /** Why a place can't be written, or null when it can. */
    notWritable(p: H.Place): { code: string; why: string; fix?: string } | null {
        if (p.segs.some((s) => s.k === "field" && s.mode !== null)) return null; // shared / once fields
        if (p.root.k === "value") return null;
        if (p.root.k === "global") {
            const g = this.c.globals.get(p.root.name);
            return g && !g.mutable ? { code: "E_ASSIGN_IMMUTABLE", why: `\`${p.root.name}\` is a top-level \`let\``, fix: "var" } : null;
        }
        const info = this.locals.get(p.root.local);
        if (!info || info.mutable || info.writeView || info.local.shared) return null;
        switch (info.kind) {
            case "param": return { code: "E_ASSIGN_IMMUTABLE", why: `parameter \`${info.local.name}\` is read-only`, fix: `${info.local.name}: *T, or \`var ${info.local.name} = ${info.local.name}\`` };
            case "this": return { code: "E_ASSIGN_IMMUTABLE", why: "`this` is read-only in this method", fix: "*this" };
            case "closure-param": return { code: "E_WRITE_TO_IMMUTABLE", why: `closure parameter \`${info.local.name}\` is read-only`, fix: "`(*T)` in the function type, or `var` before the parameter" };
            default: return { code: "E_ASSIGN_IMMUTABLE", why: `\`${info.local.name}\` is not a \`var\``, fix: ":== or var" };
        }
    }

    // ---- the walk -----------------------------------------------------------------------------

    block(b: H.Block, inLoop: boolean): void {
        const stmts = b.stmts;
        for (let i = 0; i < stmts.length; i++) {
            const s = stmts[i]!;
            this.stmt(s);
            // a write view is live from its binding to its last use in this block
            if (s.k === "let" && s.pattern.k === "bind") {
                const info = this.locals.get(s.pattern.local.sym);
                if (info?.writeView) this.writeViewLive(s.pattern.local.sym, info.writeView, stmts.slice(i + 1), b.value);
            }
        }
        if (b.value) {
            this.concurrency(b.value);
            this.expr(b.value, true);
        }
        void inLoop;
    }

    stmt(s: H.Stmt): void {
        if (s.k === "let") {
            this.concurrency(s.value);
            this.expr(s.value, s.value.k !== "closure");
            if (s.else) this.branchBlock(s.else);
            return;
        }
        this.statement(s.expr);
    }

    /** A statement: the unit within which tasks run concurrently and must be awaited (§11.2). */
    statement(e: H.Expr): void {
        this.concurrency(e);
        this.expr(e, false);
    }

    branchBlock(b: H.Block): void {
        const saved = new Map(this.moved);
        this.block(b, false);
        for (const [k, v] of saved) if (!this.moved.has(k)) this.moved.set(k, v);
    }

    /**
     * Each branch from the same state; afterwards a value moved in any branch that can finish may
     * be moved. A branch that diverges (`return`, `break`, a panic) doesn't reach what follows.
     */
    branches(run: { go: () => void; diverges: boolean }[]): void {
        const start = new Map(this.moved);
        const after = new Map<Sym, H.Span>();
        let any = false;
        for (const r of run) {
            this.moved = new Map(start);
            r.go();
            if (r.diverges) continue;
            any = true;
            for (const [k, v] of this.moved) after.set(k, v);
        }
        this.moved = any ? after : start;
    }

    /** `consume`: the value is moved here (bound, stored, returned, passed to a keeping parameter). */
    expr(e: H.Expr, consume: boolean): void {
        switch (e.k) {
            case "read":
                this.use(e.place, e.span);
                if (consume && e.place.segs.length === 0 && e.place.root.k === "local") this.move(e.place.root.local, e.span);
                return;
            case "assign": {
                this.expr(e.value, true);
                const bad = this.notWritable(e.place);
                if (bad) this.report(bad.code, `can't assign: ${bad.why}`, e.span, bad.fix);
                if (e.op !== "=") this.use(e.place, e.span);
                else this.placeParts(e.place);
                if (e.place.root.k === "local" && e.place.segs.length === 0) {
                    // a fresh value: no longer moved, no longer poisoned
                    this.moved.delete(e.place.root.local);
                    this.poisoned.delete(e.place.root.local);
                }
                return;
            }
            case "call":
                return this.call(e);
            case "callvalue":
                this.expr(e.fn, false);
                for (const a of e.args) this.arg(a, false, e.span);
                return;
            case "extern":
                for (const a of e.args ?? []) this.expr(a, true);
                return;
            case "struct": case "record":
                for (const x of e.fields) this.expr(x.value, true);
                return;
            case "variant":
                for (const x of e.fields) this.expr(x, true);
                return;
            case "tuple":
                for (const x of e.elems) this.expr(x, true);
                return;
            case "vec": case "array": case "set":
                for (const x of e.elems) this.expr(x.k === "spread" ? x.expr : x, true);
                return;
            case "map":
                for (const en of e.entries) {
                    if ("k" in en) this.expr(en.expr, true);
                    else (this.expr(en.key, true), this.expr(en.value, true));
                }
                return;
            case "if":
                this.expr(e.cond, false);
                this.branches([
                    { go: () => this.block(e.then, false), diverges: diverges(e.then) },
                    { go: () => e.else && this.block(e.else, false), diverges: e.else ? diverges(e.else) : false },
                ]);
                return;
            case "match":
                this.expr(e.subject, consume);
                this.branches(e.arms.map((a) => ({
                    go: () => {
                        if (a.guard) this.expr(a.guard, false);
                        this.expr(a.body, consume);
                    },
                    diverges: T.prune(a.body.ty).k === "never" || (a.body.k === "block" && diverges(a.body.block)),
                })));
                return;
            case "loop": case "foreach": {
                if (e.k === "foreach") this.expr(e.iterable, false);
                // twice: a move in the body is a use after move on the next iteration
                this.block(e.body, true);
                this.block(e.body, true);
                return;
            }
            case "break": case "return":
                if (e.value) this.expr(e.value, true);
                return;
            case "block":
                return this.block(e.block, false);
            case "closure":
                return this.closure(e, consume);
            case "await":
                if (this.lockDepth > 0) this.report("E_AWAIT_IN_LOCK", "`await` inside `lock`: a lock is never held across a suspension", e.span, "move the `await` out of the `lock`");
                return this.expr(e.expr, consume);
            case "select":
                if (this.lockDepth > 0) this.report("E_AWAIT_IN_LOCK", "`select` inside `lock` waits while holding the lock", e.span);
                for (const a of e.arms) this.expr(a.wait, false);
                this.branches([
                    ...e.arms.map((a) => ({ go: () => this.expr(a.body, consume), diverges: T.prune(a.body.ty).k === "never" })),
                    ...(e.else ? [{ go: () => this.expr(e.else!, consume), diverges: T.prune(e.else.ty).k === "never" }] : []),
                ]);
                return;
            case "recover": {
                const before = this.writtenLocals(e.body);
                this.block(e.body, false);
                // a `var` written inside a block that may have panicked is half-updated (§13.3)
                for (const s of before) this.poisoned.add(s);
                return;
            }
            case "lock":
                for (const p of e.places) this.use(p, e.span);
                this.lockDepth++;
                this.block(e.body, false);
                this.lockDepth--;
                return;
            case "unary": case "tostr": case "cast": case "truthy":
                return this.expr(e.expr, false);
            case "binary": case "and": case "or":
                this.expr(e.left, false);
                this.expr(e.right, false);
                return;
            case "concat":
                for (const x of e.parts) this.expr(x, false);
                return;
            case "range":
                if (e.start) this.expr(e.start, false);
                if (e.end) this.expr(e.end, false);
                return;
            default:
                return;
        }
    }

    placeParts(p: H.Place): void {
        if (p.root.k === "value") this.expr(p.root.expr, false);
        for (const s of p.segs) if (s.k === "elem") this.expr(s.index, false);
    }

    /** A use of a place: after a move, after a poisoning panic. */
    use(p: H.Place, at: H.Span): void {
        this.placeParts(p);
        if (p.root.k !== "local") return;
        const sym = p.root.local;
        const movedAt = this.moved.get(sym);
        if (movedAt) this.report("E_USE_AFTER_MOVE", `\`${p.root.name}\` is Unique and was moved earlier (or may have been, on some path)`, at);
        if (this.poisoned.has(sym)) {
            this.report("E_USE_OF_POISONED", `\`${p.root.name}\` was written inside a \`recover\` block that may have panicked: assign it before reading it`, at);
        }
    }

    move(sym: Sym, at: H.Span): void {
        const info = this.locals.get(sym);
        if (info?.local.unique) this.moved.set(sym, at);
    }

    arg(a: H.Arg, consumes: boolean, at: H.Span): void {
        if (a.mode === "read") {
            this.expr(a.expr, consumes);
            return;
        }
        this.use(a.place, at);
        const bad = this.notWritable(a.place);
        if (bad) this.report("E_WRITE_TO_IMMUTABLE", `can't pass as \`*\`: ${bad.why}`, at, bad.fix);
    }

    call(e: H.Expr & { k: "call" }): void {
        const callee = e.callee.k === "fn" ? this.c.byName.get(e.callee.name) : undefined;
        const sum = callee ? this.c.summaries.get(callee) : undefined;
        // which parameters keep or consume their argument: those arguments move if Unique (§9.2)
        const takes = (name: string) => !!sum && [...sum.keeps, ...sum.consumes].some((x) => splitPath(x)[0] === name);
        const unknown = !callee;
        if (e.recv) this.arg(e.recv, unknown || takes("this"), e.span);
        e.args.forEach((a, i) => {
            const name = callee?.params[i]?.name ?? `#${i}`;
            this.arg(a, (unknown && e.callee.k !== "auto") || takes(name), a.mode === "read" ? a.expr.span : e.span);
        });
        this.overlapping(e, callee, sum);
    }

    // ---- E_OVERLAPPING_ACCESS (§9.4) ----------------------------------------------------------

    overlapping(e: H.Expr & { k: "call" }, callee: H.Fun | undefined, sum: Summary | undefined): void {
        const args: { arg: H.Arg; name: string }[] = [
            ...(e.recv ? [{ arg: e.recv, name: "this" }] : []),
            ...e.args.map((arg, i) => ({ arg, name: callee?.params[i]?.name ?? `#${i}` })),
        ];
        // the places passed (a read argument of a Copy type is a bit copy: nothing stays live)
        const regions = args.map(({ arg }) => {
            if (arg.mode === "write") return this.path(arg.place);
            if (arg.expr.k === "read" && !isCopy(arg.expr.ty)) return this.path(arg.expr.place);
            return null;
        });
        args.forEach(({ arg, name }, i) => {
            if (arg.mode !== "write") return;
            const base = regions[i];
            if (!base || base.shared) return;
            // what the callee writes through this argument (all of it when there is no summary)
            const written: Path[] = sum
                ? [...sum.writes].filter((w) => splitPath(w)[0] === name).map((w) => ({ ...base, segs: [...base.segs, ...splitPath(w).slice(1)] }))
                : [base];
            regions.forEach((other, j) => {
                if (j === i || !other || other.shared) return;
                const hit = written.find((w) => overlap(w, other));
                if (hit) this.report("E_OVERLAPPING_ACCESS", `\`${show(other)}\` overlaps \`${show(hit)}\`, which this call writes through another argument`, e.span);
            });
        });
    }

    // ---- write views (§9.7) -------------------------------------------------------------------

    writeViewLive(sym: Sym, sources: Path[], rest: H.Stmt[], value: H.Expr | null): void {
        const uses = (x: H.Stmt | H.Expr): boolean => {
            let found = false;
            const check = (p: H.Place) => {
                if (p.root.k === "local" && p.root.local === sym) found = true;
            };
            const visit = (e: H.Expr) => eachPlace(e, check);
            if ("k" in x && (x.k === "let" || x.k === "expr") && !("ty" in x)) {
                const s = x as H.Stmt;
                if (s.k === "let") walkExpr(s.value, visit);
                else walkExpr(s.expr, visit);
            } else walkExpr(x as H.Expr, visit);
            return found;
        };
        const all: (H.Stmt | H.Expr)[] = [...rest, ...(value ? [value] : [])];
        let last = -1;
        all.forEach((x, i) => {
            if (uses(x)) last = i;
        });
        for (let i = 0; i < last; i++) {
            const x = all[i]!;
            const visit = (e: H.Expr) =>
                eachPlace(e, (p, at) => {
                    if (p.root.k === "local" && p.root.local === sym) return;
                    const path = this.path(p);
                    if (!path || path.shared) return;
                    const hit = sources.find((s) => overlap(s, path));
                    if (hit) this.report("E_ACCESS_DURING_WRITE_VIEW", `\`${show(path)}\` is used while a write view of \`${show(hit)}\` is live`, at);
                });
            if ("ty" in x) walkExpr(x as H.Expr, visit);
            else if ((x as H.Stmt).k === "let") walkExpr((x as H.Stmt & { k: "let" }).value, visit);
            else walkExpr((x as H.Stmt & { k: "expr" }).expr, visit);
        }
    }

    // ---- closures (§9.9, §10.3) ---------------------------------------------------------------

    closure(e: H.Expr & { k: "closure" }, escapes: boolean): void {
        // an escaping closure works on copies of what it captures: a write would be lost
        if (escapes) {
            for (const cap of e.captures) {
                if (cap.mode !== "write") continue;
                const info = this.locals.get(cap.sym);
                if (info && !info.local.shared) {
                    this.report("E_WRITE_TO_CAPTURED_COPY", `this closure escapes and writes \`${cap.name}\`, a copy of the outer variable: the write would be lost`, e.span, `shared var ${cap.name}`);
                }
            }
            for (const cap of e.captures) if (this.locals.get(cap.sym)?.local.unique) this.move(cap.sym, e.span);
        }
        for (const cap of e.captures) {
            if (this.moved.has(cap.sym)) this.report("E_USE_AFTER_MOVE", `\`${cap.name}\` is Unique and was moved earlier`, e.span);
        }
        const saved = this.lockDepth;
        this.lockDepth = 0; // a closure body runs later, not inside the enclosing `lock`
        const moved = this.moved;
        this.moved = new Map();
        this.block(e.body, false);
        this.moved = moved;
        this.lockDepth = saved;
    }

    /** Locals a block writes (directly or as `*` arguments): candidates for poisoning. */
    writtenLocals(b: H.Block): Set<Sym> {
        const out = new Set<Sym>();
        walkBlock(b, (e) => {
            if (e.k === "assign" && e.place.root.k === "local") out.add(e.place.root.local);
            if (e.k === "call") for (const a of [...(e.recv ? [e.recv] : []), ...e.args]) if (a.mode === "write" && a.place.root.k === "local") out.add(a.place.root.local);
        });
        // only `var`s declared outside the block can be read half-updated afterwards
        const inner = new Set<Sym>();
        walkBlock(b, () => {}, (s) => {
            if (s.k === "let" && s.pattern.k === "bind") inner.add(s.pattern.local.sym);
        });
        return new Set([...out].filter((s) => !inner.has(s) && this.locals.get(s)?.mutable && !this.locals.get(s)?.local.shared));
    }

    // ---- tasks (§11.2) ------------------------------------------------------------------------

    /** Concurrency inside one statement: overlapping tasks, and tasks that aren't awaited. */
    concurrency(stmt: H.Expr): void {
        const visit = (e: H.Expr, awaited: boolean) => {
            if (e.k === "closure") return; // a closure's calls happen when it runs
            if (e.k === "await") return visit(e.expr, true);
            if (e.k === "select") {
                this.overlapAmong(e.arms.map((a) => a.wait), e.span);
                for (const a of e.arms) visit(a.wait, true);
                return;
            }
            if (e.k === "call" && e.callee.k === "fn" && (e.callee.name === "prelude.all" || e.callee.name === "prelude.race")) {
                const tasks = e.args.flatMap((a) => (a.mode === "read" && a.expr.k === "vec" ? a.expr.elems.map((x) => (x.k === "spread" ? x.expr : x)) : a.mode === "read" ? [a.expr] : []));
                this.overlapAmong(tasks, e.span);
                for (const t of tasks) visit(t, awaited);
                return;
            }
            if (e.k === "call" && e.async && !awaited) this.detached(e);
            eachChild(e, (x) => visit(x, false));
        };
        visit(stmt, false);
    }

    /** An async call not awaited in its statement: it may only take owned values (§11.2). */
    detached(e: H.Expr & { k: "call" }): void {
        for (const a of [...(e.recv ? [e.recv] : []), ...e.args]) {
            if (a.mode === "write") {
                const p = this.path(a.place);
                if (p && !p.shared) this.report("E_VIEW_ACROSS_TASK", `this task isn't awaited in its statement but gets \`*${show(p)}\``, e.span, "`await` it there");
                continue;
            }
            if (a.expr.k === "read" && !isCopy(a.expr.ty) && this.mayBeWritten(a.expr.place, a.expr.ty)) {
                this.report("E_VIEW_ACROSS_TASK", `this task isn't awaited in its statement but gets a view of \`${show(this.path(a.expr.place)!)}\`, which may be written meanwhile`, e.span, "`await` it there");
            }
        }
        // a closure handed to a task escapes into it
        for (const a of e.args) if (a.mode === "read" && a.expr.k === "closure") this.closureEscapes(a.expr);
    }

    closureEscapes(c: H.Expr & { k: "closure" }): void {
        for (const cap of c.captures) {
            const info = this.locals.get(cap.sym);
            if (cap.mode === "write" && info && !info.local.shared) {
                this.report("E_WRITE_TO_CAPTURED_COPY", `this closure escapes into a task and writes \`${cap.name}\`, a copy of the outer variable`, c.span, `shared var ${cap.name}`);
            }
        }
    }

    /** Rooted in a `var`, a `*` parameter or `*this`, through non-shared fields (§11.2). */
    mayBeWritten(p: H.Place, ty: Ty): boolean {
        if (p.root.k !== "local") return false;
        const info = this.locals.get(p.root.local);
        if (!info || info.local.shared || !info.mutable) return false;
        if (p.segs.some((s) => s.k === "field" && s.mode !== null)) return false;
        const t = T.prune(ty);
        if (t.k === "named" && this.c.p.types.some((d) => d.kind === "struct" && d.sym === t.sym && d.identity)) return false;
        return true;
    }

    /** E_CONCURRENT_OVERLAP: tasks of one statement whose writes overlap the others' accesses. */
    overlapAmong(tasks: H.Expr[], at: H.Span): void {
        const effects = tasks.map((t) => this.taskEffects(t));
        for (let i = 0; i < effects.length; i++) {
            for (let j = 0; j < effects.length; j++) {
                if (i === j) continue;
                for (const w of effects[i]!.writes) {
                    const hit = [...effects[j]!.writes, ...effects[j]!.reads].find((x) => overlap(w, x));
                    if (hit) {
                        // reported at the later of the two tasks
                        this.report("E_CONCURRENT_OVERLAP", `two tasks of this statement touch \`${show(hit)}\`, and one writes \`${show(w)}\``, tasks[Math.max(i, j)]?.span ?? at);
                        return;
                    }
                }
            }
        }
    }

    /** What a task does to the caller's places, from its callee's summary (non-shared paths only). */
    taskEffects(e: H.Expr): { reads: Path[]; writes: Path[] } {
        const reads: Path[] = [];
        const writes: Path[] = [];
        if (e.k !== "call") return { reads, writes };
        const callee = e.callee.k === "fn" ? this.c.byName.get(e.callee.name) : undefined;
        const sum = callee ? this.c.summaries.get(callee) : undefined;
        const args: { arg: H.Arg; name: string }[] = [
            ...(e.recv ? [{ arg: e.recv, name: "this" }] : []),
            ...e.args.map((arg, i) => ({ arg, name: callee?.params[i]?.name ?? `#${i}` })),
        ];
        for (const { arg, name } of args) {
            const place = arg.mode === "write" ? arg.place : arg.expr.k === "read" ? arg.expr.place : null;
            const ty = arg.mode === "write" ? arg.ty : arg.expr.ty;
            const base = place ? this.path(place) : null;
            if (!base || base.shared) continue;
            const map = (paths: Iterable<string>) => [...paths].filter((x) => splitPath(x)[0] === name).map((x) => {
                const rest = splitPath(x).slice(1);
                return { ...base, segs: [...base.segs, ...rest], shared: this.throughShared(ty, rest) };
            }).filter((x) => !x.shared);
            if (sum) {
                reads.push(...map(sum.reads));
                writes.push(...map(sum.writes));
            } else {
                reads.push(base);
                if (arg.mode === "write") writes.push(base);
            }
        }
        return { reads, writes };
    }
}

/** A block that can't finish normally: one of its statements diverges. */
function diverges(b: H.Block): boolean {
    const never = (e: H.Expr) => T.prune(e.ty).k === "never" || (e.k === "block" && diverges(e.block));
    return b.stmts.some((s) => s.k === "expr" && never(s.expr)) || (b.value !== null && never(b.value));
}

// ---- walking -----------------------------------------------------------------------------------

function walkBlock(b: H.Block, f: (e: H.Expr) => void, stmt?: (s: H.Stmt) => void): void {
    for (const s of b.stmts) {
        stmt?.(s);
        if (s.k === "let") {
            walkExpr(s.value, f, stmt);
            if (s.else) walkBlock(s.else, f, stmt);
        } else walkExpr(s.expr, f, stmt);
    }
    if (b.value) walkExpr(b.value, f, stmt);
}

function walkExpr(e: H.Expr, f: (e: H.Expr) => void, stmt?: (s: H.Stmt) => void): void {
    f(e);
    eachChild(e, (x) => walkExpr(x, f, stmt), (b) => walkBlock(b, f, stmt));
}

/** The direct sub-expressions (and blocks) of an expression, places' parts included. */
function eachChild(e: H.Expr, f: (e: H.Expr) => void, blk?: (b: H.Block) => void): void {
    const block = (b: H.Block) => {
        if (blk) return blk(b);
        for (const s of b.stmts) f(s.k === "let" ? s.value : s.expr);
        if (b.value) f(b.value);
    };
    const place = (p: H.Place) => {
        if (p.root.k === "value") f(p.root.expr);
        for (const s of p.segs) if (s.k === "elem") f(s.index);
    };
    const arg = (a: H.Arg) => (a.mode === "read" ? f(a.expr) : place(a.place));
    const sub = (x: H.Expr | H.Spread | null) => {
        if (x) f(x.k === "spread" ? x.expr : x);
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
        case "vec": case "array": case "set": e.elems.forEach(sub); return;
        case "map": e.entries.forEach((en) => ("k" in en ? sub(en) : (f(en.key), f(en.value)))); return;
        case "range": sub(e.start); sub(e.end); return;
        case "unary": case "tostr": case "cast": case "await": case "truthy": return f(e.expr);
        case "binary": case "and": case "or": f(e.left); f(e.right); return;
        case "concat": e.parts.forEach(f); return;
        case "if": f(e.cond); block(e.then); if (e.else) block(e.else); return;
        case "match": f(e.subject); e.arms.forEach((a) => (sub(a.guard), f(a.body))); return;
        case "loop": return block(e.body);
        case "foreach": f(e.iterable); return block(e.body);
        case "break": case "return": return sub(e.value);
        case "block": return block(e.block);
        case "closure": return block(e.body);
        case "select": e.arms.forEach((a) => (f(a.wait), f(a.body))); return sub(e.else);
        case "recover": return block(e.body);
        case "lock": e.places.forEach(place); return block(e.body);
        default: return;
    }
}

/** Every place an expression touches (reads, assignment targets, arguments, lock places). */
function eachPlace(e: H.Expr, f: (p: H.Place, at: H.Span) => void): void {
    switch (e.k) {
        case "read": return f(e.place, e.span);
        case "assign": return f(e.place, e.span);
        case "call":
            for (const a of [...(e.recv ? [e.recv] : []), ...e.args]) if (a.mode === "write") f(a.place, e.span);
            return;
        case "callvalue":
            for (const a of e.args) if (a.mode === "write") f(a.place, e.span);
            return;
        case "lock":
            for (const p of e.places) f(p, e.span);
            return;
        default:
            return;
    }
}
