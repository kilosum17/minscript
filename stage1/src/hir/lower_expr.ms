// Lowering of expressions: names, literals with fields, closures, operators, members, calls and
// control flow (ported from minscript/src/lower.ts).
package hir

import "app.lexer.{Span}"
import "app.ast.*"
import "app.check.{CallInfo, CallTarget, VariantRef, Owner, Ty, tag, named_sym, named_args, arg_at, is_int, is_numeric, is_stringy, is_prim, prim, void_ty, unknown, dec_neg}"

fun elem_ast(el: &Elem) -> Expr {
    match el {
        EValue(x) => x.clone()
        ESpread { expr, .. } => expr.clone()
    }
}

fun operator_method(op: &str) -> string {
    match op {
        "+" => "plus"
        "-" => "minus"
        "*" => "times"
        "/" => "divide"
        "%" => "remainder"
        _ => ""
    }
}

fun bool_ty() -> Ty { prim("bool") }

fun boxed(e: HExpr?) -> Box[HExpr]? {
    match e {
        Some(x) => Some(Box.new(x))
        None => None
    }
}

fun arm(pattern: HPat, body: HExpr) -> HArm { HArm { pattern, guard: None, body } }

fun not_e(span: Span, e: HExpr) -> HExpr { mk(bool_ty(), span, KUnary { op: "not", expr: Box.new(e) }) }

/// The element type of a collection type (its first argument).
fun elem_ty_of(l: &Lowerer, t: &Ty) -> Ty? {
    let s = l.strip(t)
    if tag(s) == "named" { named_args(s).get(0) } else { None }
}

fun inner_ty_of(l: &Lowerer, t: &Ty) -> Ty {
    let s = l.strip(t)
    if tag(s) == "named" { arg_at(s, 0) } else { unknown() }
}

impl Lowerer {
    fun expr(&mut this, e: &Expr) -> HExpr {
        let ty = this.ty(e.id)
        let span = e.span
        match &e.kind {
            Ident(name) => this.ident(e, name, ty)
            This => match this.refs.get(e.id) {
                Some(sym) => this.sym_ref(sym, ty, span)
                None => this.unsupported("`this` without a receiver", span, ty)
            }
            Int(v) => lit_e(LBig(v.clone()), ty, span)
            Float(x) => lit_e(LNum(x), ty, span)
            Str { value, .. } => lit_e(LStr(value.clone()), ty, span)
            Char(c) => mk(ty, span, KChar(c.clone()))
            Bool(b) => lit_e(LBool(b), ty, span)
            Nil => mk(ty, span, KVariant { union_name: "std.Option", variant: "None", fields: [] })
            Template(parts) => {
                var out = [] as Vec[HExpr]
                for p in parts.iter() {
                    match p {
                        Text(s) => {
                            if !s.is_empty() {
                                out.push(lit_e(LStr(s.clone()), prim("string"), span))
                            }
                        }
                        Interp(x) => {
                            let v = this.expr(x)
                            out.push(this.to_str(v))
                        }
                    }
                }
                mk(prim("string"), span, KConcat(out))
            }
            Paren(x) => this.expr(x.get())
            VecLit(elems) => mk(ty.clone(), span, KVec(this.elems(elems, elem_ty_of(this, ty))))
            ArrayLit(elems) => mk(ty.clone(), span, KArray(this.elems(elems, elem_ty_of(this, ty))))
            SetLit(elems) => mk(ty.clone(), span, KSet(this.elems(elems, elem_ty_of(this, ty))))
            TupleLit(elems) => {
                if elems.is_empty() {
                    return lit_e(LUnit, void_ty(), span)
                }
                var out = [] as Vec[HExpr]
                for el in elems.iter() {
                    out.push(this.expr(elem_ast(el)))
                }
                mk(ty, span, KTuple(out))
            }
            MapLit(entries) => {
                var out = [] as Vec[HEntry]
                for en in entries.iter() {
                    out.push(match en {
                        MSpread { expr, .. } => HEntrySpread(this.expr(expr))
                        MEntry(me) => {
                            let k = this.expr(me.key)
                            HPair { key: k, value: this.expr(me.value) }
                        }
                    })
                }
                mk(ty, span, KMap(out))
            }
            RecordLit(fields) => this.record(fields, ty, span)
            Inferred(fields) => {
                let t = this.strip(ty)
                let sym = named_sym(t)
                if sym >= 0 {
                    if let Some(dfields) = this.struct_fields(sym) {
                        let given = this.given_fields(fields)
                        return this.struct_from_fields(sym, dfields, given, spread_of(fields), span, ty)
                    }
                }
                this.record(fields, ty, span)
            }
            StructLit { fields, .. } => this.struct_lit(e, fields, ty)
            Closure { params, body, .. } => this.closure(e, params, body, ty)
            Unary { op, expr } => this.unary(e, op, expr.get(), ty)
            Await(x) => mk(ty, span, KAwait(Box.new(this.expr(x.get()))))
            Binary { op, left, right } => this.binary(e, op, left.get(), right.get(), ty)
            Assign { op, target, value } => this.assign(e, op, target.get(), value.get())
            RangeExpr { op, start, end } => {
                let s = match start {
                    Some(x) => Some(this.expr(x.get()))
                    None => None
                }
                let en = match end {
                    Some(x) => Some(this.expr(x.get()))
                    None => None
                }
                mk(ty, span, KRange { start: boxed(s), end: boxed(en), inclusive: op == "..=" })
            }
            As { expr, .. } => {
                let inner = this.expr(expr.get())
                let from = this.strip(inner.ty)
                let to = this.strip(ty)
                let numeric = #{ x: &Ty => is_numeric(x) || tag(x) == "ptr" || is_prim(x, "char") }
                let same_prim = tag(from) == "prim" && tag(to) == "prim" && from == to
                if numeric(from) && numeric(to) && !same_prim {
                    return mk(ty.clone(), span, KCast { expr: Box.new(inner), to: ty })
                }
                let ity = if tag(inner.ty) == "var" { ty.clone() } else { inner.ty.clone() }
                this.coerce(HExpr { ty: ity, span: inner.span, kind: inner.kind }, Some(ty), true)
            }
            Or { expr, rhs, .. } => this.or_expr(e, expr.get(), rhs.get(), ty)
            Member { object, name, .. } => this.member(e, object.get(), name, ty)
            OptMember { object, name, index } => this.opt_member(e, object.get(), name, index, ty)
            Call { callee, args } => this.call(e, callee.get(), args, ty)
            IndexExpr { object, index } => {
                let ot = this.strip(this.ty(object.get().id))
                let osym = named_sym(ot)
                let map = osym >= 0 && this.syms[osym].std && this.syms[osym].name == "Map"
                let o = this.expr(object.get())
                let i = this.expr(index.get())
                mk(ty, span, KIndex { object: Box.new(o), index: Box.new(i), map })
            }
            GenericApply { target, .. } => this.expr(target.get())
            Try(x) => this.try_expr(e, x.get(), ty)
            If { cond, then, else_branch } => this.if_expr(e, cond, then, else_branch, ty)
            Match { subject, arms } => this.match_expr(e, subject, arms, ty)
            Select { arms, else_branch } => {
                var out = [] as Vec[HSelectArm]
                for a in arms.iter() {
                    let wait = this.expr(a.expr)
                    let pattern = match &a.pattern {
                        Some(p) => {
                            let wt = inner_ty_of(this, wait.ty)
                            this.pattern(p, wt)
                        }
                        None => QWild
                    }
                    out.push(HSelectArm { wait, pattern, body: this.expr(a.body) })
                }
                let els = match else_branch {
                    Some(x) => Some(this.expr(x.get()))
                    None => None
                }
                mk(ty, span, KSelect { arms: out, else_expr: boxed(els) })
            }
            For { label, form, is_await, pattern, pattern2, expr, body } => this.for_expr(e, label, form, is_await, pattern, pattern2, expr, body, ty)
            BlockExpr(b) | Unsafe(b) => {
                let hb = this.stmts(b.stmts)
                this.block_expr(hb, ty, span)
            }
            Recover(b) => mk(ty, span, KRecover(this.stmts(b.stmts)))
            Return(value) => {
                let v = match value {
                    Some(x) => {
                        let raw = this.expr(x.get())
                        Some(this.coerce(raw, Some(this.ret.clone()), true))
                    }
                    None => None
                }
                mk(TyNever, span, KReturn(boxed(v)))
            }
            Break { label, value } => {
                let v = match value {
                    Some(x) => Some(this.expr(x.get()))
                    None => None
                }
                mk(TyNever, span, KBreak { label: label.clone(), value: boxed(v) })
            }
            Continue(label) => mk(TyNever, span, KContinue(label.clone()))
            Error => this.unsupported("a syntax error", span, ty)
        }
    }

