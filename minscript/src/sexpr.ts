// S-expression dump of the AST, used for `test/parser/*.ast` snapshots and `ms parse`.
// It follows the notation of the corpus comments: `(+ 1 (* 2 3))`, `(call (. x abs))`, `(as v (Option i32))`.
// A form that doesn't fit in WIDTH columns is broken onto indented lines.

import type * as A from "./ast.ts"

type Sx = string | Sx[]

const WIDTH = 100

export function printFile(file: A.File): string {
    return layout(file_(file), 0) + "\n"
}

export function printExpr(e: A.Expr): string {
    return layout(expr(e), 0)
}

/** One statement on one line. */
export function printStmtFlat(s: A.Stmt): string {
    return flat(stmt(s))
}

// ---- layout -----------------------------------------------------------------------------------

function flat(x: Sx): string {
    return typeof x === "string" ? x : `(${x.map(flat).join(" ")})`
}

function layout(x: Sx, indent: number): string {
    const f = flat(x)
    if (typeof x === "string" || indent + f.length <= WIDTH) return f
    // keep the head (and short atoms right after it) on the first line
    const [head, ...rest] = x
    let line = `(${flat(head!)}`
    let i = 0
    while (i < rest.length && typeof rest[i] === "string" && line.length + 1 + (rest[i] as string).length < 40) {
        line += ` ${rest[i] as string}`
        i++
    }
    const pad = " ".repeat(indent + 2)
    const lines = [line]
    for (; i < rest.length; i++) lines.push(pad + layout(rest[i]!, indent + 2))
    return lines.join("\n") + ")"
}

// ---- nodes ------------------------------------------------------------------------------------

const str = (s: string) => JSON.stringify(s)
const opt = <T>(x: T | null, f: (x: T) => Sx): Sx[] => (x === null ? [] : [f(x)])

function file_(f: A.File): Sx {
    return ["file", f.package.join("."), ...f.imports.map(import_), ...f.items.map(item)]
}

function import_(i: A.Import): Sx {
    return ["import", ...(i.pub ? ["pub"] : []), str(i.path), ...(i.alias ? ["as", i.alias] : [])]
}

function generics(gs: A.GenericParam[]): Sx[] {
    if (gs.length === 0) return []
    return [["generics", ...gs.map((g): Sx => (g.bounds.length === 0 ? g.name : [g.name, ...g.bounds.map(type)]))]]
}

function fun(f: A.FunDecl): Sx {
    const mods = [...(f.pub ? ["pub"] : []), ...(f.async ? ["async"] : [])]
    const params: Sx = ["params", ...(f.receiver ? [f.receiver] : []), ...f.params.map(param)]
    return ["fun", f.name, ...mods, ...generics(f.generics), params, ...opt(f.ret, (t) => ["->", type(t)]), ...opt(f.body, block)]
}

function param(p: A.Param): Sx {
    const name = `${p.variadic ? "..." : ""}${p.name}`
    return [...(p.mut ? ["mut"] : []), name, type(p.type)]
}

function field(f: A.Field): Sx {
    return [...(f.pub ? ["pub"] : []), f.name, type(f.type), ...opt(f.default, (d) => ["=", expr(d)])]
}

function variant(v: A.Variant): Sx {
    if (v.tuple) return [v.name, ...v.tuple.map(type)]
    if (v.fields) return [v.name, ["fields", ...v.fields.map(field)]]
    return v.name
}

function item(it: A.Item): Sx {
    switch (it.kind) {
        case "FunDecl": return fun(it)
        case "TypeDecl": {
            const head = ["type", it.name, ...(it.pub ? ["pub"] : []), ...generics(it.generics), ...(it.impls.length ? [["impls", ...it.impls.map(type)]] : [])]
            if (it.body.kind === "StructBody") {
                return [...head, ["fields", ...it.body.fields.map(field)], ...it.body.methods.map(fun)] as Sx
            }
            return [...head, type(it.body)] as Sx
        }
        case "UnionDecl":
            return ["union", it.name, ...(it.pub ? ["pub"] : []), ...generics(it.generics), ...(it.impls.length ? [["impls", ...it.impls.map(type)]] : []),
                ["variants", ...it.variants.map(variant)], ...it.methods.map(fun)]
        case "InterDecl":
            return ["inter", it.name, ...(it.pub ? ["pub"] : []), ...generics(it.generics), ...(it.supers.length ? [["supers", ...it.supers.map(type)]] : []),
                ...(it.composition ? [type(it.composition)] : []), ...(it.methods ?? []).map(fun)]
        case "ImplDecl":
            return ["impl", ...generics(it.generics), ...(it.interfaces.length ? [["for", ...it.interfaces.map(type)]] : []), type(it.target), ...it.methods.map(fun)]
        case "LetDecl":
            return ["let", ...(it.pub ? ["pub"] : []), it.name, ...opt(it.type, type), expr(it.value)]
        case "ExternDecl":
            return ["extern", str(it.abi), ...it.funs.map(fun)]
    }
}

