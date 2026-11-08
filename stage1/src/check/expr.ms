// Expressions: literals, names, operators, members, calls, literals with fields, closures.
package check

import "app.lexer.{Span}"
import "app.ast.*"

/// What a call calls: its signature (None: a value without one), the callee's type, whether it was
/// reached through `?.`, and whether it is a method called on a value.
type CalleeRes = { c: Callable?, ty: Ty, via_opt: bool = false, on_value: bool = false }

fun elem_expr(el: &Elem) -> Expr {
    match el {
        EValue(x) => x.clone()
        ESpread { expr, .. } => expr.clone()
    }
}

fun is_closure_elem(el: &Elem) -> bool {
    match el {
        EValue(x) => match &x.kind {
            Closure { .. } => true
            _ => false
        }
        ESpread { .. } => false
    }
}

fun is_comparison(op: &str) -> bool {
    match op {
        "==" | "!=" | "<" | "<=" | ">" | ">=" => true
        _ => false
    }
}

fun is_arith(op: &str) -> bool {
    match op {
        "+" | "-" | "*" | "/" | "%" => true
        _ => false
    }
}

/// A non-negative decimal integer (a tuple index, an `itN` suffix).
fun dec_value(s: &str) -> int {
    var n = 0
    var i = 0
    for i < s.len() {
        n = n * 10 + (s.byte_at(i) as int - 48)
        i += 1
    }
    n
}

impl Checker {
    pub fun check_expr(&mut this, e: &Expr, expected: Ty?) -> Ty {
        let ty = this.expr_inner(e, expected)
        this.types[e.id] = ty.clone()
        ty
    }

    fun strip_opt(&this, t: &Ty?) -> Ty? {
        match t {
            Some(x) => Some(this.strip(x))
            None => None
        }
    }

    fun expr_inner(&mut this, e: &Expr, exp: Ty?) -> Ty {
        match &e.kind {
            Ident(name) => this.check_ident(e, name, exp)
            This => this.ctx.this_ty ?? TyUnknown
            Int(v) => this.check_int(e, v, exp)
            Float(_) => {
                if let Some(x) = this.strip_opt(exp) {
                    if is_float(x) {
                        return x
                    }
                }
                this.fresh_lit("float")
            }
            Str { value, .. } => {
                if let Some(x) = this.strip_opt(exp) {
                    let k = tag(x)
                    if k == "lit" || k == "union" {
                        if this.try_assign(TyLit(LStr(value.clone())), x) {
                            return x
                        }
                    }
                }
                prim("string")
            }
            Char(_) => prim("char")
            Bool(_) => prim("bool")
            Nil => {
                if let Some(x) = this.strip_opt(exp) {
                    if this.is_option(x) {
                        return x
                    }
                }
                let v = this.fresh_at(e.id, e.span, "`nil`")
                this.option(v)
            }
            Template(parts) => {
                for p in parts.iter() {
                    if let Interp(x) = p {
                        let _ = this.check_expr(x, None)
                    }
                }
                prim("string")
            }
            Paren(x) => this.check_expr(x.get(), exp)
            VecLit(elems) => this.check_vec(e, elems, exp)
            ArrayLit(elems) => {
                let x = this.strip_opt(exp)
                let elem = match &x {
                    Some(t) => if tag(t) == "named" && this.is_prelude(named_sym(t), "Array") { arg_at(t, 0) } else { this.fresh_at(e.id, e.span, "the array's elements") }
                    None => this.fresh_at(e.id, e.span, "the array's elements")
                }
                this.check_elems(elems, elem, "Array")
                this.named("Array", [elem, TyLit(LInt("${elems.len()}"))])
            }
            TupleLit(elems) => {
                let x = this.strip_opt(exp)
                var out = [] as Vec[Ty]
                var i = 0
                for el in elems.iter() {
                    let want = match &x {
                        Some(TyTuple(xs)) => xs.get(i)
                        _ => None
                    }
                    out.push(this.check_expr(elem_expr(el), want))
                    i += 1
                }
                if out.is_empty() { void_ty() } else { TyTuple(out) }
            }
            SetLit(elems) => {
                let x = this.strip_opt(exp)
                let elem = match &x {
                    Some(t) => if tag(t) == "named" && this.is_prelude(named_sym(t), "Set") { arg_at(t, 0) } else { this.fresh_at(e.id, e.span, "the set's elements") }
                    None => this.fresh_at(e.id, e.span, "the set's elements")
                }
                this.check_elems(elems, elem, "Set")
                this.named("Set", [elem])
            }
            MapLit(entries) => this.check_map(e, entries, exp)
            RecordLit(fields) => this.check_record(fields, exp)
            Inferred(fields) => this.check_inferred(e, fields, exp)
            StructLit { ty, fields } => this.check_struct_lit(e, ty.get(), fields, exp)
            Closure { params, ret, body, .. } => this.check_closure(e, params, ret, body, exp)
            Unary { op, expr } => this.check_unary(e, op, expr.get(), exp)
            Await(x) => {
                if !this.ctx.is_async {
                    this.error("E_AWAIT_OUTSIDE_ASYNC", "`await` is only allowed in an `async fun` (or `main`)", e.span)
                }
                let t = this.check_expr(x.get(), None)
                this.awaited(t, x.get().span)
            }
            Binary { op, left, right } => this.check_binary(e, op, left.get(), right.get(), exp)
            Assign { op, target, value } => this.check_assign(e, op, target.get(), value.get())
            RangeExpr { start, end, .. } => {
                var elem = this.fresh_lit("int")
                if let Some(s) = start {
                    elem = this.check_expr(s.get(), Some(elem))
                }
                if let Some(x) = end {
                    let t = this.check_expr(x.get(), Some(elem.clone()))
                    this.expect_assign(x.get().span, t, elem)
                }
                this.named("Range", [elem])
            }
            As { expr, ty } => this.check_as(e, expr.get(), ty)
            Or { expr, rhs, .. } => this.check_or(e, expr.get(), rhs.get())
            Member { object, name, index } => this.check_member(e, object.get(), name, index, false, exp)
            OptMember { object, name, index } => this.check_member(e, object.get(), name, index, true, exp)
            Call { callee, args } => this.check_call(e, callee.get(), args, exp)
            IndexExpr { object, index } => this.check_index(e, object.get(), index.get())
            GenericApply { target, args } => this.check_generic_value(e, target.get(), args)
            Try(x) => this.check_try(e, x.get())
            If { cond, then, else_branch } => this.check_if(e, cond, then, else_branch, exp)
            Match { subject, arms } => this.check_match(e, subject, arms, exp)
            Select { arms, else_branch } => this.check_select(e, arms, else_branch, exp)
            For { form, is_await, pattern, pattern2, expr, body, .. } => this.check_for(e, form, is_await, pattern, pattern2, expr, body)
            BlockExpr(b) => this.check_stmts(b.stmts, exp)
            Unsafe(b) => this.check_stmts(b.stmts, exp)
            Recover(b) => {
                var inner: Ty? = None
                if let Some(x) = this.strip_opt(exp) {
                    if this.is_result(x) {
                        inner = Some(arg_at(x, 0))
                    }
                }
                let v = this.check_stmts(b.stmts, inner.clone())
                let ok = if this.ptag(v) == "never" { inner ?? void_ty() } else { v }
                let panic = this.named("Panic", [])
                this.named("Result", [ok, panic])
            }
            Return(value) => {
                let ret = this.ctx.ret.clone()
                if let Some(v) = value {
                    let t = this.check_expr(v.get(), Some(ret.clone()))
                    this.expect_assign_as(v.get().span, t, ret, "the function returns")
                } else if !this.is_void(ret) && this.ptag(ret) != "unknown" && this.ptag(ret) != "var" {
                    this.error("E_TYPE_MISMATCH", "`return` needs a value of type `${this.show(ret)}`", e.span)
                } else if this.ptag(ret) == "var" {
                    let _ = this.try_assign(void_ty(), ret)
                }
                TyNever
            }
            Break { value, .. } => {
                let n = this.ctx.loops.len()
                if let Some(v) = value {
                    let current = if n > 0 { this.ctx.loops[n - 1].clone() } else { None }
                    let ty = this.check_expr(v.get(), current.clone())
                    if n > 0 {
                        match current {
                            None => this.ctx.loops[n - 1] = Some(ty)
                            Some(bt) => this.expect_assign(v.get().span, ty, bt)
                        }
                    }
                }
                TyNever
            }
            Continue(_) => TyNever
            Error => TyUnknown
        }
    }