    fun elems(&mut this, elems: &Vec[Elem], ty: Ty?) -> Vec[HElem] {
        var out = [] as Vec[HElem]
        for el in elems.iter() {
            out.push(match el {
                ESpread { expr, .. } => HSpread(this.expr(expr))
                EValue(x) => {
                    let v = this.expr(x)
                    HValue(this.coerce(v, ty.clone(), true))
                }
            })
        }
        out
    }

    fun ident(&mut this, e: &Expr, name: &str, ty: Ty) -> HExpr {
        let span = e.span
        if let Some(v) = this.variants.get(e.id) {
            return this.variant_value(v, ty, span)
        }
        let Some(sym) = this.refs.get(e.id) else {
            // names from a glob import, or variants of a package type that isn't loaded yet: they stay symbolic
            if this.open.has(e.id) || this.deferred.has(e.id) {
                return mk(ty, span, KExtern { path: name.to_str(), args: None, type_args: None })
            }
            return this.unsupported("unresolved name `${name}`", span, ty)
        }
        match this.syms[sym].kind.clone() {
            "local" | "param" | "closure-param" | "implicit" | "this" => this.sym_ref(sym, ty, span)
            _ => this.sym_value(sym, span, ty)
        }
    }

    /// A top-level item used as a value.
    fun sym_value(&mut this, sym: int, span: Span, ty: Ty) -> HExpr {
        let kind = this.syms[sym].kind.clone()
        match kind {
            "fun" | "extern-fun" => {
                let Some(d) = this.syms[sym].decl else { return this.unsupported("function", span, ty) }
                if this.fun_decl(d).is_none() {
                    return this.unsupported("function", span, ty)
                }
                mk(ty, span, KFn(this.fun_name(d, None)))
            }
            "global" => mk(ty, span, KGlobal(this.type_name(sym))),
            "package" | "import" => mk(ty, span, KExtern { path: this.syms[sym].detail ?? this.syms[sym].name.clone(), args: None, type_args: None }),
            _ => this.unsupported("`${this.syms[sym].name}` used as a value", span, ty)
        }
    }

    /// A variant used as a value: the value itself (unit variant), or its constructor.
    fun variant_value(&this, v: VariantRef, ty: Ty, span: Span) -> HExpr {
        if let Some(vd) = this.union_variant(v.owner, v.variant) {
            if vd.tuple.is_some() || vd.fields.is_some() {
                return mk(ty, span, KFn("${this.type_name(v.owner)}.${v.variant}"))
            }
        }
        this.variant_e(v.owner, v.variant, [], ty, span)
    }

    fun record(&mut this, fields: &Vec[RecordItem], ty: Ty, span: Span) -> HExpr {
        let spread = spread_of(fields)
        let given = this.given_fields(fields)
        let Some(sp) = spread else { return mk(ty, span, KRecord(given)) }
        // `r{ ...base, a: 1 }`: copy the base's fields, then override
        let base = this.expr(sp)
        let tmp = this.temp("base", base.ty.clone())
        let bt = this.strip(base.ty)
        var all = [] as Vec[HField]
        if let TyRecord(bfs) = &bt {
            for f in bfs.iter() {
                if !given.any(#{ g => g.name == f.name }) {
                    all.push(HField { name: f.name.clone(), value: field_e(unknown(), span, this.refl(tmp, span), f.name) })
                }
            }
        }
        all.extend(given)
        let value = mk(ty.clone(), span, KRecord(all))
        this.block_expr(hblock([HLet { local: tmp, value: base }], Some(value)), ty, span)
    }

