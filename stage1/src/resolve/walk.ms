// Name resolution of types, statements, patterns and expressions (spec §8.7).
package resolve

import "app.lexer.{Span}"
import "app.ast.*"

impl Resolver {
    // ---- types ----

    pub fun resolve_type(&mut this, scope: int, t: &Type) {
        match &t.kind {
            TName { path, args } => {
                let head = path[0].clone()
                let label = path.join(".")
                if head == "Self" {
                    match this.type_ctx {
                        None => this.error("E_SELF_OUTSIDE_TYPE", "`Self` is only available inside a type, union, interface or impl", t.span)
                        Some(ctx) => if let Some(s) = ctx.self_sym { this.set_ref(t.id, t.span, label, s) }
                    }
                } else {
                    let sym = this.lookup(scope, head)
                    if this.ambiguous(sym, t.span) {
                        for a in args.iter() {
                            this.resolve_type(scope, a)
                        }
                        return
                    }
                    match sym {
                        None => {
                            if this.is_open(scope) {
                                this.defer(t.id, t.span, label)
                            } else {
                                this.error("E_UNDECLARED_TYPE", "unknown type `${head}`", t.span)
                            }
                        }
                        Some(s) => {
                            let kind = this.symbols[s].kind.clone()
                            if path.len() == 1 && !type_kind(kind) {
                                this.error("E_NOT_A_TYPE", "`${head}` is a ${describe_kind(kind)}, not a type", t.span)
                            } else {
                                this.set_ref(t.id, t.span, label, s)
                            }
                        }
                    }
                }
                for a in args.iter() {
                    this.resolve_type(scope, a)
                }
            }
            TOption(inner) => this.resolve_type(scope, inner.get())
            TRef { inner, .. } => this.resolve_type(scope, inner.get())
            TPtr { inner, .. } => this.resolve_type(scope, inner.get())
            TTuple(elems) => {
                for e in elems.iter() {
                    this.resolve_type(scope, e)
                }
            }
            TRecord(fields) => {
                var seen = s{} as Set[string]
                for f in fields.iter() {
                    if seen.has(f.name) {
                        this.error("E_DUPLICATE_FIELD", "field `${f.name}` is declared twice", f.span)
                    }
                    let _ = seen.insert(f.name.clone())
                    this.resolve_type(scope, f.ty)
                }
            }
            TFn { params, ret } => {
                for p in params.iter() {
                    this.resolve_type(scope, p)
                }
                this.resolve_type(scope, ret.get())
            }
            TTypeOf(path) => {
                let sym = this.lookup(scope, path[0])
                if this.ambiguous(sym, t.span) {
                    return
                }
                let label = "TypeOf(${path.join(".")})"
                match sym {
                    None => {
                        if this.is_open(scope) {
                            this.defer(t.id, t.span, label)
                        } else {
                            this.error("E_UNDECLARED_NAME", "unknown name `${path[0]}`", t.span)
                        }
                    }
                    Some(s) => this.set_ref(t.id, t.span, label, s)
                }
            }
            TUnion(ms) => {
                for m in ms.iter() {
                    this.resolve_type(scope, m)
                }
            }
            TIntersection(ms) => {
                for m in ms.iter() {
                    this.resolve_type(scope, m)
                }
            }
            TLiteral(_) => {}
            TError => {}
        }
    }

    // ---- statements ----

    fun resolve_stmts(&mut this, scope: int, stmts: &Vec[Stmt]) {
        for s in stmts.iter() {
            match s {
                ExprStmt(e) => this.resolve_expr(scope, e.expr)
                Let(l) => {
                    this.resolve_expr(scope, l.value)            // `let x = x + 1` sees the outer `x`
                    if let Some(t) = &l.ty {
                        this.resolve_type(scope, t)
                    }
                    if let Some(b) = &l.else_branch {
                        this.resolve_block(scope, b)
                    }
                    this.bind_pattern(scope, l.pattern, l.mutable)
                }
            }
        }
    }

    fun resolve_block(&mut this, parent: int, b: &Block) {
        let scope = this.new_scope("block", Some(parent))
        this.resolve_stmts(scope, b.stmts)
    }

    // ---- patterns ----

