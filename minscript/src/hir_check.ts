// Structural checks on lowered HIR, used by the tests: every local is bound before use (by a
// parameter, `let`, pattern, closure parameter or capture), every `break` / `continue` label names
// an enclosing loop, `break` / `continue` only occur inside loops, and nothing is `unsupported`.
// A failure here is a bug in lowering, not in the program.

import type * as H from "./hir.ts"
import type { Sym } from "./resolve.ts"

export function validateHir(p: H.Program): string[] {
    const problems: string[] = []
    for (const f of p.funs) {
        if (f.body === null) continue
        const scope = new Set<Sym>([...f.params.map((x) => x.sym), ...(f.self ? [f.self.sym] : [])])
        new Validator(f.name, problems).block(f.body, scope, [], false)
    }
    for (const g of p.globals) new Validator(`global ${g.name}`, problems).expr(g.value, new Set(), [], false)
    return problems
}

class Validator {
    private readonly where: string
    private readonly problems: string[]
    constructor(where: string, problems: string[]) {
        this.where = where
        this.problems = problems
    }

    private report(msg: string, span: { line: number, col: number }): void {
        this.problems.push(`${this.where} ${span.line}:${span.col}: ${msg}`)
    }

    block(b: H.Block, outer: Set<Sym>, labels: (string | null)[], inLoop: boolean): void {
        const scope = new Set(outer)
        for (const s of b.stmts) {
            if (s.k === "let") {
                this.expr(s.value, scope, labels, inLoop)
                scope.add(s.local.sym)
            } else {
                this.expr(s.expr, scope, labels, inLoop)
            }
        }
        if (b.value) this.expr(b.value, scope, labels, inLoop)
    }

    private binds(p: H.Pattern, into: Set<Sym>): void {
        switch (p.k) {
            case "bind": into.add(p.local.sym); break
            case "variant": p.fields.forEach((f) => this.binds(f, into)); break
            case "fields": p.fields.forEach((f) => this.binds(f.pattern, into)); break
            case "tuple": p.elems.forEach((e) => this.binds(e, into)); break
            case "or": if (p.alts[0]) this.binds(p.alts[0], into); break
            case "ok": this.binds(p.value, into); break
            case "fail": this.binds(p.payload, into); break
            default: break
        }
    }

    expr(e: H.Expr, scope: Set<Sym>, labels: (string | null)[], inLoop: boolean): void {
        const go = (x: H.Expr) => this.expr(x, scope, labels, inLoop)
        const goElem = (x: H.Expr | H.Spread) => go(x.k === "spread" ? x.expr : x)
        switch (e.k) {
            case "local":
                if (!scope.has(e.sym)) this.report(`\`${e.sym.name}\` is used but not bound`, e.span)
                return
            case "unsupported": this.report(`unsupported: ${e.what}`, e.span); return
            case "lit": case "char": case "global": case "fn": case "continue":
                if (e.k === "continue") this.checkJump(e.label, labels, inLoop, e.span)
                return
            case "call": e.args.forEach(go); return
            case "dyncall": go(e.recv); e.args.forEach(go); return
            case "callvalue": go(e.callee); e.args.forEach(go); return
            case "extern": e.args?.forEach(go); return
            case "struct": case "record": e.fields.forEach((f) => go(f.value)); return
            case "variant": e.fields.forEach(go); return
            case "tuple": e.elems.forEach(go); return
            case "vec": case "array": case "set": e.elems.forEach(goElem); return
            case "map": e.entries.forEach((x) => ("k" in x ? go(x.expr) : (go(x.key), go(x.value)))); return
            case "range": if (e.start) go(e.start); if (e.end) go(e.end); return
            case "field": go(e.object); return
            case "index": go(e.object); go(e.index); return
            case "unary": case "truthy": case "tostr": case "widen": case "cast": case "await": go(e.expr); return
            case "binary": case "and": case "or": go(e.left); go(e.right); return
            case "concat": e.parts.forEach(go); return
            case "assign": go(e.target); go(e.value); return
            case "if":
                go(e.cond)
                this.block(e.then, scope, labels, inLoop)
                if (e.else) this.block(e.else, scope, labels, inLoop)
                return
            case "match":
                go(e.subject)
                for (const a of e.arms) {
                    const s = new Set(scope)
                    this.binds(a.pattern, s)
                    if (a.guard) this.expr(a.guard, s, labels, inLoop)
                    this.expr(a.body, s, labels, inLoop)
                }
                return
            case "loop":
                this.block(e.body, scope, [...labels, e.label], true)
                if (e.step) this.block(e.step, scope, [...labels, e.label], true)
                return
            case "break":
                this.checkJump(e.label, labels, inLoop, e.span)
                if (e.value) go(e.value)
                return
            case "return": if (e.value) go(e.value); return
            case "block": this.block(e.block, scope, labels, inLoop); return
            case "closure": {
                const s = new Set(scope)
                for (const p of e.params) s.add(p.sym)
                for (const c of e.captures) if (!scope.has(c.sym)) this.report(`capture \`${c.sym.name}\` is not bound`, e.span)
                this.block(e.body, s, [], false)
                return
            }
            case "select":
                for (const a of e.arms) {
                    go(a.wait)
                    const s = new Set(scope)
                    this.binds(a.pattern, s)
                    this.expr(a.body, s, labels, inLoop)
                }
                if (e.else) go(e.else)
                return
            case "recover": this.block(e.body, scope, labels, inLoop); return
        }
    }

    private checkJump(label: string | null, labels: (string | null)[], inLoop: boolean, span: { line: number, col: number }): void {
        if (!inLoop) this.report("`break` / `continue` outside a loop", span)
        else if (label !== null && !labels.includes(label)) this.report(`unknown label \`${label}\``, span)
    }
}