    fun given_fields(&mut this, fields: &Vec[RecordItem]) -> Vec[HField] {
        var out = [] as Vec[HField]
        for f in fields.iter() {
            let RField(rf) = f else { continue }
            if let Some(v) = &rf.value {
                out.push(HField { name: rf.key.clone(), value: this.expr(v) })
                continue
            }
            let value = match this.refs.get(rf.id) {
                Some(sym) => this.sym_ref(sym, this.local_of(sym).ty, rf.span)
                None => this.unsupported("field `${rf.key}`", rf.span, unknown())
            }
            out.push(HField { name: rf.key.clone(), value })
        }
        out
    }

    fun none_e(&this, span: Span) -> HExpr { mk(unknown(), span, KVariant { union_name: "std.Option", variant: "None", fields: [] }) }

    /// A struct value with every field: given, from the spread base, the default, or `None` for `T?`.
    fun struct_from_fields(&mut this, sym: int, decl: Vec[Field], given: Vec[HField], spread: Expr?, span: Span, ty: Ty) -> HExpr {
        var stmts = [] as Vec[HStmt]
        var base: HLocal? = None
        if let Some(sp) = spread {
            let b = this.expr(sp)
            let tmp = this.temp("base", b.ty.clone())
            stmts.push(HLet { local: tmp.clone(), value: b })
            base = Some(tmp)
        }
        var fields = [] as Vec[HField]
        for f in decl.iter() {
            let value = if let Some(g) = given.find(#{ x => x.name == f.name }) {
                g.value
            } else if let Some(b) = &base {
                field_e(unknown(), span, this.refl(b, span), f.name)
            } else if let Some(d) = &f.default {
                this.expr(d)
            } else if is_option_type(f.ty) {
                this.none_e(span)
            } else {
                this.unsupported("missing field `${f.name}`", span, unknown())
            }
            fields.push(HField { name: f.name.clone(), value })
        }
        let value = mk(ty.clone(), span, KStruct { type_name: this.type_name(sym), fields })
        if stmts.is_empty() { value } else { this.block_expr(hblock(stmts, Some(value)), ty, span) }
    }

    fun struct_lit(&mut this, e: &Expr, items: &Vec[RecordItem], ty: Ty) -> HExpr {
        if let Some(v) = this.variants.get(e.id) {
            let vdecl = this.union_variant(v.owner, v.variant)
            let given = this.given_fields(items)
            var fields = [] as Vec[HExpr]
            let decl_fields = match &vdecl {
                Some(vd) => vd.fields ?? []
                None => []
            }
            for f in decl_fields.iter() {
                fields.push(if let Some(g) = given.find(#{ x => x.name == f.name }) {
                    g.value
                } else if let Some(d) = &f.default {
                    this.expr(d)
                } else if is_option_type(f.ty) {
                    this.none_e(e.span)
                } else {
                    this.unsupported("missing field `${f.name}`", e.span, unknown())
                })
            }
            return this.variant_e(v.owner, v.variant, fields, ty, e.span)
        }
        let t = this.strip(ty)
        let sym = named_sym(t)
        if sym >= 0 {
            if let Some(dfields) = this.struct_fields(sym) {
                let given = this.given_fields(items)
                return this.struct_from_fields(sym, dfields, given, spread_of(items), e.span, ty)
            }
        }
        // a type from a package that isn't loaded yet (`models.User { … }`)
        this.record(items, ty, e.span)
    }

    fun closure(&mut this, e: &Expr, params: &Vec[ClosureParam]?, body: &Block, ty: Ty) -> HExpr {
        let ft = this.strip(ty)
        let fparams = match &ft {
            TyFn { params: ps, .. } => Some(ps.clone())
            _ => None
        }
        var locals = [] as Vec[HLocal]
        match params {
            Some(ps) => {
                for p in ps.iter() {
                    if let Some(s) = this.decls.get(p.id) {
                        locals.push(this.local_of(s))
                    }
                }
            }
            None => {
                var implicit = [] as Vec[int]
                for s in (this.implicit_by_owner.get(e.id) ?? []).iter() {
                    if !implicit.contains(s) {
                        implicit.push(s)
                    }
                }
                var n = 0
                for s in implicit.iter() {
                    if this.implicit_num(s) > n {
                        n = this.implicit_num(s)
                    }
                }
                var i = 1
                for i <= n {
                    var found: int? = None
                    for s in implicit.iter() {
                        if found.is_none() && this.implicit_num(s) == i {
                            found = Some(s)
                        }
                    }
                    match found {
                        Some(s) => locals.push(this.local_of(s))
                        None => {
                            let pt = match &fparams {
                                Some(ps) => ps.get(i - 1) ?? unknown()
                                None => unknown()
                            }
                            locals.push(this.temp("it${i}", pt))
                        }
                    }
                    i += 1
                }
            }
        }
        let Closure { captures: written, .. } = &e.kind else { return this.unsupported("closure", e.span, ty) }
        var explicit = m{} as Map[int, string]
        for c in (written ?? []).iter() {
            if let Some(s) = this.refs.get(c.id) {
                explicit[s] = c.mode.clone()
            }
        }
        var captures = [] as Vec[HCapture]
        for sym in (this.captures.get(e.id) ?? []).iter() {
            captures.push(HCapture { sym, name: this.display(sym), mode: explicit.get(sym) ?? "ref" })
        }
        let ret = match &ft {
            TyFn { ret, .. } => this.prune(ret.get())
            _ => unknown()
        }
        let saved = this.ret.clone()
        this.ret = ret.clone()
        let b = this.body(body, ret)
        this.ret = saved
        mk(ty, e.span, KClosure { params: locals, captures, body: b })
    }

    /// `it` / `it1` → 1, `it2` → 2, …
    fun implicit_num(&this, s: int) -> int {
        let n = this.syms[s].name.substring(2, this.syms[s].name.len())
        if n.is_empty() { 1 } else { dec_int(n) }
    }