    /// Resolves the paths in a pattern and declares its bindings in `scope`.
    fun bind_pattern(&mut this, scope: int, p: &Pattern, mutable: bool) {
        var binds = m{} as Map[string, Vec[BindNode]]
        this.pattern_names(scope, p, binds, mutable)
        for name, nodes in binds {
            let first = nodes[0]
            let sym = this.bind(scope, name, "local", first.id, first.span, mutable || first.is_mut)
            var i = 1
            for i < nodes.len() {
                this.decls[nodes[i].id] = sym
                i += 1
            }
        }
    }

    /// Collects the bindings of `p` into `out` (name → binding nodes) and resolves its paths.
    /// Or-patterns must bind the same names in every alternative.
    fun pattern_names(&mut this, scope: int, p: &Pattern, out: &mut Map[string, Vec[BindNode]], mutable: bool) {
        match &p.kind {
            PBind { name, is_mut } => {
                if out.has(name) {
                    this.error("E_DUPLICATE_BINDING", "`${name}` is bound twice in the same pattern", p.span)
                    return
                }
                out[name.clone()] = [r{ id: p.id, span: p.span, is_mut }]
            }
            PPath(path) => this.resolve_pattern_path(scope, p.id, p.span, path.join("."), path)
            PCall { path, args, .. } => {
                this.resolve_pattern_path(scope, p.id, p.span, path.join("."), path)
                for a in args.iter() {
                    this.pattern_names(scope, a, out, mutable)
                }
            }
            PStruct { path, fields, .. } => {
                if let Some(ps) = path {
                    this.resolve_pattern_path(scope, p.id, p.span, ps.join("."), ps)
                }
                for f in fields.iter() {
                    match &f.pattern {
                        None => {
                            // shorthand `Card { number }` binds `number`
                            if out.has(f.name) {
                                this.error("E_DUPLICATE_BINDING", "`${f.name}` is bound twice in the same pattern", f.span)
                            } else {
                                out[f.name.clone()] = [r{ id: f.id, span: f.span, is_mut: false }]
                            }
                        }
                        Some(fp) => this.pattern_names(scope, fp, out, mutable)
                    }
                }
            }
            PTuple { elems, .. } => {
                for e in elems.iter() {
                    this.pattern_names(scope, e, out, mutable)
                }
            }
            POr(alts) => {
                var maps = [] as Vec[Map[string, Vec[BindNode]]]
                for alt in alts.iter() {
                    var m = m{} as Map[string, Vec[BindNode]]
                    this.pattern_names(scope, alt, m, mutable)
                    maps.push(m)
                }
                var first_names = maps[0].keys()
                first_names.sort()
                let names = first_names.join(",")
                var i = 1
                for i < maps.len() {
                    var these = maps[i].keys()
                    these.sort()
                    if these.join(",") != names {
                        this.error("E_INCONSISTENT_OR_BINDINGS", "every alternative of an or-pattern must bind the same names", alts[i].span)
                    }
                    i += 1
                }
                for m, k in maps {
                    for name, nodes in m {
                        match out.get(name) {
                            None => out[name.clone()] = nodes.clone()
                            Some(prev) => {
                                if k != 0 || !maps[0].has(name) {
                                    var merged = prev
                                    merged.extend(nodes.clone())
                                    out[name.clone()] = merged
                                } else {
                                    this.error("E_DUPLICATE_BINDING", "`${name}` is bound twice in the same pattern", nodes[0].span)
                                }
                            }
                        }
                    }
                }
            }
            PWild => {}
            PLit(_) => {}
            PRange { .. } => {}
            PError => {}
        }
    }

    fun resolve_pattern_path(&mut this, scope: int, id: int, span: Span, label: string, path: &Vec[string]) {
        let head = path[0].clone()
        if head == "Self" {
            match this.type_ctx {
                Some(ctx) => if let Some(s) = ctx.self_sym { this.set_ref(id, span, label, s) }
                None => this.error("E_SELF_OUTSIDE_TYPE", "`Self` is only available inside a type, union, interface or impl", span)
            }
            return
        }
        let sym = this.lookup(scope, head)
        if this.ambiguous(sym, span) {
            return
        }
        let Some(s) = sym else {
            // `Cash`, `Close`: variants of the scrutinee's type (spec §6)
            if path.len() == 1 || is_upper(head) || this.is_open(scope) {
                this.defer(id, span, label)
            } else {
                this.error("E_UNDECLARED_NAME", "unknown name `${head}`", span)
            }
            return
        }
        this.set_ref(id, span, label, s)
        // `Shape.Line` in a pattern: a union of this package must have that variant
        let target = this.symbols[s].clone()
        if path.len() == 2 && target.kind == "union" && target.decl.is_some() {
            let variant = path[1].clone()
            if !target.variants.any(#{ v => v.name == variant }) {
                this.error("E_UNKNOWN_VARIANT", "`${target.name}` has no variant `${variant}`", span)
            }
        }
    }

