// Control flow (if / match / select / for), patterns (spec §6) and exhaustiveness.
package check

import "app.lexer.{Span}"
import "app.ast.*"

/// What a constructor pattern names, given the value's type.
union PatVariant = {
    /// the type isn't known well enough to tell
    PVUnknown
    /// the pattern can't match a value of this type
    PVNone
    PVFound(VariantFound)
}

fun last_value_span(b: &Block) -> Span {
    match b.stmts.last() {
        Some(ExprStmt(es)) => es.expr.span
        _ => b.span
    }
}

fun irrefutable(p: &Pattern) -> bool {
    match &p.kind {
        PWild | PBind { .. } | PError => true
        PTuple { elems, .. } => elems.all(#{ x, _ => irrefutable(x) })
        POr(alts) => alts.any(#{ x, _ => irrefutable(x) })
        _ => false
    }
}

fun pattern_path(p: &Pattern) -> Vec[string]? {
    match &p.kind {
        PPath(path) => Some(path.clone())
        PCall { path, .. } => Some(path.clone())
        PStruct { path, .. } => path.clone()
        _ => None
    }
}

// ---- `break` inside a loop body (not in nested loops or closures) ----

fun block_has_break(b: &Block) -> bool { b.stmts.any(#{ s, _ => stmt_has_break(s) }) }

fun stmt_has_break(s: &Stmt) -> bool {
    match s {
        Let(l) => expr_has_break(l.value) || (match &l.else_branch {
            Some(b) => block_has_break(b)
            None => false
        })
        ExprStmt(es) => expr_has_break(es.expr)
    }
}

fun opt_has_break(e: &Box[Expr]?) -> bool {
    match e {
        Some(x) => expr_has_break(x.get())
        None => false
    }
}

fun elems_have_break(elems: &Vec[Elem]) -> bool {
    elems.any(#{ el, _ => match el {
        EValue(x) => expr_has_break(x)
        ESpread { expr, .. } => expr_has_break(expr)
    } })
}

fun items_have_break(items: &Vec[RecordItem]) -> bool {
    items.any(#{ f, _ => match f {
        RField(rf) => match &rf.value {
            Some(v) => expr_has_break(v)
            None => false
        }
        RSpread { expr, .. } => expr_has_break(expr)
    } })
}

fun expr_has_break(e: &Expr) -> bool {
    match &e.kind {
        Break { .. } => true
        For { .. } | Closure { .. } => false
        Paren(x) | Await(x) | Try(x) => expr_has_break(x.get())
        Unary { expr, .. } => expr_has_break(expr.get())
        As { expr, .. } => expr_has_break(expr.get())
        Return(v) => opt_has_break(v)
        Template(parts) => parts.any(#{ p, _ => match p {
            Interp(x) => expr_has_break(x)
            Text(_) => false
        } })
        VecLit(elems) | ArrayLit(elems) | TupleLit(elems) | SetLit(elems) => elems_have_break(elems)
        RecordLit(items) | Inferred(items) => items_have_break(items)
        MapLit(entries) => entries.any(#{ en, _ => match en {
            MEntry(me) => expr_has_break(me.key) || expr_has_break(me.value)
            MSpread { expr, .. } => expr_has_break(expr)
        } })
        StructLit { ty, fields } => expr_has_break(ty.get()) || items_have_break(fields)
        Binary { left, right, .. } => expr_has_break(left.get()) || expr_has_break(right.get())
        Assign { target, value, .. } => expr_has_break(target.get()) || expr_has_break(value.get())
        RangeExpr { start, end, .. } => opt_has_break(start) || opt_has_break(end)
        Or { expr, rhs, .. } => expr_has_break(expr.get()) || expr_has_break(rhs.get())
        Member { object, .. } | OptMember { object, .. } => expr_has_break(object.get())
        Call { callee, args } => expr_has_break(callee.get()) || elems_have_break(args)
        IndexExpr { object, index } => expr_has_break(object.get()) || expr_has_break(index.get())
        GenericApply { target, .. } => expr_has_break(target.get())
        If { cond, then, else_branch } => {
            let c = match cond {
                CExpr(x) => expr_has_break(x.get())
                CLet(lc) => expr_has_break(lc.value.get())
            }
            c || block_has_break(then) || opt_has_break(else_branch)
        }
        Match { subject, arms } => opt_has_break(subject) || arms.any(#{ a, _ =>
            (match &a.test {
                Some(t) => expr_has_break(t)
                None => false
            }) || (match &a.guard {
                Some(g) => expr_has_break(g)
                None => false
            }) || expr_has_break(a.body)
        })
        Select { arms, else_branch } => arms.any(#{ a, _ => expr_has_break(a.expr) || expr_has_break(a.body) }) || opt_has_break(else_branch)
        BlockExpr(b) | Unsafe(b) | Recover(b) => block_has_break(b)
        _ => false
    }
}

