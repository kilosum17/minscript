// Clones at last use (spec §14.1), ported from minscript/src/ownership.ts (`findMoves`): the
// `x.clone()` calls whose source is never observed again, which lowering turns into moves.
//
// `x` is a local declared by a plain `let` from a fresh value (it can't share an object with anything
// still alive), never reassigned, never an owner of a scoped value, and nothing reads it after the
// statement of the clone (nor in a later iteration of a loop, or call of a closure, it was declared
// outside of). The clone must be the auto-generated one (a user `clone` may have effects).
//
// Stage 0 visits every node by reflection; this walk visits the same nodes (as `ast.collect_spans`).
package ownership

import "app.lexer.{Span}"
import "app.ast.*"
import "app.check.{tag, unknown}"

type Pending = { call: int, sym: int, root: int, stmts: Vec[int], bounds: Vec[Span] }

type MoveWalk = {
    /// binding → where it is declared
    candidates: Map[int, int] = m{}
    reassigned: Set[int] = Set.new()
    pending: Vec[Pending] = []
    bounds: Vec[Span] = []
    stmts: Vec[int] = []
}

/// The functions an item declares (methods included).
fun funs_of(itm: &Item) -> Vec[FunDecl] {
    match itm {
        Fun(f) => [f.clone()]
        TypeDef(d) => match &d.body {
            Struct(b) => b.methods.clone()
            _ => []
        }
        Union(d) => d.methods.clone()
        Impl(d) => d.methods.clone()
        Inter(d) => d.methods ?? []
        _ => []
    }
}

impl Ownership {
    fun find_all_moves(&this, files: &Vec[File]) -> Set[int] {
        var out = Set.new() as Set[int]
        for f in files.iter() {
            for itm in f.items.iter() {
                for fd in funs_of(itm).iter() {
                    this.find_moves(fd, out)
                }
            }
        }
        out
    }