    fun unary(&mut this, e: &Expr, op: &str, x: &Expr, ty: Ty) -> HExpr {
        let inner = this.expr(x)
        let span = e.span
        match op {
            "-" => {
                match &inner.kind {
                    KLit(LBig(d)) => return mk(ty, span, KLit(LBig(dec_neg(d))))
                    KLit(LNum(v)) => return mk(ty, span, KLit(LNum(-v)))
                    _ => {}
                }
                mk(ty, span, KUnary { op: "neg", expr: Box.new(inner) })
            }
            "!" => {
                if is_int(this.strip(inner.ty)) {
                    return mk(ty, span, KUnary { op: "bitnot", expr: Box.new(inner) })
                }
                not_e(span, this.truthy(inner))
            }
            "*" => mk(ty, span, KUnary { op: "deref", expr: Box.new(inner) })
            _ => inner                    // borrows have no runtime form here
        }
    }

    fun binary(&mut this, e: &Expr, op: &str, l: &Expr, r: &Expr, ty: Ty) -> HExpr {
        let span = e.span
        if op == "&&" || op == "||" {
            let le = this.expr(l)
            let left = this.truthy(le)
            let re = this.expr(r)
            let right = this.truthy(re)
            return mk(bool_ty(), span, if op == "&&" { KAnd { left: Box.new(left), right: Box.new(right) } } else { KOr { left: Box.new(left), right: Box.new(right) } })
        }
        if op == "??" {
            return this.nullish(e, l, r, ty)
        }
        var left = this.expr(l)
        var right = this.expr(r)
        let ls = this.strip(left.ty)
        let rs = this.strip(right.ty)
        if op == "+" && is_stringy(ls) && is_stringy(rs) {
            return mk(prim("string"), span, KConcat([left, right]))
        }
        // mixed widths: widen the narrower side (spec §9.5)
        if is_numeric(ls) && is_numeric(rs) {
            left = this.coerce(left, Some(right.ty.clone()), false)
            right = this.coerce(right, Some(left.ty.clone()), false)
        }
        // operator interfaces on user types: `a + b` → `T.plus(a, b)`
        let method = operator_method(op)
        let lsym = named_sym(ls)
        if method != "" && lsym >= 0 && !this.syms[lsym].std {
            return mk(ty, span, KCall { callee: "${this.type_name(lsym)}.${method}", args: [left, right], shapes: None, witness_args: [] })
        }
        mk(ty, span, KBinary { op: op.to_str(), left: Box.new(left), right: Box.new(right) })
    }

    /// `a ?? b` → `match a { Some(v) => v, None => b }` (b is evaluated only when needed).
    fun nullish(&mut this, e: &Expr, l: &Expr, r: &Expr, ty: Ty) -> HExpr {
        let span = e.span
        let left = this.expr(l)
        let raw = this.expr(r)
        let right = this.coerce(raw, Some(ty.clone()), true)
        let inner = inner_ty_of(this, left.ty)
        let v = this.temp("v", inner.clone())
        let keeps = this.option_kind(ty) == "option" && this.option_kind(inner) != "option"
        let some_body = if keeps { this.variant_e(this.option_sym(), "Some", [this.refl(v, span)], ty.clone(), span) } else { this.refl(v, span) }
        mk(ty, span, KMatch { subject: Box.new(left), arms: [arm(QOk(Box.new(QBind(v))), some_body), arm(QWild, right)] })
    }

    fun assign(&mut this, e: &Expr, op: &str, t: &Expr, v: &Expr) -> HExpr {
        let span = e.span
        let target = this.expr(t)
        let raw = this.expr(v)
        let value = this.coerce(raw, Some(target.ty.clone()), true)
        if op == "??=" {
            // `x ??= v` → `if !x { x = Some(v) }`
            let some = this.variant_e(this.option_sym(), "Some", [value], target.ty.clone(), span)
            let set = mk(void_ty(), span, KAssign { target: Box.new(target.clone()), op: "=", value: Box.new(some) })
            let cond = not_e(span, this.truthy(target))
            return mk(void_ty(), span, KIf { cond: Box.new(cond), then: hblock([], Some(set)), else_block: None })
        }
        if op == "+=" && is_stringy(this.strip(target.ty)) {
            let cat = mk(prim("string"), span, KConcat([target.clone(), value]))
            return mk(void_ty(), span, KAssign { target: Box.new(target), op: "=", value: Box.new(cat) })
        }
        mk(void_ty(), span, KAssign { target: Box.new(target), op: op.to_str(), value: Box.new(value) })
    }

    /// `e or rhs` → `match e { Some(v) / Ok(v) => v, None / Err(it) => return rhs }`.
    fun or_expr(&mut this, e: &Expr, x: &Expr, rhs: &Expr, ty: Ty) -> HExpr {
        let span = e.span
        let subject = this.expr(x)
        let v = this.temp("v", ty.clone())
        let implicit = match this.implicit_by_owner.get(e.id) {
            Some(list) => list.get(0)
            None => None
        }
        let payload = this.decls.get(e.id) ?? implicit
        let r = this.expr(rhs)
        let fallback = if tag(this.prune(r.ty)) == "never" {
            r
        } else {
            let ret = this.ret.clone()
            mk(TyNever, rhs.span, KReturn(Some(Box.new(this.coerce(r, Some(ret), true)))))
        }
        let fail: HPat = match payload {
            Some(s) => QBind(this.local_of(s))
            None => QWild
        }
        let body = this.refl(v, span)
        mk(ty, span, KMatch { subject: Box.new(subject), arms: [arm(QOk(Box.new(QBind(v))), body), arm(QFail(Box.new(fail)), fallback)] })
    }

    /// `e?` → `match e { ok(v) => v, fail => return e }`: the failed value is returned as it is.
    fun try_expr(&mut this, e: &Expr, x: &Expr, ty: Ty) -> HExpr {
        let span = e.span
        let subject = this.expr(x)
        let t = this.temp("t", subject.ty.clone())
        let v = this.temp("v", ty.clone())
        let failed = HExpr { ty: this.ret.clone(), span, kind: KLocal { sym: t.sym, name: t.name.clone() } }
        let m = mk(ty.clone(), span, KMatch { subject: Box.new(this.refl(t, span)), arms: [
            arm(QOk(Box.new(QBind(v.clone()))), this.refl(v, span)),
            arm(QWild, mk(TyNever, span, KReturn(Some(Box.new(failed))))),
        ] })
        this.block_expr(hblock([HLet { local: t, value: subject }], Some(m)), ty, span)
    }