impl Checker {
    // ---- control flow ----

    /// The type of two branches together (if / match).
    fun join(&mut this, span: Span, a: Ty?, b: Ty) -> Ty {
        let Some(x) = a else { return b }
        if this.ptag(x) == "never" {
            return b
        }
        if this.ptag(b) == "never" {
            return x
        }
        if this.try_assign(b, x) {
            return x
        }
        if this.try_assign(x, b) {
            return b
        }
        this.error("E_TYPE_MISMATCH", "the branches have different types: `${this.show(x)}` and `${this.show(b)}`", span)
        x
    }

    fun check_if(&mut this, e: &Expr, cond: &Cond, then: &Block, else_branch: &Box[Expr]?, exp: Ty?) -> Ty {
        match cond {
            CLet(lc) => {
                let v = this.check_expr(lc.value.get(), None)
                this.bind_pattern(lc.pattern, v)
            }
            CExpr(c) => {
                let t = this.check_expr(c.get(), Some(prim("bool")))
                this.check_truthy(c.get().span, t)
            }
        }
        let branch_exp = if else_branch.is_some() { exp.clone() } else { None }
        let then_ty = this.check_stmts(then.stmts, branch_exp.clone())
        let Some(eb) = else_branch else { return void_ty() }
        let els = eb.get()
        let else_exp = match branch_exp {
            Some(b) => Some(b)
            None => this.arm_hint(Some(then_ty.clone()))
        }
        let else_ty = match &els.kind {
            BlockExpr(b) => this.check_stmts(b.stmts, else_exp)
            _ => this.check_expr(els, else_exp)
        }
        if let Some(x) = &exp {
            if !this.is_void(x) {
                if this.ptag(then_ty) != "never" {
                    this.expect_assign(last_value_span(then), then_ty, x)
                }
                if this.ptag(else_ty) != "never" {
                    let at = match &els.kind {
                        BlockExpr(b) => last_value_span(b)
                        _ => els.span
                    }
                    this.expect_assign(at, else_ty, x)
                }
                return if this.ptag(then_ty) == "never" && this.ptag(else_ty) == "never" { TyNever } else { x.clone() }
            }
        }
        if this.is_void(then_ty) || this.is_void(else_ty) {
            return if this.ptag(then_ty) == "never" { else_ty } else if this.ptag(else_ty) == "never" { then_ty } else { void_ty() }
        }
        this.join(e.span, Some(then_ty), else_ty)
    }

