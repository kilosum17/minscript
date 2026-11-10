// HIR dump (the `.hir` format): each function's signature and witness parameters, then its body
// as S-expressions. Places print as access paths (`this.stock.items[*]`); an argument the callee
// may write prints with `*` (`*this.stock`).

import type * as H from "./hir.ts";
import { pathOf } from "./hir.ts";
import * as T from "./types.ts";

type Doc = string | { head: string; items: Doc[] };

const WIDTH = 100;

export function dumpFun(f: H.Fun): string {
    const params = [...(f.self ? [`${f.selfMode === "write" ? "*" : ""}this: ${T.show(f.self.ty)}`] : []), ...f.params.map((p, i) => `${p.name}: ${f.modes[i] === "write" ? "*" : ""}${T.show(p.ty)}`)];
    let head = `${f.async ? "async " : ""}fn ${f.name}(${params.join(", ")}) -> ${T.show(f.ret)}`;
    if (f.builtin) head += " = builtin";
    const lines = [head];
    if (f.generics.length > 0) {
        const names = (xs: { name: string }[]) => `[${xs.map((x) => x.name).join(", ")}]`;
        lines.push(`  generics ${names(f.generics)}  witnesses js ${names(f.witnesses.js)} native ${names(f.witnesses.native)}`);
    }
    if (f.body) lines.push(render(block(f.body), 1));
    return lines.join("\n");
}

export function dumpProgram(p: H.Program, filter: (f: H.Fun) => boolean = () => true): string {
    const out: string[] = [];
    for (const g of p.globals) out.push(`global ${g.name}: ${T.show(g.ty)} = ${render(expr(g.value), 0).trim()}`);
    for (const f of p.funs) if (filter(f)) out.push(dumpFun(f));
    return out.join("\n\n") + "\n";
}

function render(d: Doc, depth: number): string {
    const pad = "  ".repeat(depth);
    const flat = (x: Doc): string => (typeof x === "string" ? x : `(${[x.head, ...x.items.map(flat)].join(" ")})`);
    const f = flat(d);
    if (typeof d === "string" || f.length + pad.length <= WIDTH) return pad + f;
    return `${pad}(${d.head}\n${d.items.map((i) => render(i, depth + 1)).join("\n")})`;
}

const n = (head: string, ...items: (Doc | null | undefined)[]): Doc => ({ head, items: items.filter((x): x is Doc => x !== null && x !== undefined) });

function place(p: H.Place): string {
    if (p.root.k !== "value") return pathOf(p, 99);
    const inner = render(expr(p.root.expr), 0);
    return p.segs.length === 0 ? inner : pathOf(p, 99).replace("<value>", `{${inner}}`);
}

function arg(a: H.Arg): Doc {
    return a.mode === "write" ? `*${place(a.place)}` : expr(a.expr);
}

function block(b: H.Block): Doc {
    const items: Doc[] = b.stmts.map(stmt);
    if (b.value) items.push(expr(b.value));
    return n("do", ...items);
}

function stmt(s: H.Stmt): Doc {
    if (s.k === "expr") return expr(s.expr);
    return n("let", pattern(s.pattern), expr(s.value), s.else ? n("else", block(s.else)) : null);
}

function pattern(p: H.Pattern): Doc {
    switch (p.k) {
        case "wild": return "_";
        case "bind": return `${p.local.mutable ? "var " : ""}${p.local.name}: ${T.show(p.local.ty)}`;
        case "lit": return lit(p.value);
        case "range": return `${lit(p.start)}${p.inclusive ? "..=" : ".."}${lit(p.end)}`;
        case "variant": return n(`${p.union}.${p.variant}`, ...p.fields.map(pattern));
        case "ok": return n("ok", pattern(p.value));
        case "fail": return n("fail", pattern(p.payload));
        case "fields": return n("fields", ...p.fields.map((f) => n(f.name, pattern(f.pattern))));
        case "tuple": return n("t", ...p.elems.map(pattern));
        case "or": return n("or", ...p.alts.map(pattern));
    }
}

function lit(v: bigint | number | string | boolean | null): string {
    if (v === null) return "t()";
    if (typeof v === "string") return JSON.stringify(v);
    return String(v);
}