    fun is_interface(&mut this, t: &Ty) -> bool {
        let s = this.strip(t)
        tag(s) == "named" && this.info_kind(named_sym(s)) == "inter"
    }

    fun is_void(&this, t: &Ty) -> bool { is_prim(this.prune(t), "void") }

    fun check_int(&mut this, e: &Expr, value: &str, exp: Ty?) -> Ty {
        if let Some(x) = this.strip_opt(exp) {
            if is_numeric(x) {
                this.check_int_range(e.span, value, prim_name(x), false)
                return x
            }
            let k = tag(x)
            if k == "lit" || k == "union" {
                if this.try_assign(TyLit(LInt(value.to_str())), x) {
                    return x
                }
            }
        }
        this.fresh_lit("int")
    }

    fun check_int_range(&mut this, span: Span, value: &str, name: &str, negated: bool) {
        let Some(range) = int_range(name) else { return }
        let t(lo, hi) = range
        let v = if negated { dec_neg(value) } else { value.to_str() }
        if dec_cmp(v, lo) < 0 || dec_cmp(v, hi) > 0 {
            this.error("E_INT_OUT_OF_RANGE", "`${v}` doesn't fit in `${name}` (${lo} to ${hi})", span)
        }
    }

    fun check_elems(&mut this, elems: &Vec[Elem], elem: &Ty, kind: &str) {
        for el in elems.iter() {
            match el {
                ESpread { expr, .. } => {
                    let t = this.check_expr(expr, None)
                    let s = this.strip(t)
                    if tag(s) == "named" && !named_args(s).is_empty() {
                        this.expect_assign(expr.span, arg_at(s, 0), elem)
                    } else if tag(s) != "unknown" {
                        this.error("E_TYPE_MISMATCH", "`...` in a ${kind} literal needs a collection, found `${this.show(t)}`", expr.span)
                    }
                }
                EValue(x) => {
                    let t = this.check_expr(x, Some(elem.clone()))
                    this.expect_assign(x.span, t, elem)
                }
            }
        }
    }

    fun check_vec(&mut this, e: &Expr, elems: &Vec[Elem], exp: Ty?) -> Ty {
        let x = this.strip_opt(exp)
        let elem = match &x {
            Some(t) => {
                if tag(t) == "unknown" {
                    this.fresh()
                } else if tag(t) == "named" && (this.is_prelude(named_sym(t), "Vec") || this.is_prelude(named_sym(t), "Slice")) {
                    match named_args(t).get(0) {
                        Some(a) => a
                        None => this.fresh()
                    }
                } else {
                    this.fresh_at(e.id, e.span, "the elements of `[]`")
                }
            }
            None => this.fresh_at(e.id, e.span, "the elements of `[]`")
        }
        this.check_elems(elems, elem, "Vec")
        this.named("Vec", [elem])
    }

    fun check_map(&mut this, e: &Expr, entries: &Vec[MapItem], exp: Ty?) -> Ty {
        let x = this.strip_opt(exp)
        let xt = x ?? TyNever
        let ok = x.is_some() && tag(xt) == "named" && this.is_prelude(named_sym(xt), "Map")
        let loose = x.is_some() && tag(xt) == "unknown"
        let key = if ok { arg_at(xt, 0) } else if loose { this.fresh() } else { this.fresh_at(e.id, e.span, "the keys of `m{}`") }
        let val = if ok { arg_at(xt, 1) } else if loose { this.fresh() } else { this.fresh_at(e.id, e.span, "the values of `m{}`") }
        for en in entries.iter() {
            match en {
                MSpread { expr, .. } => {
                    let want = this.named("Map", [key.clone(), val.clone()])
                    let _ = this.check_expr(expr, Some(want))
                }
                MEntry(me) => {
                    let k = this.check_expr(me.key, Some(key.clone()))
                    this.expect_assign(me.key.span, k, key)
                    let v = this.check_expr(me.value, Some(val.clone()))
                    this.expect_assign(me.value.span, v, val)
                }
            }
        }
        this.named("Map", [key, val])
    }

    // ---- names ----

    fun check_ident(&mut this, e: &Expr, name: &str, exp: Ty?) -> Ty {
        let Some(sym) = this.refs.get(e.id) else {
            if this.deferred.has(e.id) && !this.open.has(e.id) {
                return this.infer_variant_value(e.id, e.span, name, exp)
            }
            return TyUnknown
        }
        this.sym_value(sym, e.id, e.span, exp)
    }

    fun sym_value(&mut this, sym: int, at_id: int, at: Span, exp: Ty?) -> Ty {
        let kind = this.syms[sym].kind.clone()
        match kind {
            "local" | "param" | "closure-param" | "implicit" => this.sym_types.get(sym) ?? TyUnknown
            "this" => this.ctx.this_ty ?? TyUnknown
            "fun" | "extern-fun" => {
                match this.fun_type(sym, None, at) {
                    Some(c) => this.fn_type(c)
                    None => TyUnknown
                }
            }
            "global" => this.global_type(sym)
            "type" | "union" | "inter" => {
                let ii = this.info(sym)
                TyMeta(Box.new(TyNamed { sym, args: this.fill_args(ii, []) }))
            }
            "builtin-type" => {
                let name = this.syms[sym].name.clone()
                TyMeta(Box.new(if name == "never" { TyNever } else { TyPrim(name) }))
            }
            "generic" => TyMeta(Box.new(TyParam(sym)))
            "variant" => {
                let owner = this.syms[sym].owner
                if let Some(o) = owner {
                    this.variants[at_id] = r{ owner: o, variant: this.syms[sym].name.clone() }
                }
                let Some(o) = owner else { return TyUnknown }
                let Some(ii) = this.info(o) else { return TyUnknown }
                let Some(DVariant(decl)) = this.decl_of(sym) else { return TyUnknown }
                let t = this.variant_recv(o, ii, exp)
                let v = this.variant_type(ii, t, decl)
                this.static_type(v)
            }
            "package" | "import" => TyPackage { name: this.syms[sym].name.clone(), sym: Some(sym) }
            _ => TyUnknown
        }
    }

    /// The union type a variant of `owner` builds: the expected type if it is that union, else fresh arguments.
    fun variant_recv(&mut this, owner: int, ii: int, exp: Ty?) -> Ty {
        if let Some(x) = this.strip_opt(exp) {
            if named_sym(x) == owner {
                return x
            }
        }
        var args = [] as Vec[Ty]
        let n = this.infos[ii].generics.len()
        for args.len() < n {
            args.push(this.fresh())
        }
        TyNamed { sym: owner, args }
    }

    fun no_variant_message(&this, name: &str, exp: &Ty?) -> string {
        let shown = match exp {
            Some(x) => " `${this.show(x)}`"
            None => ""
        }
        "unknown name `${name}`: no variant `${name}` in the expected type${shown}; qualify it (`Type.${name}`)"
    }

