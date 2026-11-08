// S-expression dump of the HIR, used for `test/hir/*.hir` snapshots and `ms hir`.
//
//   (fun area (params (s Shape)) -> f64
//     (match s ((variant Shape.Circle r) (* r r)) …))
//
// Locals print by name; when two different locals share a name in one function, the later ones get
// `'2`, `'3` … so shadowing stays visible. Temporaries introduced by lowering start with `$`.

import type * as H from "./hir.ts"
import type { Sym } from "./resolve.ts"
import { show } from "./types.ts"

type Sx = string | Sx[]
const WIDTH = 100

function flat(x: Sx): string {
    return typeof x === "string" ? x : `(${x.map(flat).join(" ")})`
}

function layout(x: Sx, indent: number): string {
    const f = flat(x)
    if (typeof x === "string" || indent + f.length <= WIDTH) return f
    const [head, ...rest] = x
    let line = `(${flat(head!)}`
    let i = 0
    while (i < rest.length && typeof rest[i] === "string" && line.length + 1 + (rest[i] as string).length < 50) {
        line += ` ${rest[i] as string}`
        i++
    }
    const pad = " ".repeat(indent + 2)
    return [line, ...rest.slice(i).map((r) => pad + layout(r, indent + 2))].join("\n") + ")"
}

export function dumpHir(p: H.Program): string {
    const out: string[] = []
    for (const t of p.types) out.push(layout(typeDef(t), 0))
    for (const g of p.globals) {
        const names = new Names()
        out.push(layout(["global", `${g.name}:`, show(g.ty), expr(g.value, names)], 0))
    }
    for (const f of p.funs) out.push(layout(fun(f), 0))
    return out.join("\n\n") + "\n"
}

class Names {
    private readonly names = new Map<Sym, string>()
    private readonly counts = new Map<string, number>()
    of(sym: Sym): string {
        const known = this.names.get(sym)
        if (known !== undefined) return known
        const base = sym.name === "it1" ? "it" : sym.kind === "this" ? "this" : sym.name
        const n = (this.counts.get(base) ?? 0) + 1
        this.counts.set(base, n)
        const name = n === 1 ? base : `${base}'${n}`
        this.names.set(sym, name)
        return name
    }
}

function typeDef(t: H.TypeDef): Sx {
    const ifaces = (list: string[]) => (list.length ? [["impls", ...list]] : [])
    const field = (f: H.FieldDef) => (f.optional ? `${f.name}?` : f.name)
    switch (t.kind) {
        case "struct": return ["struct", t.name, ...ifaces(t.interfaces), ["fields", ...t.fields.map(field)]]
        case "union": return ["union", t.name, ...ifaces(t.interfaces), ...t.variants.map((v): Sx => (v.fields.length === 0 ? v.name : [v.name, ...v.fields.map(field)]))]
        case "inter": return ["inter", t.name, ...t.methods]
    }
}

function fun(f: H.Fun): Sx {
    const names = new Names()
    const params: Sx = ["params", ...(f.self ? [[names.of(f.self.sym), "self"]] : []), ...f.params.map((p): Sx => [names.of(p.sym), show(p.ty)])]
    const head: Sx[] = ["fun", f.name, ...(f.async ? ["async"] : []), params, "->", show(f.ret)]
    if (f.body === null) return [...head, ["extern", JSON.stringify(f.extern ?? "")]]
    return [...head, block(f.body, names)]
}

function block(b: H.Block, n: Names): Sx {
    return ["do", ...b.stmts.map((s) => stmt(s, n)), ...(b.value ? [expr(b.value, n)] : [])]
}

function stmt(s: H.Stmt, n: Names): Sx {
    if (s.k === "expr") return expr(s.expr, n)
    return [s.local.mutable ? "var" : "let", `${n.of(s.local.sym)}:`, show(s.local.ty), expr(s.value, n)]
}

function lit(v: bigint | number | string | boolean | null): string {
    if (v === null) return "t()"
    if (typeof v === "string") return JSON.stringify(v)
    if (typeof v === "bigint") return `${v}`
    return String(v)
}

function elem(x: H.Expr | H.Spread, n: Names): Sx {
    return x.k === "spread" ? ["...", expr(x.expr, n)] : expr(x, n)
}