    fun check_match(&mut this, e: &Expr, subject: &Box[Expr]?, arms: &Vec[MatchArm], exp: Ty?) -> Ty {
        let subj = match subject {
            Some(s) => Some(this.check_expr(s.get(), None))
            None => None
        }
        var result: Ty? = None
        let fixed = match &exp {
            Some(x) => !this.is_void(x)
            None => false
        }
        for arm in arms.iter() {
            if let Some(p) = &arm.pattern {
                if let Some(s) = &subj {
                    this.bind_pattern(p, s)
                }
            }
            if let Some(t) = &arm.test {
                let tt = this.check_expr(t, Some(prim("bool")))
                this.check_truthy(t.span, tt)
            }
            if let Some(g) = &arm.guard {
                let gt = this.check_expr(g, Some(prim("bool")))
                this.check_truthy(g.span, gt)
            }
            // without an expected type, the arms so far give one (`List([…])` after a first arm of type Sx)
            let hint = match &exp {
                Some(x) => Some(x.clone())
                None => this.arm_hint(result.clone())
            }
            let ty = this.check_expr(arm.body, hint)
            if fixed && this.ptag(ty) != "never" {
                this.expect_assign(arm.body.span, ty, exp ?? TyUnknown)
            } else {
                result = Some(this.join_arm(arm.body.span, result, ty))
            }
        }
        this.check_exhaustive(e, arms, subj)
        if fixed {
            return exp ?? TyUnknown
        }
        result ?? TyNever
    }

    /// The type earlier branches settled on, as the expected type of the next one: only a named type
    /// (so an inferred variant there resolves, spec §7.6); literals keep their own inference.
    fun arm_hint(&this, t: Ty?) -> Ty? {
        let Some(x) = t else { return None }
        let p = this.prune(x)
        if tag(p) == "named" { Some(p) } else { None }
    }

    fun join_arm(&mut this, span: Span, a: Ty?, b: Ty) -> Ty {
        if let Some(x) = &a {
            if (this.is_void(x) || this.is_void(b)) && this.ptag(x) != "never" && this.ptag(b) != "never" {
                return void_ty()
            }
        }
        this.join(span, a, b)
    }

    fun check_select(&mut this, e: &Expr, arms: &Vec[SelectArm], else_branch: &Box[Expr]?, exp: Ty?) -> Ty {
        if !this.ctx.is_async {
            this.error("E_AWAIT_OUTSIDE_ASYNC", "`select` waits, so it is only allowed in an `async fun` (or `main`)", e.span)
        }
        var result: Ty? = None
        for arm in arms.iter() {
            let t = this.check_expr(arm.expr, None)
            let s = this.strip(t)
            var value: Ty = TyUnknown
            if tag(s) == "named" && this.is_prelude(named_sym(s), "Promise") {
                value = arg_at(s, 0)
            } else if tag(s) != "unknown" && tag(s) != "var" {
                this.error("E_SELECT_ARM_NOT_PROMISE", "a `select` arm waits on a Promise, found `${this.show(t)}`", arm.expr.span)
            }
            if let Some(p) = &arm.pattern {
                this.bind_pattern(p, value)
            }
            let bt = this.check_expr(arm.body, exp.clone())
            result = Some(this.join_arm(arm.body.span, result, bt))
        }
        if let Some(eb) = else_branch {
            let et = this.check_expr(eb.get(), exp)
            result = Some(this.join_arm(eb.get().span, result, et))
        }
        result ?? void_ty()
    }