export function type(t: A.Type): Sx {
    switch (t.kind) {
        case "TName": {
            const name = t.path.join(".")
            return t.args.length === 0 ? name : [name, ...t.args.map(type)]
        }
        case "TOption": return ["Option", type(t.inner)]
        case "TRef": return [t.mut ? "&mut" : "&", type(t.inner)]
        case "TPtr": return [t.mut ? "*mut" : "*", type(t.inner)]
        case "TTuple": return ["t", ...t.elems.map(type)]
        case "TRecord": return ["r", ...t.fields.map(field)]
        case "TFn": return ["fn", ["params", ...t.params.map(type)], type(t.ret)]
        case "TTypeOf": return ["TypeOf", t.path.join(".")]
        case "TLiteral": return typeof t.value === "string" ? str(t.value) : String(t.value)
        case "TUnion": return ["|", ...t.members.map(type)]
        case "TIntersection": return ["and", ...t.members.map(type)]
        case "TError": return "<error>"
    }
}

function block(b: A.Block): Sx {
    return ["block", ...b.stmts.map(stmt)]
}

function stmt(s: A.Stmt): Sx {
    if (s.kind === "ExprStmt") return s.semi ? [";", expr(s.expr)] : expr(s.expr)
    const head = s.short ? (s.mutable ? ":==" : ":=") : (s.mutable ? "var" : "let")
    return [head, pattern(s.pattern), ...opt(s.type, type), expr(s.value), ...opt(s.else, (b) => ["else", block(b)])]
}

function elem(e: A.Expr | A.Spread): Sx {
    return e.kind === "Spread" ? ["...", expr(e.expr)] : expr(e)
}

function recField(f: A.RecordField | A.Spread): Sx {
    if (f.kind === "Spread") return ["...", expr(f.expr)]
    const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(f.key) ? f.key : str(f.key)
    return f.value === null ? [key] : [key, expr(f.value)]
}

function member(name: string | number): string {
    return String(name)
}

function charLit(v: string): string {
    const j = JSON.stringify(v)
    return `'${j.slice(1, -1).replaceAll("\\\"", "\"").replaceAll("'", "\\'")}'`
}