    fun member(&mut this, e: &Expr, object: &Expr, name: &str, ty: Ty) -> HExpr {
        let span = e.span
        let target = this.members.get(e.id)
        if let Some(MItem(sym)) = &target {
            return this.sym_value(sym, span, ty)
        }
        if let Some(path) = this.extern_path(e) {
            return mk(ty, span, KExtern { path, args: None, type_args: None })
        }
        match target {
            Some(MVariant(v)) => this.variant_value(v, ty, span)
            Some(MStatic { decl, owner }) => mk(ty, span, KFn(this.fun_name(decl, Some(owner)))),
            Some(MMethod { .. }) => this.unsupported("the method `${name}` used as a value (wrap it in a closure)", span, ty)
            Some(MTuple(i)) => field_e(ty, span, this.expr(object), "${i}")
            _ => field_e(ty, span, this.expr(object), name)
        }
    }

    /// `json.parse`, `ws.Message.Close`: a path into a std package without signatures.
    fun extern_path(&this, e: &Expr) -> string? {
        match &e.kind {
            Ident(name) => {
                let Some(sym) = this.refs.get(e.id) else {
                    if this.open.has(e.id) || (this.deferred.has(e.id) && !this.variants.has(e.id)) {
                        return Some(name.clone())
                    }
                    return None
                }
                let kind = this.syms[sym].kind.clone()
                // a loaded package's members resolve to its items; only packages without signatures stay symbolic
                if (kind == "package" || kind == "import") && this.syms[sym].target.is_none() {
                    return Some(this.syms[sym].detail ?? this.syms[sym].name.clone())
                }
                None
            }
            Member { object, name, index } => {
                if index {
                    return None
                }
                match this.extern_path(object.get()) {
                    Some(base) => Some("${base}.${name}")
                    None => None
                }
            }
            _ => None
        }
    }

    /// `x?.f` → `match x { Some(o) => Some(o.f), None => None }` (no double Option).
    fun opt_member(&mut this, e: &Expr, object: &Expr, name: &str, index: bool, ty: Ty) -> HExpr {
        let span = e.span
        let subject = this.expr(object)
        let o = this.temp("o", inner_ty_of(this, subject.ty))
        let inner = this.refl(o, span)
        let access = if index { field_e(unknown(), span, inner, name) } else { field_e(inner_ty_of(this, ty), span, inner, name) }
        this.some_or_none(subject, o, access, ty, span)
    }

    fun some_or_none(&this, subject: HExpr, o: HLocal, value: HExpr, ty: Ty, span: Span) -> HExpr {
        let option = this.option_sym()
        let wrapped = if this.option_kind(value.ty) == "option" { value } else { this.variant_e(option, "Some", [value], ty.clone(), span) }
        let none = this.variant_e(option, "None", [], ty.clone(), span)
        mk(ty, span, KMatch { subject: Box.new(subject), arms: [arm(QOk(Box.new(QBind(o))), wrapped), arm(QWild, none)] })
    }

    // ---- calls ----

    fun call(&mut this, e: &Expr, callee: &Expr, args: &Vec[Elem], ty: Ty) -> HExpr {
        var out = this.call_inner(e, callee, args, ty)
        // the callee's generics as instantiated here: type witnesses, if the callee needs them
        let env = match this.calls.get(e.id) {
            Some(info) => info.type_env
            None => []
        }
        if !env.is_empty() {
            if let KCall { callee: c, args: a, shapes, .. } = &out.kind {
                var wargs = [] as Vec[t(int, Shape?)]
                for entry in env.iter() {
                    let t(s, ty2) = entry
                    wargs.push(t(s, this.ty_shape(ty2)))
                }
                out.kind = KCall { callee: c.clone(), args: a.clone(), shapes: shapes.clone(), witness_args: wargs }
            }
        }
        out
    }