function expr(e: H.Expr, n: Names): Sx {
    switch (e.k) {
        case "lit": {
            if (typeof e.value === "bigint" && /^[iu]64$/.test(show(e.ty))) return `${e.value}n`
            if (typeof e.value === "number" && Number.isInteger(e.value) && /^f(32|64)$/.test(show(e.ty))) return e.value.toFixed(1)
            return lit(e.value)
        }
        case "char": return `'${e.value}'`
        case "local": return n.of(e.sym)
        case "global": return `@${e.name}`
        case "fn": return `#${e.name}`
        case "call": return [e.fn, ...e.args.map((a) => expr(a, n))]
        case "dyncall": return ["dyn", expr(e.recv, n), e.method, ...e.args.map((a) => expr(a, n))]
        case "callvalue": return ["callv", expr(e.callee, n), ...e.args.map((a) => expr(a, n))]
        case "wstatic": return [`wstatic:${e.witness && "param" in e.witness ? e.witness.param.name : "?"}.${e.method}`, ...e.args.map((a) => expr(a, n))]
        case "extern": return e.args === null ? `extern:${e.path}` : [`extern:${e.path}`, ...e.args.map((a) => expr(a, n))]
        case "struct": return ["struct", e.type, ...e.fields.map((f): Sx => [f.name, expr(f.value, n)])]
        case "variant": return e.fields.length === 0 ? `${e.union}.${e.variant}` : [`${e.union}.${e.variant}`, ...e.fields.map((f) => expr(f, n))]
        case "record": return ["record", ...e.fields.map((f): Sx => [f.name, expr(f.value, n)])]
        case "tuple": return ["tuple", ...e.elems.map((x) => expr(x, n))]
        case "vec": case "array": case "set": return [e.k, ...e.elems.map((x) => elem(x, n))]
        case "map": return ["map", ...e.entries.map((x): Sx => ("k" in x ? ["...", expr(x.expr, n)] : [expr(x.key, n), expr(x.value, n)]))]
        case "range": return [e.inclusive ? "..=" : "..", e.start ? expr(e.start, n) : "_", e.end ? expr(e.end, n) : "_"]
        case "field": return [".", expr(e.object, n), e.name]
        case "index": return [e.map ? "map-get" : "index", expr(e.object, n), expr(e.index, n)]
        case "unary": return [e.op, expr(e.expr, n)]
        case "binary": return [e.op, expr(e.left, n), expr(e.right, n)]
        case "and": return ["and", expr(e.left, n), expr(e.right, n)]
        case "or": return ["or", expr(e.left, n), expr(e.right, n)]
        case "truthy": return [e.of === "option" ? "is-some" : "is-ok", expr(e.expr, n)]
        case "concat": return ["concat", ...e.parts.map((p) => expr(p, n))]
        case "tostr": return ["to_str", expr(e.expr, n)]
        case "widen": return ["widen", expr(e.expr, n)]
        case "cast": return ["cast", expr(e.expr, n), show(e.to)]
        case "assign": return [e.op, expr(e.target, n), expr(e.value, n)]
        case "if": return ["if", expr(e.cond, n), block(e.then, n), ...(e.else ? [block(e.else, n)] : [])]
        case "match": return ["match", expr(e.subject, n), ...e.arms.map((a): Sx => [pattern(a.pattern, n), ...(a.guard ? [["if", expr(a.guard, n)]] : []), expr(a.body, n)])]
        case "loop": return ["loop", ...(e.label ? [`${e.label}:`] : []), ...(e.step ? [["step", ...block(e.step, n).slice(1)]] : []), block(e.body, n)]
        case "break": return ["break", ...(e.label ? [e.label] : []), ...(e.value ? [expr(e.value, n)] : [])]
        case "continue": return ["continue", ...(e.label ? [e.label] : [])]
        case "return": return ["return", ...(e.value ? [expr(e.value, n)] : [])]
        case "block": return block(e.block, n)
        case "closure": {
            const params = e.params.map((p) => n.of(p.sym))
            const caps = e.captures.map((c) => (c.mode === "move" ? n.of(c.sym) : c.mode === "mut" ? `&mut ${n.of(c.sym)}` : `&${n.of(c.sym)}`))
            return ["closure", ["params", ...params], ...(caps.length ? [["captures", ...caps]] : []), block(e.body, n)]
        }
        case "await": return ["await", expr(e.expr, n)]
        case "select": return ["select", ...e.arms.map((a): Sx => [pattern(a.pattern, n), "=", expr(a.wait, n), expr(a.body, n)]), ...(e.else ? [["else", expr(e.else, n)]] : [])]
        case "recover": return ["recover", block(e.body, n)]
        case "unsupported": return `<unsupported: ${e.what}>`
    }
}

function pattern(p: H.Pattern, n: Names): Sx {
    switch (p.k) {
        case "wild": return "_"
        case "bind": return n.of(p.local.sym)
        case "lit": return lit(p.value)
        case "range": return [p.inclusive ? "..=" : "..", p.start === null ? "_" : lit(p.start), p.end === null ? "_" : lit(p.end)]
        case "variant": return p.fields.length === 0 ? `${p.union}.${p.variant}` : [`${p.union}.${p.variant}`, ...p.fields.map((f) => pattern(f, n))]
        case "fields": return ["fields", ...p.fields.map((f): Sx => [f.name, pattern(f.pattern, n)])]
        case "tuple": return ["t", ...p.elems.map((e) => pattern(e, n))]
        case "or": return ["|", ...p.alts.map((a) => pattern(a, n))]
        case "ok": return ["ok", pattern(p.value, n)]
        case "fail": return p.payload.k === "wild" ? "fail" : ["fail", pattern(p.payload, n)]
    }
}