export function expr(e: A.Expr): Sx {
    switch (e.kind) {
        case "Ident": return e.name
        case "This": return "this"
        case "Int": return String(e.value)
        case "Float": return Number.isInteger(e.value) ? e.value.toFixed(1) : String(e.value)
        case "Str": return e.raw ? `r${str(e.value)}` : str(e.value)
        case "Template": return ["template", ...e.parts.map((p) => (typeof p === "string" ? str(p) : expr(p)))]
        case "Char": return charLit(e.value)
        case "Bool": return String(e.value)
        case "Nil": return "nil"
        case "Paren": return ["paren", expr(e.expr)]
        case "Vec": return ["vec", ...e.elems.map(elem)]
        case "Array": return ["array", ...e.elems.map(elem)]
        case "Tuple": return ["tuple", ...e.elems.map(elem)]
        case "Record": return ["record", ...e.fields.map(recField)]
        case "Map": return ["map", ...e.entries.map((m): Sx => (m.kind === "Spread" ? ["...", expr(m.expr)] : [expr(m.key), expr(m.value)]))]
        case "Set": return ["set", ...e.elems.map(elem)]
        case "Inferred": return ["_", ...e.fields.map(recField)]
        case "StructLit": return ["struct", expr(e.type), ...e.fields.map(recField)]
        case "Closure": {
            const caps = e.captures === null ? [] : [["captures", ...e.captures.map((c) => (c.mode === "move" ? c.name : c.mode === "ref" ? `&${c.name}` : `&mut ${c.name}`))]]
            const params = e.params === null ? [] : [["params", ...e.params.map((p): Sx => {
                const name = p.mut ? `mut ${p.name}` : p.name
                return p.type === null ? name : [name, type(p.type)]
            })]]
            return ["closure", ...caps, ...params, ...opt(e.ret, (t) => ["->", type(t)]), ...e.body.stmts.map(stmt)] as Sx
        }
        case "Unary": return [e.op === "*" ? "deref" : e.op, expr(e.expr)]
        case "Await": return ["await", expr(e.expr)]
        case "Binary": return [e.op, expr(e.left), expr(e.right)]
        case "Assign": return [e.op, expr(e.target), expr(e.value)]
        case "Range": return [e.op, e.start ? expr(e.start) : "_", e.end ? expr(e.end) : "_"]
        case "As": return ["as", expr(e.expr), type(e.type)]
        case "Or": return ["or", expr(e.expr), ...(e.name ? [e.name, "=>"] : []), expr(e.rhs)]
        case "Member": return [".", expr(e.object), member(e.name)]
        case "OptMember": return ["?.", expr(e.object), member(e.name)]
        case "Call": return ["call", expr(e.callee), ...e.args.map(elem)]
        case "Index": return ["index", expr(e.object), expr(e.index)]
        case "GenericApply": return ["generic", expr(e.target), ...e.args.map(type)]
        case "Try": return ["?", expr(e.expr)]
        case "If": {
            const cond: Sx = e.cond.kind === "LetCond" ? ["let", pattern(e.cond.pattern), expr(e.cond.value)] : expr(e.cond)
            const els: Sx[] = e.else === null ? [] : [e.else.kind === "Block" ? block(e.else) : expr(e.else)]
            return ["if", cond, block(e.then), ...els]
        }
        case "Match":
            return ["match", ...(e.subject ? [expr(e.subject)] : []), ...e.arms.map((a): Sx => [
                "=>", a.pattern ? pattern(a.pattern) : expr(a.test!), ...opt(a.guard, (g) => ["if", expr(g)]), expr(a.body),
            ])]
        case "Select":
            return ["select", ...e.arms.map((a): Sx => ["=>", ...(a.pattern ? [pattern(a.pattern), "="] : []), expr(a.expr), expr(a.body)]),
                ...opt(e.else, (b) => ["else", expr(b)])]
        case "For": return forLoop(e)
        case "Block": return block(e)
        case "Unsafe": return ["unsafe", block(e.body)]
        case "Recover": return ["recover", block(e.body)]
        case "Return": return ["return", ...opt(e.value, expr)]
        case "Break": return ["break", ...(e.label ? [e.label] : []), ...opt(e.value, expr)]
        case "Continue": return ["continue", ...(e.label ? [e.label] : [])]
        case "Error": return "<error>"
    }
}

function forLoop(e: Extract<A.Expr, { kind: "For" }>): Sx {
    const label = e.label ? [`${e.label}:`] : []
    switch (e.form) {
        case "infinite": return ["for", ...label, block(e.body)]
        case "cond": return ["for", ...label, expr(e.expr!), block(e.body)]
        case "let": return ["for-let", ...label, pattern(e.pattern!), expr(e.expr!), block(e.body)]
        case "in": return [e.await ? "for-await" : "for-in", ...label, pattern(e.pattern!), ...opt(e.pattern2, pattern), expr(e.expr!), block(e.body)]
    }
}

export function pattern(p: A.Pattern): Sx {
    switch (p.kind) {
        case "PWild": return "_"
        case "PBind": return p.mut ? ["mut", p.name] : p.name
        case "PLit": return expr(p.value)
        case "PRange": return [p.op, p.start ? expr(p.start) : "_", p.end ? expr(p.end) : "_"]
        case "PPath": return p.path.join(".")
        case "PCall": return [p.path.join("."), ...p.args.map(pattern), ...(p.rest ? [".."] : [])]
        case "PStruct": return [p.path ? p.path.join(".") : "r", ...p.fields.map((f): Sx => (f.pattern ? [f.name, pattern(f.pattern)] : [f.name])), ...(p.rest ? [".."] : [])]
        case "PTuple": return ["t", ...p.elems.map(pattern), ...(p.rest ? [".."] : [])]
        case "POr": return ["|", ...p.alts.map(pattern)]
        case "PError": return "<error>"
    }
}
