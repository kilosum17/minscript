// S-expression dump of the HIR (`ms hir`), ported from minscript/src/hir_dump.ts.
//
//   (fun area (params (s Shape)) -> f64
//     (match s ((variant Shape.Circle r) (* r r)) …))
//
// Locals print by name; when two different locals share a name in one function, the later ones get
// `'2`, `'3` … so shadowing stays visible. Temporaries introduced by lowering start with `$`.
package hir

import "app.lexer.{js_number, json_quote}"
import "app.resolve.{Sym}"
import "app.check.{Ty, VarState, show_ty}"

let WIDTH = 100

/// An S-expression: an atom, or a list.
union X = {
    XA(string)
    XL(Vec[X])
}

/// The length JavaScript would give the text (UTF-16 units): stage 0 measures widths that way.
fun js_len(s: &str) -> int {
    var n = 0
    for c in s.chars() {
        n += if (c as int) < 0x10000 { 1 } else { 2 }
    }
    n
}

fun flat(x: &X) -> string {
    match x {
        XA(s) => s.clone()
        XL(items) => "(${items.map(#{ i => flat(i) }).join(" ")})"
    }
}

fun layout(x: &X, indent: int) -> string {
    let f = flat(x)
    let XL(items) = x else { return f }
    if indent + js_len(f) <= WIDTH || items.is_empty() {
        return f
    }
    var line = "(${flat(items[0])}"
    var i = 1
    for i < items.len() {
        let XA(s) = &items[i] else { break }
        if js_len(line) + 1 + js_len(s) >= 50 {
            break
        }
        line += " ${s}"
        i += 1
    }
    var pad = ""
    var k = 0
    for k < indent + 2 {
        pad += " "
        k += 1
    }
    var lines = [line]
    for i < items.len() {
        lines.push("${pad}${layout(items[i], indent + 2)}")
        i += 1
    }
    "${lines.join("\n")})"
}

fun a(s: &str) -> X { XA(s.to_str()) }

fun cat(head: Vec[X], rest: Vec[X]) -> Vec[X] {
    var out = head
    out.extend(rest)
    out
}

/// The names of one function's locals.
type Names = { names: Map[int, string] = m{}, counts: Map[string, int] = m{} }

impl Names {
    fun of(&mut this, sym: int, base: &str) -> string {
        if let Some(known) = this.names.get(sym) {
            return known
        }
        let n = (this.counts.get(base) ?? 0) + 1
        this.counts[base.to_str()] = n
        let name = if n == 1 { base.to_str() } else { "${base}'${n}" }
        this.names[sym] = name.clone()
        name
    }
}

type Dumper = { vars: Vec[VarState], syms: Vec[Sym] }

pub fun dump_hir(p: &Program, vars: &Vec[VarState], syms: &Vec[Sym]) -> string {
    let d = Dumper { vars: vars.clone(), syms: syms.clone() }
    var out = [] as Vec[string]
    for t in p.types.iter() {
        out.push(layout(type_def(t), 0))
    }
    for g in p.globals.iter() {
        var names = Names {}
        out.push(layout(XL([a("global"), a("${g.name}:"), a(d.show(g.ty)), d.expr(g.value, names)]), 0))
    }
    for f in p.funs.iter() {
        out.push(layout(d.fun(f), 0))
    }
    "${out.join("\n\n")}\n"
}

fun field_x(f: &FieldDef) -> X { a(if f.optional { "${f.name}?" } else { f.name.clone() }) }