    // ---- expressions ----

    fun resolve_name(&mut this, scope: int, id: int, span: Span, name: &str, assigning: bool) {
        if is_implicit_param(name) {
            return this.resolve_implicit(scope, id, span, name)
        }
        if name == "Self" {
            match this.type_ctx {
                None => this.error("E_SELF_OUTSIDE_TYPE", "`Self` is only available inside a type, union, interface or impl", span)
                Some(ctx) => if let Some(s) = ctx.self_sym { this.set_ref(id, span, name, s) }
            }
            return
        }
        if name == "_" {
            return
        }
        let sym = this.lookup(scope, name)
        if this.ambiguous(sym, span) {
            return
        }
        if let Some(s) = sym {
            return this.use_sym(id, span, name, s, scope)
        }
        if is_upper(name) || this.is_open(scope) {
            this.defer(id, span, name)
            if this.is_open(scope) {
                let _ = this.open.insert(id)
            }
            return
        }
        if assigning {
            this.error("E_UNDECLARED_ASSIGNMENT", "`${name}` is not declared: declare it with `let`, `var`, `:=` or `:==`", span)
        } else {
            this.error("E_UNDECLARED_NAME", "unknown name `${name}`", span)
        }
    }

    /// `it` / `itN`: the payload of the innermost header-less closure or unnamed `or`.
    fun resolve_implicit(&mut this, scope: int, id: int, span: Span, name: &str) {
        var s: int? = Some(scope)
        for let Some(i) = s {
            let kind = this.scopes[i].kind.clone()
            let provider = this.scopes[i].provider
            if kind == "closure" && !provider {
                return                  // named closure: the parser reported E_IT_IN_NAMED_CLOSURE
            }
            if (kind == "closure" || kind == "or") && provider {
                let key = if name == "it" { "it1" } else { name.to_str() }
                var sym = this.scopes[i].names.get(key)
                if sym.is_none() {
                    let created = this.define(i, key, "implicit", None, None, false)
                    if name == "it" || name == "it1" {
                        this.scopes[i].names[if name == "it" { "it1" } else { "it" }] = created
                    }
                    sym = Some(created)
                }
                return this.use_sym(id, span, name, sym.unwrap(), scope)
            }
            if kind == "function" || kind == "file" {
                break
            }
            s = this.scopes[i].parent
        }
        this.error("E_IT_OUTSIDE_CLOSURE", "`${name}` is only available in a closure without parameters (`#{ … }`) or after `or`", span)
    }

    fun check_sigil(&mut this, scope: int, letter: &str, span: Span) {
        let Some(s) = this.lookup(scope, letter) else { return }
        let kind = this.symbols[s].kind.clone()
        if value_kind(kind) {
            let what = describe_kind(kind)
            this.error("E_SIGIL_SHADOWS_BINDING", "`${letter}` is a ${what} here, so `${letter}${sigil_opener(letter)}…` is ambiguous; rename the ${what}", span)
        }
    }

    fun resolve_fields(&mut this, scope: int, fields: &Vec[RecordItem]) {
        var seen = s{} as Set[string]
        for f in fields.iter() {
            match f {
                RSpread { expr: x, .. } => this.resolve_expr(scope, x)
                RField(rf) => {
                    if !rf.key.is_empty() && seen.has(rf.key) {
                        this.error("E_DUPLICATE_FIELD", "field `${rf.key}` is given twice", rf.span)
                    }
                    let _ = seen.insert(rf.key.clone())
                    match &rf.value {
                        Some(v) => this.resolve_expr(scope, v)
                        None => this.resolve_name(scope, rf.id, rf.span, rf.key, false)   // shorthand `r{ name }` reads `name`
                    }
                }
            }
        }
    }

    fun resolve_elems(&mut this, scope: int, elems: &Vec[Elem]) {
        for e in elems.iter() {
            match e {
                EValue(x) => this.resolve_expr(scope, x)
                ESpread { expr: x, .. } => this.resolve_expr(scope, x)
            }
        }
    }

