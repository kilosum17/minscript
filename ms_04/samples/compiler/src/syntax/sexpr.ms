package syntax

// The AST dump as S-expressions: the `.ast` format of the TypeScript compiler (src/sexpr.ts).
// Each node prints as `(Kind field=value …)`, leaving out spans, nulls, `false` and empty lists;
// nodes without a kind (parameters, arms, elements) print as `(…)`. Fields come in the order the
// TypeScript parser builds them, so the two dumps can be compared byte for byte.
//
// The printer works in two steps: each node becomes an `S` (a small generic tree), then `layout`
// lays it out: on one line when it fits in 100 columns, else one item per line.

import "std.json"

/// A printable value.
union S {
    /// null / undefined / false / an empty list: left out of a node's fields
    Omit
    /// already printed: a JSON string, a number, `true`
    Atom(str)
    List(Vec[S])
    /// `head` is "" for nodes without a kind
    Node(str, Vec[t(str, S)])
}

let WIDTH = 100

pub fn dump_file(f: File) -> str { render(file(f), 0) + "\n" }

// ---- rendering ---------------------------------------------------------------------------------

/// A rendered piece: its text, its width in UTF-16 units (what JavaScript's `.length` counts, as
/// the TypeScript printer measures lines), and whether it spans several lines. Carrying the width
/// avoids measuring every candidate line again: only atoms are ever scanned.
type R {
    text: str
    width: int
    multi: bool
}

fn render(v: S, depth: int) -> str { layout(v, depth).text }