    /// The element type of `for x in e` (spec §5.3, §10.2), and of the second binding (None: there is none).
    fun element_of(&mut this, of: &Ty, at: Span, is_await: bool) -> t(Ty, Ty?) {
        let s = this.strip(of)
        if tag(s) == "unknown" || tag(s) == "var" {
            return t(TyUnknown, None)
        }
        if is_await {
            if let Some(next) = this.find_method(s, "next", None, at) {
                let r = this.awaited(next.ret, at)
                if let Some(o) = this.optional_inner(r) {
                    return t(o.inner, None)
                }
            }
            if tag(s) == "named" {
                return t(TyUnknown, None)
            }
            this.error("E_NOT_ITERABLE", "`for await` needs an AsyncIterator (a value with `async fun next() -> T?`), found `${this.show(of)}`", at)
            return t(TyUnknown, None)
        }
        if let TyNamed { sym, .. } = &s {
            let n = this.syms[sym].name.clone()
            if this.syms[sym].std {
                if n == "Vec" || n == "Array" || n == "Slice" || n == "Set" {
                    return t(arg_at(s, 0), Some(prim("int")))
                }
                if n == "Map" {
                    return t(arg_at(s, 0), Some(arg_at(s, 1)))
                }
                if n == "Range" {
                    return t(arg_at(s, 0), None)
                }
            }
            if let Some(next) = this.find_method(s, "next", None, at) {
                if let Some(o) = this.optional_inner(next.ret) {
                    return t(o.inner, Some(prim("int")))
                }
            }
            if let Some(iter) = this.find_method(s, "iter", None, at) {
                return this.element_of(iter.ret, at, false)
            }
        }
        if is_stringy(s) {
            this.error("E_NOT_ITERABLE", "a string isn't iterable directly: use `.chars()`, `.bytes()` or `.lines()`", at)
            return t(TyUnknown, None)
        }
        this.error("E_NOT_ITERABLE", "`${this.show(of)}` can't be iterated with `for … in`", at)
        t(TyUnknown, None)
    }

    fun check_for(&mut this, e: &Expr, form: &str, is_await: bool, pattern: &Pattern?, pattern2: &Pattern?, expr: &Box[Expr]?, body: &Block) -> Ty {
        if is_await && !this.ctx.is_async {
            this.error("E_AWAIT_OUTSIDE_ASYNC", "`for await` is only allowed in an `async fun` (or `main`)", e.span)
        }
        if form == "cond" {
            if let Some(x) = expr {
                let t = this.check_expr(x.get(), Some(prim("bool")))
                this.check_truthy(x.get().span, t)
            }
        } else if form == "let" {
            if let Some(x) = expr {
                let t = this.check_expr(x.get(), None)
                if let Some(p) = pattern {
                    this.bind_pattern(p, t)
                }
            }
        } else if form == "in" {
            if let Some(x) = expr {
                let iter_ty = this.check_expr(x.get(), None)
                let t(item, second) = this.element_of(iter_ty, x.get().span, is_await)
                if let Some(p) = pattern {
                    this.bind_pattern(p, item)
                }
                if let Some(p2) = pattern2 {
                    if second.is_none() {
                        this.error("E_TYPE_MISMATCH", "`${this.show(iter_ty)}` yields one value per step, so there is no second binding", p2.span)
                    }
                    this.bind_pattern(p2, second ?? TyUnknown)
                }
            }
        }
        this.ctx.loops.push(None)
        let _ = this.check_stmts(body.stmts, None)
        let break_ty = this.ctx.loops.pop() ?? None
        if form == "infinite" {
            return break_ty ?? (if block_has_break(body) { void_ty() } else { TyNever })
        }
        void_ty()
    }

    // ---- patterns (spec §6) ----

    fun bind_sym(&mut this, id: int, ty: &Ty) {
        if let Some(sym) = this.decls.get(id) {
            this.sym_types[sym] = ty.clone()
        }
    }

