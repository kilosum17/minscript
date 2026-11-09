// Ownership and borrow checking (spec §9.1–§9.4, §9.6), ported from minscript/src/ownership.ts.
//
// Runs after the type checker, per function, walking statements in evaluation order with a state
// of moved bindings. Branches are analysed on copies of the state and merged ("may have been moved");
// loop bodies run twice so a move in one iteration is caught on the next.
//
// Checks:
// - mutability: assigning to, or `&mut`-borrowing, a binding that isn't `var` / `mut` / `&mut`;
// - moves: use after move; moving out of a borrow (needs `.clone()`). Copy values, `string` and
//   handles (`Ref`, `Topic`, `Queue`, `Signal`, `Weak`: cloned implicitly) never move;
// - scoped values (values holding a borrow, §9.3): an owner may not change while a value borrowed
//   from it is still used later; a function may only return borrows of its borrowed parameters;
//   field declarations can't hold borrows; closures holding borrows can't escape (§9.4);
// - async calls with borrowed arguments must be awaited in the same expression (§9.6).
//
// Stage 0 keeps one function context in a field and swaps it for closures; here the contexts are a
// stack (`ctxs`, the current one last). Nodes are known by id and span.
package ownership

import "app.lexer.{Span, Diagnostic}"
import "app.ast.*"
import "app.resolve.{Sym, Resolution, Ref}"
import "app.check.{CheckResult, CallInfo, Ty, VarState, prune_ty, strip_ty, pruned, stripped, show_ty, tag, named_sym, unknown}"

type Moved = r{ at: Span, maybe: bool }

type State = { dead: bool, moved: Map[int, Moved] = m{} }

/// A read ("use": read or borrow) or a change ("mut": mutate, move or `&mut`) of a binding.
type Event = r{ sym: int, kind: string, pos: int, span: Span }

/// A binding holding a borrow, and what it borrows from ("shared" / "mut").
type Scoped = { sym: int, owners: Map[int, string], def_end: int, def_pos: int }

/// A closure, as far as captures go.
type ClosureRef = { id: int, captures: Vec[Capture]? }

type LoopCtx = { span: Span, breaks: Vec[State] = [] }

type FnCtx = {
    /// how each binding is held when it isn't owned: borrowed parameters, `this`, loop items, captures
    borrowed: Map[int, string] = m{}
    ret_node: Type?
    events: Vec[Event] = []
    scoped: Vec[Scoped] = []
    loops: Vec[LoopCtx] = []
    /// loop bodies, for liveness
    fors: Vec[Span] = []
    /// locals holding a closure that holds borrows
    closure_locals: Map[int, ClosureRef] = m{}
}

/// The binding at the root of a place (`a`, `a.b[0]`, `this.items`), and whether the place is the whole binding.
type Root = r{ sym: int, whole: bool }

type Ownership = {
    syms: Vec[Sym]
    refs: Map[int, Ref]
    decls: Map[int, int]
    captures: Map[int, Vec[int]]
    types: Map[int, Ty]
    sym_types: Map[int, Ty]
    calls: Map[int, CallInfo]
    vars: Vec[VarState]
    diagnostics: Vec[Diagnostic] = []
    reported: Set[string] = Set.new()
    /// the uses (Ident, This, record shorthand) of each binding
    uses_of: Map[int, Vec[Span]] = m{}
    /// the uses of `this`, in resolution order
    this_refs: Vec[Ref] = []
    copy_types: Set[int] = Set.new()
    ctxs: Vec[FnCtx] = []
    /// bindings some scoped value borrows from (a `let` of a borrow, a borrowing closure)
    lent_owners: Set[int] = Set.new()
}

/// `moves`: the `x.clone()` calls (by id) whose source is never observed again, which lowering turns
/// into moves (spec §14.1, moves.ms).
pub type OwnershipResult = { pub diagnostics: Vec[Diagnostic], pub moves: Set[int] }

/// `&x.f` (or `(…)` around it) → the place `x.f`; anything else as it is.
fun place_of_borrow(e: &Expr) -> &Expr {
    match &e.kind {
        Paren(x) => place_of_borrow(x.get())
        Unary { op, expr } => if op == "&" || op == "&mut" { unparen(expr.get()) } else { e }
        _ => e
    }
}

fun unparen(e: &Expr) -> &Expr {
    match &e.kind {
        Paren(x) => unparen(x.get())
        _ => e
    }
}

fun local_kind(k: &str) -> bool {
    match k {
        "local" | "param" | "closure-param" | "implicit" | "this" => true
        _ => false
    }
}

fun handle_name(n: &str) -> bool {
    match n {
        "Ref" | "Weak" | "Topic" | "Queue" | "Signal" => true
        _ => false
    }
}

fun is_copy_iface(t: &Type) -> bool {
    match &t.kind {
        TName { path, .. } => path.join(".") == "Copy"
        _ => false
    }
}

/// `res` and `checked` lend their arenas (symbols, inference variables) and side tables for the pass,
/// and get them back.
pub fun check_ownership(files: &Vec[File], res: &mut Resolution, checked: &mut CheckResult) -> OwnershipResult {
    var caps = m{} as Map[int, Vec[int]]
    for id, c in res.captures {
        caps[id] = c.syms.clone()
    }
    var o = Ownership {
        syms: res.symbols.drain(), refs: res.refs.drain(), decls: res.decls.drain(), captures: caps,
        types: checked.types.drain(), sym_types: checked.symbols.drain(), calls: checked.calls.drain(), vars: checked.vars.drain(),
    }
    for _, rf in o.refs {
        if o.syms[rf.sym].kind == "this" {
            o.this_refs.push(rf)
        }
        // stage 0 lists the Ident, This and RecordField uses: not captures (`#[x]`) or `TypeOf(x)`
        if rf.label.starts_with("capture ") || rf.label.starts_with("TypeOf(") {
            continue
        }
        var list = o.uses_of.get(rf.sym) ?? []
        list.push(rf.span)
        o.uses_of[rf.sym] = list
    }
    for f in files.iter() {
        o.collect_copy(f)
    }
    for f in files.iter() {
        for itm in f.items.iter() {
            o.check_item(itm)
        }
    }
    let moves = o.find_all_moves(files)
    res.symbols = o.syms.drain()
    res.refs = o.refs.drain()
    res.decls = o.decls.drain()
    checked.types = o.types.drain()
    checked.symbols = o.sym_types.drain()
    checked.calls = o.calls.drain()
    checked.vars = o.vars.drain()
    OwnershipResult { diagnostics: o.diagnostics, moves }
}

impl Ownership {
    fun error(&mut this, code: &str, message: string, span: Span) {
        let key = "${code}@${span.start}"
        if this.reported.has(key) {
            return
        }
        let _ = this.reported.insert(key)
        this.diagnostics.push(Diagnostic { code: code.to_str(), message, span })
    }

    fun ref_sym(&this, id: int) -> int? {
        match this.refs.get(id) {
            Some(r) => Some(r.sym)
            None => None
        }
    }

