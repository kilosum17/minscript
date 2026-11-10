// Witness analysis (spec §15.4): which type parameters each generic function needs at run time,
// so a call passes their witness tables as hidden arguments. Computed per back end:
//
// - js: a parameter whose values the body hashes, compares, prints, defaults, uses as Map / Set
//   keys, or calls a bound or generated method on, or passes to a callee that needs it. Values
//   are references on JS and the GC owns them, so holding or copying a `T` needs nothing.
// - native: also every parameter whose values the body holds at all (locals, parameters, results):
//   it needs their size and how to copy and drop them.
//
// The needs of callees flow to callers through each call's type arguments, to a fixpoint.

import type * as H from "./hir.ts";
import { walkBlock, walkExpr } from "./lower.ts";
import type { Sym } from "./resolve.ts";
import * as T from "./types.ts";
import type { Ty } from "./types.ts";

export function computeWitnesses(p: H.Program): void {
    const byName = new Map(p.funs.map((f) => [f.name, f] as const));
    const direct = new Map<H.Fun, { js: Set<Sym>; native: Set<Sym> }>();
    for (const f of p.funs) direct.set(f, directNeeds(f));
    for (const f of p.funs) {
        const d = direct.get(f)!;
        f.witnesses = { js: [...d.js], native: [...d.native] };
    }
    // callee needs flow to callers, to a fixpoint
    for (let changed = true; changed; ) {
        changed = false;
        for (const f of p.funs) {
            if (f.generics.length === 0 || !f.body) continue;
            const js = new Set(f.witnesses.js);
            const native = new Set(f.witnesses.native);
            walkBlock(f.body, (e) => {
                if (e.k !== "call" || e.callee.k !== "fn") return;
                const callee = byName.get(e.callee.name);
                if (!callee) return;
                for (const [sym, ty] of e.witnessArgs) {
                    for (const g of f.generics) {
                        if (!mentions(ty, g)) continue;
                        if (callee.witnesses.js.includes(sym)) js.add(g);
                        if (callee.witnesses.native.includes(sym)) native.add(g);
                    }
                }
            });
            for (const g of js) native.add(g);
            if (js.size !== f.witnesses.js.length || native.size !== f.witnesses.native.length) {
                f.witnesses = { js: f.generics.filter((g) => js.has(g)), native: f.generics.filter((g) => native.has(g)) };
                changed = true;
            }
        }
    }
}

const KEYED_BUILTINS = ["prelude.Map.", "prelude.Set.", "prelude.PMap."];

function directNeeds(f: H.Fun): { js: Set<Sym>; native: Set<Sym> } {
    const js = new Set<Sym>();
    const native = new Set<Sym>();
    if (f.generics.length === 0) return { js, native };
    // builtins of hashed collections hash and compare their keys
    if (f.builtin && KEYED_BUILTINS.some((p) => f.name.startsWith(p)) && f.generics[0]) js.add(f.generics[0]);
    const holds = (t: Ty) => {
        for (const g of f.generics) if (mentions(t, g)) native.add(g);
    };
    for (const l of [...f.params, ...(f.self ? [f.self] : [])]) holds(l.ty);
    holds(f.ret);
    if (f.builtin) for (const g of f.generics) native.add(g);
    if (f.body) {
        walkBlock(f.body, (e) => {
            holds(e.ty);
            const param = (t: Ty): Sym | null => {
                const x = T.prune(t);
                return x.k === "param" && f.generics.includes(x.sym) ? x.sym : null;
            };
            switch (e.k) {
                case "call": {
                    if (e.callee.k === "witness") js.add(e.callee.param);
                    if ((e.callee.k === "dyn" || e.callee.k === "auto") && e.recv) {
                        const t = e.recv.mode === "read" ? e.recv.expr.ty : e.recv.ty;
                        for (const g of f.generics) if (mentions(t, g)) js.add(g);
                    }
                    return;
                }
                case "binary": {
                    if (["==", "!=", "<", "<=", ">", ">="].includes(e.op)) {
                        for (const g of f.generics) if (mentions(e.left.ty, g)) js.add(g);
                    }
                    const p = param(e.left.ty);
                    if (p) js.add(p);
                    return;
                }
                case "tostr":
                    for (const g of f.generics) if (mentions(e.expr.ty, g)) js.add(g);
                    return;
                case "map": case "set": {
                    const t = T.prune(e.ty);
                    const key = t.k === "named" ? t.args[0] : undefined;
                    if (key) for (const g of f.generics) if (mentions(key, g)) js.add(g);
                    return;
                }
                case "foreach":
                    walkExpr(e.iterable, () => {});
                    return;
                default:
                    return;
            }
        });
    }
    for (const g of js) native.add(g);
    return { js, native };
}

/** Whether `t` contains the generic parameter `g`. */
export function mentions(t: Ty, g: Sym): boolean {
    const p = T.prune(t);
    switch (p.k) {
        case "param": return p.sym === g;
        case "named": return p.args.some((a) => mentions(a, g));
        case "tuple": return p.elems.some((e) => mentions(e, g));
        case "record": return p.fields.some((f) => mentions(f.ty, g));
        case "fn": return p.params.some((x) => mentions(x.ty, g)) || mentions(p.ret, g);
        case "meta": return mentions(p.ty, g);
        default: return false;
    }
}