    fun bind_pattern(&mut this, p: &Pattern, ty: &Ty) {
        let t = this.strip(ty)
        let unknown = tag(t) == "unknown"
        match &p.kind {
            PWild | PError => {}
            PBind { .. } => this.bind_sym(p.id, ty)
            PLit(v) => {
                let lt = this.check_expr(v.get(), if unknown { None } else { Some(t.clone()) })
                if !this.try_assign(lt, t) && !this.try_assign(t, lt) {
                    this.error("E_TYPE_MISMATCH", "this pattern is `${this.show(lt)}`, but the value is `${this.show(ty)}`", p.span)
                }
            }
            PRange { start, end, .. } => {
                for v in [start.clone(), end.clone()].iter() {
                    let Some(x) = v else { continue }
                    let lt = this.check_expr(x.get(), if unknown { None } else { Some(t.clone()) })
                    if !this.try_assign(lt, t) {
                        this.error("E_TYPE_MISMATCH", "this range is `${this.show(lt)}`, but the value is `${this.show(ty)}`", p.span)
                    }
                }
            }
            PTuple { elems, rest } => {
                if tag(t) == "unknown" || tag(t) == "var" {
                    for el in elems.iter() {
                        this.bind_pattern(el, TyUnknown)
                    }
                    return
                }
                let ok = match &t {
                    TyTuple(ts) => if rest { ts.len() >= elems.len() } else { ts.len() == elems.len() }
                    _ => false
                }
                if !ok {
                    this.error("E_TYPE_MISMATCH", "this pattern is a tuple of ${elems.len()}${if rest { " or more" } else { "" }}, but the value is `${this.show(ty)}`", p.span)
                    for el in elems.iter() {
                        this.bind_pattern(el, TyUnknown)
                    }
                    return
                }
                let TyTuple(ts) = &t else { return }
                var i = 0
                for el in elems.iter() {
                    this.bind_pattern(el, ts[i])
                    i += 1
                }
            }
            POr(alts) => {
                for a in alts.iter() {
                    this.bind_pattern(a, ty)
                }
            }
            PPath(_) | PCall { .. } | PStruct { .. } => this.bind_constructor(p, ty)
        }
    }

    fun variant_from_value(&mut this, t: &Ty, name: &str) -> PatVariant {
        if tag(t) != "named" {
            return PVNone
        }
        let Some(ii) = this.info(named_sym(t)) else { return PVNone }
        let Some(v) = this.variant_of(ii, name) else { return PVNone }
        PVFound(VariantFound { info: ii, t: t.clone(), v: Some(v) })
    }

    /// The variant (or struct) a constructor pattern names, given the value's type.
    fun pattern_variant(&mut this, p: &Pattern, ty: &Ty) -> PatVariant {
        let t = this.strip(ty)
        let Some(path) = pattern_path(p) else { return PVUnknown }
        let open_ty = tag(t) == "unknown" || tag(t) == "var"
        let Some(sym) = this.refs.get(p.id) else {
            if open_ty {
                return PVUnknown
            }
            return if path.len() == 1 { this.variant_from_value(t, path[0]) } else { PVUnknown }
        }
        let kind = this.syms[sym].kind.clone()
        if kind == "variant" {
            if open_ty {
                return PVUnknown
            }
            let owner = this.syms[sym].owner ?? -1
            if tag(t) != "named" || named_sym(t) != owner {
                return PVNone
            }
            let name = this.syms[sym].name.clone()
            return this.variant_from_value(t, name)
        }
        if kind == "union" && path.len() == 2 {
            if open_ty {
                return PVUnknown
            }
            if tag(t) != "named" || named_sym(t) != sym {
                return PVNone
            }
            return this.variant_from_value(t, path[1])
        }
        if kind == "type" && path.len() == 1 {
            if open_ty {
                return PVUnknown
            }
            if tag(t) != "named" || named_sym(t) != sym {
                return PVNone
            }
            let Some(ii) = this.info(sym) else { return PVUnknown }
            return PVFound(VariantFound { info: ii, t, v: None })
        }
        PVUnknown
    }

    fun bind_all_unknown(&mut this, p: &Pattern) {
        match &p.kind {
            PCall { args, .. } => {
                for a in args.iter() {
                    this.bind_pattern(a, TyUnknown)
                }
            }
            PStruct { fields, .. } => {
                for f in fields.iter() {
                    match &f.pattern {
                        Some(fp) => this.bind_pattern(fp, TyUnknown)
                        None => this.bind_sym(f.id, TyUnknown)
                    }
                }
            }
            _ => {}
        }
    }