    /// The local binding (local, parameter, `this`, …) a node refers to.
    fun local_ref(&this, id: int) -> int? {
        let Some(s) = this.ref_sym(id) else { return None }
        if local_kind(this.syms[s].kind) { Some(s) } else { None }
    }

    fun sym_name(&this, sym: int) -> string {
        if this.syms[sym].kind == "this" { "this" } else { this.syms[sym].name.clone() }
    }

    fun prune(&this, t: &Ty) -> Ty { prune_ty(t, this.vars) }

    fun show(&this, t: &Ty) -> string { show_ty(t, this.vars, this.syms) }

    fun type_of(&this, id: int) -> Ty? { this.types.get(id) }

    fun sym_type(&this, sym: int) -> Ty? { this.sym_types.get(sym) }

    // ---- the current function context ----

    fun top(&this) -> int { this.ctxs.len() - 1 }

    fun borrowed_of(&this, sym: int) -> string? {
        let k = this.top()
        this.ctxs[k].borrowed.get(sym)
    }

    fun set_borrowed(&mut this, sym: int, mode: &str) {
        let k = this.top()
        this.ctxs[k].borrowed[sym] = mode.to_str()
    }

    fun event(&mut this, sym: int, kind: &str, span: Span) {
        let k = this.top()
        this.ctxs[k].events.push(r{ sym, kind: kind.to_str(), pos: span.start, span })
    }

    // ---- type properties ----

