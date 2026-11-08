// The spans of every node of a file, as `start:end:line` keys: the loader attributes a resolver or
// checker diagnostic of a multi-file package to the file that has a node at exactly its span (stage
// 0's `hasSpan`, which walks every object with a `span`).
package ast

import "app.lexer.{Span}"

fun key(s: Span) -> string { "${s.start}:${s.end}:${s.line}" }

pub fun collect_spans(f: &File) -> Set[string] {
    var out = Set.new() as Set[string]
    let _ = out.insert(key(f.span))
    for imp in f.imports.iter() {
        let _ = out.insert(key(imp.span))
    }
    for itm in f.items.iter() {
        item_spans(itm, out)
    }
    out
}

fun add(out: &mut Set[string], s: Span) {
    let _ = out.insert(key(s))
}

fun generics_spans(gs: &Vec[GenericParam], out: &mut Set[string]) {
    for g in gs.iter() {
        add(out, g.span)
        for b in g.bounds.iter() {
            type_spans(b, out)
        }
    }
}

fun fun_spans(f: &FunDecl, out: &mut Set[string]) {
    add(out, f.span)
    generics_spans(f.generics, out)
    for p in f.params.iter() {
        add(out, p.span)
        type_spans(p.ty, out)
    }
    if let Some(r) = &f.ret {
        type_spans(r, out)
    }
    if let Some(b) = &f.body {
        block_spans(b, out)
    }
}

fun field_spans(f: &Field, out: &mut Set[string]) {
    add(out, f.span)
    type_spans(f.ty, out)
    if let Some(d) = &f.default {
        expr_spans(d, out)
    }
}

fun types_spans(ts: &Vec[Type], out: &mut Set[string]) {
    for t in ts.iter() {
        type_spans(t, out)
    }
}

fun item_spans(itm: &Item, out: &mut Set[string]) {
    match itm {
        Fun(f) => fun_spans(f, out)
        TypeDef(d) => {
            add(out, d.span)
            generics_spans(d.generics, out)
            types_spans(d.impls, out)
            match &d.body {
                Struct(b) => {
                    add(out, b.span)
                    for f in b.fields.iter() {
                        field_spans(f, out)
                    }
                    for m in b.methods.iter() {
                        fun_spans(m, out)
                    }
                }
                Alias(t) => type_spans(t, out)
            }
        }
        Union(d) => {
            add(out, d.span)
            generics_spans(d.generics, out)
            types_spans(d.impls, out)
            for v in d.variants.iter() {
                add(out, v.span)
                if let Some(ts) = &v.tuple {
                    types_spans(ts, out)
                }
                if let Some(fs) = &v.fields {
                    for f in fs.iter() {
                        field_spans(f, out)
                    }
                }
            }
            for m in d.methods.iter() {
                fun_spans(m, out)
            }
        }
        Inter(d) => {
            add(out, d.span)
            generics_spans(d.generics, out)
            types_spans(d.supers, out)
            for m in (d.methods ?? []).iter() {
                fun_spans(m, out)
            }
            if let Some(c) = &d.composition {
                type_spans(c, out)
            }
        }
        Impl(d) => {
            add(out, d.span)
            generics_spans(d.generics, out)
            types_spans(d.interfaces, out)
            type_spans(d.target, out)
            for m in d.methods.iter() {
                fun_spans(m, out)
            }
        }
        Let(d) => {
            add(out, d.span)
            if let Some(t) = &d.ty {
                type_spans(t, out)
            }
            expr_spans(d.value, out)
        }
        Extern(d) => {
            add(out, d.span)
            for f in d.funs.iter() {
                fun_spans(f, out)
            }
        }
    }
}

fun type_spans(t: &Type, out: &mut Set[string]) {
    add(out, t.span)
    match &t.kind {
        TName { args, .. } => types_spans(args, out)
        TOption(x) => type_spans(x.get(), out)
        TRef { inner, .. } | TPtr { inner, .. } => type_spans(inner.get(), out)
        TTuple(ts) | TUnion(ts) | TIntersection(ts) => types_spans(ts, out)
        TRecord(fs) => {
            for f in fs.iter() {
                field_spans(f, out)
            }
        }
        TFn { params, ret } => {
            types_spans(params, out)
            type_spans(ret.get(), out)
        }
        _ => {}
    }
}

fun block_spans(b: &Block, out: &mut Set[string]) {
    add(out, b.span)
    for s in b.stmts.iter() {
        match s {
            Let(l) => {
                add(out, l.span)
                pattern_spans(l.pattern, out)
                if let Some(t) = &l.ty {
                    type_spans(t, out)
                }
                expr_spans(l.value, out)
                if let Some(eb) = &l.else_branch {
                    block_spans(eb, out)
                }
            }
            ExprStmt(es) => {
                add(out, es.span)
                expr_spans(es.expr, out)
            }
        }
    }
}

fun opt_spans(e: &Box[Expr]?, out: &mut Set[string]) {
    if let Some(x) = e {
        expr_spans(x.get(), out)
    }
}

fun elems_spans(elems: &Vec[Elem], out: &mut Set[string]) {
    for el in elems.iter() {
        match el {
            EValue(x) => expr_spans(x, out)
            ESpread { span, expr } => {
                add(out, span)
                expr_spans(expr, out)
            }
        }
    }
}