    /// A bare uppercase name the resolver couldn't bind: a variant of the expected union (spec §7.6).
    fun infer_variant_value(&mut this, at_id: int, at: Span, name: &str, exp: Ty?) -> Ty {
        if let Some(x) = this.strip_opt(exp) {
            if tag(x) == "unknown" {
                return TyUnknown
            }
        }
        let Some(found) = this.expected_variant(name, exp) else {
            let msg = this.no_variant_message(name, exp)
            this.error("E_CANNOT_INFER_VARIANT", msg, at)
            return TyUnknown
        }
        this.variants[at_id] = r{ owner: this.infos[found.info].sym, variant: name.to_str() }
        let Some(v) = &found.v else { return TyUnknown }
        let s = this.variant_type(found.info, found.t, v)
        this.static_type(s)
    }

    fun expected_variant(&mut this, name: &str, exp: &Ty?) -> VariantFound? {
        let Some(x) = this.strip_opt(exp) else { return None }
        if tag(x) != "named" {
            return None
        }
        let Some(ii) = this.info(named_sym(x)) else { return None }
        let Some(v) = this.variant_of(ii, name) else { return None }
        Some(VariantFound { info: ii, t: x, v: Some(v) })
    }

    // ---- operators ----

    fun check_truthy(&mut this, span: Span, t: &Ty) {
        let s = this.strip(t)
        let k = tag(s)
        if k == "unknown" || k == "var" || k == "never" || is_prim(s, "bool") || this.is_option(s) || this.is_result(s) {
            return
        }
        let hint = if is_numeric(s) { ": compare explicitly, e.g. `n != 0`" } else if is_stringy(s) { ": use `!s.is_empty()`" } else { "" }
        this.error("E_NOT_TRUTHY", "a condition must be `bool`, an Option or a Result, found `${this.show(t)}`${hint}", span)
    }

    fun check_unary(&mut this, e: &Expr, op: &str, x: &Expr, exp: Ty?) -> Ty {
        match op {
            "-" => {
                if let Int(v) = &x.kind {
                    if let Some(xs) = this.strip_opt(exp) {
                        if is_numeric(xs) {
                            this.check_int_range(e.span, v, prim_name(xs), true)
                            this.types[x.id] = xs.clone()
                            return xs
                        }
                    }
                }
                let t = this.check_expr(x, exp)
                let s = this.strip(t)
                if tag(s) == "var" || tag(s) == "unknown" || is_numeric(s) {
                    return t
                }
                if tag(s) == "named" && this.find_method(s, "neg", None, e.span).is_some() {
                    return t
                }
                this.error("E_INVALID_OPERANDS", "`-` needs a number, found `${this.show(t)}`", e.span)
                TyUnknown
            }
            "!" => {
                let t = this.check_expr(x, None)
                if is_int(this.strip(t)) {
                    return t        // bitwise not
                }
                this.check_truthy(x.span, t)
                prim("bool")
            }
            "&" | "&mut" => {
                let want = match &exp {
                    Some(xe) => match this.prune(xe) {
                        TyRef { inner, .. } => Some(inner.get().clone())
                        _ => None
                    }
                    None => None
                }
                let t = this.check_expr(x, want)
                TyRef { is_mut: op == "&mut", inner: Box.new(t) }
            }
            "*" => {
                let raw = this.check_expr(x, None)
                let t = this.prune(raw)
                match &t {
                    TyPtr { inner, .. } => return inner.get().clone()
                    TyRef { inner, .. } => return inner.get().clone()
                    _ => {}
                }
                if tag(t) != "unknown" && tag(t) != "var" {
                    this.error("E_INVALID_OPERANDS", "`*` dereferences a pointer, found `${this.show(t)}`", e.span)
                }
                TyUnknown
            }
            _ => TyUnknown
        }
    }

    fun check_binary(&mut this, e: &Expr, op: &str, left: &Expr, right: &Expr, exp: Ty?) -> Ty {
        if op == "&&" || op == "||" {
            let l = this.check_expr(left, None)
            this.check_truthy(left.span, l)
            let r = this.check_expr(right, None)
            this.check_truthy(right.span, r)
            return prim("bool")
        }
        if op == "??" {
            return this.check_nullish(e, left, right, exp)
        }
        let l = this.check_expr(left, if is_arith(op) { exp } else { None })
        let r = this.check_expr(right, Some(l.clone()))
        let ls = this.strip(l)
        let rs = this.strip(r)
        if tag(ls) == "unknown" || tag(rs) == "unknown" {
            return if is_comparison(op) { prim("bool") } else { TyUnknown }
        }
        if is_comparison(op) {
            if !this.try_assign(r, l) && !this.try_assign(l, r) {
                this.error("E_TYPE_MISMATCH", "can't compare `${this.show(l)}` with `${this.show(r)}`", e.span)
            }
            return prim("bool")
        }
        let lnum = is_numeric(ls) || (tag(ls) == "var" && this.var_lit(var_of(ls)) != "")
        let rnum = is_numeric(rs) || (tag(rs) == "var" && this.var_lit(var_of(rs)) != "")
        if op == "+" && is_stringy(ls) && is_stringy(rs) {
            return prim("string")
        }
        if is_arith(op) && lnum && rnum {
            return this.numeric_result(e.span, l, r)
        }
        if op == "&" || op == "|" || op == "^" || op == "<<" || op == ">>" {
            let lint = is_int(ls) || (tag(ls) == "var" && this.var_lit(var_of(ls)) == "int")
            let rint = is_int(rs) || (tag(rs) == "var" && this.var_lit(var_of(rs)) == "int")
            if lint && rint {
                return if op == "<<" || op == ">>" { l } else { this.numeric_result(e.span, l, r) }
            }
            this.error("E_INVALID_OPERANDS", "`${op}` needs integers, found `${this.show(l)}` and `${this.show(r)}`", e.span)
            return TyUnknown
        }
        // operator interfaces (Plus, Minus, …)
        let method = operator_method(op)
        if method != "" && tag(ls) != "var" {
            if let Some(c) = this.find_method(ls, method, None, e.span) {
                if c.params.len() == 1 {
                    this.expect_assign(right.span, r, c.params[0].ty)
                    return c.ret
                }
            }
        }
        if (tag(ls) == "var" && this.var_lit(var_of(ls)) == "") || (tag(rs) == "var" && this.var_lit(var_of(rs)) == "") {
            return TyUnknown
        }
        this.error("E_INVALID_OPERANDS", "`${op}` can't be applied to `${this.show(l)}` and `${this.show(r)}`", e.span)
        TyUnknown
    }

    /// Arithmetic on numbers: same type, or the wider one when one side widens losslessly (spec §9.5).
    fun numeric_result(&mut this, span: Span, l: Ty, r: Ty) -> Ty {
        if this.try_assign(r, l) {
            return l
        }
        if this.try_assign(l, r) {
            return r
        }
        this.error("E_TYPE_MISMATCH", "mismatched number types `${this.show(l)}` and `${this.show(r)}`: convert one with `as`", span)
        l
    }

    fun optional_inner(&this, t: &Ty) -> OptInner? {
        let s = this.strip(t)
        if tag(s) != "named" {
            return None
        }
        let sym = named_sym(s)
        if this.is_prelude(sym, "Option") {
            return Some(OptInner { inner: arg_at(s, 0), payload: None })
        }
        if this.is_prelude(sym, "Result") {
            return Some(OptInner { inner: arg_at(s, 0), payload: Some(arg_at(s, 1)) })
        }
        None
    }