    fun bind_constructor(&mut this, p: &Pattern, ty: &Ty) {
        let found = match this.pattern_variant(p, ty) {
            PVUnknown => {
                if let PStruct { path: None, fields, .. } = &p.kind {
                    return this.bind_record_pattern(fields, ty)
                }
                return this.bind_all_unknown(p)
            }
            PVNone => {
                let path = pattern_path(p)
                let name = match &path {
                    Some(ps) => ps.join(".")
                    None => "r{…}"
                }
                let t = this.strip(ty)
                let single = match &path {
                    Some(ps) => ps.len() == 1
                    None => false
                }
                if tag(t) == "named" && single && this.refs.get(p.id).is_none() {
                    this.error("E_UNKNOWN_VARIANT", "`${this.show(ty)}` has no variant `${name}`", p.span)
                } else {
                    this.error("E_TYPE_MISMATCH", "the pattern `${name}` doesn't match a value of type `${this.show(ty)}`", p.span)
                }
                return this.bind_all_unknown(p)
            }
            PVFound(f) => f
        }
        let env = this.env_for(found.info, named_args(found.t))
        let Some(v) = &found.v else {
            // a struct pattern on a named struct: `User { id, .. }`
            if let PStruct { fields, .. } = &p.kind {
                let decl = this.infos[found.info].fields.clone()
                this.bind_field_patterns(fields, decl, env, found.t)
            }
            return
        }
        this.variants[p.id] = r{ owner: this.infos[found.info].sym, variant: v.name.clone() }
        match &p.kind {
            PCall { args, rest, .. } => {
                var payload = [] as Vec[Ty]
                for x in (v.tuple ?? []).iter() {
                    let raw = this.to_ty(x)
                    payload.push(this.subst(raw, env))
                }
                let bad = match &v.tuple {
                    None => true
                    Some(_) => if rest { payload.len() < args.len() } else { payload.len() != args.len() }
                }
                if bad {
                    let has = match &v.tuple {
                        None => if v.fields.is_some() { "named fields" } else { "no payload" }
                        Some(_) => "${payload.len()} field${if payload.len() == 1 { "" } else { "s" }}"
                    }
                    this.error("E_TYPE_MISMATCH", "variant `${v.name}` has ${has}, but the pattern gives ${args.len()}", p.span)
                    return this.bind_all_unknown(p)
                }
                var i = 0
                for a in args.iter() {
                    this.bind_pattern(a, payload[i])
                    i += 1
                }
            }
            PStruct { fields, .. } => {
                let Some(vfields) = &v.fields else {
                    this.error("E_TYPE_MISMATCH", "variant `${v.name}` has no named fields", p.span)
                    return this.bind_all_unknown(p)
                }
                this.bind_field_patterns(fields, vfields, env, found.t)
            }
            _ => {
                if v.tuple.is_some() || v.fields.is_some() {
                    let alt = if v.fields.is_some() { " or `${v.name} { … }`" } else { "" }
                    this.error("E_TYPE_MISMATCH", "variant `${v.name}` has a payload: match it with `${v.name}(…)`${alt}", p.span)
                }
            }
        }
    }