fn layout(v: S, depth: int) -> R {
    match v {
        Omit => R { text: "_", width: 1, multi: false }
        Atom(a) => R { text: a, width: utf16_len(a), multi: false }
        List(xs) => wrap("[", "]", xs.map(#{ x, _i => layout(x, depth + 1) }), depth, false)
        Node(head, fields) => {
            var items = [] as Vec[R]
            for f in fields {
                if omitted(f.1) { continue }
                r := layout(f.1, depth + 1)
                items.push(R { text: "${f.0}=${r.text}", width: utf16_len(f.0) + 1 + r.width, multi: r.multi })
            }
            wrap(if head.is_empty() { "(" } else { "(${head}" }, ")", items, depth, !head.is_empty())
        }
    }
}

fn omitted(v: S) -> bool {
    match v {
        Omit => true
        List(xs) => xs.is_empty()
        _ => false
    }
}

fn wrap(open: str, close: str, items: Vec[R], depth: int, spaced: bool) -> R {
    if items.is_empty() { return R { text: open + close, width: utf16_len(open) + 1, multi: false } }
    var width = utf16_len(open) + 1 + (if spaced { 1 } else { 0 }) + items.len() - 1
    var multi = false
    for piece in items {
        width += piece.width
        if piece.multi { multi = true }
    }
    if width + depth * 2 <= WIDTH && !multi {
        sep := if spaced { " " } else { "" }
        return R { text: open + sep + items.map(#{ i, _n => i.text }).join(" ") + close, width, multi: false }
    }
    pad := indent(depth + 1)
    text := open + "\n" + items.map(#{ i, _n => pad + i.text }).join("\n") + "\n" + indent(depth) + close
    R { text, width, multi: true }
}

fn indent(n: int) -> str {
    var s = ""
    for _ in 0..n { s += "  " }
    s
}

/// The length JavaScript's `.length` gives: UTF-16 code units (a 4-byte UTF-8 sequence is two).
fn utf16_len(s: str) -> int {
    var n = 0
    for i in 0..s.len() {
        b := s.byte_at(i) as int
        if b & 0xc0 != 0x80 { n += if b >= 0xf0 { 2 } else { 1 } }
    }
    n
}

// ---- building blocks ---------------------------------------------------------------------------

fn str_(s: str) -> S { Atom(json.stringify(s)) }
fn int_(n: int) -> S { Atom("${n}") }
fn bool_(b: bool) -> S { if b { Atom("true") } else { Omit } }
fn opt_str(s: str?) -> S {
    match s {
        Some(x) => str_(x)
        None => Omit
    }
}
fn strs(xs: Vec[str]) -> S { List(xs.map(#{ x, _i => str_(x) })) }
fn node(head: str, fields: Vec[t(str, S)]) -> S { Node(head, fields) }

// ---- files and items ---------------------------------------------------------------------------

fn file(f: File) -> S {
    node("File", [t("package", strs(f.pkg)), t("imports", List(f.imports.map(#{ i, _n => import_(i) }))), t("items", List(f.items.map(#{ i, _n => item(i) })))])
}

fn import_(i: Import) -> S {
    node("Import", [t("isPub", bool_(i.is_pub)), t("path", str_(i.path)), t("alias", opt_str(i.alias))])
}

fn attrs(xs: Vec[Attribute]) -> S {
    List(xs.map(#{ a, _i =>
        node("Attribute", [t("name", str_(a.name)), t("args", List(a.args.map(#{ g, _n => node("", [t("name", str_(g.name)), t("paths", strs(g.paths))]) })))])
    }))
}

fn generics(xs: Vec[GenericParam]) -> S {
    List(xs.map(#{ g, _i => node("", [t("name", str_(g.name)), t("bounds", types(g.bounds))]) }))
}

fn fn_decl(f: FnDecl) -> S {
    let params: S = List(f.params.map(#{ p, _i => node("", [t("name", str_(p.name)), t("star", bool_(p.star)), t("variadic", bool_(p.variadic)), t("type", ty(p.ty))]) }))
    node("Fn", [
        t("attrs", attrs(f.attrs)), t("isPub", bool_(f.is_pub)), t("isAsync", bool_(f.is_async)), t("name", str_(f.name)),
        t("generics", generics(f.generics)), t("receiver", opt_str(f.receiver)), t("params", params), t("retStar", bool_(f.ret_star)),
        t("ret", opt_ty(f.ret)), t("body", match f.body {
            Some(b) => block(b)
            None => Omit
        }),
    ])
}

fn field_decl(f: FieldDecl) -> S {
    node("Field", [
        t("attrs", attrs(f.attrs)), t("isPub", bool_(f.is_pub)), t("mode", opt_str(f.mode)), t("name", str_(f.name)),
        t("type", ty(f.ty)), t("default", opt_expr(f.default)),
    ])
}

fn variant(v: Variant) -> S {
    node("Variant", [
        t("name", str_(v.name)),
        t("tuple", match v.tuple {
            Some(ts) => types(ts)
            None => Omit
        }),
        t("fields", match v.fields {
            Some(fs) => List(fs.map(#{ f, _i => field_decl(f) }))
            None => Omit
        }),
    ])
}

fn item(i: Item) -> S {
    match i.k {
        IFn(f) => fn_decl(f)
        TypeDecl { attrs: a, is_pub, name, generics: g, impls, members, alias } => node("TypeDecl", [
            t("attrs", attrs(a)), t("isPub", bool_(is_pub)), t("name", str_(name)), t("generics", generics(g)), t("impls", types(impls)),
            t("members", match members {
                Some(ms) => List(ms.map(#{ m, _n =>
                    match m {
                        MField(f) => field_decl(f)
                        MFn(f) => fn_decl(f)
                    }
                }))
                None => Omit
            }),
            t("alias", opt_ty(alias)),
        ])
        UnionDecl { attrs: a, is_pub, name, generics: g, impls, members } => node("UnionDecl", [
            t("attrs", attrs(a)), t("isPub", bool_(is_pub)), t("name", str_(name)), t("generics", generics(g)), t("impls", types(impls)),
            t("members", List(members.map(#{ m, _n =>
                match m {
                    UVariant(v) => variant(v)
                    UFn(f) => fn_decl(f)
                }
            }))),
        ])
        InterDecl { attrs: a, is_pub, name, generics: g, supers, methods, alias } => node("InterDecl", [
            t("attrs", attrs(a)), t("isPub", bool_(is_pub)), t("name", str_(name)), t("generics", generics(g)), t("supers", types(supers)),
            t("methods", match methods {
                Some(ms) => List(ms.map(#{ f, _n => fn_decl(f) }))
                None => Omit
            }),
            t("alias", opt_ty(alias)),
        ])
        ImplDecl { attrs: a, generics: g, inters, target, methods } => node("ImplDecl", [
            t("attrs", attrs(a)), t("generics", generics(g)), t("inters", types(inters)), t("target", ty(target)),
            t("methods", List(methods.map(#{ f, _n => fn_decl(f) }))),
        ])
        LetDecl { attrs: a, is_pub, name, ty: tt, value } => node("LetDecl", [
            t("attrs", attrs(a)), t("isPub", bool_(is_pub)), t("name", str_(name)), t("type", opt_ty(tt)), t("value", expr(value)),
        ])
        VarDecl { attrs: a, is_pub, shared, name, ty: tt, value } => node("VarDecl", [
            t("attrs", attrs(a)), t("isPub", bool_(is_pub)), t("shared", bool_(shared)), t("name", str_(name)), t("type", opt_ty(tt)), t("value", expr(value)),
        ])
        ExternDecl { attrs: a, abi, fns } => node("ExternDecl", [t("attrs", attrs(a)), t("abi", str_(abi)), t("fns", List(fns.map(#{ f, _n => fn_decl(f) })))])
    }
}

// ---- types -------------------------------------------------------------------------------------

fn types(xs: Vec[Type]) -> S { List(xs.map(#{ x, _i => ty(x) })) }

fn opt_ty(x: Type?) -> S {
    match x {
        Some(tt) => ty(tt)
        None => Omit
    }
}

fn ty(x: Type) -> S {
    match x.k {
        TName { path, args } => node("TName", [t("path", strs(path)), t("args", types(args))])
        TOptional { inner } => node("TOptional", [t("inner", ty(inner))])
        TTuple { elems } => node("TTuple", [t("elems", types(elems))])
        TRecord { fields } => node("TRecord", [t("fields", List(fields.map(#{ f, _i => node("", [t("name", str_(f.name)), t("type", ty(f.ty))]) })))])
        TFn { params, ret } => node("TFn", [t("params", List(params.map(#{ p, _i => node("", [t("star", bool_(p.star)), t("type", ty(p.ty))]) }))), t("ret", ty(ret))])
        TUnion { alts } => node("TUnion", [t("alts", types(alts))])
        TInter { parts } => node("TInter", [t("parts", types(parts))])
        TTypeOf { path } => node("TTypeOf", [t("path", strs(path))])
        TLit { value } => node("TLit", [t("value", match value {
            LStr(s) => str_(s)
            LInt(d) => Atom(d)
            LBool(b) => bool_(b)
        })])
        TError => node("TError", [])
    }
}

// ---- statements --------------------------------------------------------------------------------

fn block(b: Block) -> S { node("Block", [t("stmts", stmts(b.stmts))]) }

fn stmts(xs: Vec[Stmt]) -> S { List(xs.map(#{ s, _i => stmt(s) })) }

fn stmt(s: Stmt) -> S {
    match s.k {
        LetStmt { pattern: p, ty: tt, value, els } => node("LetStmt", [
            t("pattern", pattern(p)), t("type", opt_ty(tt)), t("value", expr(value)),
            t("else", match els {
                Some(b) => block(b)
                None => Omit
            }),
        ])
        VarStmt { shared, name, ty: tt, value } => node("VarStmt", [t("shared", bool_(shared)), t("name", str_(name)), t("type", opt_ty(tt)), t("value", expr(value))])
        ShortDecl { name, mutable, value } => node("ShortDecl", [t("name", str_(name)), t("mutable", bool_(mutable)), t("value", expr(value))])
        ExprStmt { expr: e, semi } => node("ExprStmt", [t("expr", expr(e)), t("semi", bool_(semi))])
    }
}

// ---- expressions -------------------------------------------------------------------------------

fn opt_expr(x: Expr?) -> S {
    match x {
        Some(e) => expr(e)
        None => Omit
    }
}

fn exprs(xs: Vec[Expr]) -> S { List(xs.map(#{ e, _i => expr(e) })) }

fn elems(xs: Vec[Elem]) -> S { List(xs.map(#{ e, _i => node("", [t("spread", bool_(e.spread)), t("value", expr(e.value))]) })) }

fn rec_items(xs: Vec[RecItem]) -> S {
    List(xs.map(#{ ri, _i =>
        match ri {
            RField { name, quoted, value, .. } => node("Field", [t("name", str_(name)), t("quoted", bool_(quoted)), t("value", opt_expr(value))])
            RSpread { value, .. } => node("Spread", [t("value", expr(value))])
        }
    }))
}

fn float_text(f: f64) -> str { json.stringify(f) }

fn expr(e: Expr) -> S {
    match e.k {
        Ident { name } => node("Ident", [t("name", str_(name))])
        This => node("This", [])
        SelfExpr => node("SelfExpr", [])
        Int { value } => node("Int", [t("value", Atom(value))])
        Float { value } => node("Float", [t("value", Atom(float_text(value)))])
        Str { value, raw, multiline } => node("Str", [t("value", str_(value)), t("raw", bool_(raw)), t("multiline", bool_(multiline))])
        Template { parts, exprs: xs, multiline } => node("Template", [t("parts", strs(parts)), t("exprs", exprs(xs)), t("multiline", bool_(multiline))])
        Char { value } => node("Char", [t("value", str_(value))])
        Byte { value } => node("Byte", [t("value", int_(value))])
        Bool { value } => node("Bool", [t("value", bool_(value))])
        Nil => node("Nil", [])
        VecLit { elems: xs } => node("Vec", [t("elems", elems(xs))])
        ArrayLit { elems: xs } => node("Array", [t("elems", elems(xs))])
        TupleLit { elems: xs } => node("Tuple", [t("elems", elems(xs))])
        SetLit { elems: xs } => node("Set", [t("elems", elems(xs))])
        Record { items } => node("Record", [t("items", rec_items(items))])
        Inferred { items } => node("Inferred", [t("items", rec_items(items))])
        Struct { ty: tt, items } => node("Struct", [t("type", expr(tt)), t("items", rec_items(items))])
        MapLit { entries } => node("Map", [t("entries", List(entries.map(#{ en, _i =>
            match en {
                MEntry { key, value, .. } => node("Entry", [t("key", expr(key)), t("value", expr(value))])
                MSpread { value, .. } => node("Spread", [t("value", expr(value))])
            }
        })))])
        Closure { params, ret, body } => node("Closure", [
            t("params", match params {
                Some(ps) => List(ps.map(#{ p, _i => node("", [t("name", str_(p.name)), t("isVar", bool_(p.is_var)), t("star", bool_(p.star)), t("type", opt_ty(p.ty))]) }))
                None => Omit
            }),
            t("ret", opt_ty(ret)), t("body", stmts(body)),
        ])
        Paren { expr: x } => node("Paren", [t("expr", expr(x))])
        Unary { op, operand } => node("Unary", [t("op", str_(op)), t("operand", expr(operand))])
        Await { operand } => node("Await", [t("operand", expr(operand))])
        Binary { op, left, right } => node("Binary", [t("op", str_(op)), t("left", expr(left)), t("right", expr(right))])
        Assign { op, target, value } => node("Assign", [t("op", str_(op)), t("target", expr(target)), t("value", expr(value))])
        Range { inclusive, start, end } => node("Range", [t("inclusive", bool_(inclusive)), t("start", opt_expr(start)), t("end", opt_expr(end))])
        As { expr: x, ty: tt } => node("As", [t("expr", expr(x)), t("type", ty(tt))])
        Or { expr: x, name, rhs } => node("Or", [t("expr", expr(x)), t("name", opt_str(name)), t("rhs", expr(rhs))])
        Call { callee, args } => node("Call", [t("callee", expr(callee)), t("args", elems(args))])
        Index { target, index } => node("Index", [t("target", expr(target)), t("index", expr(index))])
        MemberE { target, name, optional } => node("Member", [t("target", expr(target)), t("name", str_(name)), t("optional", bool_(optional))])
        GenericApply { target, args } => node("GenericApply", [t("target", expr(target)), t("args", types(args))])
        Try { expr: x } => node("Try", [t("expr", expr(x))])
        If { pattern: p, cond, then, els } => node("If", [t("pattern", opt_pattern(p)), t("cond", expr(cond)), t("then", block(then)), t("else", opt_expr(els))])
        Match { subject, arms } => node("Match", [t("subject", opt_expr(subject)), t("arms", List(arms.map(#{ a, _i =>
            node("", [t("pattern", opt_pattern(a.pattern)), t("guard", opt_expr(a.guard)), t("cond", opt_expr(a.cond)), t("body", expr(a.body))])
        })))])
        Select { arms, els } => node("Select", [t("arms", List(arms.map(#{ a, _i =>
            node("", [t("pattern", opt_pattern(a.pattern)), t("expr", expr(a.expr)), t("body", expr(a.body))])
        }))), t("else", opt_expr(els))])
        Lock { places, body } => node("Lock", [t("places", exprs(places)), t("body", block(body))])
        For { label, form, is_await, pattern: p, pattern2, expr: x, body } => node("For", [
            t("label", opt_str(label)), t("form", str_(form)), t("isAwait", bool_(is_await)), t("pattern", opt_pattern(p)),
            t("pattern2", opt_pattern(pattern2)), t("expr", opt_expr(x)), t("body", block(body)),
        ])
        BlockE(b) => block(b)
        Unsafe { body } => node("Unsafe", [t("body", block(body))])
        Recover { body } => node("Recover", [t("body", block(body))])
        Return { value } => node("Return", [t("value", opt_expr(value))])
        Break { label, value } => node("Break", [t("label", opt_str(label)), t("value", opt_expr(value))])
        Continue { label } => node("Continue", [t("label", opt_str(label))])
        ErrorE => node("Error", [])
    }
}

// ---- patterns ----------------------------------------------------------------------------------

fn opt_pattern(x: Pattern?) -> S {
    match x {
        Some(p) => pattern(p)
        None => Omit
    }
}

fn patterns(xs: Vec[Pattern]) -> S { List(xs.map(#{ p, _i => pattern(p) })) }

fn field_pats(xs: Vec[FieldPat]) -> S {
    List(xs.map(#{ f, _i => node("", [t("name", str_(f.name)), t("pattern", opt_pattern(f.pattern)), t("isVar", bool_(f.is_var))]) }))
}

fn pattern(p: Pattern) -> S {
    match p.k {
        PWild => node("PWild", [])
        PBind { name, is_var } => node("PBind", [t("name", str_(name)), t("isVar", bool_(is_var))])
        PLit { value } => node("PLit", [t("value", expr(value))])
        PRange { start, end, inclusive } => node("PRange", [t("start", expr(start)), t("end", expr(end)), t("inclusive", bool_(inclusive))])
        PCtor { path, args, fields, rest } => node("PCtor", [
            t("path", strs(path)),
            t("args", match args {
                Some(xs) => patterns(xs)
                None => Omit
            }),
            t("fields", match fields {
                Some(xs) => field_pats(xs)
                None => Omit
            }),
            t("rest", bool_(rest)),
        ])
        PTuple { elems: xs, rest } => node("PTuple", [t("elems", patterns(xs)), t("rest", bool_(rest))])
        PRecord { fields, rest } => node("PRecord", [t("fields", field_pats(fields)), t("rest", bool_(rest))])
        POr { alts } => node("POr", [t("alts", patterns(alts))])
        PError => node("PError", [])
    }
}