    fun check_nullish(&mut this, e: &Expr, left: &Expr, right: &Expr, exp: Ty?) -> Ty {
        let want = match &exp {
            Some(x) => Some(this.option(x.clone()))
            None => None
        }
        let l = this.check_expr(left, want)
        let ls = this.strip(l)
        if tag(ls) == "unknown" || tag(ls) == "var" {
            let _ = this.check_expr(right, exp.clone())
            return exp ?? TyUnknown
        }
        let Some(o) = this.optional_inner(l) else {
            this.error("E_TYPE_MISMATCH", "`??` needs an Option or a Result on its left, found `${this.show(l)}`", left.span)
            let _ = this.check_expr(right, None)
            return TyUnknown
        }
        let r = this.check_expr(right, Some(o.inner.clone()))
        if this.try_assign(r, o.inner) {
            return o.inner
        }
        let opt = this.option(o.inner.clone())
        if this.try_assign(r, opt) {
            return opt
        }
        this.error("E_TYPE_MISMATCH", "the fallback of `??` should be `${this.show(o.inner)}`, found `${this.show(r)}`", right.span)
        o.inner
    }

    fun check_assign(&mut this, e: &Expr, op: &str, target: &Expr, value: &Expr) -> Ty {
        let tt = this.check_expr(target, None)
        if op == "??=" {
            let o = this.optional_inner(tt)
            if o.is_none() && tag(this.strip(tt)) != "unknown" {
                this.error("E_TYPE_MISMATCH", "`??=` needs an Option on its left, found `${this.show(tt)}`", target.span)
            }
            let want = match o {
                Some(x) => x.inner
                None => TyUnknown
            }
            let v = this.check_expr(value, Some(want.clone()))
            this.expect_assign(value.span, v, want)
            return void_ty()
        }
        let v = this.check_expr(value, Some(tt.clone()))
        if op == "=" {
            this.expect_assign(value.span, v, tt)
        } else {
            let base = op.substring(0, op.len() - 1)
            let ts = this.strip(tt)
            let vs = this.strip(v)
            if base == "+" && is_stringy(ts) {
                this.expect_assign(value.span, v, prim("string"))
            } else if is_numeric(ts) || tag(ts) == "var" {
                this.expect_assign(value.span, v, tt)
            } else if tag(ts) != "unknown" && tag(vs) != "unknown" {
                let method = operator_method(base)
                var found = false
                if method != "" {
                    found = this.find_method(ts, "${method}_assign", None, e.span).is_some() || this.find_method(ts, method, None, e.span).is_some()
                }
                if !found {
                    this.error("E_INVALID_OPERANDS", "`${op}` can't be applied to `${this.show(tt)}`", e.span)
                }
            }
        }
        void_ty()
    }

    fun check_as(&mut this, e: &Expr, x: &Expr, ty: &Type) -> Ty {
        let t = this.to_ty(ty)
        let v = this.check_expr(x, Some(t.clone()))
        if this.try_assign(v, t) {
            return t                     // a type annotation (spec §3.3)
        }
        // an untyped literal that isn't the target type: its default type, then a cast (`3.9 as int`)
        let lit = this.prune(v)
        if tag(lit) == "var" {
            let l = this.var_lit(var_of(lit))
            if l != "" {
                let _ = this.try_assign(lit, prim(if l == "float" { "f64" } else { "int" }))
            }
        }
        let vs = this.strip(v)
        let ts = this.strip(t)
        if castable(vs) && castable(ts) {
            return t                     // a cast
        }
        this.error("E_INVALID_CAST", "`${this.show(v)}` can't be used as `${this.show(t)}`: `as` annotates a matching type or casts between numbers / pointers", e.span)
        t
    }

    fun check_or(&mut this, e: &Expr, x: &Expr, rhs: &Expr) -> Ty {
        let l = this.check_expr(x, None)
        let o = this.optional_inner(l)
        let ls = this.strip(l)
        if o.is_none() && tag(ls) != "unknown" && tag(ls) != "var" {
            this.error("E_TYPE_MISMATCH", "`or` needs an Option or a Result on its left, found `${this.show(l)}`", x.span)
        }
        // the payload (`it`, or the named binding) is the error of a Result
        let payload = match &o {
            Some(OptInner { payload: Some(p), .. }) => p.clone()
            _ => TyUnknown
        }
        if let Some(named) = this.decls.get(e.id) {
            this.sym_types[named] = payload.clone()
        }
        for s in (this.implicit_by_owner.get(e.id) ?? []).iter() {
            this.sym_types[s] = payload.clone()
        }
        let ret = this.ctx.ret.clone()
        let r = this.check_expr(rhs, Some(ret.clone()))
        if this.ptag(r) != "never" {
            this.expect_assign_as(rhs.span, r, ret, "`or` returns its right side from the function, which returns")
        }
        match o {
            Some(x) => x.inner
            None => TyUnknown
        }
    }

    fun check_try(&mut this, e: &Expr, x: &Expr) -> Ty {
        let t = this.check_expr(x, None)
        let Some(o) = this.optional_inner(t) else {
            let k = tag(this.strip(t))
            if k != "unknown" && k != "var" {
                this.error("E_INVALID_TRY", "`?` needs an Option or a Result, found `${this.show(t)}`", e.span)
            }
            return TyUnknown
        }
        let fret = this.ctx.ret.clone()
        let ret = this.strip(fret)
        if tag(ret) == "unknown" || tag(ret) == "var" {
            return o.inner
        }
        match &o.payload {
            None => {
                if !this.is_option(ret) {
                    this.error("E_INVALID_TRY", "`?` on an Option returns `None`, so the function must return an Option (it returns `${this.show(fret)}`)", e.span)
                }
            }
            Some(p) => {
                if !this.is_result(ret) {
                    this.error("E_INVALID_TRY", "`?` on a Result returns the error, so the function must return a Result (it returns `${this.show(fret)}`)", e.span)
                } else {
                    let err = arg_at(ret, 1)
                    if !this.try_assign(p, err) {
                        this.error("E_INVALID_TRY", "`?` would return an error of type `${this.show(p)}`, but the function's errors are `${this.show(err)}`", e.span)
                    }
                }
            }
        }
        o.inner
    }

    fun awaited(&mut this, t: &Ty, at: Span) -> Ty {
        let s = this.strip(t)
        if tag(s) == "named" && this.is_prelude(named_sym(s), "Promise") {
            return arg_at(s, 0)
        }
        let k = tag(s)
        if k != "unknown" && k != "var" && k != "never" {
            this.error("E_TYPE_MISMATCH", "`await` needs a Promise, found `${this.show(t)}`", at)
        }
        TyUnknown
    }

    fun check_index(&mut this, e: &Expr, object: &Expr, index: &Expr) -> Ty {
        let t = this.check_expr(object, None)
        let s = this.strip(t)
        if tag(s) == "named" {
            let sym = named_sym(s)
            if this.is_prelude(sym, "Vec") || this.is_prelude(sym, "Array") || this.is_prelude(sym, "Slice") {
                let ix = this.check_expr(index, Some(prim("int")))
                this.expect_assign_as(index.span, ix, prim("int"), "an index is")
                return arg_at(s, 0)
            }
            if this.is_prelude(sym, "Map") {
                let k = arg_at(s, 0)
                let ix = this.check_expr(index, Some(k.clone()))
                this.expect_assign_as(index.span, ix, k, "the map's keys are")
                return arg_at(s, 1)
            }
            if let Some(c) = this.find_method(s, "index", None, e.span) {
                if c.params.len() == 1 {
                    let p = c.params[0].ty.clone()
                    let ix = this.check_expr(index, Some(p.clone()))
                    this.expect_assign(index.span, ix, p)
                    return this.strip(c.ret)
                }
            }
        }
        let _ = this.check_expr(index, None)
        if tag(s) == "unknown" || tag(s) == "var" {
            return TyUnknown
        }
        let hint = if is_stringy(s) { ": strings aren't integer-indexable, use `.bytes()`, `.chars()` or `.substring(a, b)`" } else { "" }
        this.error("E_NOT_INDEXABLE", "`${this.show(t)}` can't be indexed${hint}", e.span)
        TyUnknown
    }