    fun find_moves(&this, f: &FunDecl, out: &mut Set[int]) {
        let Some(body) = &f.body else { return }
        var w = MoveWalk {}
        this.mv_block(body, w)
        if w.pending.is_empty() {
            return
        }
        var uses = m{} as Map[int, Vec[t(int, Span)]]
        for id, rf in this.refs {
            if !w.candidates.has(rf.sym) {
                continue
            }
            var list = uses.get(rf.sym) ?? []
            list.push(t(id, rf.span))
            uses[rf.sym] = list
        }
        for p in w.pending.iter() {
            let Some(declared) = w.candidates.get(p.sym) else { continue }
            if w.reassigned.has(p.sym) || this.lent_owners.has(p.sym) {
                continue
            }
            if !p.bounds.all(#{ b => b.start <= declared && declared <= b.end }) {
                continue
            }
            // the statement of the clone in the block that declares `x` (the outermost one after the
            // declaration): every other use must be over before it starts
            let Some(stmt) = p.stmts.find(#{ start => start > declared }) else { continue }
            var ok = true
            for u in (uses.get(p.sym) ?? []).iter() {
                let t(id, span) = u
                if id != p.root && span.end > stmt {
                    ok = false
                    break
                }
            }
            if ok {
                let _ = out.insert(p.call)
            }
        }
    }

    /// A `let` of a plain name holding a fresh owned value is a candidate source of moves.
    fun move_candidate(&this, l: &LetStmt, w: &mut MoveWalk) {
        let PBind { .. } = &l.pattern.kind else { return }
        if l.else_branch.is_some() {
            return
        }
        let Some(sym) = this.decls.get(l.pattern.id) else { return }
        if this.syms[sym].kind != "local" {
            return
        }
        let Some(ty) = this.sym_types.get(sym) else { return }
        let some_ty = Some(ty.clone())
        if tag(this.prune(ty)) == "ref" || this.is_copy(some_ty) || this.is_handle(some_ty) || this.holds_borrow(some_ty, 0) {
            return
        }
        if !this.fresh(l.value) {
            return
        }
        w.candidates[sym] = l.span.start
    }

    /// The Ident a place expression is rooted at, when it is a local (`x`, `x.f`, `x[i]`).
    fun root_ident(&this, e: &Expr) -> t(int, int)? {
        match &e.kind {
            Paren(x) => this.root_ident(x.get())
            Member { object, .. } | IndexExpr { object, .. } => this.root_ident(object.get())
            Unary { op, expr } => if op == "*" { this.root_ident(expr.get()) } else { None }
            Ident(_) => {
                let Some(sym) = this.local_ref(e.id) else { return None }
                Some(t(sym, e.id))
            }
            _ => None
        }
    }

    /// `x.clone()` / `x.f.clone()`, the auto-generated clone, on a place rooted at a local.
    fun clone_source(&this, e: &Expr) -> t(int, int)? {
        let Call { callee, args } = &e.kind else { return None }
        let Member { object, name, .. } = &callee.get().kind else { return None }
        if name != "clone" || !args.is_empty() {
            return None
        }
        let Some(info) = this.calls.get(e.id) else { return None }
        let CMethod { auto, .. } = &info.target else { return None }
        if auto != Some("clone") {
            return None
        }
        let Some(found) = this.root_ident(object.get()) else { return None }
        let t(sym, _) = found
        if this.syms[sym].kind != "local" {
            return None
        }
        Some(found)
    }

    /// A value that can't contain (part of) a place that stays alive: no field or element moved out
    /// of something, at any depth.
    fun fresh(&this, e: &Expr) -> bool {
        match &e.kind {
            Paren(x) | Try(x) => this.fresh(x.get())
            As { expr, .. } => this.fresh(expr.get())
            Ident(_) | Int(_) | Float(_) | Str { .. } | Char(_) | Bool(_) | Nil | Template(_) | RangeExpr { .. } | Closure { .. } | Await(_) => true
            Binary { op, left, right } => op != "??" || (this.fresh(left.get()) && this.fresh(right.get()))
            Unary { op, .. } => op == "-" || op == "!"
            Or { expr, rhs, .. } => this.fresh(expr.get()) && this.fresh(rhs.get())
            VecLit(elems) | ArrayLit(elems) | TupleLit(elems) | SetLit(elems) => elems.all(#{ x => this.fresh(elem_expr(x)) })
            MapLit(entries) => entries.all(#{ x => match x {
                MEntry(me) => this.fresh(me.key) && this.fresh(me.value)
                MSpread { expr, .. } => this.fresh(expr)
            } })
            RecordLit(items) | Inferred(items) | StructLit { fields: items, .. } => items.all(#{ x => match x {
                RField(rf) => match &rf.value {
                    Some(v) => this.fresh(v)
                    None => true
                }
                RSpread { expr, .. } => this.fresh(expr)
            } })
            Call { callee: callee0, args } => {
                // arguments passed by value (and a consumed receiver) end up in the result: they must be fresh
                let Some(info) = this.calls.get(e.id) else { return false }
                let callee = match &callee0.get().kind {
                    GenericApply { target, .. } => target.get()
                    _ => callee0.get()
                }
                let receiver = info.receiver ?? ""
                if receiver == "this" || receiver == "mut this" {
                    match &callee.kind {
                        Member { object, .. } | OptMember { object, .. } => {
                            if !this.fresh(object.get()) {
                                return false
                            }
                        }
                        _ => {}
                    }
                }
                var i = 0
                for a in args.iter() {
                    let p = this.prune(info.args.get(i) ?? unknown())
                    i += 1
                    if tag(p) != "ref" && !this.fresh(elem_expr(a)) {
                        return false
                    }
                }
                true
            }
            _ => false
        }
    }

    // ---- the walk (every node, as `ast.collect_spans`) ----

    fun mv_block(&this, b: &Block, w: &mut MoveWalk) {
        for s in b.stmts.iter() {
            match s {
                Let(l) => {
                    w.stmts.push(l.span.start)
                    this.move_candidate(l, w)
                    this.mv_pattern(l.pattern, w)
                    this.mv_expr(l.value, w)
                    if let Some(eb) = &l.else_branch {
                        this.mv_block(eb, w)
                    }
                    let _ = w.stmts.pop()
                }
                ExprStmt(es) => {
                    w.stmts.push(es.span.start)
                    this.mv_expr(es.expr, w)
                    let _ = w.stmts.pop()
                }
            }
        }
    }

    fun mv_opt(&this, e: &Box[Expr]?, w: &mut MoveWalk) {
        if let Some(x) = e {
            this.mv_expr(x.get(), w)
        }
    }

    fun mv_elems(&this, elems: &Vec[Elem], w: &mut MoveWalk) {
        for el in elems.iter() {
            this.mv_expr(elem_expr(el), w)
        }
    }

    fun mv_items(&this, items: &Vec[RecordItem], w: &mut MoveWalk) {
        for f in items.iter() {
            match f {
                RField(rf) => {
                    if let Some(v) = &rf.value {
                        this.mv_expr(v, w)
                    }
                }
                RSpread { expr, .. } => this.mv_expr(expr, w)
            }
        }
    }

    fun mv_expr(&this, e: &Expr, w: &mut MoveWalk) {
        let bound = match &e.kind {
            For { .. } | Closure { .. } => true
            _ => false
        }
        if bound {
            w.bounds.push(e.span)
        }
        match &e.kind {
            Assign { target, .. } => {
                if let Some(r) = this.root(target.get()) {
                    if r.whole {
                        let _ = w.reassigned.insert(r.sym)
                    }
                }
            }
            Call { .. } => {
                if let Some(found) = this.clone_source(e) {
                    let t(sym, root) = found
                    w.pending.push(Pending { call: e.id, sym, root, stmts: w.stmts.clone(), bounds: w.bounds.clone() })
                }
            }
            _ => {}
        }
        match &e.kind {
            Template(parts) => {
                for p in parts.iter() {
                    if let Interp(x) = p {
                        this.mv_expr(x, w)
                    }
                }
            }
            Paren(x) | Await(x) | Try(x) => this.mv_expr(x.get(), w)
            VecLit(elems) | ArrayLit(elems) | TupleLit(elems) | SetLit(elems) => this.mv_elems(elems, w)
            RecordLit(items) | Inferred(items) => this.mv_items(items, w)
            MapLit(entries) => {
                for en in entries.iter() {
                    match en {
                        MEntry(me) => {
                            this.mv_expr(me.key, w)
                            this.mv_expr(me.value, w)
                        }
                        MSpread { expr, .. } => this.mv_expr(expr, w)
                    }
                }
            }
            StructLit { ty, fields } => {
                this.mv_expr(ty.get(), w)
                this.mv_items(fields, w)
            }
            Closure { body, .. } => this.mv_block(body, w)
            Unary { expr, .. } => this.mv_expr(expr.get(), w)
            Binary { left, right, .. } | Assign { target: left, value: right, .. } => {
                this.mv_expr(left.get(), w)
                this.mv_expr(right.get(), w)
            }
            RangeExpr { start, end, .. } => {
                this.mv_opt(start, w)
                this.mv_opt(end, w)
            }
            As { expr, .. } => this.mv_expr(expr.get(), w)
            Or { expr, rhs, .. } => {
                this.mv_expr(expr.get(), w)
                this.mv_expr(rhs.get(), w)
            }
            Member { object, .. } | OptMember { object, .. } => this.mv_expr(object.get(), w)
            Call { callee, args } => {
                this.mv_expr(callee.get(), w)
                this.mv_elems(args, w)
            }
            IndexExpr { object, index } => {
                this.mv_expr(object.get(), w)
                this.mv_expr(index.get(), w)
            }
            GenericApply { target, .. } => this.mv_expr(target.get(), w)
            If { cond, then, else_branch } => {
                match cond {
                    CExpr(x) => this.mv_expr(x.get(), w)
                    CLet(lc) => {
                        this.mv_pattern(lc.pattern, w)
                        this.mv_expr(lc.value.get(), w)
                    }
                }
                this.mv_block(then, w)
                this.mv_opt(else_branch, w)
            }
            Match { subject, arms } => {
                this.mv_opt(subject, w)
                for a in arms.iter() {
                    if let Some(p) = &a.pattern {
                        this.mv_pattern(p, w)
                    }
                    if let Some(x) = &a.test {
                        this.mv_expr(x, w)
                    }
                    if let Some(g) = &a.guard {
                        this.mv_expr(g, w)
                    }
                    this.mv_expr(a.body, w)
                }
            }
            Select { arms, else_branch } => {
                for a in arms.iter() {
                    if let Some(p) = &a.pattern {
                        this.mv_pattern(p, w)
                    }
                    this.mv_expr(a.expr, w)
                    this.mv_expr(a.body, w)
                }
                this.mv_opt(else_branch, w)
            }
            For { pattern, pattern2, expr, body, .. } => {
                if let Some(p) = pattern {
                    this.mv_pattern(p, w)
                }
                if let Some(p) = pattern2 {
                    this.mv_pattern(p, w)
                }
                this.mv_opt(expr, w)
                this.mv_block(body, w)
            }
            BlockExpr(b) | Unsafe(b) | Recover(b) => this.mv_block(b, w)
            Return(v) => this.mv_opt(v, w)
            Break { value, .. } => this.mv_opt(value, w)
            _ => {}
        }
        if bound {
            let _ = w.bounds.pop()
        }
    }

    fun mv_pattern(&this, p: &Pattern, w: &mut MoveWalk) {
        match &p.kind {
            PLit(x) => this.mv_expr(x.get(), w)
            PRange { start, end, .. } => {
                this.mv_opt(start, w)
                this.mv_opt(end, w)
            }
            PCall { args, .. } => {
                for a in args.iter() {
                    this.mv_pattern(a, w)
                }
            }
            PStruct { fields, .. } => {
                for f in fields.iter() {
                    if let Some(fp) = &f.pattern {
                        this.mv_pattern(fp, w)
                    }
                }
            }
            PTuple { elems, .. } => {
                for x in elems.iter() {
                    this.mv_pattern(x, w)
                }
            }
            POr(alts) => {
                for x in alts.iter() {
                    this.mv_pattern(x, w)
                }
            }
            _ => {}
        }
    }
}