    /// Types declared `Copy` (`type X: Copy = …` or `impl Copy for X`).
    fun collect_copy(&mut this, file: &File) {
        for itm in file.items.iter() {
            match itm {
                TypeDef(d) => {
                    if d.impls.any(#{ t, _ => is_copy_iface(t) }) {
                        if let Some(s) = this.decls.get(d.id) {
                            let _ = this.copy_types.insert(s)
                        }
                    }
                }
                Union(d) => {
                    if d.impls.any(#{ t, _ => is_copy_iface(t) }) {
                        if let Some(s) = this.decls.get(d.id) {
                            let _ = this.copy_types.insert(s)
                        }
                    }
                }
                Impl(d) => {
                    if d.interfaces.any(#{ t, _ => is_copy_iface(t) }) {
                        if let TName { .. } = &d.target.kind {
                            if let Some(s) = this.ref_sym(d.target.id) {
                                let _ = this.copy_types.insert(s)
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// Copy (spec §9.1): primitives, `string` (immutable, shared), shared borrows, and tuples / records / Options of Copy.
    fun is_copy(&this, t0: &Ty?) -> bool {
        let Some(raw) = t0 else { return true }
        let t = this.prune(raw)
        match t {
            TyRef { is_mut, .. } => !is_mut
            TyTuple(elems) => elems.all(#{ e, _ => this.is_copy(Some(e.clone())) })
            TyRecord(fields) => fields.all(#{ f, _ => this.is_copy(Some(f.ty.clone())) })
            TyFn { .. } => false
            TyNamed { sym, args } => {
                if this.copy_types.has(sym) {
                    return true
                }
                let s = &this.syms[sym]
                if s.std && (s.name == "Option" || s.name == "Result" || s.name == "Range") {
                    return args.all(#{ a, _ => this.is_copy(Some(a.clone())) })
                }
                s.std && (s.name == "Ordering" || s.name == "PanicKind")
            }
            other => tag(other) != "param"
        }
    }

    /// Handles are cloned implicitly instead of moved (spec §9.1).
    fun is_handle(&this, t0: &Ty?) -> bool {
        let Some(raw) = t0 else { return false }
        let s = strip_ty(raw, this.vars)
        let sym = named_sym(s)
        sym >= 0 && this.syms[sym].std && handle_name(this.syms[sym].name)
    }

    /// Does a value of this type hold a borrow (a scoped value, §9.3)?
    fun holds_borrow(&this, t0: &Ty?, depth: int) -> bool {
        let Some(raw) = t0 else { return false }
        if depth > 8 {
            return false
        }
        let t = this.prune(raw)
        match t {
            TyRef { .. } => true
            TyNamed { sym, args } => (this.syms[sym].std && this.syms[sym].name == "Slice") || args.any(#{ a, _ => this.holds_borrow(Some(a.clone()), depth + 1) })
            TyTuple(elems) => elems.any(#{ e, _ => this.holds_borrow(Some(e.clone()), depth + 1) })
            TyRecord(fields) => fields.any(#{ f, _ => this.holds_borrow(Some(f.ty.clone()), depth + 1) })
            _ => false
        }
    }

    // ---- items ----

    fun check_item(&mut this, itm: &Item) {
        match itm {
            Fun(f) => this.check_fun(f)
            TypeDef(d) => {
                match &d.body {
                    Struct(b) => {
                        for f in b.fields.iter() {
                            this.check_field_type(f.ty, f.span)
                        }
                        for m in b.methods.iter() {
                            this.check_fun(m)
                        }
                    }
                    Alias(t) => {
                        if let TRecord(fields) = &t.kind {
                            for f in fields.iter() {
                                this.check_field_type(f.ty, f.span)
                            }
                        }
                    }
                }
            }
            Union(d) => {
                for v in d.variants.iter() {
                    for f in (v.fields ?? []).iter() {
                        this.check_field_type(f.ty, f.span)
                    }
                    for t in (v.tuple ?? []).iter() {
                        this.check_field_type(t, t.span)
                    }
                }
                for m in d.methods.iter() {
                    this.check_fun(m)
                }
            }
            Inter(d) => {
                for m in (d.methods ?? []).iter() {
                    this.check_fun(m)
                }
            }
            Impl(d) => {
                for m in d.methods.iter() {
                    this.check_fun(m)
                }
            }
            Let(_) | Extern(_) => {}
        }
    }

    /// Field types may not contain borrows (E_BORROW_IN_FIELD, §9.3).
    fun check_field_type(&mut this, t: &Type, at: Span) {
        if let Some(b) = find_borrow_type(t) {
            this.error("E_BORROW_IN_FIELD", "a field can't hold a borrow (`${b}`): store an owned value instead (`string` for `&str`, `Vec[T]` for `Slice[T]`)", at)
        }
    }

    fun check_fun(&mut this, f: &FunDecl) {
        let Some(body) = &f.body else { return }
        this.ctxs.push(FnCtx { ret_node: f.ret.clone() })
        for p in f.params.iter() {
            let Some(sym) = this.decls.get(p.id) else { continue }
            let t = this.prune(this.sym_type(sym) ?? unknown())
            if let TyRef { is_mut, .. } = &t {
                this.set_borrowed(sym, if is_mut { "mut" } else { "shared" })
            }
        }
        if let Some(this_sym) = this.find_this(body) {
            let recv = f.receiver ?? ""
            if recv == "&this" || recv == "&mut this" {
                this.set_borrowed(this_sym, if recv == "&mut this" { "mut" } else { "shared" })
            }
        }
        var st = State { dead: false }
        this.body(body, st, f.ret)
        this.check_scoped()
        let _ = this.ctxs.pop()
    }

    /// The resolver's `this` symbol used inside a body, if any.
    fun find_this(&this, body: &Block) -> int? {
        for rf in this.this_refs.iter() {
            if rf.span.start >= body.span.start && rf.span.end <= body.span.end {
                return Some(rf.sym)
            }
        }
        None
    }

    /// A function or closure body: its last expression is returned.
    fun body(&mut this, b: &Block, st: &mut State, ret: &Type?) {
        var i = 0
        for s in b.stmts.iter() {
            let last = i == b.stmts.len() - 1
            i += 1
            if last {
                if let ExprStmt(es) = s {
                    if !es.semi {
                        this.returned(es.expr, st, ret)
                        continue
                    }
                }
            }
            this.stmt(s, st)
        }
    }

    // ---- state ----

    /// Joins branch states into `into`: a binding moved on any live branch may have been moved.
    fun merge(&this, into: &mut State, branches: Vec[State]) {
        let live = branches.filter(#{ b, _ => !b.dead })
        if live.is_empty() {
            into.dead = true
            return
        }
        var moved = m{} as Map[int, Moved]
        for b in live.iter() {
            for sym, mv in b.moved {
                let all = live.all(#{ o, _ => o.moved.has(sym) })
                let next = match moved.get(sym) {
                    Some(prev) => r{ at: prev.at, maybe: !all || mv.maybe || prev.maybe }
                    None => r{ at: mv.at, maybe: !all || mv.maybe }
                }
                moved[sym] = next
            }
        }
        into.dead = false
        into.moved = moved
    }

    // ---- places ----

    fun root(&this, e: &Expr) -> Root? { this.root_in(e, true) }

    fun root_in(&this, e: &Expr, whole: bool) -> Root? {
        match &e.kind {
            Paren(x) => this.root_in(x.get(), whole)
            Member { object, .. } => this.root_in(object.get(), false)
            IndexExpr { object, .. } => this.root_in(object.get(), false)
            Unary { op, expr } => if op == "*" { this.root_in(expr.get(), false) } else { None }
            Ident(_) | This => {
                let Some(sym) = this.local_ref(e.id) else { return None }
                Some(r{ sym, whole })
            }
            _ => None
        }
    }

    fun is_place(&this, e: &Expr) -> bool {
        match &e.kind {
            Paren(x) => this.is_place(x.get())
            Ident(_) | This | Member { .. } | IndexExpr { .. } => this.root(e).is_some()
            _ => false
        }
    }

    /// Is the binding held as a borrow here (borrowed param, `&this`, loop item, implicit capture)?
    fun held_by(&this, sym: int) -> string {
        if let Some(b) = this.borrowed_of(sym) {
            return b
        }
        let t = this.prune(this.sym_type(sym) ?? unknown())
        match t {
            TyRef { is_mut, .. } => if is_mut { "mut" } else { "shared" }
            _ => "owned"
        }
    }

    /// A use of a binding: it must not have been moved.
    fun touch(&mut this, sym: int, span: Span, st: &State, kind: &str) {
        if let Some(mv) = st.moved.get(sym) {
            if !st.dead {
                let loc = "${mv.at.line}:${mv.at.col}"
                let name = if this.syms[sym].name == "it1" { "it" } else { this.syms[sym].name.clone() }
                let msg = if mv.maybe {
                    "`${name}` may have been moved (at ${loc}) on some path to here: clone it before the move, or restructure"
                } else {
                    "`${name}` was moved at ${loc} and can't be used after that: clone it before the move (`.clone()`), or borrow it"
                }
                this.error("E_USE_AFTER_MOVE", msg, span)
            }
        }
        this.event(sym, kind, span)
    }

    /// Reads every binding used inside a place expression (and the index expressions).
    fun read_place(&mut this, e: &Expr, st: &mut State, kind: &str) {
        match &e.kind {
            Paren(x) => this.read_place(x.get(), st, kind)
            Member { object, .. } => this.read_place(object.get(), st, kind)
            IndexExpr { object, index } => {
                this.read_place(object.get(), st, kind)
                this.expr(index.get(), st, false)
            }
            Unary { expr, .. } => this.read_place(expr.get(), st, kind)
            Ident(_) | This => {
                if let Some(sym) = this.local_ref(e.id) {
                    this.touch(sym, e.span, st, kind)
                }
            }
            _ => this.expr(e, st, false)
        }
    }

    /// Can this place be written (assignment or `&mut`)?
    fun check_writable(&mut this, target: &Expr, code: &str) {
        let Some(r) = this.root(target) else { return }
        if let Unary { op, .. } = &target.kind {
            if op == "*" {
                return               // raw pointer writes (unsafe)
            }
        }
        this.check_writable_sym(r.sym, r.whole, target.span, code)
    }

    fun check_writable_sym(&mut this, sym: int, whole: bool, span: Span, code: &str) {
        let held = this.held_by(sym)
        let is_this = this.syms[sym].kind == "this"
        let name = this.sym_name(sym)
        let what = if code == "E_ASSIGN_IMMUTABLE" { "assign to" } else { "borrow mutably" }
        let place = if whole { "`${name}`" } else { "a part of `${name}`" }
        if held == "mut" {
            return
        }
        if held == "shared" {
            let capture = !is_this && this.is_implicit_capture(sym)
            let hint = if is_this {
                "declare the method with `&mut this`"
            } else if capture {
                "the closure borrows `${name}` read-only: capture it with `#[&mut ${name}]`"
            } else {
                "`${name}` is a shared borrow: take `&mut` instead"
            }
            this.error(code, "can't ${what} ${place}: ${hint}", span)
            return
        }
        if this.syms[sym].mutable {
            return
        }
        let hint = if is_this {
            "the method takes `this` by value: declare it with `mut this`"
        } else if this.syms[sym].kind == "param" {
            "declare the parameter as `mut ${name}`"
        } else {
            "declare it with `var` (or `:==`)"
        }
        this.error(code, "can't ${what} ${place}, which isn't mutable: ${hint}", span)
    }

    fun is_implicit_capture(&this, sym: int) -> bool {
        let k = this.syms[sym].kind.clone()
        (this.borrowed_of(sym) ?? "") == "shared" && k != "param" && k != "this"
    }

    // ---- moves ----

    /// `e` is consumed by an owner (a binding, an owned parameter, a field, the result): a non-Copy
    /// place is moved, and a place held through a borrow can't be moved out of.
    fun consume(&mut this, e: &Expr, st: &mut State, owned_target: bool, typed_owned: bool) {
        if let Paren(x) = &e.kind {
            return this.consume(x.get(), st, owned_target, typed_owned)
        }
        // (escaping closures are checked where they escape: returns, fields, owned `(T) -> U` parameters)
        let Some(rt) = this.root(e) else { return this.expr(e, st, false) }
        if !this.is_place(e) {
            return this.expr(e, st, false)
        }
        let ty = this.type_of(e.id)
        this.read_place(e, st, "use")
        // a `&T` given where an owned `T` is required (an owned parameter, the result, a field):
        // the referenced value would have to move out of the borrow
        let pt = this.prune(ty ?? unknown())
        if typed_owned {
            if let TyRef { inner, .. } = &pt {
                let inner_ty = Some(inner.get().clone())
                if !this.is_copy(inner_ty) && !this.is_handle(inner_ty) {
                    let name = this.sym_name(rt.sym)
                    this.error("E_MOVE_OUT_OF_BORROW", "`${name}` is a borrow (`${this.show(pt)}`), but an owned `${this.show(inner.get())}` is needed here: use `.clone()`", e.span)
                    return
                }
            }
        }
        if this.is_copy(ty) || this.is_handle(ty) {
            return
        }
        let held = this.held_by(rt.sym)
        if held != "owned" {
            if !owned_target {
                return
            }
            let name = this.sym_name(rt.sym)
            let place = if rt.whole { "`${name}`" } else { "out of `${name}`" }
            let how = if this.syms[rt.sym].kind == "this" { " (`&this`)" } else { "" }
            this.error("E_MOVE_OUT_OF_BORROW", "can't move ${place} here: it is borrowed${how}, so the value isn't ours to give away; use `.clone()`", e.span)
            return
        }
        if !owned_target || !rt.whole {
            return                  // partial moves are not tracked yet
        }
        st.moved[rt.sym] = r{ at: e.span, maybe: false }
        this.event(rt.sym, "mut", e.span)
    }

    /// A value returned from the function (or closure): moved out, or checked as a returned borrow.
    fun returned(&mut this, e: &Expr, st: &mut State, ret: &Type?) {
        if let Some(rt) = ret {
            if find_borrow_type(rt).is_some() {
                // walked first: a `match` / `if let` marks the bindings that borrow from its subject
                this.expr(e, st, false)
                this.check_returned_borrow(e)
                return
            }
            if let TFn { .. } = &rt.kind {
                this.check_escape_of(e)
            }
        }
        this.consume(e, st, ret.is_some(), ret.is_some())
    }

    // ---- statements ----

    fun stmt(&mut this, s: &Stmt, st: &mut State) {
        let Let(l) = s else {
            if let ExprStmt(es) = s {
                this.expr(es.expr, st, false)
            }
            return
        }
        let annotated_borrow = match &l.ty {
            Some(t) => find_borrow_type(t).is_some()
            None => false
        }
        this.consume(l.value, st, !annotated_borrow, l.ty.is_some() && !annotated_borrow)
        if let Some(eb) = &l.else_branch {
            var branch = st.clone()
            this.block(eb, branch)
            // the else block diverges, so its state doesn't flow on
        }
        this.fresh_bindings(l.pattern, st)
        // a binding that holds a borrow is a scoped value: remember what it borrows from
        let PBind { .. } = &l.pattern.kind else { return }
        let Some(sym) = this.decls.get(l.pattern.id) else { return }
        let ty = this.sym_type(sym)
        if let Some(c) = this.closure_of(l.value) {
            if this.closure_holds_borrow(c) {
                let k = this.top()
                this.ctxs[k].closure_locals[sym] = c
            }
        }
        let is_fn = match this.prune(ty ?? unknown()) {
            TyFn { .. } => true
            _ => false
        }
        if this.holds_borrow(ty, 0) || is_fn {
            var owners = this.owners_of(l.value)
            let _ = owners.remove(sym)
            if !owners.is_empty() {
                for o, _ in owners {
                    let _ = this.lent_owners.insert(o)
                }
                let k = this.top()
                this.ctxs[k].scoped.push(Scoped { sym, owners, def_end: l.span.end, def_pos: l.span.start })
            }
        }
    }

    fun closure_of(&this, e: &Expr) -> ClosureRef? {
        match &e.kind {
            Paren(x) => this.closure_of(x.get())
            Closure { captures, .. } => Some(ClosureRef { id: e.id, captures: captures.clone() })
            Ident(_) => {
                let Some(sym) = this.ref_sym(e.id) else { return None }
                let k = this.top()
                this.ctxs[k].closure_locals.get(sym)
            }
            _ => None
        }
    }

    /// New bindings start out valid (a `let` in a loop body is fresh on every iteration).
    fun fresh_bindings(&this, p: &Pattern, st: &mut State) {
        if let Some(sym) = this.decls.get(p.id) {
            let _ = st.moved.remove(sym)
        }
        match &p.kind {
            PCall { args, .. } => {
                for a in args.iter() {
                    this.fresh_bindings(a, st)
                }
            }
            PStruct { fields, .. } => {
                for f in fields.iter() {
                    if let Some(sym) = this.decls.get(f.id) {
                        let _ = st.moved.remove(sym)
                    }
                    if let Some(fp) = &f.pattern {
                        this.fresh_bindings(fp, st)
                    }
                }
            }
            PTuple { elems, .. } => {
                for x in elems.iter() {
                    this.fresh_bindings(x, st)
                }
            }
            POr(alts) => {
                for x in alts.iter() {
                    this.fresh_bindings(x, st)
                }
            }
            _ => {}
        }
    }

    /// Bindings of a pattern matched against a borrowed place are borrowed too.
    fun borrow_pattern(&mut this, p: &Pattern, mode: &str) {
        if let Some(sym) = this.decls.get(p.id) {
            this.set_borrowed(sym, mode)
        }
        match &p.kind {
            PCall { args, .. } => {
                for a in args.iter() {
                    this.borrow_pattern(a, mode)
                }
            }
            PStruct { fields, .. } => {
                for f in fields.iter() {
                    if let Some(sym) = this.decls.get(f.id) {
                        this.set_borrowed(sym, mode)
                    }
                    if let Some(fp) = &f.pattern {
                        this.borrow_pattern(fp, mode)
                    }
                }
            }
            PTuple { elems, .. } => {
                for x in elems.iter() {
                    this.borrow_pattern(x, mode)
                }
            }
            POr(alts) => {
                for x in alts.iter() {
                    this.borrow_pattern(x, mode)
                }
            }
            _ => {}
        }
    }

    fun block(&mut this, b: &Block, st: &mut State) {
        for s in b.stmts.iter() {
            this.stmt(s, st)
        }
    }

    // ---- expressions ----

    fun expr(&mut this, e: &Expr, st: &mut State, awaited: bool) {
        match &e.kind {
            Ident(_) | This => {
                if let Some(sym) = this.local_ref(e.id) {
                    this.touch(sym, e.span, st, "use")
                }
            }
            Int(_) | Float(_) | Str { .. } | Char(_) | Bool(_) | Nil | Error => {}
            Template(parts) => {
                for p in parts.iter() {
                    if let Interp(x) = p {
                        this.expr(x, st, false)
                    }
                }
            }
            Paren(x) => this.expr(x.get(), st, awaited)
            VecLit(elems) | ArrayLit(elems) | TupleLit(elems) | SetLit(elems) => {
                for el in elems.iter() {
                    match el {
                        EValue(x) => this.element(x, st, false)
                        ESpread { expr, .. } => this.element(expr, st, false)
                    }
                }
            }
            MapLit(entries) => {
                for en in entries.iter() {
                    match en {
                        MSpread { expr, .. } => this.expr(expr, st, false)
                        MEntry(me) => {
                            this.element(me.key, st, false)
                            this.element(me.value, st, false)
                        }
                    }
                }
            }
            RecordLit(fields) | Inferred(fields) => this.fields(fields, st, false)
            StructLit { ty, fields } => {
                this.expr(ty.get(), st, false)
                this.fields(fields, st, true)
            }
            Closure { captures, ret, body, .. } => this.closure(e, captures, ret, body, st)
            Unary { op, expr } => {
                if op == "&mut" {
                    this.check_writable(expr.get(), "E_MUT_BORROW_IMMUTABLE")
                    return this.read_place(expr.get(), st, "mut")
                }
                if op == "&" {
                    return this.read_place(expr.get(), st, "use")
                }
                this.expr(expr.get(), st, false)
            }
            Await(x) => this.await_expr(x.get(), st)
            Binary { op, left, right } => {
                this.expr(left.get(), st, false)
                if op == "&&" || op == "||" || op == "??" {
                    var rs = st.clone()
                    if op == "??" {
                        this.consume(right.get(), rs, true, false)
                    } else {
                        this.expr(right.get(), rs, false)
                    }
                    this.merge(st, [st.clone(), rs])
                    return
                }
                this.expr(right.get(), st, false)
            }
            Assign { op, target, value } => this.assign(op, target.get(), value.get(), st)
            RangeExpr { start, end, .. } => {
                if let Some(s) = start {
                    this.expr(s.get(), st, false)
                }
                if let Some(x) = end {
                    this.expr(x.get(), st, false)
                }
            }
            As { expr, .. } => this.expr(expr.get(), st, false)
            Or { expr, rhs, .. } => {
                this.consume(expr.get(), st, true, false)
                var branch = st.clone()
                this.consume(rhs.get(), branch, true, false)       // the right side is returned (or breaks): it diverges
            }
            Member { object, .. } | OptMember { object, .. } => this.expr(object.get(), st, false)
            IndexExpr { object, index } => {
                this.expr(object.get(), st, false)
                this.expr(index.get(), st, false)
            }
            GenericApply { target, .. } => this.expr(target.get(), st, false)
            Try(x) => this.consume(x.get(), st, true, false)
            Call { callee, args } => this.call(e, callee.get(), args, st, awaited)
            If { cond, then, else_branch } => this.if_expr(cond, then, else_branch, st)
            Match { subject, arms } => this.match_expr(subject, arms, st)
            Select { arms, else_branch } => this.select_expr(arms, else_branch, st)
            For { form, is_await, pattern, pattern2, expr, body, .. } => this.for_expr(form, is_await, pattern, pattern2, expr, body, st)
            BlockExpr(b) | Unsafe(b) => this.block(b, st)
            Recover(b) => {
                let before = st.clone()
                this.block(b, st)
                this.merge(st, [before, st.clone()])        // the block may panic part-way
            }
            Return(value) => {
                if let Some(v) = value {
                    let k = this.top()
                    let ret = this.ctxs[k].ret_node.clone()
                    this.returned(v.get(), st, ret)
                }
                st.dead = true
            }
            Break { value, .. } => {
                if let Some(v) = value {
                    this.consume(v.get(), st, true, false)
                }
                let k = this.top()
                let n = this.ctxs[k].loops.len()
                if n > 0 {
                    this.ctxs[k].loops[n - 1].breaks.push(st.clone())
                }
                st.dead = true
            }
            Continue(_) => st.dead = true
        }
    }

    fun fields(&mut this, fields: &Vec[RecordItem], st: &mut State, typed_owned: bool) {
        for f in fields.iter() {
            match f {
                RSpread { expr, .. } => this.expr(expr, st, false)
                RField(rf) => {
                    match &rf.value {
                        Some(v) => this.element(v, st, typed_owned)
                        None => this.shorthand_field(rf, st)
                    }
                }
            }
        }
    }

    /// An element of a literal (Vec, struct field, …): owned by the literal.
    fun element(&mut this, e: &Expr, st: &mut State, typed_owned: bool) {
        this.check_escape_of(e)
        this.consume(e, st, true, typed_owned)
    }

    fun shorthand_field(&mut this, f: &RecordField, st: &mut State) {
        let Some(sym) = this.local_ref(f.id) else { return }
        this.touch(sym, f.span, st, "use")
        let ty = this.sym_type(sym)
        let k = this.top()
        if let Some(c) = this.ctxs[k].closure_locals.get(sym) {
            this.check_escape(f.span, c)
        }
        if this.is_copy(ty) || this.is_handle(ty) {
            return
        }
        if this.held_by(sym) != "owned" {
            this.error("E_MOVE_OUT_OF_BORROW", "can't move `${this.syms[sym].name}` into this literal: it is borrowed; use `${f.key}: ${f.key}.clone()`", f.span)
            return
        }
        st.moved[sym] = r{ at: f.span, maybe: false }
        this.event(sym, "mut", f.span)
    }

    fun await_expr(&mut this, e: &Expr, st: &mut State) {
        let call = match &e.kind {
            Call { .. } => true
            Paren(x) => match &x.get().kind {
                Call { .. } => true
                _ => false
            }
            _ => false
        }
        if call {
            return this.expr(e, st, true)
        }
        this.consume(e, st, true, false)        // awaiting a stored Promise consumes it
    }

    fun assign(&mut this, op: &str, target: &Expr, value: &Expr, st: &mut State) {
        this.check_writable(target, "E_ASSIGN_IMMUTABLE")
        if op == "=" {
            this.consume(value, st, true, false)
            this.check_escape_of(value)
            if let Some(r) = this.root(target) {
                if r.whole {
                    let _ = st.moved.remove(r.sym)           // re-initialized
                    this.event(r.sym, "mut", target.span)
                    return
                }
            }
            this.read_place(target, st, "mut")
            return
        }
        this.expr(value, st, false)
        this.read_place(target, st, "mut")
    }

    fun call(&mut this, e: &Expr, callee0: &Expr, args: &Vec[Elem], st: &mut State, awaited: bool) {
        let info = this.calls.get(e.id)
        let callee = match &callee0.kind {
            GenericApply { target, .. } => target.get().clone()
            _ => callee0.clone()
        }
        let receiver = match &info {
            Some(i) => i.receiver.clone()
            None => None
        }
        let recv_expr = match &callee.kind {
            Member { object, .. } | OptMember { object, .. } => if receiver.is_some() { Some(object.get().clone()) } else { None }
            _ => None
        }
        // the receiver
        if let Some(recv) = &recv_expr {
            let how = receiver ?? ""
            if how == "this" || how == "mut this" {
                this.consume(recv, st, true, false)
            } else if how == "&mut this" {
                if this.is_place(recv) && !this.is_handle(this.type_of(recv.id)) {
                    this.check_writable(recv, "E_MUT_BORROW_IMMUTABLE")
                    this.read_place(recv, st, "mut")
                } else {
                    this.expr(recv, st, false)
                }
            } else {
                this.expr(recv, st, false)
            }
        } else {
            this.expr(callee0, st, false)
        }
        // the arguments
        var i = 0
        for a in args.iter() {
            let arg = elem_expr(a)
            let p = match &info {
                Some(ci) => ci.args.get(i)
                None => None
            }
            i += 1
            let Some(pty) = p else {
                this.expr(arg, st, false)
                continue
            }
            let pt = this.prune(pty)
            if let TyRef { is_mut, .. } = &pt {
                if is_mut && this.is_place(arg) {
                    this.check_writable(arg, "E_MUT_BORROW_IMMUTABLE")
                    this.read_place(arg, st, "mut")
                } else {
                    this.expr(arg, st, false)
                }
                continue
            }
            let k = tag(pt)
            if k == "fn" {
                this.check_escape_of(arg)
            }
            if k == "unknown" || k == "var" {
                this.expr(arg, st, false)
                continue
            }
            this.consume(arg, st, true, k != "param")
        }
        if let Some(ci) = &info {
            if ci.is_async && !awaited {
                this.check_spawn(e, args, ci, recv_expr)
            }
        }
        if tag(pruned(this.type_of(e.id) ?? unknown(), this.vars)) == "never" {
            st.dead = true
        }
    }

    fun borrowed_place(&this, x: &Expr) -> bool {
        let t = this.type_of(x.id)
        this.is_place(x) && !this.is_handle(t) && !this.is_copy(t)
    }

    /// An async call that isn't awaited right away runs as a task: it can't hold borrows (§9.6).
    fun check_spawn(&mut this, e: &Expr, args: &Vec[Elem], info: &CallInfo, recv: &Expr?) {
        if let Some(r) = recv {
            let how = info.receiver ?? ""
            if (how == "&this" || how == "&mut this") && this.borrowed_place(r) {
                this.error("E_BORROW_ACROSS_SPAWN", "this async call borrows its receiver, so it must be awaited in the same expression (`await x.f()`); or call it on an owned value / a handle", e.span)
                return
            }
        }
        var i = 0
        for a in args.iter() {
            let p = this.prune(info.args.get(i) ?? unknown())
            i += 1
            let arg = elem_expr(a)
            if tag(p) == "ref" && this.borrowed_place(arg) {
                this.error("E_BORROW_ACROSS_SPAWN", "this async call borrows an argument, so it must be awaited in the same expression (`await f(x)`); or pass an owned value or a handle (`Ref`)", arg.span)
            }
        }
    }

    fun if_expr(&mut this, cond: &Cond, then: &Block, else_branch: &Box[Expr]?, st: &mut State) {
        match cond {
            CLet(lc) => {
                this.expr(lc.value.get(), st, false)
                this.matched_by(lc.value.get(), lc.pattern)
            }
            CExpr(c) => this.expr(c.get(), st, false)
        }
        var then_st = st.clone()
        if let CLet(lc) = cond {
            this.fresh_bindings(lc.pattern, then_st)
        }
        this.block(then, then_st)
        var else_st = st.clone()
        if let Some(eb) = else_branch {
            match &eb.get().kind {
                BlockExpr(b) => this.block(b, else_st)
                _ => this.expr(eb.get(), else_st, false)
            }
        }
        this.merge(st, [then_st, else_st])
    }

    /// Bindings of a pattern matched against a borrowed place borrow from it.
    /// Bindings of a pattern matched against a borrowed place borrow from it (`match &x.f`: the `&`
    /// borrows the place `x.f`).
    fun matched_by(&mut this, subject0: &Expr, p: &Pattern) {
        let subject = place_of_borrow(subject0)
        let Some(r) = this.root(subject) else { return }
        if !this.is_place(subject) {
            return
        }
        let held = this.held_by(r.sym)
        if held != "owned" {
            this.borrow_pattern(p, held)
        }
    }

    fun match_expr(&mut this, subject: &Box[Expr]?, arms: &Vec[MatchArm], st: &mut State) {
        if let Some(s) = subject {
            this.expr(s.get(), st, false)
        }
        var branches = [] as Vec[State]
        for arm in arms.iter() {
            var b = st.clone()
            if let Some(p) = &arm.pattern {
                if let Some(s) = subject {
                    this.matched_by(s.get(), p)
                }
                this.fresh_bindings(p, b)
            }
            if let Some(t) = &arm.test {
                this.expr(t, b, false)
            }
            if let Some(g) = &arm.guard {
                this.expr(g, b, false)
            }
            this.consume_or_expr(arm.body, b)
            branches.push(b)
        }
        if !branches.is_empty() {
            this.merge(st, branches)
        }
    }

    fun consume_or_expr(&mut this, e: &Expr, st: &mut State) {
        if this.is_place(e) {
            this.consume(e, st, true, false)
        } else {
            this.expr(e, st, false)
        }
    }

    fun select_expr(&mut this, arms: &Vec[SelectArm], else_branch: &Box[Expr]?, st: &mut State) {
        for arm in arms.iter() {
            this.expr(arm.expr, st, true)          // every arm waits: awaited
        }
        var branches = [] as Vec[State]
        for arm in arms.iter() {
            var b = st.clone()
            if let Some(p) = &arm.pattern {
                this.fresh_bindings(p, b)
            }
            this.consume_or_expr(arm.body, b)
            branches.push(b)
        }
        if let Some(eb) = else_branch {
            var b = st.clone()
            this.expr(eb.get(), b, false)
            branches.push(b)
        }
        if !branches.is_empty() {
            this.merge(st, branches)
        }
    }

    fun for_expr(&mut this, form: &str, is_await: bool, pattern: &Pattern?, pattern2: &Pattern?, expr: &Box[Expr]?, body: &Block, st: &mut State) {
        if let Some(x) = expr {
            if form == "in" && is_await {
                this.read_place(x.get(), st, "mut")
            } else {
                this.expr(x.get(), st, false)
            }
        }
        // `for x in items` borrows each item (iter(), spec §10.2); `for await` and ranges yield owned values
        if form == "in" && !is_await {
            if let Some(p) = pattern {
                if let Some(x) = expr {
                    let t = strip_ty(this.type_of(x.get().id) ?? unknown(), this.vars)
                    let sym = named_sym(t)
                    if sym >= 0 && this.syms[sym].std {
                        let n = this.syms[sym].name.clone()
                        if n == "Vec" || n == "Array" || n == "Slice" || n == "Set" || n == "Map" {
                            this.borrow_pattern(p, "shared")
                        }
                    }
                }
            }
        }
        if form == "let" {
            if let Some(p) = pattern {
                if let Some(x) = expr {
                    this.matched_by(x.get(), p)
                }
            }
        }
        let k = this.top()
        this.ctxs[k].fors.push(body.span)
        this.ctxs[k].loops.push(LoopCtx { span: body.span })
        // run the body twice: a move in one iteration is a use-after-move in the next
        var first = st.clone()
        this.declare_patterns(pattern, pattern2, first)
        this.block(body, first)
        var again = st.clone()
        this.merge(again, [st.clone(), first.clone()])
        this.declare_patterns(pattern, pattern2, again)
        this.block(body, again)
        let k2 = this.top()
        let breaks = match this.ctxs[k2].loops.pop() {
            Some(l) => l.breaks
            None => []
        }
        if form == "infinite" {
            this.merge(st, if breaks.is_empty() { [State { dead: true }] } else { breaks })
        } else {
            var all = [st.clone(), first, again]
            all.extend(breaks)
            this.merge(st, all)
        }
    }

    fun declare_patterns(&this, pattern: &Pattern?, pattern2: &Pattern?, st: &mut State) {
        if let Some(p) = pattern {
            this.fresh_bindings(p, st)
        }
        if let Some(p) = pattern2 {
            this.fresh_bindings(p, st)
        }
    }

    // ---- closures (§9.4) ----

    fun closure_holds_borrow(&this, c: &ClosureRef) -> bool { !this.borrowed_captures(c).is_empty() }

    /// Captures held as borrows: the implicit ones (except handles) and `#[&mut x]`.
    fun borrowed_captures(&this, c: &ClosureRef) -> Vec[t(int, string)] {
        var explicit = m{} as Map[int, string]
        for cap in (c.captures ?? []).iter() {
            if let Some(s) = this.ref_sym(cap.id) {
                explicit[s] = cap.mode.clone()
            }
        }
        var out = [] as Vec[t(int, string)]
        for sym in (this.captures.get(c.id) ?? []).iter() {
            let mode = explicit.get(sym) ?? ""
            if mode == "move" {
                continue
            }
            if mode == "mut" {
                out.push(t(sym, "mut"))
                continue
            }
            if this.is_handle(this.sym_type(sym)) {
                continue            // handles are cloned into the closure
            }
            out.push(t(sym, "shared"))
        }
        out
    }

    fun check_escape_of(&mut this, e: &Expr) {
        if let Some(c) = this.closure_of(e) {
            this.check_escape(e.span, c)
        }
    }

    /// A closure holding borrows can't be returned, stored, or passed as an owned function (§9.4).
    fun check_escape(&mut this, span: Span, c: &ClosureRef) {
        let borrowed = this.borrowed_captures(c)
        if borrowed.is_empty() {
            return
        }
        var names = [] as Vec[string]
        var fix = [] as Vec[string]
        for b in borrowed.iter() {
            let t(sym, mode) = b
            names.push("`${this.sym_name(sym)}`")
            if mode == "shared" {
                fix.push(this.syms[sym].name.clone())
            }
        }
        let hint = if fix.is_empty() { "" } else { ": capture by value with `#[${fix.join(", ")}]`" }
        this.error("E_CLOSURE_ESCAPES_BORROW", "this closure borrows ${names.join(", ")}, so it can't outlive this scope (returned, stored, or passed as an owned `(T) -> U`)${hint}", span)
    }

    fun closure(&mut this, e: &Expr, captures: &Vec[Capture]?, ret: &Type?, body: &Block, st: &mut State) {
        // creating the closure: by-value captures move in, `&mut` captures need a mutable binding
        var explicit = Set.new() as Set[int]
        for cap in (captures ?? []).iter() {
            let Some(sym) = this.ref_sym(cap.id) else { continue }
            let _ = explicit.insert(sym)
            if cap.mode == "move" {
                this.touch(sym, cap.span, st, "use")
                let ty = this.sym_type(sym)
                if !this.is_copy(ty) && !this.is_handle(ty) {
                    if this.held_by(sym) != "owned" {
                        this.error("E_MOVE_OUT_OF_BORROW", "can't move `${this.syms[sym].name}` into the closure: it is borrowed; capture a clone", cap.span)
                    } else {
                        st.moved[sym] = r{ at: cap.span, maybe: false }
                        this.event(sym, "mut", cap.span)
                    }
                }
            } else if cap.mode == "mut" {
                this.touch(sym, cap.span, st, "mut")
                this.check_writable_sym(sym, true, cap.span, "E_MUT_BORROW_IMMUTABLE")
            } else {
                this.touch(sym, cap.span, st, "use")
            }
        }
        for sym in (this.captures.get(e.id) ?? []).iter() {
            if explicit.has(sym) {
                continue
            }
            if st.moved.has(sym) {
                this.touch(sym, e.span, st, "use")
            } else {
                this.event(sym, "use", e.span)
            }
        }
        // the body runs later: its own analysis, with the captures held as borrows (or owned)
        let cref = ClosureRef { id: e.id, captures: captures.clone() }
        let k = this.top()
        var inner = FnCtx { ret_node: ret.clone(), borrowed: this.ctxs[k].borrowed.clone(), closure_locals: this.ctxs[k].closure_locals.clone() }
        for b in this.borrowed_captures(cref).iter() {
            let t(sym, mode) = b
            inner.borrowed[sym] = mode.clone()
        }
        for cap in (captures ?? []).iter() {
            if let Some(sym) = this.ref_sym(cap.id) {
                if cap.mode == "move" {
                    let _ = inner.borrowed.remove(sym)
                }
            }
        }
        this.ctxs.push(inner)
        var body_st = State { dead: false }
        this.body(body, body_st, ret)
        this.check_scoped()
        let _ = this.ctxs.pop()
    }

    // ---- scoped values (§9.3) ----

    /// The bindings a value may borrow from, by its shape: places it reads (`x`, `x.f`, `x[i]` → x),
    /// receivers of `&this` methods, arguments passed by reference, and the captures of closures.
    /// Arithmetic, templates and owned arguments produce owned values, so they borrow nothing.
    fun owners_of(&this, e: &Expr) -> Map[int, string] {
        var out = m{} as Map[int, string]
        this.owners_visit(e, out)
        out
    }

    fun add_owner(&this, sym: int, mode: &str, out: &mut Map[int, string]) {
        if (out.get(sym) ?? "") != "mut" {
            out[sym] = mode.to_str()
        }
        let k = this.top()
        for s in this.ctxs[k].scoped.iter() {
            if s.sym != sym {
                continue
            }
            for o, m in s.owners {
                if (out.get(o) ?? "") != "mut" {
                    out[o] = m.clone()
                }
            }
        }
    }

    fun owners_block(&this, b: &Block, out: &mut Map[int, string]) {
        for s in b.stmts.iter() {
            match s {
                ExprStmt(es) => this.owners_visit(es.expr, out)
                Let(l) => this.owners_visit(l.value, out)
            }
        }
    }

    fun owners_visit(&this, n: &Expr, out: &mut Map[int, string]) {
        match &n.kind {
            Ident(_) | This => {
                let Some(sym) = this.local_ref(n.id) else { return }
                if this.is_handle(this.sym_type(sym)) {
                    return
                }
                this.add_owner(sym, "shared", out)
            }
            Member { object, .. } | OptMember { object, .. } => this.owners_visit(object.get(), out)
            IndexExpr { object, .. } => this.owners_visit(object.get(), out)
            Paren(x) | Try(x) => this.owners_visit(x.get(), out)
            As { expr, .. } => this.owners_visit(expr.get(), out)
            Binary { op, left, right } => {
                if op == "??" {
                    this.owners_visit(left.get(), out)
                    this.owners_visit(right.get(), out)
                }
            }
            Or { expr, .. } => this.owners_visit(expr.get(), out)
            VecLit(elems) | ArrayLit(elems) | TupleLit(elems) | SetLit(elems) => {
                for el in elems.iter() {
                    this.owners_visit(elem_expr(el), out)
                }
            }
            If { cond, then, else_branch } => {
                if let CExpr(c) = cond {
                    this.owners_visit(c.get(), out)
                }
                this.owners_block(then, out)
                if let Some(eb) = else_branch {
                    match &eb.get().kind {
                        BlockExpr(b) => this.owners_block(b, out)
                        _ => this.owners_visit(eb.get(), out)
                    }
                }
            }
            Match { arms, .. } => {
                for a in arms.iter() {
                    this.owners_visit(a.body, out)
                }
            }
            BlockExpr(b) | Unsafe(b) | Recover(b) => this.owners_block(b, out)
            Closure { captures, .. } => {
                for b in this.borrowed_captures(ClosureRef { id: n.id, captures: captures.clone() }).iter() {
                    let t(sym, mode) = b
                    this.add_owner(sym, mode, out)
                }
            }
            Unary { op, expr } => {
                if op == "&mut" {
                    if let Some(r) = this.root(expr.get()) {
                        this.add_owner(r.sym, "mut", out)
                    }
                    return
                }
                this.owners_visit(expr.get(), out)
            }
            Call { callee: callee0, args } => {
                let info = this.calls.get(n.id)
                let callee = match &callee0.get().kind {
                    GenericApply { target, .. } => target.get().clone()
                    _ => callee0.get().clone()
                }
                let receiver = match &info {
                    Some(i) => i.receiver ?? ""
                    None => ""
                }
                match &callee.kind {
                    Member { object, .. } | OptMember { object, .. } => {
                        if receiver == "&mut this" {
                            if let Some(r) = this.root(object.get()) {
                                this.add_owner(r.sym, "mut", out)
                            }
                        } else if receiver == "this" || receiver == "mut this" {
                            // the receiver is consumed: the result borrows nothing from it
                        } else {
                            this.owners_visit(object.get(), out)
                            // a borrow returned by a handle's method (`r.get()`: `&T`) borrows from that handle
                            if let Some(r) = this.root(object.get()) {
                                if this.is_handle(this.sym_type(r.sym)) && tag(pruned(this.type_of(n.id) ?? unknown(), this.vars)) == "ref" {
                                    this.add_owner(r.sym, "shared", out)
                                }
                            }
                        }
                    }
                    _ => {}
                }
                var i = 0
                for a in args.iter() {
                    let p = match &info {
                        Some(ci) => this.prune(ci.args.get(i) ?? unknown())
                        None => unknown()
                    }
                    i += 1
                    let k = tag(p)
                    if k == "ref" || k == "unknown" {
                        this.owners_visit(elem_expr(a), out)       // owned arguments are moved, not borrowed
                    }
                }
            }
            _ => {}
        }
    }

    /// A function returning a borrow may only return borrows of its borrowed parameters / receiver.
    fun check_returned_borrow(&mut this, e: &Expr) {
        let owners = this.owners_of(e)
        for sym, _ in owners {
            if this.held_by(sym) != "owned" {
                continue
            }
            if this.holds_borrow(this.sym_type(sym), 0) {
                continue            // a scoped local: its own owners are listed too
            }
            let name = this.sym_name(sym)
            let what = if this.syms[sym].kind == "param" {
                "the parameter `${name}`, which is owned (it is dropped when the function returns)"
            } else {
                "`${name}`, which is local to the function"
            }
            this.error("E_RETURN_LOCAL_BORROW", "this returns a borrow of ${what}: return an owned value (`.to_str()`, `.to_vec()`, `.clone()`) or take the parameter as `&T`", e.span)
            return
        }
    }

    /// An owner can't change while a value borrowed from it is still used later (and nothing may
    /// touch an owner that is borrowed mutably).
    fun check_scoped(&mut this) {
        let k = this.top()
        let scoped = this.ctxs[k].scoped.clone()
        let events = this.ctxs[k].events.clone()
        let fors = this.ctxs[k].fors.clone()
        for s in scoped.iter() {
            let uses = (this.uses_of.get(s.sym) ?? []).filter(#{ u, _ => u.start > s.def_end })
            if uses.is_empty() {
                continue
            }
            var end = 0
            var last_use = uses[0]
            for u in uses.iter() {
                if u.end > end {
                    end = u.end
                }
                if u.start > last_use.start {
                    last_use = u
                }
            }
            // used inside a loop declared outside it: live until the end of the loop
            for f in fors.iter() {
                if s.def_pos >= f.start && s.def_pos <= f.end {
                    continue
                }
                if uses.any(#{ u, _ => u.start >= f.start && u.end <= f.end }) && f.end > end {
                    end = f.end
                }
            }
            for ev in events.iter() {
                if ev.pos <= s.def_end || ev.pos >= end {
                    continue
                }
                let Some(mode) = s.owners.get(ev.sym) else { continue }
                if mode == "shared" && ev.kind != "mut" {
                    continue
                }
                let name = this.sym_name(ev.sym)
                let verb = if mode == "mut" { "used" } else { "changed" }
                let how = if mode == "mut" { "it mutably" } else { "from it" }
                this.error("E_BORROW_CONFLICT", "`${name}` is ${verb} here while `${this.syms[s.sym].name}` (which borrows ${how}) is still used at ${last_use.line}:${last_use.col}", ev.span)
            }
        }
    }
}

fun elem_expr(el: &Elem) -> Expr {
    match el {
        EValue(x) => x.clone()
        ESpread { expr, .. } => expr.clone()
    }
}

/// The first borrow inside a type annotation (`&T`, `Slice[T]`), as text.
fun find_borrow_type(t: &Type) -> string? {
    match &t.kind {
        TRef { is_mut, inner } => Some("&${if is_mut { "mut " } else { "" }}${type_text(inner.get())}")
        TName { path, args } => {
            if path.len() == 1 && path[0] == "Slice" {
                return Some(type_text(t))
            }
            for a in args.iter() {
                if let Some(b) = find_borrow_type(a) {
                    return Some(b)
                }
            }
            None
        }
        TOption(inner) => find_borrow_type(inner.get())
        TTuple(elems) => {
            for x in elems.iter() {
                if let Some(b) = find_borrow_type(x) {
                    return Some(b)
                }
            }
            None
        }
        TRecord(fields) => {
            for f in fields.iter() {
                if let Some(b) = find_borrow_type(f.ty) {
                    return Some(b)
                }
            }
            None
        }
        _ => None
    }
}

fun type_text(t: &Type) -> string {
    match &t.kind {
        TName { path, args } => "${path.join(".")}${if args.is_empty() { "" } else { "[${args.map(#{ a, _ => type_text(a) }).join(", ")}]" }}"
        TRef { is_mut, inner } => "&${if is_mut { "mut " } else { "" }}${type_text(inner.get())}"
        TOption(inner) => "${type_text(inner.get())}?"
        _ => "…"
    }
}

/// The ownership dump: one line per diagnostic (as stage 0's `ms ownership`).
pub fun dump_ownership(diagnostics: &Vec[Diagnostic]) -> string {
    var out = ""
    for d in diagnostics.iter() {
        var p = "${d.span.line}:${d.span.col}"
        for p.len() < 8 {
            p += " "
        }
        out += "${p}${d.code} ${d.message}\n"
    }
    out
}