    // ---- members and calls ----

    fun check_member(&mut this, e: &Expr, object: &Expr, name: &str, index: bool, opt: bool, exp: Ty?) -> Ty {
        let obj = this.check_expr(object, None)
        if opt {
            let Some(o) = this.optional_inner(obj) else {
                let k = tag(this.strip(obj))
                if k != "unknown" && k != "var" {
                    this.error("E_TYPE_MISMATCH", "`?.` needs an Option or a Result, found `${this.show(obj)}`; use `.`", e.span)
                }
                return TyUnknown
            }
            let inner = this.member_of(e.id, e.span, o.inner, name, index)
            return if this.is_option(inner) { inner } else { this.option(inner) }
        }
        let _ = exp
        this.member_of(e.id, e.span, obj, name, index)
    }

    fun member_of(&mut this, id: int, span: Span, obj_ty: &Ty, name: &str, index: bool) -> Ty {
        let t = this.strip(obj_ty)
        match &t {
            TyUnknown | TyVar(_) | TyPackage { .. } | TyNever => return TyUnknown
            TyMeta(inner) => {
                if !index {
                    let target = this.prune(inner.get())
                    let Some(st) = this.find_static(inner.get(), name, None, span) else {
                        if tag(target) != "named" {
                            return TyUnknown
                        }
                        this.error("E_UNKNOWN_MEMBER", "`${this.show(target)}` has no variant or static method `${name}`", span)
                        return TyUnknown
                    }
                    match &st {
                        SCall(c) => {
                            if let Some(v) = &c.variant {
                                if tag(target) == "named" {
                                    this.members[id] = MVariant(r{ owner: named_sym(target), variant: name.to_str() })
                                }
                                let _ = v
                            } else if let Some(d) = c.decl {
                                let owner = c.owner.clone() ?? (if tag(target) == "named" { OSym(named_sym(target)) } else { OName("auto") })
                                this.members[id] = MStatic { decl: d, owner }
                            }
                        }
                        STy(_) => {
                            if tag(target) == "named" {
                                this.members[id] = MVariant(r{ owner: named_sym(target), variant: name.to_str() })
                            }
                        }
                    }
                    return this.static_type(st)
                }
            }
            TyTuple(elems) => {
                if index {
                    let n = dec_value(name)
                    this.members[id] = MTuple(n)
                    if let Some(el) = elems.get(n) {
                        return el
                    }
                    this.error("E_UNKNOWN_FIELD", "the tuple has ${elems.len()} elements, so `.${name}` doesn't exist", span)
                    return TyUnknown
                }
            }
            TyRecord(fields) => {
                if let Some(f) = fields.find(#{ x, _ => x.name == name }) {
                    this.members[id] = MField
                    return f.ty
                }
            }
            TyNamed { sym, args } => {
                let ii = this.info(sym)
                if let Some(i) = ii {
                    if let Some(field) = this.field_of(i, name) {
                        this.members[id] = MField
                        let raw = this.to_ty(field.ty)
                        let env = this.env_for(i, args.clone())
                        return this.subst(raw, env)
                    }
                }
                if !index {
                    if let Some(m) = this.find_method(t, name, None, span) {
                        this.members[id] = MMethod { decl: m.decl, owner: m.owner.clone() ?? OName("auto"), is_dyn: m.is_dyn }
                        return this.fn_type(m)
                    }
                }
                if ii.is_none() {
                    return TyUnknown
                }
            }
            _ => {
                if !index {
                    if let Some(m) = this.find_method(t, name, None, span) {
                        return this.fn_type(m)
                    }
                }
            }
        }
        this.error("E_UNKNOWN_FIELD", "`${this.show(obj_ty)}` has no field or method `${name}`", span)
        TyUnknown
    }

    fun check_generic_value(&mut this, e: &Expr, target: &Expr, args: &Vec[Type]) -> Ty {
        var targs = [] as Vec[Ty]
        for a in args.iter() {
            targs.push(this.to_ty(a))
        }
        if let Ident(_) = &target.kind {
            if let Some(sym) = this.refs.get(target.id) {
                let k = this.syms[sym].kind.clone()
                if k == "fun" || k == "extern-fun" {
                    let ty = match this.fun_type(sym, Some(targs), e.span) {
                        Some(c) => this.fn_type(c)
                        None => TyUnknown
                    }
                    this.types[target.id] = ty.clone()
                    return ty
                }
            }
        }
        let t = this.check_expr(target, None)
        let s = this.prune(t)
        if let TyMeta(inner) = &s {
            let target_ty = this.prune(inner.get())
            if let TyNamed { args: own, .. } = &target_ty {
                let _ = this.eq_args(own, targs)
                return TyMeta(Box.new(target_ty.clone()))
            }
        }
        TyUnknown
    }

    /// Resolves what is being called: a function, method, constructor or closure.
    fun callee(&mut this, e: &Expr, callee0: &Expr, exp: Ty?) -> CalleeRes {
        var callee = callee0.clone()
        var explicit: Vec[Ty]? = None
        if let GenericApply { target, args } = &callee0.kind {
            var ts = [] as Vec[Ty]
            for a in args.iter() {
                ts.push(this.to_ty(a))
            }
            explicit = Some(ts)
            callee = target.get().clone()
        }
        // method call / static call: x.f(…), T.f(…), x?.f(…)
        let member = match &callee.kind {
            Member { object, name, index } => if index { None } else { Some(t(object.get().clone(), name.clone(), false)) }
            OptMember { object, name, index } => if index { None } else { Some(t(object.get().clone(), name.clone(), true)) }
            _ => None
        }
        if let Some(mem) = member {
            let t(object, name, via_opt) = mem
            let obj = this.check_expr(object, None)
            var recv = obj.clone()
            if via_opt {
                recv = match this.optional_inner(obj) {
                    Some(o) => o.inner
                    None => TyUnknown
                }
            }
            let s = this.prune(recv)
            if let TyMeta(inner) = &s {
                let Some(st) = this.find_static(inner.get(), name, explicit, callee.span) else {
                    let target = this.prune(inner.get())
                    if tag(target) == "named" {
                        this.error("E_UNKNOWN_MEMBER", "`${this.show(target)}` has no static method or variant `${name}`", callee.span)
                    }
                    return CalleeRes { c: None, ty: TyUnknown, via_opt }
                }
                let SCall(c) = st else {
                    this.error("E_NOT_CALLABLE", "`${name}` has no payload; write it without `(…)`", e.span)
                    return CalleeRes { c: None, ty: TyUnknown, via_opt }
                }
                let ty = this.fn_type(c)
                return CalleeRes { c: Some(c), ty, via_opt }
            }
            let st = this.strip(recv)
            let k = tag(st)
            if k == "unknown" || k == "var" || k == "package" || k == "never" {
                return CalleeRes { c: None, ty: TyUnknown, via_opt }
            }
            if let Some(m) = this.find_method(st, name, explicit, callee.span) {
                let ty = this.fn_type(m)
                return CalleeRes { c: Some(m), ty, via_opt, on_value: true }
            }
            // a field holding a function
            let ft = this.member_of(callee.id, callee.span, st, name, false)
            return CalleeRes { c: None, ty: ft, via_opt }
        }
        if let Ident(name) = &callee.kind {
            let sym = this.refs.get(callee.id)
            if sym.is_none() && this.deferred.has(callee.id) {
                let loose = match this.strip_opt(exp) {
                    Some(x) => tag(x) == "unknown"
                    None => false
                }
                if this.open.has(callee.id) || loose {
                    return CalleeRes { c: None, ty: TyUnknown }
                }
                // Text("hi") with an expected union (spec §7.6)
                let Some(found) = this.expected_variant(name, exp) else {
                    let msg = this.no_variant_message(name, exp)
                    this.error("E_CANNOT_INFER_VARIANT", msg, callee.span)
                    return CalleeRes { c: None, ty: TyUnknown }
                }
                let Some(v) = &found.v else { return CalleeRes { c: None, ty: TyUnknown } }
                return match this.variant_type(found.info, found.t, v) {
                    SCall(c) => {
                        let ty = this.fn_type(c)
                        CalleeRes { c: Some(c), ty }
                    }
                    STy(t) => CalleeRes { c: None, ty: t }
                }
            }
            if let Some(s) = sym {
                if let Some(r) = this.callee_sym(s, callee, explicit, exp, e) {
                    return r
                }
            }
        }
        let t = this.check_expr(callee, None)
        CalleeRes { c: None, ty: t }
    }