fun items_spans(items: &Vec[RecordItem], out: &mut Set[string]) {
    for f in items.iter() {
        match f {
            RField(rf) => {
                add(out, rf.span)
                if let Some(v) = &rf.value {
                    expr_spans(v, out)
                }
            }
            RSpread { span, expr } => {
                add(out, span)
                expr_spans(expr, out)
            }
        }
    }
}

fun expr_spans(e: &Expr, out: &mut Set[string]) {
    add(out, e.span)
    match &e.kind {
        Template(parts) => {
            for p in parts.iter() {
                if let Interp(x) = p {
                    expr_spans(x, out)
                }
            }
        }
        Paren(x) | Await(x) | Try(x) => expr_spans(x.get(), out)
        VecLit(elems) | ArrayLit(elems) | TupleLit(elems) | SetLit(elems) => elems_spans(elems, out)
        RecordLit(items) | Inferred(items) => items_spans(items, out)
        MapLit(entries) => {
            for en in entries.iter() {
                match en {
                    MEntry(me) => {
                        add(out, me.span)
                        expr_spans(me.key, out)
                        expr_spans(me.value, out)
                    }
                    MSpread { span, expr } => {
                        add(out, span)
                        expr_spans(expr, out)
                    }
                }
            }
        }
        StructLit { ty, fields } => {
            expr_spans(ty.get(), out)
            items_spans(fields, out)
        }
        Closure { captures, params, ret, body } => {
            for c in (captures ?? []).iter() {
                add(out, c.span)
            }
            for p in (params ?? []).iter() {
                add(out, p.span)
                if let Some(t) = &p.ty {
                    type_spans(t, out)
                }
            }
            if let Some(r) = ret {
                type_spans(r, out)
            }
            block_spans(body, out)
        }
        Unary { expr, .. } => expr_spans(expr.get(), out)
        Binary { left, right, .. } => {
            expr_spans(left.get(), out)
            expr_spans(right.get(), out)
        }
        Assign { target, value, .. } => {
            expr_spans(target.get(), out)
            expr_spans(value.get(), out)
        }
        RangeExpr { start, end, .. } => {
            opt_spans(start, out)
            opt_spans(end, out)
        }
        As { expr, ty } => {
            expr_spans(expr.get(), out)
            type_spans(ty, out)
        }
        Or { expr, rhs, .. } => {
            expr_spans(expr.get(), out)
            expr_spans(rhs.get(), out)
        }
        Member { object, .. } | OptMember { object, .. } => expr_spans(object.get(), out)
        Call { callee, args } => {
            expr_spans(callee.get(), out)
            elems_spans(args, out)
        }
        IndexExpr { object, index } => {
            expr_spans(object.get(), out)
            expr_spans(index.get(), out)
        }
        GenericApply { target, args } => {
            expr_spans(target.get(), out)
            types_spans(args, out)
        }
        If { cond, then, else_branch } => {
            match cond {
                CExpr(x) => expr_spans(x.get(), out)
                CLet(lc) => {
                    add(out, lc.span)
                    pattern_spans(lc.pattern, out)
                    expr_spans(lc.value.get(), out)
                }
            }
            block_spans(then, out)
            opt_spans(else_branch, out)
        }
        Match { subject, arms } => {
            opt_spans(subject, out)
            for a in arms.iter() {
                add(out, a.span)
                if let Some(p) = &a.pattern {
                    pattern_spans(p, out)
                }
                if let Some(t) = &a.test {
                    expr_spans(t, out)
                }
                if let Some(g) = &a.guard {
                    expr_spans(g, out)
                }
                expr_spans(a.body, out)
            }
        }
        Select { arms, else_branch } => {
            for a in arms.iter() {
                add(out, a.span)
                if let Some(p) = &a.pattern {
                    pattern_spans(p, out)
                }
                expr_spans(a.expr, out)
                expr_spans(a.body, out)
            }
            opt_spans(else_branch, out)
        }
        For { pattern, pattern2, expr, body, .. } => {
            if let Some(p) = pattern {
                pattern_spans(p, out)
            }
            if let Some(p) = pattern2 {
                pattern_spans(p, out)
            }
            opt_spans(expr, out)
            block_spans(body, out)
        }
        BlockExpr(b) | Unsafe(b) | Recover(b) => block_spans(b, out)
        Return(v) => opt_spans(v, out)
        Break { value, .. } => opt_spans(value, out)
        _ => {}
    }
}

fun pattern_spans(p: &Pattern, out: &mut Set[string]) {
    add(out, p.span)
    match &p.kind {
        PLit(x) => expr_spans(x.get(), out)
        PRange { start, end, .. } => {
            opt_spans(start, out)
            opt_spans(end, out)
        }
        PCall { args, .. } => {
            for a in args.iter() {
                pattern_spans(a, out)
            }
        }
        PStruct { fields, .. } => {
            for f in fields.iter() {
                add(out, f.span)
                if let Some(fp) = &f.pattern {
                    pattern_spans(fp, out)
                }
            }
        }
        PTuple { elems, .. } => {
            for x in elems.iter() {
                pattern_spans(x, out)
            }
        }
        POr(alts) => {
            for x in alts.iter() {
                pattern_spans(x, out)
            }
        }
        _ => {}
    }
}