    fun type_args(&this, info: &CallInfo?) -> Vec[Shape?] {
        match info {
            Some(i) => i.type_args.map(#{ t => this.ty_shape(t) })
            None => []
        }
    }

    fun call_inner(&mut this, e: &Expr, callee0: &Expr, args: &Vec[Elem], ty: Ty) -> HExpr {
        let span = e.span
        let info = this.calls.get(e.id)
        let callee = match &callee0.kind {
            GenericApply { target, .. } => target.get().clone()
            _ => callee0.clone()
        }
        let target = match &info {
            Some(i) => i.target.clone()
            None => CUnknown
        }
        let target_decl = match &target {
            CMethod { decl, .. } => decl
            CStatic { decl, .. } => Some(decl)
            CFun(d) => Some(d)
            _ => None
        }
        // `T.default()`: a static of a generic parameter, called through T's witness
        if let Member { object, name, .. } = &callee.kind {
            if let Ident(_) = &object.get().kind {
                if let Some(owner) = this.refs.get(object.get().id) {
                    if this.syms[owner].kind == "generic" {
                        let a = this.args(e, args, info, target_decl)
                        return mk(ty, span, KWstatic { witness: Some(SParam(owner)), method: name.clone(), args: a })
                    }
                }
            }
        }
        // calls through `?.`: `x?.f()` → match x { Some(o) => Some(o.f()), None => None }
        if let OptMember { object, name, .. } = &callee.kind {
            let method_or_unknown = match &target {
                CMethod { .. } | CUnknown => true
                _ => false
            }
            if method_or_unknown {
                let subject = this.expr(object.get())
                let o = this.temp("o", inner_ty_of(this, subject.ty))
                let recv = this.refl(o, span)
                let mdecl = match &target {
                    CMethod { decl, .. } => decl
                    _ => None
                }
                let a = this.args(e, args, info, mdecl)
                let inner = this.method_call(target, recv, name, a, inner_ty_of(this, ty), span)
                return this.some_or_none(subject, o, inner, ty, span)
            }
        }
        match target {
            CFun(decl) => {
                let a = this.args(e, args, info, Some(decl))
                let fi = this.fun_decl(decl)
                let shapes = match &fi {
                    Some(f) => if f.builtin && f.generics > 0 { Some(this.type_args(info)) } else { None }
                    None => None
                }
                mk(ty, span, KCall { callee: this.fun_name(decl, None), args: a, shapes, witness_args: [] })
            }
            CStatic { decl, owner } => {
                let a = this.args(e, args, info, Some(decl))
                mk(ty, span, KCall { callee: this.fun_name(decl, Some(owner)), args: a, shapes: None, witness_args: [] })
            }
            CVariant(v) => {
                var a = this.args(e, args, info, None)
                let n = match this.union_variant(v.owner, v.variant) {
                    Some(vd) => match &vd.tuple {
                        Some(ts) => ts.len()
                        None => 0
                    }
                    None => 0
                }
                for a.len() < n {
                    a.push(lit_e(LUnit, void_ty(), span))      // `Ok()` → Ok(t())
                }
                this.variant_e(v.owner, v.variant, a, ty, span)
            }
            CMethod { decl, .. } => {
                let Member { object, name, .. } = &callee.kind else { return this.unsupported("method call", span, ty) }
                let recv = this.expr(object.get())
                let a = this.args(e, args, info, decl)
                var call = this.method_call(target.clone(), recv, name, a, ty, span)
                // `res.json.[User]()`: a builtin method gets the shapes of its own type arguments too
                if let Some(d) = decl {
                    if let Some(f) = this.fun_decl(d) {
                        if f.builtin && f.generics > 0 {
                            if let KCall { callee: c, args: ca, witness_args, .. } = &call.kind {
                                call.kind = KCall { callee: c.clone(), args: ca.clone(), shapes: Some(this.type_args(info)), witness_args: witness_args.clone() }
                            }
                        }
                    }
                }
                call
            }
            CValue => {
                let c = this.expr(callee)
                let a = this.args(e, args, info, None)
                mk(ty, span, KCallValue { callee: Box.new(c), args: a })
            }
            CUnknown => {
                if let Some(path) = this.extern_path(callee) {
                    // `json.parse.[User](s)`: the runtime needs the type to build a `User`
                    let type_args = match &callee0.kind {
                        GenericApply { args: targs, .. } => Some(targs.map(#{ ta => match &ta.kind {
                            TName { .. } => match this.refs.get(ta.id) {
                                Some(s) => this.type_name(s)
                                None => "?"
                            }
                            _ => "?"
                        } }))
                        _ => None
                    }
                    let a = this.args(e, args, info, None)
                    return mk(ty, span, KExtern { path, args: Some(a), type_args })
                }
                if let Member { object, name, index } = &callee.kind {
                    if !index {
                        let recv = this.expr(object.get())
                        let a = this.args(e, args, info, None)
                        return mk(ty, span, KDyncall { recv: Box.new(recv), method: name.clone(), args: a })
                    }
                }
                let c = this.expr(callee)
                let a = this.args(e, args, info, None)
                mk(ty, span, KCallValue { callee: Box.new(c), args: a })
            }
        }
    }

    fun method_call(&this, target: CallTarget, recv: HExpr, name: &str, args: Vec[HExpr], ty: Ty, span: Span) -> HExpr {
        let CMethod { decl, owner, is_dyn, auto } = &target else {
            return mk(ty, span, KDyncall { recv: Box.new(recv), method: name.to_str(), args })
        }
        let Some(d) = decl else {
            return mk(ty, span, KDyncall { recv: Box.new(recv), method: auto ?? name.to_str(), args })
        }
        if is_dyn {
            return mk(ty, span, KDyncall { recv: Box.new(recv), method: auto ?? name.to_str(), args })
        }
        var all = [recv]
        all.extend(args)
        mk(ty, span, KCall { callee: this.fun_name(d, Some(owner.clone())), args: all, shapes: None, witness_args: [] })
    }

    /// Arguments coerced to their parameters; variadic arguments packed into a slice; missing `void` arguments filled.
    fun args(&mut this, e: &Expr, args: &Vec[Elem], info: &CallInfo?, decl: int?) -> Vec[HExpr] {
        let params = match decl {
            Some(d) => match this.fun_decl(d) {
                Some(f) => f.params
                None => []
            }
            None => []
        }
        var variadic_at = -1
        var k = 0
        for p in params.iter() {
            if p.variadic && variadic_at < 0 {
                variadic_at = k
            }
            k += 1
        }
        var out = [] as Vec[HExpr]
        var packed = [] as Vec[HElem]
        var spread_only: HExpr? = None
        var i = 0
        for a in args.iter() {
            let want = match info {
                Some(ci) => ci.args.get(i)
                None => None
            }
            if variadic_at >= 0 && i >= variadic_at {
                match a {
                    ESpread { expr, .. } => {
                        let s = this.expr(expr)
                        if args.len() - 1 == variadic_at {
                            spread_only = Some(s)
                        } else {
                            packed.push(HSpread(s))
                        }
                    }
                    EValue(x) => {
                        let v = this.expr(x)
                        packed.push(HValue(this.coerce(v, want, true)))
                    }
                }
                i += 1
                continue
            }
            let v = this.expr(elem_ast(a))
            out.push(this.coerce(v, want, true))
            i += 1
        }
        if variadic_at >= 0 {
            out.push(spread_only ?? mk(unknown(), e.span, KVec(packed)))
        } else {
            for out.len() < params.len() {
                out.push(lit_e(LUnit, void_ty(), e.span))      // omitted `void` arguments
            }
        }
        out
    }

    // ---- control flow ----

    fun if_expr(&mut this, e: &Expr, cond: &Cond, then: &Block, else_branch: &Box[Expr]?, ty: Ty) -> HExpr {
        let span = e.span
        let then_b = this.stmts(then.stmts)
        let else_block = match else_branch {
            None => None
            Some(x) => match &x.get().kind {
                BlockExpr(b) => Some(this.stmts(b.stmts))
                _ => Some(hblock([], Some(this.expr(x.get()))))
            }
        }
        match cond {
            CLet(lc) => {
                let subject = this.expr(lc.value.get())
                let pattern = this.pattern(lc.pattern, subject.ty)
                let body = this.block_expr(then_b, ty.clone(), then.span)
                let other = match else_block {
                    Some(b) => this.block_expr(b, ty.clone(), span)
                    None => lit_e(LUnit, void_ty(), span)
                }
                mk(ty, span, KMatch { subject: Box.new(subject), arms: [arm(pattern, body), arm(QWild, other)] })
            }
            CExpr(c) => {
                let ce = this.expr(c.get())
                let t = this.truthy(ce)
                mk(ty, span, KIf { cond: Box.new(t), then: then_b, else_block })
            }
        }
    }

    fun match_expr(&mut this, e: &Expr, subject: &Box[Expr]?, arms: &Vec[MatchArm], ty: Ty) -> HExpr {
        let span = e.span
        let Some(s) = subject else {
            // `match { c1 => a, c2 => b, _ => d }` → if c1 { a } else if c2 { b } else { d }
            var result: HExpr? = None
            var i = arms.len() - 1
            for i >= 0 {
                let a = &arms[i]
                i -= 1
                let body = this.expr(a.body)
                let Some(test) = &a.test else {
                    result = Some(body)
                    continue
                }
                let te = this.expr(test)
                let cond = this.truthy(te)
                let els = match result {
                    Some(r) => Some(hblock([], Some(r)))
                    None => None
                }
                result = Some(mk(ty.clone(), a.span, KIf { cond: Box.new(cond), then: hblock([], Some(body)), else_block: els }))
            }
            return result ?? lit_e(LUnit, void_ty(), span)
        }
        let subj = this.expr(s.get())
        var out = [] as Vec[HArm]
        for a in arms.iter() {
            let pattern = match &a.pattern {
                Some(p) => this.pattern(p, subj.ty)
                None => QWild
            }
            let guard = match &a.guard {
                Some(g) => {
                    let ge = this.expr(g)
                    Some(this.truthy(ge))
                }
                None => None
            }
            out.push(HArm { pattern, guard, body: this.expr(a.body) })
        }
        mk(ty, span, KMatch { subject: Box.new(subj), arms: out })
    }

    fun brk(&this, span: Span) -> HExpr { mk(TyNever, span, KBreak { label: None, value: None }) }

    fun guard_break(&this, span: Span, cond: HExpr) -> HStmt {
        HDo(mk(void_ty(), span, KIf { cond: Box.new(not_e(span, cond)), then: hblock([], Some(this.brk(span))), else_block: None }))
    }

    fun for_expr(&mut this, e: &Expr, label: &string?, form: &str, is_await: bool, pattern: &Pattern?, pattern2: &Pattern?, expr: &Box[Expr]?, body: &Block, ty: Ty) -> HExpr {
        let span = e.span
        if form == "infinite" {
            let b = this.stmts(body.stmts)
            return mk(ty, span, KLoop { label: label.clone(), body: b, step: None })
        }
        let Some(x) = expr else { return this.unsupported("for", span, ty) }
        if form == "cond" {
            let b = this.stmts(body.stmts)
            let ce = this.expr(x.get())
            let cond = this.truthy(ce)
            var stmts = [this.guard_break(span, cond)]
            stmts.extend(b.stmts)
            return mk(ty, span, KLoop { label: label.clone(), body: HBlock { stmts, value: b.value }, step: None })
        }
        if form == "let" {
            // for let P = e { … } → loop { match e { P => { … }, _ => break } }
            let subject = this.expr(x.get())
            let b = this.stmts(body.stmts)
            let Some(p) = pattern else { return this.unsupported("for", span, ty) }
            let pat = this.pattern(p, subject.ty)
            let inner = this.block_expr(b, void_ty(), body.span)
            let m = mk(void_ty(), span, KMatch { subject: Box.new(subject), arms: [arm(pat, inner), arm(QWild, this.brk(span))] })
            return mk(ty, span, KLoop { label: label.clone(), body: hblock([HDo(m)], None), step: None })
        }
        this.for_in(e, label, is_await, pattern, pattern2, x.get(), body, ty)
    }

    fun loop_e(&this, ty: Ty, span: Span, label: &string?, body: HBlock, step: HBlock?) -> HExpr {
        mk(ty, span, KLoop { label: label.clone(), body, step })
    }

    fun bind_item(&mut this, pattern: &Pattern?, value: HExpr, out: &mut Vec[HStmt]) {
        if let Some(p) = pattern {
            this.destructure(p, value, out)
        }
    }

    fun for_in(&mut this, e: &Expr, label: &string?, is_await: bool, pattern: &Pattern?, pattern2: &Pattern?, x: &Expr, body: &Block, ty: Ty) -> HExpr {
        let span = e.span
        let iterable = this.expr(x)
        let iter_ty = this.strip(iterable.ty)
        let isym = named_sym(iter_ty)
        let std_name = if isym >= 0 && this.syms[isym].std { this.syms[isym].name.clone() } else { "" }

        // for await x in s → loop { match await s.next() { Some(x) => { … }, None => break } }
        if is_await {
            let call = if std_name != "" {
                mk(unknown(), span, KCall { callee: "std.${std_name}.next", args: [iterable], shapes: None, witness_args: [] })
            } else {
                mk(unknown(), span, KDyncall { recv: Box.new(iterable), method: "next", args: [] })
            }
            let next = mk(unknown(), span, KAwait(Box.new(call)))
            let v = this.temp("item", unknown())
            var stmts = [] as Vec[HStmt]
            this.bind_item(pattern, this.refl(v, span), stmts)
            let b = this.stmts(body.stmts)
            stmts.extend(b.stmts)
            let inner = this.block_expr(HBlock { stmts, value: b.value }, void_ty(), body.span)
            let some: HPat = QVariant { union_name: "std.Option", variant: "Some", fields: [QBind(v)] }
            let m = mk(void_ty(), span, KMatch { subject: Box.new(next), arms: [arm(some, inner), arm(QWild, this.brk(span))] })
            return this.loop_e(ty, span, label, hblock([HDo(m)], None), None)
        }

        // ranges and indexable collections: a counter with a `step` (so `continue` advances it)
        if let KRange { start: Some(start), end, inclusive } = &iterable.kind {
            let int_ty = this.prune(start.get().ty)
            var pre = [] as Vec[HStmt]
            var end_ref: HExpr? = None
            if let Some(en) = end {
                let tmp = this.temp("end", en.get().ty.clone())
                end_ref = Some(this.refl(tmp, span))
                pre.push(HLet { local: tmp, value: en.get().clone() })
            }
            var i = this.temp("i", int_ty.clone())
            i.mutable = true
            let i_ref = this.refl(i, span)
            let cond = match end_ref {
                Some(r) => mk(bool_ty(), span, KBinary { op: if inclusive { "<=" } else { "<" }, left: Box.new(i_ref.clone()), right: Box.new(r) })
                None => lit_e(LBool(true), bool_ty(), span)
            }
            return this.counter_loop(span, ty, label, pattern, pattern2, body, i, start.get().clone(), int_ty, cond, Some(i_ref), pre)
        }
        if std_name == "Vec" || std_name == "Array" || std_name == "Slice" {
            let coll = this.temp("items", iterable.ty.clone())
            let len = mk(prim("int"), span, KCall { callee: "std.${std_name}.len", args: [this.refl(coll, span)], shapes: None, witness_args: [] })
            var i = this.temp("i", prim("int"))
            i.mutable = true
            let i_ref = this.refl(i, span)
            let cond = mk(bool_ty(), span, KBinary { op: "<", left: Box.new(i_ref.clone()), right: Box.new(len) })
            let item = mk(elem_ty_of(this, iterable.ty) ?? unknown(), span, KIndex { object: Box.new(this.refl(coll, span)), index: Box.new(i_ref), map: false })
            let pre = [HLet { local: coll, value: iterable }] as Vec[HStmt]
            return this.counter_loop(span, ty, label, pattern, pattern2, body, i, lit_e(LNum(0.0), prim("int"), span), prim("int"), cond, Some(item), pre)
        }

        // everything else: the iterator protocol (`iter()` unless it is already an iterator)
        let iter_expr = if std_name == "Iterator" || this.has_next(iter_ty) {
            iterable
        } else if std_name != "" {
            mk(unknown(), span, KCall { callee: "std.${std_name}.iter", args: [iterable], shapes: None, witness_args: [] })
        } else {
            mk(unknown(), span, KDyncall { recv: Box.new(iterable), method: "iter", args: [] })
        }
        let iter = this.temp("iter", iter_expr.ty.clone())
        let v = this.temp("item", unknown())
        var stmts = [] as Vec[HStmt]
        match pattern2 {
            Some(p2) => {
                if std_name == "Map" {
                    if let Some(p) = pattern {
                        this.destructure(p, field_e(unknown(), span, this.refl(v, span), "0"), stmts)
                    }
                    this.destructure(p2, field_e(unknown(), span, this.refl(v, span), "1"), stmts)
                } else {
                    this.bind_item(pattern, this.refl(v, span), stmts)
                }
            }
            None => this.bind_item(pattern, this.refl(v, span), stmts)
        }
        let b = this.stmts(body.stmts)
        stmts.extend(b.stmts)
        let next = mk(unknown(), span, KDyncall { recv: Box.new(this.refl(iter, span)), method: "next", args: [] })
        let inner = this.block_expr(HBlock { stmts, value: b.value }, void_ty(), body.span)
        let some: HPat = QVariant { union_name: "std.Option", variant: "Some", fields: [QBind(v)] }
        let m = mk(void_ty(), span, KMatch { subject: Box.new(next), arms: [arm(some, inner), arm(QWild, this.brk(span))] })
        let l = this.loop_e(ty.clone(), span, label, hblock([HDo(m)], None), None)
        mk(ty, span, KBlock(hblock([HLet { local: iter, value: iter_expr }], Some(l))))
    }

    /// The counter loop: `let $i = start; loop (step $i += 1) { if !cond { break }; let item = …; body }`.
    fun counter_loop(&mut this, span: Span, ty: Ty, label: &string?, pattern: &Pattern?, pattern2: &Pattern?, body: &Block, i: HLocal, start: HExpr, int_ty: Ty, cond: HExpr, item: HExpr?, pre: Vec[HStmt]) -> HExpr {
        let i_ref = this.refl(i, span)
        var stmts = [this.guard_break(span, cond)]
        if let Some(value) = item {
            this.bind_item(pattern, value, stmts)
        }
        if let Some(p2) = pattern2 {
            this.destructure(p2, i_ref.clone(), stmts)
        }
        let b = this.stmts(body.stmts)
        let one: HLit = if this.is_big(int_ty) { LBig("1") } else { LNum(1.0) }
        let step_e = mk(void_ty(), span, KAssign { target: Box.new(i_ref), op: "+=", value: Box.new(lit_e(one, int_ty, span)) })
        let step = hblock([HDo(step_e)], None)
        stmts.extend(b.stmts)
        let l = this.loop_e(ty.clone(), span, label, HBlock { stmts, value: b.value }, Some(step))
        var all = pre
        all.push(HLet { local: i, value: start })
        mk(ty, span, KBlock(hblock(all, Some(l))))
    }

    fun has_next(&this, t: &Ty) -> bool {
        let sym = named_sym(t)
        if sym < 0 {
            return false
        }
        match this.decl_of(sym) {
            Some(LStruct { methods, .. }) => methods.contains("next")
            _ => false
        }
    }
}

fun spread_of(fields: &Vec[RecordItem]) -> Expr? {
    for f in fields.iter() {
        if let RSpread { expr, .. } = f {
            return Some(expr.clone())
        }
    }
    None
}

fun dec_int(s: &str) -> int {
    var n = 0
    var i = 0
    for i < s.len() {
        n = n * 10 + (s.byte_at(i) as int - 48)
        i += 1
    }
    n
}