    /// Calling a name that resolved to `sym`: a function, variant or type.
    fun callee_sym(&mut this, sym: int, callee: &Expr, explicit: Vec[Ty]?, exp: Ty?, e: &Expr) -> CalleeRes? {
        let kind = this.syms[sym].kind.clone()
        let name = this.syms[sym].name.clone()
        if kind == "fun" || kind == "extern-fun" {
            if let Some(c) = this.fun_type(sym, explicit.clone(), callee.span) {
                let ty = this.fn_type(c)
                this.types[callee.id] = ty.clone()
                return Some(CalleeRes { c: Some(c), ty })
            }
        }
        if kind == "variant" {
            let t = this.sym_value(sym, callee.id, callee.span, exp.clone())
            this.types[callee.id] = t
            let Some(owner) = this.syms[sym].owner else { return Some(CalleeRes { c: None, ty: TyUnknown }) }
            let Some(ii) = this.info(owner) else { return Some(CalleeRes { c: None, ty: TyUnknown }) }
            let recv = this.variant_recv(owner, ii, exp)
            let Some(DVariant(decl)) = this.decl_of(sym) else { return Some(CalleeRes { c: None, ty: TyUnknown }) }
            if let SCall(c) = this.variant_type(ii, recv, decl) {
                let ty = this.fn_type(c)
                return Some(CalleeRes { c: Some(c), ty })
            }
            this.error("E_NOT_CALLABLE", "`${name}` has no payload; write it without `(…)`", e.span)
            return Some(CalleeRes { c: None, ty: TyUnknown })
        }
        if kind == "type" || kind == "union" {
            // `Signal(0)`, `Ref(x)`: calling a type calls its static `new`
            let meta = this.sym_value(sym, callee.id, callee.span, None)
            this.types[callee.id] = meta.clone()
            let TyMeta(inner) = &meta else { return None }
            if let Some(SCall(c)) = this.find_static(inner.get(), "new", explicit, callee.span) {
                let ty = this.fn_type(c)
                return Some(CalleeRes { c: Some(c), ty })
            }
            this.error("E_NOT_CALLABLE", "`${name}` is a type without a static `new`; build it with `${name} { … }`", e.span)
            return Some(CalleeRes { c: None, ty: TyUnknown })
        }
        None
    }

