// HIR validator: invariants lowering must keep. Its findings are compiler bugs, not user errors.
// - every local read, written or passed is declared in the function (a parameter, `this`, a
//   pattern binding, a closure parameter) or captured by an enclosing closure;
// - `break` and `continue` are inside a loop;
// - no expression is left with an inference variable (lowering grounds them to `unknown`).

import type * as H from "./hir.ts";
import type { Sym } from "./resolve.ts";
import * as T from "./types.ts";

export function checkHir(p: H.Program): string[] {
    const problems: string[] = [];
    for (const f of p.funs) {
        if (!f.body) continue;
        const declared = new Set<Sym>([...f.params.map((l) => l.sym), ...(f.self ? [f.self.sym] : [])]);
        new Validator(f, declared, problems).block(f.body, 0);
    }
    for (const g of p.globals) new Validator({ name: `global ${g.name}` } as H.Fun, new Set(), problems).expr(g.value, 0);
    return problems;
}

class Validator {
    readonly f: H.Fun;
    readonly declared: Set<Sym>;
    readonly problems: string[];

    constructor(f: H.Fun, declared: Set<Sym>, problems: string[]) {
        this.f = f;
        this.declared = declared;
        this.problems = problems;
    }

    report(what: string, at: H.Span): void {
        this.problems.push(`${this.f.name} @${at.start}: ${what}`);
    }

    bind(p: H.Pattern): void {
        switch (p.k) {
            case "bind": this.declared.add(p.local.sym); return;
            case "variant": p.fields.forEach((x) => this.bind(x)); return;
            case "ok": return this.bind(p.value);
            case "fail": return this.bind(p.payload);
            case "fields": p.fields.forEach((x) => this.bind(x.pattern)); return;
            case "tuple": p.elems.forEach((x) => this.bind(x)); return;
            case "or": p.alts.forEach((x) => this.bind(x)); return;
            default: return;
        }
    }

    block(b: H.Block, loops: number): void {
        for (const s of b.stmts) {
            if (s.k === "let") {
                this.expr(s.value, loops);
                if (s.else) this.block(s.else, loops);
                this.bind(s.pattern);
            } else this.expr(s.expr, loops);
        }
        if (b.value) this.expr(b.value, loops);
    }

    place(p: H.Place, at: H.Span, loops: number): void {
        if (p.root.k === "local" && !this.declared.has(p.root.local)) this.report(`local \`${p.root.name}\` is not declared`, at);
        if (p.root.k === "value") this.expr(p.root.expr, loops);
        for (const s of p.segs) if (s.k === "elem") this.expr(s.index, loops);
    }

    arg(a: H.Arg, at: H.Span, loops: number): void {
        if (a.mode === "read") this.expr(a.expr, loops);
        else this.place(a.place, at, loops);
    }

    expr(e: H.Expr, loops: number): void {
        if (T.freeVars(e.ty).size > 0) this.report(`\`${e.k}\` has an inference variable in its type ${T.show(e.ty)}`, e.span);
        const sub = (x: H.Expr | H.Spread | null) => {
            if (x) this.expr(x.k === "spread" ? x.expr : x, loops);
        };
        switch (e.k) {
            case "read": return this.place(e.place, e.span, loops);
            case "assign": this.place(e.place, e.span, loops); return sub(e.value);
            case "call": if (e.recv) this.arg(e.recv, e.span, loops); e.args.forEach((a) => this.arg(a, e.span, loops)); return;
            case "callvalue": sub(e.fn); e.args.forEach((a) => this.arg(a, e.span, loops)); return;
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
            case "if": sub(e.cond); this.block(e.then, loops); if (e.else) this.block(e.else, loops); return;
            case "match":
                sub(e.subject);
                for (const a of e.arms) {
                    this.bind(a.pattern);
                    sub(a.guard);
                    sub(a.body);
                }
                return;
            case "loop": return this.block(e.body, loops + 1);
            case "foreach":
                sub(e.iterable);
                this.bind(e.item);
                if (e.second) this.bind(e.second);
                return this.block(e.body, loops + 1);
            case "break": case "continue":
                if (loops === 0) this.report(`\`${e.k}\` outside a loop`, e.span);
                if (e.k === "break") sub(e.value);
                return;
            case "return": return sub(e.value);
            case "block": return this.block(e.block, loops);
            case "closure":
                for (const p of e.params) this.declared.add(p.sym);
                for (const c of e.captures) if (!this.declared.has(c.sym)) this.report(`capture \`${c.name}\` is not declared outside`, e.span);
                return this.block(e.body, 0);
            case "select":
                for (const a of e.arms) {
                    sub(a.wait);
                    this.bind(a.pattern);
                    sub(a.body);
                }
                return sub(e.else);
            case "recover": return this.block(e.body, loops);
            case "lock": e.places.forEach((p) => this.place(p, e.span, loops)); return this.block(e.body, loops);
            default: return;
        }
    }
}