function callee(c: H.Callee): string {
    switch (c.k) {
        case "fn": return c.name;
        case "dyn": return `dyn .${c.method}`;
        case "auto": return `auto .${c.method}`;
        case "witness": return `witness ${c.param.name}.${c.method}`;
    }
}

function expr(e: H.Expr): Doc {
    switch (e.k) {
        case "lit": return lit(e.value);
        case "char": return `'${e.value}'`;
        case "read": return place(e.place);
        case "assign": return n(e.op, place(e.place), expr(e.value));
        case "fnref": return `&${e.name}`;
        case "call": {
            const w = e.witnessArgs.length > 0 ? `[${e.witnessArgs.map(([s, t]) => `${s.name}=${T.show(t)}`).join(", ")}]` : null;
            return n(`call ${callee(e.callee)}`, w, e.recv ? arg(e.recv) : null, ...e.args.map(arg));
        }
        case "callvalue": return n("callv", expr(e.fn), ...e.args.map(arg));
        case "extern": return e.args ? n(`extern ${e.path}`, ...e.args.map(expr)) : `extern ${e.path}`;
        case "struct": return n(`struct ${e.type}`, ...e.fields.map((f) => n(f.name, expr(f.value))));
        case "variant": return e.fields.length === 0 ? `${e.union}.${e.variant}` : n(`${e.union}.${e.variant}`, ...e.fields.map(expr));
        case "record": return n("r", ...e.fields.map((f) => n(f.name, expr(f.value))));
        case "tuple": return n("t", ...e.elems.map(expr));
        case "vec": case "array": case "set": return n(e.k, ...e.elems.map((x) => (x.k === "spread" ? n("...", expr(x.expr)) : expr(x))));
        case "map": return n("map", ...e.entries.map((en) => ("k" in en ? n("...", expr(en.expr)) : n(":", expr(en.key), expr(en.value)))));
        case "range": return n(e.inclusive ? "..=" : "..", e.start ? expr(e.start) : "_", e.end ? expr(e.end) : "_");
        case "unary": return n(e.op, expr(e.expr));
        case "binary": return n(e.op, expr(e.left), expr(e.right));
        case "and": return n("&&", expr(e.left), expr(e.right));
        case "or": return n("||", expr(e.left), expr(e.right));
        case "truthy": return n(`truthy-${e.of}`, expr(e.expr));
        case "concat": return n("concat", ...e.parts.map(expr));
        case "tostr": return n("tostr", expr(e.expr));
        case "cast": return n(`as ${T.show(e.to)}`, expr(e.expr));
        case "if": return n("if", expr(e.cond), block(e.then), e.else ? block(e.else) : null);
        case "match": return n("match", expr(e.subject), ...e.arms.map((a) => n("=>", pattern(a.pattern), a.guard ? n("if", expr(a.guard)) : null, expr(a.body))));
        case "loop": return n(`loop${e.label ? " " + e.label : ""}`, block(e.body));
        case "foreach": return n(`for-${e.of}${e.label ? " " + e.label : ""}`, pattern(e.item), e.second ? pattern(e.second) : null, n("in", expr(e.iterable)), block(e.body));
        case "break": return n(`break${e.label ? " " + e.label : ""}`, e.value ? expr(e.value) : null);
        case "continue": return `continue${e.label ? " " + e.label : ""}`;
        case "return": return n("return", e.value ? expr(e.value) : null);
        case "block": return block(e.block);
        case "closure": {
            const params = e.params.map((p, i) => `${e.modes[i] === "write" ? "*" : ""}${p.name}`).join(", ");
            const caps = e.captures.length > 0 ? `[${e.captures.map((c) => (c.mode === "write" ? "*" : "") + c.name).join(", ")}]` : null;
            return n(`fn(${params})`, caps, block(e.body));
        }
        case "await": return n("await", expr(e.expr));
        case "select": return n("select", ...e.arms.map((a) => n("<-", pattern(a.pattern), expr(a.wait), expr(a.body))), e.else ? n("else", expr(e.else)) : null);
        case "recover": return n("recover", block(e.body));
        case "lock": return n(`lock [${e.places.map(place).join(", ")}]`, block(e.body));
        case "unsupported": return `<unsupported: ${e.what}>`;
    }
}