    fun check_call(&mut this, e: &Expr, callee: &Expr, args: &Vec[Elem], exp: Ty?) -> Ty {
        let res = this.callee(e, callee, exp.clone())
        let ty = res.ty.clone()
        let callable = match res.c {
            Some(c) => c
            None => {
                let s = this.strip(ty)
                if let TyFn { params, ret, is_async } = &s {
                    var ps = [] as Vec[ParamTy]
                    var i = 0
                    for p in params.iter() {
                        ps.push(ParamTy { name: "${i}", ty: p.clone(), variadic: false })
                        i += 1
                    }
                    Callable { params: ps, ret: ret.get().clone(), is_async, receiver: None, decl: None }
                } else {
                    let k = tag(s)
                    if k != "unknown" && k != "var" && k != "package" && k != "never" {
                        this.error("E_NOT_CALLABLE", "`${this.show(ty)}` can't be called", callee.span)
                    }
                    for a in args.iter() {
                        let _ = this.check_expr(elem_expr(a), Some(TyUnknown))
                    }
                    this.calls[e.id] = CallInfo { target: CUnknown, args: args.map(#{ _, _ => TyUnknown }), receiver: None, is_async: false }
                    return TyUnknown
                }
            }
        }
        // let the expected result guide inference, unless it is an interface (`&Stringer` accepts any type,
        // so it must not decide a generic result: `log.println(xs.fold(0, …))`)
        if let Some(x) = &exp {
            if !this.is_interface(x) {
                let _ = this.try_assign(callable.ret, x)
            }
        }
        this.apply_args(e, args, callable)
        var env = [] as Vec[t(int, Ty)]
        for g, gt in callable.env {
            env.push(t(g, gt.clone()))
        }
        this.calls[e.id] = CallInfo {
            target: call_target(callable, res.on_value), args: this.arg_params(args, callable),
            receiver: if res.on_value { callable.receiver.clone() } else { None }, is_async: callable.is_async,
            type_args: callable.bounds.map(#{ b, _ => b.v.clone() }), type_env: env,
        }
        var all = callable.bounds.clone()
        all.extend(callable.outer_bounds.clone())
        for b in all.iter() {
            for bound in b.bounds.iter() {
                let v = this.prune(b.v)
                let bs = this.strip(bound)
                if tag(v) == "var" || tag(bs) != "named" {
                    continue
                }
                if !this.implements(v, named_sym(bs)) {
                    this.error("E_BOUND_NOT_SATISFIED", "`${this.show(v)}` doesn't implement `${this.show(bound)}`", e.span)
                }
            }
        }
        let ret = callable.ret.clone()
        if res.via_opt {
            return if this.is_option(ret) { ret } else { this.option(ret) }
        }
        ret
    }

    /// The parameter type each argument binds to (spread arguments: the variadic parameter itself).
    fun arg_params(&this, args: &Vec[Elem], c: &Callable) -> Vec[Ty] {
        let n = c.params.len()
        let variadic = n > 0 && c.params[n - 1].variadic
        let fixed = if variadic { n - 1 } else { n }
        var out = [] as Vec[Ty]
        var i = 0
        for a in args.iter() {
            let p = if i < fixed { c.params.get(i) } else if variadic { c.params.get(n - 1) } else { None }
            i += 1
            let Some(param) = p else {
                out.push(TyUnknown)
                continue
            }
            let spread = match a {
                ESpread { .. } => true
                _ => false
            }
            if !param.variadic || spread {
                out.push(param.ty)
                continue
            }
            let s = this.strip(param.ty)
            out.push(if tag(s) == "named" { arg_at(s, 0) } else { TyUnknown })
        }
        out
    }

    fun omittable(&mut this, p: &ParamTy) -> bool {
        let t = this.prune(p.ty)
        if tag(t) == "var" && this.var_lit(var_of(t)) == "" {
            return this.try_assign(void_ty(), t)
        }
        this.is_void(t) || tag(t) == "unknown"
    }

    fun apply_args(&mut this, e: &Expr, args: &Vec[Elem], c: &Callable) {
        let n = c.params.len()
        let variadic = n > 0 && c.params[n - 1].variadic
        let fixed = if variadic { n - 1 } else { n }
        // missing trailing `void` arguments may be left out: `Ok()`, `resolver.resolve()` (spec §7.1)
        var required = 0
        var i = 0
        for i < fixed {
            if i >= args.len() {
                if !this.omittable(c.params[i]) {
                    required += 1
                }
            } else {
                required += 1
            }
            i += 1
        }
        let lower = if required < fixed { required } else { fixed }
        if args.len() < lower || (!variadic && args.len() > fixed) {
            let count = if required == fixed { "${fixed}" } else { "${required}–${fixed}" }
            this.error("E_ARG_COUNT", "expected ${if variadic { "at least " } else { "" }}${count} argument${if fixed == 1 { "" } else { "s" }}, found ${args.len()}", e.span)
        }
        // closures last, so the other arguments can bind generics first (`map(items, #{ … })`)
        var order = [] as Vec[int]
        var k = 0
        for a in args.iter() {
            if !is_closure_elem(a) {
                order.push(k)
            }
            k += 1
        }
        k = 0
        for a in args.iter() {
            if is_closure_elem(a) {
                order.push(k)
            }
            k += 1
        }
        for idx in order.iter() {
            let a = &args[idx]
            let p = if idx < fixed { c.params.get(idx) } else if variadic { c.params.get(n - 1) } else { None }
            let Some(param) = p else {
                let _ = this.check_expr(elem_expr(a), None)
                continue
            }
            var want = param.ty.clone()
            if param.variadic {
                let s = this.strip(want)
                let elem = if tag(s) == "named" { arg_at(s, 0) } else { TyUnknown }
                if let ESpread { expr, .. } = a {
                    let _ = this.check_expr(expr, Some(want))
                    continue
                }
                want = elem
            }
            match a {
                ESpread { span, expr } => {
                    this.error("E_TYPE_MISMATCH", "`...` spreads only into a variadic parameter (`...name: T`)", span)
                    let _ = this.check_expr(expr, None)
                }
                EValue(x) => {
                    let t = this.check_expr(x, Some(want.clone()))
                    this.expect_assign(x.span, t, want)
                }
            }
        }
    }

    // ---- literals with fields ----

    fun field_hint(&mut this, x: &Ty?, name: &str) -> Ty? {
        let Some(t) = x else { return None }
        match t {
            TyRecord(fields) => match fields.find(#{ f, _ => f.name == name }) {
                Some(f) => Some(f.ty)
                None => None
            }
            TyNamed { sym, args } => {
                let Some(ii) = this.info(sym) else { return None }
                let Some(f) = this.field_of(ii, name) else { return None }
                let raw = this.to_ty(f.ty)
                let env = this.env_for(ii, args.clone())
                Some(this.subst(raw, env))
            }
            _ => None
        }
    }

    fun check_record(&mut this, items: &Vec[RecordItem], exp: Ty?) -> Ty {
        let x = this.strip_opt(exp)
        var fields = [] as Vec[FieldTy]
        for f in items.iter() {
            match f {
                RSpread { expr, .. } => {
                    let raw = this.check_expr(expr, None)
                    let st = this.strip(raw)
                    let src = if tag(st) == "named" && this.info_kind(named_sym(st)) == "struct" { this.struct_as_record(st) } else { st }
                    if let TyRecord(gs) = &src {
                        for g in gs.iter() {
                            if !fields.any(#{ h, _ => h.name == g.name }) {
                                fields.push(g.clone())
                            }
                        }
                    }
                }
                RField(rf) => {
                    let hint = this.field_hint(x, rf.key)
                    let ty = this.field_value(rf, hint)
                    var i = 0
                    for i < fields.len() {
                        if fields[i].name == rf.key {
                            let _ = fields.remove(i)
                            break
                        }
                        i += 1
                    }
                    fields.push(FieldTy { name: rf.key.clone(), ty, optional: false })
                }
            }
        }
        sort_fields(fields)
        TyRecord(fields)
    }

    fun field_value(&mut this, f: &RecordField, want: Ty?) -> Ty {
        if let Some(v) = &f.value {
            return this.check_expr(v, want)
        }
        // shorthand: `r{ name }`
        match this.refs.get(f.id) {
            Some(sym) => this.sym_value(sym, f.id, f.span, None)
            None => TyUnknown
        }
    }

    fun check_inferred(&mut this, e: &Expr, items: &Vec[RecordItem], exp: Ty?) -> Ty {
        let x = this.strip_opt(exp)
        let xt = x.clone() ?? TyVar(-1)
        if x.is_none() || tag(xt) == "var" {
            this.error("E_CANNOT_INFER_STRUCT_TYPE", "`_{ … }` takes its type from the context, and there is none here: name the type (`Config { … }`) or annotate it", e.span)
            for f in items.iter() {
                match f {
                    RSpread { expr, .. } => { let _ = this.check_expr(expr, None) }
                    RField(rf) => {
                        if let Some(v) = &rf.value {
                            let _ = this.check_expr(v, None)
                        }
                    }
                }
            }
            return TyUnknown
        }
        if tag(xt) == "unknown" {
            for f in items.iter() {
                match f {
                    RSpread { expr, .. } => { let _ = this.check_expr(expr, None) }
                    RField(rf) => { let _ = this.field_value(rf, None) }
                }
            }
            return TyUnknown
        }
        if tag(xt) == "record" {
            return this.check_record(items, Some(xt))
        }
        if tag(xt) == "named" && this.info_kind(named_sym(xt)) == "struct" {
            this.check_struct_fields(e.span, xt, items)
            return xt
        }
        this.error("E_CANNOT_INFER_STRUCT_TYPE", "`_{ … }` builds a struct or record, but `${this.show(xt)}` is expected", e.span)
        TyUnknown
    }

    fun check_struct_lit(&mut this, e: &Expr, ty_expr0: &Expr, items: &Vec[RecordItem], exp: Ty?) -> Ty {
        var ty_expr = ty_expr0.clone()
        var explicit: Vec[Ty]? = None
        if let GenericApply { target, args } = &ty_expr0.kind {
            var ts = [] as Vec[Ty]
            for a in args.iter() {
                ts.push(this.to_ty(a))
            }
            explicit = Some(ts)
            ty_expr = target.get().clone()
        }
        // a struct-like variant: `Payment.Card { … }`, or `Card { … }` with an expected union (spec §7.6)
        var variant: VariantFound? = None
        match &ty_expr.kind {
            Ident(name) => {
                if this.refs.get(ty_expr.id).is_none() && this.deferred.has(ty_expr.id) {
                    variant = this.expected_variant(name, exp.clone())
                    if variant.is_none() {
                        let loose = match this.strip_opt(exp) {
                            Some(x) => tag(x) == "unknown"
                            None => false
                        }
                        if !this.open.has(ty_expr.id) && !loose {
                            this.error("E_CANNOT_INFER_VARIANT", "unknown type or variant `${name}`", ty_expr.span)
                        }
                        this.check_fields_loosely(items)
                        return TyUnknown
                    }
                }
            }
            Member { object, name, index } => {
                if !index {
                    let raw = this.check_expr(object.get(), None)
                    let obj = this.prune(raw)
                    if let TyMeta(inner) = &obj {
                        let t = this.prune(inner.get())
                        if tag(t) == "named" {
                            if let Some(ii) = this.info(named_sym(t)) {
                                if let Some(v) = this.variant_of(ii, name) {
                                    var self_ty = t.clone()
                                    if let Some(x) = this.strip_opt(exp) {
                                        if named_sym(x) == named_sym(t) {
                                            self_ty = x
                                        }
                                    }
                                    variant = Some(VariantFound { info: ii, t: self_ty, v: Some(v) })
                                }
                            }
                        }
                    }
                    if variant.is_none() {
                        this.check_fields_loosely(items)
                        return TyUnknown            // `models.User { … }`: a package's type, not loaded yet
                    }
                }
            }
            _ => {}
        }
        if let Some(found) = variant {
            let Some(v) = &found.v else { return TyUnknown }
            this.variants[e.id] = r{ owner: this.infos[found.info].sym, variant: v.name.clone() }
            let Some(vfields) = &v.fields else {
                this.error("E_TYPE_MISMATCH", "variant `${v.name}` has no fields", e.span)
                return found.t
            }
            let env = this.env_for(found.info, named_args(found.t))
            this.check_field_list(e.span, vfields, env, items, found.t)
            return found.t
        }
        let raw = this.check_expr(ty_expr, None)
        let meta = this.prune(raw)
        let TyMeta(inner) = &meta else {
            if tag(meta) != "unknown" {
                this.error("E_NOT_A_TYPE", "`${this.show(meta)}` is not a struct type", ty_expr.span)
            }
            this.check_fields_loosely(items)
            return TyUnknown
        }
        let t = this.prune(inner.get())
        if tag(t) != "named" || this.info_kind(named_sym(t)) != "struct" {
            if tag(t) == "named" {
                this.error("E_TYPE_MISMATCH", "`${this.show(t)}` is not a struct, so it can't be built with `{ … }`", ty_expr.span)
            }
            this.check_fields_loosely(items)
            return TyUnknown
        }
        if let Some(ex) = explicit {
            let _ = this.eq_args(named_args(t), ex)
        }
        if let Some(x) = this.strip_opt(exp) {
            if named_sym(x) == named_sym(t) {
                let _ = this.eq_args(named_args(t), named_args(x))
            }
        }
        this.check_struct_fields(e.span, t, items)
        t
    }

    fun check_fields_loosely(&mut this, items: &Vec[RecordItem]) {
        for f in items.iter() {
            match f {
                RSpread { expr, .. } => { let _ = this.check_expr(expr, Some(TyUnknown)) }
                RField(rf) => { let _ = this.field_value(rf, Some(TyUnknown)) }
            }
        }
    }

    fun check_struct_fields(&mut this, span: Span, t: &Ty, items: &Vec[RecordItem]) {
        let Some(ii) = this.info(named_sym(t)) else { return }
        let fields = this.infos[ii].fields.clone()
        let env = this.env_for(ii, named_args(t))
        this.check_field_list(span, fields, env, items, t)
    }

    /// Fields of a struct literal: known names, required fields present (or spread), types match.
    fun check_field_list(&mut this, span: Span, decl: &Vec[Field], env: &Map[int, Ty], given: &Vec[RecordItem], self_ty: &Ty) {
        var spread = false
        var seen = Set.new() as Set[string]
        for f in given.iter() {
            match f {
                RSpread { expr, .. } => {
                    spread = true
                    let t = this.check_expr(expr, Some(self_ty.clone()))
                    this.expect_assign_as(expr.span, t, self_ty, "`...` here spreads a")
                }
                RField(rf) => {
                    let Some(df) = decl.find(#{ d, _ => d.name == rf.key }) else {
                        this.error("E_UNKNOWN_FIELD", "`${this.show(self_ty)}` has no field `${rf.key}`", rf.span)
                        let _ = this.field_value(rf, None)
                        continue
                    }
                    let _ = seen.insert(rf.key.clone())
                    let raw = this.to_ty(df.ty)
                    let want = this.subst(raw, env)
                    let at = match &rf.value {
                        Some(v) => v.span
                        None => rf.span
                    }
                    let t = this.field_value(rf, Some(want.clone()))
                    this.expect_assign(at, t, want)
                }
            }
        }
        if spread {
            return
        }
        var missing = [] as Vec[string]
        for d in decl.iter() {
            if seen.has(d.name) || d.default.is_some() {
                continue
            }
            let dt = this.to_ty(d.ty)
            if !this.is_option(dt) {
                missing.push("`${d.name}`")
            }
        }
        if !missing.is_empty() {
            this.error("E_MISSING_FIELD", "missing field${if missing.len() > 1 { "s" } else { "" }} ${missing.join(", ")} in `${this.show(self_ty)}`", span)
        }
    }

    // ---- closures ----

    fun check_closure(&mut this, e: &Expr, params: &Vec[ClosureParam]?, ret_type: &Type?, body: &Block, exp: Ty?) -> Ty {
        let x = this.strip_opt(exp)
        var want_params: Vec[Ty]? = None
        var want_ret: Ty? = None
        var loose = false
        if let Some(xt) = &x {
            if let TyFn { params: ps, ret, .. } = xt {
                want_params = Some(ps.clone())
                want_ret = Some(ret.get().clone())
            }
            loose = tag(xt) == "unknown"             // passed to something without a signature yet
        }
        let wp = want_params ?? []
        var tys = [] as Vec[Ty]
        match params {
            Some(ps) => {
                var i = 0
                for p in ps.iter() {
                    let given = if want_params.is_some() { wp.get(i) } else { None }
                    let ty = match &p.ty {
                        Some(pt) => this.to_ty(pt)
                        None => match &given {
                            Some(g) => g.clone()
                            None => if loose { TyUnknown } else { this.fresh_at(p.id, p.span, "closure parameter `${p.name}`") }
                        }
                    }
                    if p.ty.is_some() {
                        if let Some(g) = &given {
                            this.expect_assign_as(p.span, g, ty, "the closure parameter is")
                        }
                    }
                    if let Some(sym) = this.decls.get(p.id) {
                        this.sym_types[sym] = ty.clone()
                    }
                    tys.push(ty)
                    i += 1
                }
            }
            None => {
                // implicit `it`, `it2` …: as many parameters as the highest one used
                let implicit = this.implicit_by_owner.get(e.id) ?? []
                var n = 0
                for s in implicit.iter() {
                    let k = dec_value(this.syms[s].name.substring(2, this.syms[s].name.len()))
                    if k > n {
                        n = k
                    }
                }
                var i = 0
                for i < n {
                    let given = if want_params.is_some() { wp.get(i) } else { None }
                    let ty = match given {
                        Some(g) => g
                        None => if loose { TyUnknown } else { this.fresh_at(e.id, e.span, "`it${if i == 0 { "" } else { "${i + 1}" }}`") }
                    }
                    tys.push(ty)
                    i += 1
                }
                for s in implicit.iter() {
                    let k = dec_value(this.syms[s].name.substring(2, this.syms[s].name.len()))
                    this.sym_types[s] = tys.get(k - 1) ?? TyUnknown
                }
            }
        }
        let ret = match ret_type {
            Some(rt) => this.to_ty(rt)
            None => match want_ret {
                Some(r) => r
                None => if loose { TyUnknown } else { this.fresh() }
            }
        }
        let saved = this.ctx.clone()
        this.ctx = FnCtx { ret: ret.clone(), is_async: false, this_ty: saved.this_ty.clone(), loops: [], is_closure: true }
        let void_ret = this.is_void(ret)
        let value = this.check_stmts(body.stmts, if void_ret { None } else { Some(ret.clone()) })
        if !void_ret && this.ptag(value) != "never" {
            var at = e.span
            if let Some(last) = body.stmts.last() {
                at = match last {
                    Let(l) => l.span
                    ExprStmt(es) => es.span
                }
            }
            this.expect_assign_as(at, value, ret, "the closure should produce")
        }
        this.ctx = saved
        TyFn { params: tys, ret: Box.new(ret), is_async: false }
    }
}

fun castable(a: &Ty) -> bool { is_numeric(a) || tag(a) == "ptr" || is_prim(a, "char") }

fun call_target(c: &Callable, on_value: bool) -> CallTarget {
    if let Some(v) = c.variant {
        return CVariant(v)
    }
    if let Some(a) = &c.auto {
        return CMethod { decl: None, owner: OName("auto"), is_dyn: true, auto: Some(a.clone()) }
    }
    let Some(decl) = c.decl else { return CValue }
    if on_value {
        return CMethod { decl: Some(decl), owner: c.owner.clone() ?? OName("auto"), is_dyn: c.is_dyn, auto: None }
    }
    if let Some(o) = &c.owner {
        return CStatic { decl, owner: o.clone() }
    }
    CFun(decl)
}