    fun bind_field_patterns(&mut this, fields: &Vec[PatField], decl: &Vec[Field], env: &Map[int, Ty], self_ty: &Ty) {
        for f in fields.iter() {
            let df = decl.find(#{ d, _ => d.name == f.name })
            let fty = match &df {
                Some(d) => {
                    let raw = this.to_ty(d.ty)
                    this.subst(raw, env)
                }
                None => TyUnknown
            }
            if df.is_none() {
                this.error("E_UNKNOWN_FIELD", "`${this.show(self_ty)}` has no field `${f.name}`", f.span)
            }
            match &f.pattern {
                Some(fp) => this.bind_pattern(fp, fty)
                None => this.bind_sym(f.id, fty)
            }
        }
    }

    fun bind_record_pattern(&mut this, fields: &Vec[PatField], ty: &Ty) {
        let t = this.strip(ty)
        let rec = if tag(t) == "named" && this.info_kind(named_sym(t)) == "struct" { this.struct_as_record(t) } else { t }
        for f in fields.iter() {
            var fty: Ty = TyUnknown
            if let TyRecord(rfs) = &rec {
                match rfs.find(#{ x, _ => x.name == f.name }) {
                    Some(g) => fty = g.ty
                    None => this.error("E_UNKNOWN_FIELD", "`${this.show(ty)}` has no field `${f.name}`", f.span)
                }
            }
            match &f.pattern {
                Some(fp) => this.bind_pattern(fp, fty)
                None => this.bind_sym(f.id, fty)
            }
        }
    }

    // ---- exhaustiveness (simple: top-level variants, bool, literal unions) ----

    fun check_exhaustive(&mut this, e: &Expr, arms: &Vec[MatchArm], subject: Ty?) {
        let unguarded = arms.filter(#{ a, _ => a.guard.is_none() })
        let Some(subj) = subject else {
            if !unguarded.any(#{ a, _ => match &a.pattern {
                Some(p) => irrefutable(p)
                None => false
            } }) {
                this.error("E_NON_EXHAUSTIVE_MATCH", "a `match` without a subject needs a final `_ =>` arm", e.span)
            }
            return
        }
        var pats = [] as Vec[Pattern]
        for a in unguarded.iter() {
            let Some(p) = &a.pattern else { continue }
            match &p.kind {
                POr(alts) => pats.extend(alts.clone())
                _ => pats.push(p.clone())
            }
        }
        if pats.any(#{ p, _ => irrefutable(p) }) {
            return
        }
        let t = this.strip(subj)
        let k = tag(t)
        if k == "unknown" || k == "var" || k == "never" {
            return
        }
        var missing = [] as Vec[string]
        if k == "named" && this.info_kind(named_sym(t)) == "union" {
            let Some(ii) = this.info(named_sym(t)) else { return }
            var covered = Set.new() as Set[string]
            for p in pats.iter() {
                let full = match &p.kind {
                    PPath(_) => true
                    PCall { args, .. } => args.all(#{ x, _ => irrefutable(x) })
                    PStruct { fields, .. } => fields.all(#{ x, _ => match &x.pattern {
                        Some(fp) => irrefutable(fp)
                        None => true
                    } })
                    _ => continue
                }
                let PVFound(f) = this.pattern_variant(p, t) else { continue }
                let Some(v) = &f.v else { continue }
                if full {
                    let _ = covered.insert(v.name.clone())
                }
            }
            for v in this.infos[ii].variants.iter() {
                if !covered.has(v.name) {
                    missing.push(v.name.clone())
                }
            }
        } else if is_prim(t, "bool") {
            var vals = Set.new() as Set[bool]
            for p in pats.iter() {
                if let PLit(v) = &p.kind {
                    if let Bool(b) = &v.get().kind {
                        let _ = vals.insert(b)
                    }
                }
            }
            for b in [true, false].iter() {
                if !vals.has(b) {
                    missing.push(if b { "true" } else { "false" })
                }
            }
        } else if let TyUnion(members) = &t {
            var vals = Set.new() as Set[string]
            for p in pats.iter() {
                let PLit(v) = &p.kind else { continue }
                let text = match &v.get().kind {
                    Str { value, .. } => value.clone()
                    Int(d) => d.clone()
                    Bool(b) => if b { "true" } else { "false" }
                    _ => "?"
                }
                let _ = vals.insert(text)
            }
            for m in members.iter() {
                let TyLit(l) = this.prune(m) else { continue }
                let text = match l {
                    LStr(s) => s
                    LInt(d) => d
                    LBool(b) => if b { "true" } else { "false" }
                }
                if !vals.has(text) {
                    missing.push(text)
                }
            }
        } else {
            missing.push("_")
        }
        if missing.is_empty() {
            return
        }
        let list = if missing[0] == "_" { "add a `_ =>` arm" } else { "missing ${missing.map(#{ m, _ => "`${m}`" }).join(", ")}" }
        this.error("E_NON_EXHAUSTIVE_MATCH", "this `match` on `${this.show(subj)}` doesn't cover every case: ${list}", e.span)
    }
}