    pub fun resolve_expr(&mut this, scope: int, e: &Expr) {
        match &e.kind {
            Ident(name) => this.resolve_name(scope, e.id, e.span, name, false)
            This => {
                match this.lookup(scope, "this") {
                    None => {
                        let loc = if this.fun_ctx.is_none() { "here" } else { "in a function without a receiver" }
                        this.error("E_THIS_OUTSIDE_METHOD", "`this` is not available ${loc}: only methods declared with `this`, `&this`, `&mut this` or `mut this` have it", e.span)
                    }
                    Some(s) => this.use_sym(e.id, e.span, "this", s, scope)
                }
            }
            Int(_) => {}
            Float(_) => {}
            Char(_) => {}
            Bool(_) => {}
            Nil => {}
            Error => {}
            Str { raw, .. } => {
                if raw {
                    this.check_sigil(scope, "r", e.span)
                }
            }
            Template(parts) => {
                for p in parts.iter() {
                    if let Interp(x) = p {
                        this.resolve_expr(scope, x)
                    }
                }
            }
            Paren(x) => this.resolve_expr(scope, x.get())
            VecLit(es) => this.resolve_elems(scope, es)
            ArrayLit(es) => {
                this.check_sigil(scope, "a", e.span)
                this.resolve_elems(scope, es)
            }
            TupleLit(es) => {
                this.check_sigil(scope, "t", e.span)
                this.resolve_elems(scope, es)
            }
            SetLit(es) => {
                this.check_sigil(scope, "s", e.span)
                this.resolve_elems(scope, es)
            }
            RecordLit(fs) => {
                this.check_sigil(scope, "r", e.span)
                this.resolve_fields(scope, fs)
            }
            Inferred(fs) => this.resolve_fields(scope, fs)
            MapLit(entries) => {
                this.check_sigil(scope, "m", e.span)
                for m in entries.iter() {
                    match m {
                        MSpread { expr: x, .. } => this.resolve_expr(scope, x)
                        MEntry(me) => {
                            this.resolve_expr(scope, me.key)
                            this.resolve_expr(scope, me.value)
                        }
                    }
                }
            }
            StructLit { ty, fields } => {
                this.resolve_expr(scope, ty.get())
                // the head of the type path is the type itself: it must be a type
                if let Ident(_) = &ty.get().kind {
                    if let Some(s) = this.ref_sym(ty.get().id) {
                        let kind = this.symbols[s].kind.clone()
                        if !type_kind(kind) {
                            let name = this.symbols[s].name.clone()
                            this.error("E_NOT_A_TYPE", "`${name}` is a ${describe_kind(kind)}, not a type", ty.get().span)
                        }
                    }
                }
                this.resolve_fields(scope, fields)
            }
            Closure { .. } => this.resolve_closure(scope, e)
            Unary { expr: x, .. } => this.resolve_expr(scope, x.get())
            Await(x) => this.resolve_expr(scope, x.get())
            Try(x) => this.resolve_expr(scope, x.get())
            Binary { left, right, .. } => {
                this.resolve_expr(scope, left.get())
                this.resolve_expr(scope, right.get())
            }
            Assign { target, value, .. } => {
                let tg = target.get()
                match &tg.kind {
                    Ident(name) => this.resolve_name(scope, tg.id, tg.span, name, true)
                    _ => this.resolve_expr(scope, tg)
                }
                this.resolve_expr(scope, value.get())
            }
            RangeExpr { start, end, .. } => {
                if let Some(s) = start {
                    this.resolve_expr(scope, s.get())
                }
                if let Some(x) = end {
                    this.resolve_expr(scope, x.get())
                }
            }
            As { expr: x, ty } => {
                this.resolve_expr(scope, x.get())
                this.resolve_type(scope, ty)
            }
            Or { expr: x, name, name_span, rhs } => {
                this.resolve_expr(scope, x.get())
                let or_scope = this.new_scope("or", Some(scope))
                this.scopes[or_scope].closure = Some(e.id)        // owner node: links the implicit `it` back to this `or`
                match name {
                    None => this.scopes[or_scope].provider = true
                    Some(n) => { let _ = this.bind(or_scope, n, "local", e.id, name_span ?? e.span, false) }
                }
                this.resolve_expr(or_scope, rhs.get())
            }
            // member names (`x.name`, `Shape.Line`, `json.parse`) need types: the type checker resolves them
            Member { object, .. } => this.resolve_expr(scope, object.get())
            OptMember { object, .. } => this.resolve_expr(scope, object.get())
            Call { callee, args } => {
                this.resolve_expr(scope, callee.get())
                this.resolve_elems(scope, args)
            }
            IndexExpr { object, index } => {
                this.resolve_expr(scope, object.get())
                this.resolve_expr(scope, index.get())
            }
            GenericApply { target, args } => {
                this.resolve_expr(scope, target.get())
                for t in args.iter() {
                    this.resolve_type(scope, t)
                }
            }
            If { cond, then, else_branch } => {
                let then_scope = this.new_scope("arm", Some(scope))
                match cond {
                    CLet(lc) => {
                        this.resolve_expr(scope, lc.value.get())
                        this.bind_pattern(then_scope, lc.pattern, false)
                    }
                    CExpr(x) => this.resolve_expr(scope, x.get())
                }
                this.resolve_block(then_scope, then)
                if let Some(b) = else_branch {
                    match &b.get().kind {
                        BlockExpr(blk) => this.resolve_block(scope, blk)
                        _ => this.resolve_expr(scope, b.get())
                    }
                }
            }
            Match { subject, arms } => {
                if let Some(s) = subject {
                    this.resolve_expr(scope, s.get())
                }
                for arm in arms.iter() {
                    let arm_scope = this.new_scope("arm", Some(scope))
                    if let Some(p) = &arm.pattern {
                        this.bind_pattern(arm_scope, p, false)
                    }
                    if let Some(t) = &arm.test {
                        this.resolve_expr(scope, t)
                    }
                    if let Some(g) = &arm.guard {
                        this.resolve_expr(arm_scope, g)
                    }
                    this.resolve_expr(arm_scope, arm.body)
                }
            }
            Select { arms, else_branch } => {
                for arm in arms.iter() {
                    this.resolve_expr(scope, arm.expr)
                    let arm_scope = this.new_scope("arm", Some(scope))
                    if let Some(p) = &arm.pattern {
                        this.bind_pattern(arm_scope, p, false)
                    }
                    this.resolve_expr(arm_scope, arm.body)
                }
                if let Some(b) = else_branch {
                    this.resolve_expr(scope, b.get())
                }
            }
            For { pattern, pattern2, expr: x, body, .. } => {
                let body_scope = this.new_scope("arm", Some(scope))
                if let Some(v) = x {
                    this.resolve_expr(scope, v.get())
                }
                if let Some(p) = pattern {
                    this.bind_pattern(body_scope, p, false)
                }
                if let Some(p) = pattern2 {
                    this.bind_pattern(body_scope, p, false)
                }
                this.resolve_block(body_scope, body)
            }
            BlockExpr(b) => this.resolve_block(scope, b)
            Unsafe(b) => this.resolve_block(scope, b)
            Recover(b) => this.resolve_block(scope, b)
            Return(v) => if let Some(x) = v { this.resolve_expr(scope, x.get()) }
            Break { value, .. } => if let Some(x) = value { this.resolve_expr(scope, x.get()) }
            Continue(_) => {}
        }
    }

