// Type witnesses (spec §14.1): which generic functions need a generic parameter at run time.
//
// A function needs the witness of its parameter `T` if its body (closures included)
// - calls a static of `T` (`T.default()`, a `wstatic` node),
// - passes `T` to a builtin that needs a type's shape (`json.from_value.[T]`, `call.shapes`), or
// - calls a function that needs a witness, passing a type that mentions `T` (`load.[Vec[T]]()`).
// The last rule makes it a fixpoint over the whole program. Every other generic function stays as it
// is: no hidden parameters, no duplicated code. The back end passes each needed witness as a hidden
// argument, built from the call's `witnessArgs`.

import type * as H from "./hir.ts"
import type { Sym } from "./resolve.ts"

/** Sets `witnesses` on every function of the program that needs some. */
export function computeWitnesses(program: H.Program): void {
    const byName = new Map(program.funs.map((f) => [f.name, f]))
    const needs = new Map<H.Fun, Set<Sym>>()
    const edges = new Map<H.Fun, { callee: string, args: [Sym, H.Shape | null][] }[]>()
    for (const f of program.funs) {
        const own = new Set<Sym>()
        const out: { callee: string, args: [Sym, H.Shape | null][] }[] = []
        if (f.body && f.generics && f.generics.length > 0) walk(f.body, own, out)
        needs.set(f, own)
        edges.set(f, out)
    }
    for (let changed = true; changed;) {
        changed = false
        for (const f of program.funs) {
            const mine = needs.get(f)!
            for (const edge of edges.get(f)!) {
                const callee = byName.get(edge.callee)
                if (callee === undefined) continue
                for (const w of needs.get(callee) ?? []) {
                    const given = edge.args.find(([s]) => s === w)
                    for (const p of params(given?.[1] ?? null)) {
                        if (!mine.has(p)) { mine.add(p); changed = true }
                    }
                }
            }
        }
    }
    for (const f of program.funs) {
        const mine = needs.get(f)!
        const list = (f.generics ?? []).filter((g) => mine.has(g))
        if (list.length > 0) f.witnesses = list
        else delete f.witnesses
    }
}

/** The generic parameters a shape mentions. */
function params(s: H.Shape | null, out: Sym[] = []): Sym[] {
    if (s === null) return out
    if ("param" in s) out.push(s.param)
    else if ("vec" in s) params(s.vec, out)
    else if ("opt" in s) params(s.opt, out)
    else if ("map" in s) params(s.map, out)
    return out
}

// keys of HIR nodes that hold symbols, types or spans, never expressions
const SKIP = new Set(["ty", "sym", "local", "span", "to", "params", "captures", "witness", "witnessArgs", "shapes", "of"])

function walk(node: unknown, own: Set<Sym>, edges: { callee: string, args: [Sym, H.Shape | null][] }[]): void {
    if (typeof node !== "object" || node === null) return
    if (Array.isArray(node)) { for (const x of node) walk(x, own, edges); return }
    const e = node as Partial<H.Expr> & Record<string, unknown>
    if (e.k === "wstatic") for (const p of params((e as Extract<H.Expr, { k: "wstatic" }>).witness)) own.add(p)
    if (e.k === "call") {
        const c = e as Extract<H.Expr, { k: "call" }>
        for (const s of c.shapes ?? []) for (const p of params(s)) own.add(p)
        if (c.witnessArgs) edges.push({ callee: c.fn, args: c.witnessArgs })
    }
    for (const [k, v] of Object.entries(e)) if (!SKIP.has(k)) walk(v, own, edges)
}
