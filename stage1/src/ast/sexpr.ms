// The S-expression dump of the AST (`.ast` format), ported from minscript/src/sexpr.ts: the same text,
// so stage 0 and stage 1 can be compared. A form that doesn't fit in WIDTH columns is broken onto
// indented lines.
package ast

import "app.lexer.{json_quote}"

let WIDTH: int = 100

/// An S-expression: an atom, or a list.
union Sx = {
    Atom(string)
    List(Vec[Sx])
}

pub fun print_file(f: &File) -> string {
    "${layout(file_sx(f), 0)}\n"
}

// ---- layout -------------------------------------------------------------------------------------

/// The length JavaScript would give the text (UTF-16 units): stage 0 measures widths that way.
fun js_len(s: &str) -> int {
    var n = 0
    for c in s.chars() {
        n += if (c as int) < 0x10000 { 1 } else { 2 }
    }
    n
}

fun flat(x: &Sx) -> string {
    match x {
        Atom(s) => s.clone()
        List(items) => "(${items.map(#{ i => flat(i) }).join(" ")})"
    }
}

fun layout(x: &Sx, indent: int) -> string {
    let f = flat(x)
    let List(items) = x else { return f }
    if indent + js_len(f) <= WIDTH {
        return f
    }
    // keep the head (and short atoms right after it) on the first line
    var line = "(${flat(items[0])}"
    var i = 1
    for i < items.len() {
        let Atom(s) = &items[i] else { break }
        if js_len(line) + 1 + js_len(s) >= 40 {
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
    var out = line
    for i < items.len() {
        out += "\n${pad}${layout(items[i], indent + 2)}"
        i += 1
    }
    "${out})"
}

// ---- building ------------------------------------------------------------------------------------

fun atom(s: &str) -> Sx { Atom(s.to_str()) }

fun list(items: Vec[Sx]) -> Sx { List(items) }

fun qstr(s: &str) -> Sx { Atom(json_quote(s)) }

fun file_sx(f: &File) -> Sx {
    var out = [atom("file"), atom(f.package_path.join("."))]
    for i in f.imports.iter() {
        out.push(import_sx(i))
    }
    for itm in f.items.iter() {
        out.push(item(itm))
    }
    List(out)
}

fun import_sx(i: &Import) -> Sx {
    var out = [atom("import")]
    if i.is_pub {
        out.push(atom("pub"))
    }
    out.push(qstr(i.path))
    if let Some(a) = &i.alias {
        out.push(atom("as"))
        out.push(atom(a))
    }
    List(out)
}

fun generics(gs: &Vec[GenericParam], out: &mut Vec[Sx]) {
    if gs.is_empty() {
        return
    }
    var g = [atom("generics")]
    for p in gs.iter() {
        if p.bounds.is_empty() {
            g.push(atom(p.name))
        } else {
            var b = [atom(p.name)]
            for t in p.bounds.iter() {
                b.push(type_sx(t))
            }
            g.push(List(b))
        }
    }
    out.push(List(g))
}

fun types_sx(head: &str, ts: &Vec[Type]) -> Sx {
    var out = [atom(head)]
    for t in ts.iter() {
        out.push(type_sx(t))
    }
    List(out)
}

fun fun_sx(f: &FunDecl) -> Sx {
    var out = [atom("fun"), atom(f.name)]
    if f.is_pub {
        out.push(atom("pub"))
    }
    if f.is_async {
        out.push(atom("async"))
    }
    generics(f.generics, out)
    var params = [atom("params")]
    if let Some(r) = &f.receiver {
        params.push(atom(r))
    }
    for p in f.params.iter() {
        params.push(param(p))
    }
    out.push(List(params))
    if let Some(t) = &f.ret {
        out.push(List([atom("->"), type_sx(t)]))
    }
    if let Some(b) = &f.body {
        out.push(block(b))
    }
    List(out)
}

fun param(p: &Param) -> Sx {
    var out = [] as Vec[Sx]
    if p.is_mut {
        out.push(atom("mut"))
    }
    out.push(atom("${if p.variadic { "..." } else { "" }}${p.name}"))
    out.push(type_sx(p.ty))
    List(out)
}

fun field(f: &Field) -> Sx {
    var out = [] as Vec[Sx]
    if f.is_pub {
        out.push(atom("pub"))
    }
    out.push(atom(f.name))
    out.push(type_sx(f.ty))
    if let Some(d) = &f.default {
        out.push(List([atom("="), expr(d)]))
    }
    List(out)
}

fun fields_sx(head: &str, fs: &Vec[Field]) -> Sx {
    var out = [atom(head)]
    for f in fs.iter() {
        out.push(field(f))
    }
    List(out)
}

fun variant(v: &Variant) -> Sx {
    if let Some(ts) = &v.tuple {
        var out = [atom(v.name)]
        for t in ts.iter() {
            out.push(type_sx(t))
        }
        return List(out)
    }
    if let Some(fs) = &v.fields {
        return List([atom(v.name), fields_sx("fields", fs)])
    }
    atom(v.name)
}

fun item(itm: &Item) -> Sx {
    match itm {
        Fun(f) => fun_sx(f)
        TypeDef(t) => {
            var out = [atom("type"), atom(t.name)]
            if t.is_pub {
                out.push(atom("pub"))
            }
            generics(t.generics, out)
            if !t.impls.is_empty() {
                out.push(types_sx("impls", t.impls))
            }
            match &t.body {
                Struct(b) => {
                    out.push(fields_sx("fields", b.fields))
                    for m in b.methods.iter() {
                        out.push(fun_sx(m))
                    }
                }
                Alias(ty) => out.push(type_sx(ty))
            }
            List(out)
        }
        Union(u) => {
            var out = [atom("union"), atom(u.name)]
            if u.is_pub {
                out.push(atom("pub"))
            }
            generics(u.generics, out)
            if !u.impls.is_empty() {
                out.push(types_sx("impls", u.impls))
            }
            var vs = [atom("variants")]
            for v in u.variants.iter() {
                vs.push(variant(v))
            }
            out.push(List(vs))
            for m in u.methods.iter() {
                out.push(fun_sx(m))
            }
            List(out)
        }
        Inter(d) => {
            var out = [atom("inter"), atom(d.name)]
            if d.is_pub {
                out.push(atom("pub"))
            }
            generics(d.generics, out)
            if !d.supers.is_empty() {
                out.push(types_sx("supers", d.supers))
            }
            if let Some(c) = &d.composition {
                out.push(type_sx(c))
            }
            if let Some(ms) = &d.methods {
                for m in ms.iter() {
                    out.push(fun_sx(m))
                }
            }
            List(out)
        }
        Impl(d) => {
            var out = [atom("impl")]
            generics(d.generics, out)
            if !d.interfaces.is_empty() {
                out.push(types_sx("for", d.interfaces))
            }
            out.push(type_sx(d.target))
            for m in d.methods.iter() {
                out.push(fun_sx(m))
            }
            List(out)
        }
        Let(d) => {
            var out = [atom("let")]
            if d.is_pub {
                out.push(atom("pub"))
            }
            out.push(atom(d.name))
            if let Some(t) = &d.ty {
                out.push(type_sx(t))
            }
            out.push(expr(d.value))
            List(out)
        }
        Extern(d) => {
            var out = [atom("extern"), qstr(d.abi)]
            for f in d.funs.iter() {
                out.push(fun_sx(f))
            }
            List(out)
        }
    }
}

pub fun type_sx(t: &Type) -> Sx {
    match &t.kind {
        TName { path, args } => {
            let name = path.join(".")
            if args.is_empty() {
                return atom(name)
            }
            var out = [atom(name)]
            for a in args.iter() {
                out.push(type_sx(a))
            }
            List(out)
        }
        TOption(inner) => List([atom("Option"), type_sx(inner.get())])
        TRef { is_mut, inner } => List([atom(if is_mut { "&mut" } else { "&" }), type_sx(inner.get())])
        TPtr { is_mut, inner } => List([atom(if is_mut { "*mut" } else { "*" }), type_sx(inner.get())])
        TTuple(elems) => types_sx("t", elems)
        TRecord(fs) => fields_sx("r", fs)
        TFn { params, ret } => List([atom("fn"), types_sx("params", params), type_sx(ret.get())])
        TTypeOf(path) => List([atom("TypeOf"), atom(path.join("."))])
        TLiteral(lit) => match lit {
            LitStr(s) => qstr(s)
            LitInt(d) => atom(d)
            LitBool(b) => atom(if b { "true" } else { "false" })
        }
        TUnion(ms) => types_sx("|", ms)
        TIntersection(ms) => types_sx("and", ms)
        TError => atom("<error>")
    }
}

fun block(b: &Block) -> Sx {
    var out = [atom("block")]
    for s in b.stmts.iter() {
        out.push(stmt(s))
    }
    List(out)
}

fun stmt(s: &Stmt) -> Sx {
    match s {
        ExprStmt(e) => if e.semi { List([atom(";"), expr(e.expr)]) } else { expr(e.expr) }
        Let(l) => {
            let head = if l.short { if l.mutable { ":==" } else { ":=" } } else { if l.mutable { "var" } else { "let" } }
            var out = [atom(head), pattern(l.pattern)]
            if let Some(t) = &l.ty {
                out.push(type_sx(t))
            }
            out.push(expr(l.value))
            if let Some(b) = &l.else_branch {
                out.push(List([atom("else"), block(b)]))
            }
            List(out)
        }
    }
}

fun elem(e: &Elem) -> Sx {
    match e {
        EValue(x) => expr(x)
        ESpread { expr: x, .. } => List([atom("..."), expr(x)])
    }
}

fun elems(head: &str, es: &Vec[Elem]) -> Sx {
    var out = [atom(head)]
    for e in es.iter() {
        out.push(elem(e))
    }
    List(out)
}

fun is_ident(s: &str) -> bool {
    if s.is_empty() {
        return false
    }
    var i = 0
    for i < s.len() {
        let c = s.byte_at(i) as int
        let alpha = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c == 0x5f
        if !alpha && !(i > 0 && c >= 0x30 && c <= 0x39) {
            return false
        }
        i += 1
    }
    true
}

fun record_items(out: &mut Vec[Sx], fs: &Vec[RecordItem]) {
    for f in fs.iter() {
        match f {
            RSpread { expr: x, .. } => out.push(List([atom("..."), expr(x)]))
            RField(rf) => {
                let key = if is_ident(rf.key) { atom(rf.key) } else { qstr(rf.key) }
                match &rf.value {
                    Some(v) => out.push(List([key, expr(v)]))
                    None => out.push(List([key]))
                }
            }
        }
    }
}

fun char_lit(v: &str) -> string {
    let j = json_quote(v)
    let inner = j.substring(1, j.len() - 1).replace("\\\"", "\"").replace("'", "\\'")
    "'${inner}'"
}

fun boxed(head: &str, x: &Box[Expr]) -> Sx { List([atom(head), expr(x.get())]) }

fun opt_expr(x: &Box[Expr]?) -> Sx {
    match x {
        Some(b) => expr(b.get())
        None => atom("_")
    }
}

pub fun expr(e: &Expr) -> Sx {
    match &e.kind {
        Ident(name) => atom(name)
        This => atom("this")
        Int(d) => atom(d)
        Float(x) => atom("${x}")
        Str { value, raw } => atom(if raw { "r${json_quote(value)}" } else { json_quote(value) })
        Template(parts) => {
            var out = [atom("template")]
            for p in parts.iter() {
                match p {
                    Text(s) => out.push(qstr(s))
                    Interp(x) => out.push(expr(x))
                }
            }
            List(out)
        }
        Char(c) => atom(char_lit(c))
        Bool(b) => atom(if b { "true" } else { "false" })
        Nil => atom("nil")
        Paren(x) => boxed("paren", x)
        VecLit(es) => elems("vec", es)
        ArrayLit(es) => elems("array", es)
        TupleLit(es) => elems("tuple", es)
        RecordLit(fs) => {
            var out = [atom("record")]
            record_items(out, fs)
            List(out)
        }
        MapLit(entries) => {
            var out = [atom("map")]
            for m in entries.iter() {
                match m {
                    MSpread { expr: x, .. } => out.push(List([atom("..."), expr(x)]))
                    MEntry(me) => out.push(List([expr(me.key), expr(me.value)]))
                }
            }
            List(out)
        }
        SetLit(es) => elems("set", es)
        Inferred(fs) => {
            var out = [atom("_")]
            record_items(out, fs)
            List(out)
        }
        StructLit { ty, fields } => {
            var out = [atom("struct"), expr(ty.get())]
            record_items(out, fields)
            List(out)
        }
        Closure { captures, params, ret, body } => {
            var out = [atom("closure")]
            if let Some(cs) = captures {
                var c = [atom("captures")]
                for cap in cs.iter() {
                    c.push(atom(if cap.mode == "move" { cap.name.clone() } else if cap.mode == "ref" { "&${cap.name}" } else { "&mut ${cap.name}" }))
                }
                out.push(List(c))
            }
            if let Some(ps) = params {
                var p = [atom("params")]
                for cp in ps.iter() {
                    let name = if cp.is_mut { "mut ${cp.name}" } else { cp.name.clone() }
                    match &cp.ty {
                        None => p.push(atom(name))
                        Some(t) => p.push(List([atom(name), type_sx(t)]))
                    }
                }
                out.push(List(p))
            }
            if let Some(t) = ret {
                out.push(List([atom("->"), type_sx(t)]))
            }
            for s in body.stmts.iter() {
                out.push(stmt(s))
            }
            List(out)
        }
        Unary { op, expr: x } => List([atom(if op == "*" { "deref" } else { op }), expr(x.get())])
        Await(x) => boxed("await", x)
        Binary { op, left, right } => List([atom(op), expr(left.get()), expr(right.get())])
        Assign { op, target, value } => List([atom(op), expr(target.get()), expr(value.get())])
        RangeExpr { op, start, end } => List([atom(op), opt_expr(start), opt_expr(end)])
        As { expr: x, ty } => List([atom("as"), expr(x.get()), type_sx(ty)])
        Or { expr: x, name, rhs, .. } => {
            var out = [atom("or"), expr(x.get())]
            if let Some(n) = name {
                out.push(atom(n))
                out.push(atom("=>"))
            }
            out.push(expr(rhs.get()))
            List(out)
        }
        Member { object, name, .. } => List([atom("."), expr(object.get()), atom(name)])
        OptMember { object, name, .. } => List([atom("?."), expr(object.get()), atom(name)])
        Call { callee, args } => {
            var out = [atom("call"), expr(callee.get())]
            for a in args.iter() {
                out.push(elem(a))
            }
            List(out)
        }
        IndexExpr { object, index } => List([atom("index"), expr(object.get()), expr(index.get())])
        GenericApply { target, args } => {
            var out = [atom("generic"), expr(target.get())]
            for a in args.iter() {
                out.push(type_sx(a))
            }
            List(out)
        }
        Try(x) => boxed("?", x)
        If { cond, then, else_branch } => {
            let c = match cond {
                CExpr(x) => expr(x.get())
                CLet(lc) => List([atom("let"), pattern(lc.pattern), expr(lc.value.get())])
            }
            var out = [atom("if"), c, block(then)]
            if let Some(b) = else_branch {
                out.push(expr(b.get()))
            }
            List(out)
        }
        Match { subject, arms } => {
            var out = [atom("match")]
            if let Some(s) = subject {
                out.push(expr(s.get()))
            }
            for a in arms.iter() {
                var arm = [atom("=>")]
                match &a.pattern {
                    Some(p) => arm.push(pattern(p))
                    None => if let Some(t) = &a.test { arm.push(expr(t)) }
                }
                if let Some(g) = &a.guard {
                    arm.push(List([atom("if"), expr(g)]))
                }
                arm.push(expr(a.body))
                out.push(List(arm))
            }
            List(out)
        }
        Select { arms, else_branch } => {
            var out = [atom("select")]
            for a in arms.iter() {
                var arm = [atom("=>")]
                if let Some(p) = &a.pattern {
                    arm.push(pattern(p))
                    arm.push(atom("="))
                }
                arm.push(expr(a.expr))
                arm.push(expr(a.body))
                out.push(List(arm))
            }
            if let Some(b) = else_branch {
                out.push(List([atom("else"), expr(b.get())]))
            }
            List(out)
        }
        For { label, form, is_await, pattern: p1, pattern2, expr: x, body } => {
            let head = match form {
                "let" => "for-let"
                "in" => if is_await { "for-await" } else { "for-in" }
                _ => "for"
            }
            var out = [atom(head)]
            if let Some(l) = label {
                out.push(atom("${l}:"))
            }
            if let Some(p) = p1 {
                out.push(pattern(p))
            }
            if let Some(p) = pattern2 {
                out.push(pattern(p))
            }
            if let Some(v) = x {
                out.push(expr(v.get()))
            }
            out.push(block(body))
            List(out)
        }
        BlockExpr(b) => block(b)
        Unsafe(b) => List([atom("unsafe"), block(b)])
        Recover(b) => List([atom("recover"), block(b)])
        Return(v) => {
            var out = [atom("return")]
            if let Some(x) = v {
                out.push(expr(x.get()))
            }
            List(out)
        }
        Break { label, value } => {
            var out = [atom("break")]
            if let Some(l) = label {
                out.push(atom(l))
            }
            if let Some(x) = value {
                out.push(expr(x.get()))
            }
            List(out)
        }
        Continue(label) => {
            var out = [atom("continue")]
            if let Some(l) = label {
                out.push(atom(l))
            }
            List(out)
        }
        Error => atom("<error>")
    }
}

pub fun pattern(p: &Pattern) -> Sx {
    match &p.kind {
        PWild => atom("_")
        PBind { name, is_mut } => if is_mut { List([atom("mut"), atom(name)]) } else { atom(name) }
        PLit(x) => expr(x.get())
        PRange { op, start, end } => List([atom(op), opt_expr(start), opt_expr(end)])
        PPath(path) => atom(path.join("."))
        PCall { path, args, rest } => {
            var out = [atom(path.join("."))]
            for a in args.iter() {
                out.push(pattern(a))
            }
            if rest {
                out.push(atom(".."))
            }
            List(out)
        }
        PStruct { path, fields, rest } => {
            var out = [atom(match path { Some(ps) => ps.join("."), None => "r" })]
            for f in fields.iter() {
                match &f.pattern {
                    Some(fp) => out.push(List([atom(f.name), pattern(fp)]))
                    None => out.push(List([atom(f.name)]))
                }
            }
            if rest {
                out.push(atom(".."))
            }
            List(out)
        }
        PTuple { elems: es, rest } => {
            var out = [atom("t")]
            for a in es.iter() {
                out.push(pattern(a))
            }
            if rest {
                out.push(atom(".."))
            }
            List(out)
        }
        POr(alts) => {
            var out = [atom("|")]
            for a in alts.iter() {
                out.push(pattern(a))
            }
            List(out)
        }
        PError => atom("<error>")
    }
}