    fun resolve_closure(&mut this, parent: int, e: &Expr) {
        let Closure { captures, params, ret, body } = &e.kind else { return }
        let scope = this.new_scope("closure", Some(parent))
        this.scopes[scope].closure = Some(e.id)
        this.scopes[scope].provider = params.is_none()
        this.captures[e.id] = Captures { span: e.span }
        if let Some(caps) = captures {
            for cap in caps.iter() {
                match this.lookup(parent, cap.name) {
                    None => this.error("E_UNDECLARED_NAME", "unknown name `${cap.name}` in the capture list", cap.span)
                    Some(s) => {
                        let kind = this.symbols[s].kind.clone()
                        if !local_kind(kind) {
                            this.error("E_INVALID_CAPTURE", "`${cap.name}` is a ${describe_kind(kind)}; only local variables are captured", cap.span)
                        } else {
                            let label = "capture ${cap.name}"
                            this.set_ref(cap.id, cap.span, label, s)
                            if !this.captures[e.id].syms.contains(s) {
                                this.captures[e.id].syms.push(s)
                            }
                            // a capture crossing outer closures is captured by them too
                            this.use_sym(cap.id, cap.span, label, s, parent)
                        }
                    }
                }
            }
        }
        if let Some(ps) = params {
            for p in ps.iter() {
                if let Some(t) = &p.ty {
                    this.resolve_type(parent, t)
                }
                let _ = this.bind(scope, p.name, "closure-param", p.id, p.span, p.is_mut)
            }
        }
        if let Some(t) = ret {
            this.resolve_type(parent, t)
        }
        this.resolve_stmts(scope, body.stmts)
    }
}