fun type_def(t: &HType) -> X {
    match t {
        TDStruct { name, fields, interfaces } => {
            var items = [a("struct"), a(name)]
            if !interfaces.is_empty() {
                items.push(XL(cat([a("impls")], interfaces.map(#{ i => a(i) }))))
            }
            items.push(XL(cat([a("fields")], fields.map(#{ f => field_x(f) }))))
            XL(items)
        }
        TDUnion { name, variants, interfaces } => {
            var items = [a("union"), a(name)]
            if !interfaces.is_empty() {
                items.push(XL(cat([a("impls")], interfaces.map(#{ i => a(i) }))))
            }
            for v in variants.iter() {
                items.push(if v.fields.is_empty() { a(v.name) } else { XL(cat([a(v.name)], v.fields.map(#{ f => field_x(f) }))) })
            }
            XL(items)
        }
        TDInter { name, methods } => XL(cat([a("inter"), a(name)], methods.map(#{ m => a(m) })))
    }
}

fun lit(v: &HLit) -> string {
    match v {
        LUnit => "t()"
        LStr(s) => json_quote(s)
        LBig(d) => d.clone()
        LNum(x) => js_number(x)
        LBool(b) => if b { "true" } else { "false" }
    }
}

fun local_name(names: &mut Names, l: &HLocal) -> string { names.of(l.sym, l.name) }

impl Dumper {
    fun show(&this, t: &Ty) -> string { show_ty(t, this.vars, this.syms) }

    fun fun(&this, f: &HFun) -> X {
        var names = Names {}
        var params = [a("params")]
        if let Some(r) = &f.recv {
            params.push(XL([a(local_name(names, r)), a("self")]))
        }
        for p in f.params.iter() {
            params.push(XL([a(local_name(names, p)), a(this.show(p.ty))]))
        }
        var head = [a("fun"), a(f.name)]
        if f.is_async {
            head.push(a("async"))
        }
        head.push(XL(params))
        head.push(a("->"))
        head.push(a(this.show(f.ret)))
        match &f.body {
            None => head.push(XL([a("extern"), a(json_quote(f.abi ?? ""))]))
            Some(b) => head.push(this.block(b, names))
        }
        XL(head)
    }

    fun block(&this, b: &HBlock, n: &mut Names) -> X {
        XL(cat([a("do")], this.block_items(b, n)))
    }

    fun block_items(&this, b: &HBlock, n: &mut Names) -> Vec[X] {
        var items = [] as Vec[X]
        for s in b.stmts.iter() {
            items.push(this.stmt(s, n))
        }
        if let Some(v) = &b.value {
            items.push(this.expr(v.get(), n))
        }
        items
    }

    fun stmt(&this, s: &HStmt, n: &mut Names) -> X {
        match s {
            HDo(e) => this.expr(e, n)
            HLet { local, value } => {
                let name = local_name(n, local)
                XL([a(if local.mutable { "var" } else { "let" }), a("${name}:"), a(this.show(local.ty)), this.expr(value, n)])
            }
        }
    }

    fun list(&this, head: X, es: &Vec[HExpr], n: &mut Names) -> X {
        var items = [head]
        for e in es.iter() {
            items.push(this.expr(e, n))
        }
        XL(items)
    }

    fun elems(&this, head: &str, es: &Vec[HElem], n: &mut Names) -> X {
        var items = [a(head)]
        for el in es.iter() {
            items.push(match el {
                HValue(x) => this.expr(x, n)
                HSpread(x) => XL([a("..."), this.expr(x, n)])
            })
        }
        XL(items)
    }

    fun fields(&this, head: &str, fs: &Vec[HField], n: &mut Names) -> X {
        var items = [a(head)]
        for f in fs.iter() {
            items.push(XL([a(f.name), this.expr(f.value, n)]))
        }
        XL(items)
    }

    fun opt(&this, e: &Box[HExpr]?, n: &mut Names) -> X {
        match e {
            Some(x) => this.expr(x.get(), n)
            None => a("_")
        }
    }

    fun expr(&this, e: &HExpr, n: &mut Names) -> X {
        match &e.kind {
            KLit(v) => {
                let ty = this.show(e.ty)
                match v {
                    LBig(d) => if ty == "i64" || ty == "u64" { a("${d}n") } else { a(d) }
                    LNum(x) => {
                        let s = js_number(x)
                        let integral = !s.contains(".") && !s.contains("e") && s != "NaN" && s != "Infinity" && s != "-Infinity"
                        if integral && (ty == "f32" || ty == "f64") { a("${s}.0") } else { a(s) }
                    }
                    _ => a(lit(v))
                }
            }
            KChar(c) => a("'${c}'")
            KLocal { sym, name } => a(n.of(sym, name))
            KGlobal(g) => a("@${g}")
            KFn(f) => a("#${f}")
            KCall { callee, args, .. } => this.list(a(callee), args, n)
            KDyncall { recv, method, args } => {
                var items = [a("dyn"), this.expr(recv.get(), n), a(method)]
                for x in args.iter() {
                    items.push(this.expr(x, n))
                }
                XL(items)
            }
            KCallValue { callee, args } => {
                var items = [a("callv"), this.expr(callee.get(), n)]
                for x in args.iter() {
                    items.push(this.expr(x, n))
                }
                XL(items)
            }
            KCopy(x) => XL([a("copy"), this.expr(x.get(), n)])
            KWstatic { witness, method, args } => {
                let w = match witness {
                    Some(SParam(s)) => this.syms[s].name.clone()
                    _ => "?"
                }
                this.list(a("wstatic:${w}.${method}"), args, n)
            }
            KExtern { path, args, .. } => match args {
                None => a("extern:${path}")
                Some(xs) => this.list(a("extern:${path}"), xs, n)
            }
            KStruct { type_name, fields } => {
                var items = [a("struct"), a(type_name)]
                for f in fields.iter() {
                    items.push(XL([a(f.name), this.expr(f.value, n)]))
                }
                XL(items)
            }
            KVariant { union_name, variant, fields } => {
                if fields.is_empty() { a("${union_name}.${variant}") } else { this.list(a("${union_name}.${variant}"), fields, n) }
            }
            KRecord(fs) => this.fields("record", fs, n)
            KTuple(xs) => this.list(a("tuple"), xs, n)
            KVec(xs) => this.elems("vec", xs, n)
            KArray(xs) => this.elems("array", xs, n)
            KSet(xs) => this.elems("set", xs, n)
            KMap(entries) => {
                var items = [a("map")]
                for en in entries.iter() {
                    items.push(match en {
                        HEntrySpread(x) => XL([a("..."), this.expr(x, n)])
                        HPair { key, value } => XL([this.expr(key, n), this.expr(value, n)])
                    })
                }
                XL(items)
            }
            KRange { start, end, inclusive } => XL([a(if inclusive { "..=" } else { ".." }), this.opt(start, n), this.opt(end, n)])
            KField { object, name } => XL([a("."), this.expr(object.get(), n), a(name)])
            KIndex { object, index, map } => XL([a(if map { "map-get" } else { "index" }), this.expr(object.get(), n), this.expr(index.get(), n)])
            KUnary { op, expr } => XL([a(op), this.expr(expr.get(), n)])
            KBinary { op, left, right } => XL([a(op), this.expr(left.get(), n), this.expr(right.get(), n)])
            KAnd { left, right } => XL([a("and"), this.expr(left.get(), n), this.expr(right.get(), n)])
            KOr { left, right } => XL([a("or"), this.expr(left.get(), n), this.expr(right.get(), n)])
            KTruthy { expr, of } => XL([a(if of == "option" { "is-some" } else { "is-ok" }), this.expr(expr.get(), n)])
            KConcat(parts) => this.list(a("concat"), parts, n)
            KToStr { expr, .. } => XL([a("to_str"), this.expr(expr.get(), n)])
            KWiden(x) => XL([a("widen"), this.expr(x.get(), n)])
            KCast { expr, to } => XL([a("cast"), this.expr(expr.get(), n), a(this.show(to))])
            KAssign { target, op, value } => XL([a(op), this.expr(target.get(), n), this.expr(value.get(), n)])
            KIf { cond, then, else_block } => {
                var items = [a("if"), this.expr(cond.get(), n), this.block(then, n)]
                if let Some(b) = else_block {
                    items.push(this.block(b, n))
                }
                XL(items)
            }
            KMatch { subject, arms } => {
                var items = [a("match"), this.expr(subject.get(), n)]
                for arm in arms.iter() {
                    var parts = [this.pattern(arm.pattern, n)]
                    if let Some(g) = &arm.guard {
                        parts.push(XL([a("if"), this.expr(g, n)]))
                    }
                    parts.push(this.expr(arm.body, n))
                    items.push(XL(parts))
                }
                XL(items)
            }
            KLoop { label, body, step } => {
                var items = [a("loop")]
                if let Some(l) = label {
                    items.push(a("${l}:"))
                }
                if let Some(s) = step {
                    items.push(XL(cat([a("step")], this.block_items(s, n))))
                }
                items.push(this.block(body, n))
                XL(items)
            }
            KBreak { label, value } => {
                var items = [a("break")]
                if let Some(l) = label {
                    items.push(a(l))
                }
                if let Some(v) = value {
                    items.push(this.expr(v.get(), n))
                }
                XL(items)
            }
            KContinue(label) => match label {
                Some(l) => XL([a("continue"), a(l)])
                None => XL([a("continue")])
            }
            KReturn(value) => match value {
                Some(v) => XL([a("return"), this.expr(v.get(), n)])
                None => XL([a("return")])
            }
            KBlock(b) => this.block(b, n)
            KClosure { params, captures, body } => {
                var ps = [a("params")]
                for p in params.iter() {
                    ps.push(a(local_name(n, p)))
                }
                var items = [a("closure"), XL(ps)]
                if !captures.is_empty() {
                    var cs = [a("captures")]
                    for c in captures.iter() {
                        let name = n.of(c.sym, c.name)
                        cs.push(a(if c.mode == "move" { name } else if c.mode == "mut" { "&mut ${name}" } else { "&${name}" }))
                    }
                    items.push(XL(cs))
                }
                items.push(this.block(body, n))
                XL(items)
            }
            KAwait(x) => XL([a("await"), this.expr(x.get(), n)])
            KSelect { arms, else_expr } => {
                var items = [a("select")]
                for arm in arms.iter() {
                    items.push(XL([this.pattern(arm.pattern, n), a("="), this.expr(arm.wait, n), this.expr(arm.body, n)]))
                }
                if let Some(x) = else_expr {
                    items.push(XL([a("else"), this.expr(x.get(), n)]))
                }
                XL(items)
            }
            KRecover(b) => XL([a("recover"), this.block(b, n)])
            KUnsupported(what) => a("<unsupported: ${what}>")
        }
    }

    fun pattern(&this, p: &HPat, n: &mut Names) -> X {
        match p {
            QWild => a("_")
            QBind(l) => a(local_name(n, l))
            QLit(v) => a(lit(v))
            QRange { start, end, inclusive } => {
                let s = match start {
                    Some(v) => lit(v)
                    None => "_"
                }
                let e = match end {
                    Some(v) => lit(v)
                    None => "_"
                }
                XL([a(if inclusive { "..=" } else { ".." }), a(s), a(e)])
            }
            QVariant { union_name, variant, fields } => {
                if fields.is_empty() {
                    return a("${union_name}.${variant}")
                }
                var items = [a("${union_name}.${variant}")]
                for f in fields.iter() {
                    items.push(this.pattern(f, n))
                }
                XL(items)
            }
            QFields(fs) => {
                var items = [a("fields")]
                for f in fs.iter() {
                    items.push(XL([a(f.name), this.pattern(f.pattern, n)]))
                }
                XL(items)
            }
            QTuple(es) => {
                var items = [a("t")]
                for x in es.iter() {
                    items.push(this.pattern(x, n))
                }
                XL(items)
            }
            QOr(alts) => {
                var items = [a("|")]
                for x in alts.iter() {
                    items.push(this.pattern(x, n))
                }
                XL(items)
            }
            QOk(v) => XL([a("ok"), this.pattern(v.get(), n)])
            QFail(payload) => match payload.get() {
                QWild => a("fail")
                other => XL([a("fail"), this.pattern(other, n)])
            }
        }
    }
}
