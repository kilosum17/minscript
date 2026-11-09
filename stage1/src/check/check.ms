// The type checker (spec §3, §4, §5, §7, §9.5–§9.10, §10), ported from minscript/src/check.ts.
//
// Bidirectional: every expression is checked against an optional expected type, which drives
// literals, `[]` / `m{}` / `nil`, `_{…}`, closures, and variants inferred from the expected type
// (spec §7.6). Generic calls get fresh inference variables, bound by unification.
//
// The result is a set of side tables keyed by node id (the type of every expression, of every
// binding, what each call and member refers to); the AST is not modified.
//
// Stage 0 keeps AST nodes in its tables (a symbol's declaration, a method's FunDecl); here a
// declaration index (`index`, node id → a copy of the declaration without function bodies) answers
// "what does this symbol declare", and the bodies are checked by walking the files.
//
// This file: the checker's state, assignability, interfaces, type information, `Type` → `Ty`,
// signatures and methods, items and statements. `expr.ms`: expressions. `control.ms`: control flow,
// patterns and exhaustiveness.
package check

import "app.lexer.{Span, Diagnostic}"
import "app.ast.*"
import "app.resolve.{Sym, Scope, Resolution}"

/// The owner of a method: a type or interface, or a primitive (`string`), or "auto".
pub union Owner = {
    OSym(int)
    OName(string)
}

pub type VariantRef = r{ owner: int, variant: string }

/// What a call calls, as resolved by the checker.
pub union CallTarget = {
    /// a top-level or extern function (its FunDecl id)
    CFun(int)
    /// a method on a value (the receiver is the callee's object)
    CMethod { decl: int?, owner: Owner, is_dyn: bool, auto: string? }
    /// `T.f(…)`, or `T(…)` (→ `T.new`)
    CStatic { decl: int, owner: Owner }
    CVariant(VariantRef)
    /// calling a function value (closure, field)
    CValue
    /// no signature
    CUnknown
}

pub union MemberTarget = {
    MField
    MTuple(int)
    /// a method used as a value
    MMethod { decl: int?, owner: Owner, is_dyn: bool }
    MStatic { decl: int, owner: Owner }
    MVariant(VariantRef)
    /// an item of an imported package
    MItem(int)
}

pub type CallInfo = {
    pub target: CallTarget
    /// the parameter type each argument is passed to (variadic: the element type)
    pub args: Vec[Ty]
    /// for a method called on a value: how it takes `this`
    pub receiver: string?
    /// the callee is an `async fun`
    pub is_async: bool
    /// the callee's own generics, as instantiated
    pub type_args: Vec[Ty] = []
    /// every generic parameter of the callee in scope, as instantiated at this call
    pub type_env: Vec[t(int, Ty)] = []
}

pub type CheckResult = {
    /// expression id → its type
    pub types: Map[int, Ty]
    /// symbol → the type of each local, parameter and global that was checked (in first-checked order)
    pub symbols: Map[int, Ty]
    /// Call id → what it calls and how each argument is passed
    pub calls: Map[int, CallInfo]
    /// FunDecl id → its declared result
    pub rets: Map[int, Ty]
    /// Member id → what `x.name` / `T.name` refers to
    pub members: Map[int, MemberTarget]
    /// node id → the variant an inferred name, struct-like variant literal or constructor pattern names
    pub variants: Map[int, VariantRef]
    pub diagnostics: Vec[Diagnostic]
    /// the inference variables the types above mention (for `show_ty`)
    pub vars: Vec[VarState]
}

/// A package this one imports, as the loader analysed it: its files and results.
/// `moves`: the clones its ownership pass found can be moves (for lowering, spec §14.1).
pub type CheckedDep = { pub files: Vec[File], pub res: Resolution, pub checked: CheckResult, pub moves: Set[int] = Set.new() }

// ---- internal structures ------------------------------------------------------------------------

/// A declaration, as the index keeps it: functions without their bodies (a body is replaced by an
/// empty block, so "has a body" is still known).
union Decl = {
    DFun(FunDecl)
    DType(TypeDecl)
    DUnion(UnionDecl)
    DInter(InterDecl)
    DGeneric(GenericParam)
    DLet(LetDecl)
    DVariant(Variant)
}

type TypeInfo = {
    sym: int
    /// "struct", "union", "inter" or "alias"
    kind: string
    generics: Vec[int]
    /// in declaration order; a repeated name replaces the earlier field in place (stage 0's Map)
    fields: Vec[Field]
    variants: Vec[Variant]
    /// inline methods, and methods from every impl block of the type
    methods: Vec[MethodEntry]
    /// interfaces the type implements (from `type X: A` and `impl A for X`), as written
    interfaces: Vec[Type]
    /// an interface: its supertypes (`supers` and the composition)
    supers: Vec[Type]
    /// an alias: the aliased type
    alias: Type?
}

type MethodEntry = {
    f: FunDecl
    /// generics in scope besides the method's own: the type's, or the impl block's
    outer: Vec[int]
    /// impl block target (`impl[T] Box[T]`): unified with the receiver to bind `outer`
    impl_target: Type?
    /// interface the method comes from, for default methods
    from_inter: int?
}

type ParamTy = { name: string, ty: Ty, variadic: bool }

type Bound = { v: Ty, bounds: Vec[Ty], span: Span? }

/// A function signature with its own generics instantiated.
type Callable = {
    params: Vec[ParamTy]
    ret: Ty
    is_async: bool = false
    bounds: Vec[Bound] = []
    receiver: string?
    // what it is, for lowering
    decl: int?
    owner: Owner?
    is_dyn: bool = false
    variant: VariantRef?
    auto: string?
    /// the instantiation of every generic in scope (own and outer)
    env: Map[int, Ty] = m{}
    /// bounds of the impl block the method comes from, checked at the call
    outer_bounds: Vec[Bound] = []
}

/// A static member: a callable (static method, variant constructor) or a value (unit variant).
union Static = {
    SCall(Callable)
    STy(Ty)
}

/// A variant found from a type: the union's info, the union type, the variant (None: a struct pattern).
type VariantFound = { info: int, t: Ty, v: Variant? }

type FnCtx = {
    /// the declared result (for async functions: the value inside the Promise)
    ret: Ty
    /// `await` allowed
    is_async: bool
    this_ty: Ty?
    /// the value type of each enclosing loop's `break`
    loops: Vec[Ty?]
    is_closure: bool
}

/// An inference variable whose type must be known by the end of the function.
type InferSite = { v: Ty, id: int, span: Span, what: string }

type OptInner = { inner: Ty, payload: Ty? }

fun no_env() -> Map[int, Ty] { m{} }

fun blank_ctx() -> FnCtx { FnCtx { ret: TyUnknown, is_async: false, this_ty: None, loops: [], is_closure: false } }

/// Interfaces every type implements through auto-generated code (spec §9.7).
fun auto_interface(name: &str) -> bool {
    match name {
        "Stringer" | "Clone" | "PartialEq" | "Hash" | "Copy" | "PartialOrd" => true
        _ => false
    }
}

/// Interfaces of the arithmetic operators, which every number type implements.
fun operator_interface(name: &str) -> bool {
    match name {
        "Plus" | "Minus" | "Times" | "Divide" | "Remainder" => true
        "PlusAssign" | "MinusAssign" | "TimesAssign" | "DivideAssign" | "RemainderAssign" => true
        _ => false
    }
}

/// Prelude types whose default is empty.
fun default_std(name: &str) -> bool { name == "Vec" || name == "Map" || name == "Set" || name == "Option" }

/// Prelude type-level forms, evaluated by a later version of the checker.
fun type_level(name: &str) -> bool {
    match name {
        "KeyOf" | "ElementOf" | "IndexOf" | "Partial" | "Omit" | "Pick" => true
        _ => false
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

// ---- the declaration index ----------------------------------------------------------------------

fun sig_fun(f: &FunDecl) -> FunDecl {
    let body = match &f.body {
        Some(b) => Some(Block { id: b.id, span: b.span, stmts: [] })
        None => None
    }
    FunDecl {
        id: f.id, span: f.span, is_pub: f.is_pub, is_async: f.is_async, name: f.name.clone(), generics: f.generics.clone(),
        receiver: f.receiver.clone(), params: f.params.clone(), ret: f.ret.clone(), body,
    }
}

fun sig_funs(fs: &Vec[FunDecl]) -> Vec[FunDecl] { fs.map(#{ f, _ => sig_fun(f) }) }

fun sig_impl(d: &ImplDecl) -> ImplDecl {
    ImplDecl { id: d.id, span: d.span, generics: d.generics.clone(), interfaces: d.interfaces.clone(), target: d.target.clone(), methods: sig_funs(d.methods) }
}

fun index_generics(index: &mut Map[int, Decl], gs: &Vec[GenericParam]) {
    for g in gs.iter() {
        index[g.id] = DGeneric(g.clone())
    }
}

fun index_methods(index: &mut Map[int, Decl], fs: &Vec[FunDecl]) {
    for f in fs.iter() {
        index_generics(index, f.generics)
    }
}

fun index_fun(index: &mut Map[int, Decl], f: &FunDecl) {
    index[f.id] = DFun(sig_fun(f))
    index_generics(index, f.generics)
}

fun index_file(index: &mut Map[int, Decl], file: &File) {
    for itm in file.items.iter() {
        match itm {
            Fun(f) => index_fun(index, f)
            TypeDef(d) => {
                let body: TypeBody = match &d.body {
                    Struct(b) => {
                        index_methods(index, b.methods)
                        Struct(StructBody { id: b.id, span: b.span, fields: b.fields.clone(), methods: sig_funs(b.methods) })
                    }
                    Alias(t) => Alias(t.clone())
                }
                index[d.id] = DType(TypeDecl { id: d.id, span: d.span, is_pub: d.is_pub, name: d.name.clone(), generics: d.generics.clone(), impls: d.impls.clone(), body })
                index_generics(index, d.generics)
            }
            Union(d) => {
                index[d.id] = DUnion(UnionDecl {
                    id: d.id, span: d.span, is_pub: d.is_pub, name: d.name.clone(), generics: d.generics.clone(), impls: d.impls.clone(),
                    variants: d.variants.clone(), methods: sig_funs(d.methods),
                })
                for v in d.variants.iter() {
                    index[v.id] = DVariant(v.clone())
                }
                index_generics(index, d.generics)
                index_methods(index, d.methods)
            }
            Inter(d) => {
                let methods = match &d.methods {
                    Some(ms) => {
                        index_methods(index, ms)
                        Some(sig_funs(ms))
                    }
                    None => None
                }
                index[d.id] = DInter(InterDecl {
                    id: d.id, span: d.span, is_pub: d.is_pub, name: d.name.clone(), generics: d.generics.clone(), supers: d.supers.clone(),
                    methods, composition: d.composition.clone(),
                })
                index_generics(index, d.generics)
            }
            Impl(d) => {
                index_generics(index, d.generics)
                index_methods(index, d.methods)
            }
            Let(d) => { index[d.id] = DLet(d.clone()) }
            Extern(d) => {
                for f in d.funs.iter() {
                    index_fun(index, f)
                }
            }
        }
    }
}

// ---- the checker ----------------------------------------------------------------------------------

type Checker = {
    syms: Vec[Sym]
    scopes: Vec[Scope]
    /// use → symbol (the prelude's and the package's)
    refs: Map[int, int]
    /// declaration → symbol
    decls: Map[int, int]
    deferred: Set[int]
    open: Set[int]
    prelude_names: Map[string, int]
    index: Map[int, Decl] = m{}
    types: Map[int, Ty] = m{}
    diagnostics: Vec[Diagnostic] = []
    sym_types: Map[int, Ty] = m{}
    calls: Map[int, CallInfo] = m{}
    members: Map[int, MemberTarget] = m{}
    rets: Map[int, Ty] = m{}
    variants: Map[int, VariantRef] = m{}
    infos: Vec[TypeInfo] = []
    info_of: Map[int, int] = m{}
    impls_by_target: Map[int, Vec[ImplDecl]] = m{}
    prim_methods: Map[string, Vec[MethodEntry]] = m{}
    implicit_by_owner: Map[int, Vec[int]] = m{}
    globals_in_progress: Set[int] = Set.new()
    vars: Vec[VarState] = []
    trail: Vec[t(int, string?)] = []
    infer_sites: Vec[InferSite] = []
    /// variables that are (or were) numeric literals, defaulted by `finish_inference`
    lit_vars: Vec[int] = []
    ctx: FnCtx
    self_stack: Vec[Ty] = []
}

/// Checks the files of one package. `prelude` is the prelude's resolution (and `prelude_file` its
/// file); `res` is the package's, which shares the prelude's symbol arena.
pub fun check_package(files: &Vec[File], res: &Resolution, prelude_file: &File, prelude: &Resolution) -> CheckResult {
    var own = res.clone()
    check_loaded(files, own, prelude_file, prelude, [], [], [])
}

/// Checks a package of a loaded program: `deps[i]` for every `i` in `reach` is a package it can reach
/// (dependencies first), and `vars` the program's inference variables so far (each package continues
/// the arena, so the types of a dependency's bindings stay valid here).
/// A resolution's tables, added to the merged ones (read in place: a resolution holds the program's arenas).
fun merge_names(r: &Resolution, refs: &mut Map[int, int], decls: &mut Map[int, int], deferred: &mut Set[int], open: &mut Set[int]) {
    for id, rf in r.refs {
        refs[id] = rf.sym
    }
    for id, s in r.decls {
        decls[id] = s
    }
    for d in r.deferred.iter() {
        let _ = deferred.insert(d.id)
    }
    for id in r.open.iter() {
        let _ = open.insert(id)
    }
}

pub fun check_loaded(files: &Vec[File], res: &mut Resolution, prelude_file: &File, prelude: &Resolution, deps: &Vec[CheckedDep], reach: &Vec[int], vars: Vec[VarState]) -> CheckResult {
    var refs = m{} as Map[int, int]
    var decls = m{} as Map[int, int]
    var deferred = Set.new() as Set[int]
    var open = Set.new() as Set[int]
    merge_names(prelude, refs, decls, deferred, open)
    for i in reach.iter() {
        merge_names(deps[i].res, refs, decls, deferred, open)
    }
    merge_names(res, refs, decls, deferred, open)
    // the checker borrows the resolution's arenas (they are the program's) and gives them back at the end
    var c = Checker {
        syms: res.symbols.drain(), scopes: res.scopes.drain(), refs, decls, deferred, open, vars,
        prelude_names: prelude.scopes[prelude.pkg_scope].names.clone(), ctx: blank_ctx(),
    }
    for i in reach.iter() {
        for sym, ty in deps[i].checked.symbols {
            c.sym_types[sym] = ty.clone()
        }
    }
    var implicit = [] as Vec[t(int, int)]
    for s in c.syms.iter() {
        if s.kind != "implicit" {
            continue
        }
        let Some(owner) = c.scopes[s.scope].closure else { continue }
        implicit.push(t(owner, s.id))
    }
    for pair in implicit.iter() {
        let t(owner, id) = pair
        var list = c.implicit_by_owner.get(owner) ?? []
        if !list.contains(id) {
            list.push(id)
        }
        c.implicit_by_owner[owner] = list
    }
    index_file(c.index, prelude_file)
    for i in reach.iter() {
        for f in deps[i].files.iter() {
            index_file(c.index, f)
        }
    }
    for f in files.iter() {
        index_file(c.index, f)
    }
    c.register_impls(prelude_file)
    for i in reach.iter() {
        for f in deps[i].files.iter() {
            c.register_impls(f)
        }
    }
    for f in files.iter() {
        c.register_impls(f)
    }
    for f in files.iter() {
        for itm in f.items.iter() {
            c.check_item(itm)
        }
    }
    res.symbols = c.syms.drain()
    res.scopes = c.scopes.drain()
    CheckResult {
        types: c.types, symbols: c.sym_types, calls: c.calls, rets: c.rets, members: c.members, variants: c.variants,
        diagnostics: c.diagnostics, vars: c.vars,
    }
}

impl Checker {
    // ---- diagnostics and inference variables ----

    fun error(&mut this, code: &str, message: string, span: Span) {
        this.diagnostics.push(Diagnostic { code: code.to_str(), message, span })
    }

    fun prune(&this, t: &Ty) -> Ty { prune_ty(t, this.vars) }
    fun strip(&this, t: &Ty) -> Ty { strip_ty(t, this.vars) }
    fun show(&this, t: &Ty) -> string { show_ty(t, this.vars, this.syms) }
    fun subst(&this, t: &Ty, env: &Map[int, Ty]) -> Ty { subst_ty(t, env, this.vars) }
    fun ptag(&this, t: &Ty) -> string { tag(prune_ty(t, this.vars)) }

    fun fresh(&mut this) -> Ty {
        this.vars.push(VarState { bound: None, lit: None })
        TyVar(this.vars.len() - 1)
    }

    fun fresh_lit(&mut this, lit: &str) -> Ty {
        this.vars.push(VarState { bound: None, lit: Some(lit.to_str()) })
        let id = this.vars.len() - 1
        this.lit_vars.push(id)
        TyVar(id)
    }

    /// An inference variable whose type must be known by the end of the function (else E_CANNOT_INFER_TYPE).
    fun fresh_at(&mut this, id: int, span: Span, what: string) -> Ty {
        let v = this.fresh()
        this.infer_sites.push(InferSite { v: v.clone(), id, span, what })
        v
    }

    fun var_lit(&this, v: int) -> string { this.vars[v].lit ?? "" }

    fun bind_var(&mut this, v: int, t0: &Ty) -> bool {
        let target = this.prune(t0)
        let tv = var_of(target)
        if tv == v {
            return true
        }
        if tv >= 0 {
            let vl = this.vars[v].lit.clone()
            let tl = this.vars[tv].lit.clone()
            if vl.is_some() || tl.is_some() {
                let lit = if (vl ?? "") == "float" || (tl ?? "") == "float" { "float" } else { "int" }
                this.trail.push(t(tv, tl))
                this.vars[tv].lit = Some(lit.to_str())
                this.lit_vars.push(tv)
            }
            this.trail.push(t(v, vl))
            this.vars[v].bound = Some(target)
            return true
        }
        let lit = this.var_lit(v)
        if lit != "" {
            let k = tag(target)
            if k == "unknown" || k == "never" {
                // fine
            } else if lit == "int" && !is_numeric(target) {
                return false
            } else if lit == "float" && !is_float(target) {
                return false
            }
        }
        if occurs(v, target, this.vars) {
            return false
        }
        this.trail.push(t(v, this.vars[v].lit.clone()))
        this.vars[v].bound = Some(target)
        true
    }

    fun undo(&mut this, mark: int) {
        for this.trail.len() > mark {
            let Some(entry) = this.trail.pop() else { return }
            let t(v, lit) = entry
            this.vars[v].bound = None
            this.vars[v].lit = lit
        }
    }

    /// Assignability with rollback on failure.
    fun try_assign(&mut this, from: &Ty, to: &Ty) -> bool {
        let mark = this.trail.len()
        if this.assign(from, to) {
            return true
        }
        this.undo(mark)
        false
    }

    /// Reports E_TYPE_MISMATCH unless `from` is assignable to `to`.
    fun expect_assign(&mut this, span: Span, from: &Ty, to: &Ty) { this.expect_assign_as(span, from, to, "expected") }

    fun expect_assign_as(&mut this, span: Span, from: &Ty, to: &Ty, what: &str) {
        if !this.try_assign(from, to) {
            let msg = "${what} `${this.show(to)}`, found `${this.show(from)}`"
            this.error("E_TYPE_MISMATCH", msg, span)
        }
    }

    // ---- assignability (spec §7.2 coercions, §7.4 conversions, §9.5 widening) ----

    fun assign(&mut this, from0: &Ty, to0: &Ty) -> bool {
        let from = this.prune(from0)
        let to = this.prune(to0)
        let fv = var_of(from)
        let tv = var_of(to)
        if fv >= 0 && fv == tv {
            return true
        }
        let fk = tag(from)
        let tk = tag(to)
        if fk == "unknown" || tk == "unknown" {
            // gradual: an inference variable meeting `unknown` becomes `unknown` (no "can't infer" error)
            if fv >= 0 && this.var_lit(fv) == "" {
                let _ = this.bind_var(fv, TyUnknown)
            }
            if tv >= 0 && this.var_lit(tv) == "" {
                let _ = this.bind_var(tv, TyUnknown)
            }
            return true
        }
        if fk == "never" {
            return true
        }
        if let TyRef { inner, .. } = &from {
            return this.assign(inner.get(), to)
        }
        if let TyRef { inner, .. } = &to {
            return this.assign(from, inner.get())
        }
        if fv >= 0 && tk == "named" && this.info_kind(named_sym(to)) == "inter" {
            // `log.println(1)`: a literal passed as `&Stringer` keeps its own (default) type
            if this.var_lit(fv) != "" {
                return true
            }
        }
        if fv >= 0 {
            return this.bind_var(fv, to)
        }
        if tv >= 0 {
            return this.bind_var(tv, from)
        }
        match &to {
            TyPrim(tn) => {
                match &from {
                    TyPrim(fname) => fname == tn || widens(fname, tn) || (is_stringy(from) && is_stringy(to))
                    TyLit(v) => lit_fits(v, tn)
                    TyUnion(ms) => {
                        for m in ms.iter() {
                            if !this.assign(m, to) {
                                return false
                            }
                        }
                        true
                    }
                    _ => false
                }
            }
            TyLit(tl) => {
                match &from {
                    TyLit(fl) => fl == tl
                    _ => false
                }
            }
            TyUnion(tms) => {
                match &from {
                    TyLit(fl) => {
                        for m in tms.iter() {
                            if let TyLit(x) = this.prune(m) {
                                if x == fl {
                                    return true
                                }
                            }
                        }
                        false
                    }
                    TyUnion(fms) => {
                        for m in fms.iter() {
                            if !this.assign(m, to) {
                                return false
                            }
                        }
                        true
                    }
                    _ => false
                }
            }
            TyNamed { sym: ts, args: targs } => {
                let kind = this.info_kind(ts)
                if kind == "inter" && named_sym(from) != ts {
                    return this.implements(from, ts)
                }
                match &from {
                    TyNamed { sym: fs, args: fargs } => {
                        if fs == ts {
                            return this.eq_args(fargs, targs)
                        }
                        // Vec[T] / Array[T, N] → Slice[T]
                        if this.is_prelude(ts, "Slice") && (this.is_prelude(fs, "Vec") || this.is_prelude(fs, "Array")) {
                            return this.eq_args([arg_at(from, 0)], [arg_at(to, 0)])
                        }
                        false
                    }
                    TyRecord(fields) => kind == "struct" && this.record_to_struct(fields, to)
                    _ => false
                }
            }
            TyTuple(tel) => {
                let TyTuple(fel) = &from else { return false }
                if fel.len() != tel.len() {
                    return false
                }
                var i = 0
                for i < fel.len() {
                    if !this.assign(fel[i], tel[i]) {
                        return false
                    }
                    i += 1
                }
                true
            }
            TyRecord(tfs) => {
                if fk == "named" {
                    if this.info_kind(named_sym(from)) != "struct" {
                        return false
                    }
                    let rec = this.struct_as_record(from)
                    return this.assign(rec, to)
                }
                let TyRecord(ffs) = &from else { return false }
                for f in tfs.iter() {
                    let Some(g) = ffs.find(#{ x, _ => x.name == f.name }) else {
                        if !f.optional {
                            return false
                        }
                        continue
                    }
                    if !this.assign(g.ty, f.ty) {
                        return false
                    }
                }
                ffs.all(#{ g, _ => tfs.any(#{ f, _ => f.name == g.name }) })
            }
            TyFn { params: tps, ret: tret, .. } => {
                let TyFn { params: fps, ret: fret, .. } = &from else { return false }
                if fps.len() > tps.len() {
                    return false
                }
                var i = 0
                for i < fps.len() {
                    if !this.assign(tps[i], fps[i]) {
                        return false
                    }
                    i += 1
                }
                if is_prim(this.prune(tret.get()), "void") {
                    return true
                }
                this.assign(fret.get(), tret.get())
            }
            TyPtr { inner: ti, .. } => {
                let TyPtr { inner: fi, .. } = &from else { return false }
                this.eq_args([fi.get().clone()], [ti.get().clone()])
            }
            TyParam(ts) => {
                match &from {
                    TyParam(fs) => fs == ts
                    _ => false
                }
            }
            _ => false
        }
    }

    fun eq_args(&mut this, xs: &Vec[Ty], ys: &Vec[Ty]) -> bool {
        if xs.len() != ys.len() {
            return xs.is_empty() || ys.is_empty()
        }
        var i = 0
        for i < xs.len() {
            if !(this.assign(xs[i], ys[i]) && this.assign(ys[i], xs[i])) {
                return false
            }
            i += 1
        }
        true
    }

    /// Record → named struct (spec §7.4): same field names, missing fields need a default or `T?`.
    fun record_to_struct(&mut this, from: &Vec[FieldTy], to: &Ty) -> bool {
        let Some(ii) = this.info(named_sym(to)) else { return false }
        let env = this.env_for(ii, named_args(to))
        let fields = this.infos[ii].fields.clone()
        for field in fields.iter() {
            let raw = this.to_ty(field.ty)
            let fty = this.subst(raw, env)
            let Some(g) = from.find(#{ f, _ => f.name == field.name }) else {
                if field.default.is_none() && !this.is_option(fty) {
                    return false
                }
                continue
            }
            if !this.assign(g.ty, fty) {
                return false
            }
        }
        from.all(#{ f, _ => fields.any(#{ x, _ => x.name == f.name }) })
    }

    fun struct_as_record(&mut this, t: &Ty) -> Ty {
        let Some(ii) = this.info(named_sym(t)) else { return TyUnknown }
        let env = this.env_for(ii, named_args(t))
        let fields = this.infos[ii].fields.clone()
        var out = [] as Vec[FieldTy]
        for f in fields.iter() {
            let raw = this.to_ty(f.ty)
            out.push(FieldTy { name: f.name.clone(), ty: this.subst(raw, env), optional: false })
        }
        sort_fields(out)
        TyRecord(out)
    }

    /// Does `t0` implement interface `iface`? Unknown and unresolved types are given the benefit of the doubt.
    fun implements(&mut this, t0: &Ty, iface: int) -> bool {
        let t = this.strip(t0)
        let istd = this.syms[iface].std
        let iname = this.syms[iface].name.clone()
        if auto_interface(iname) && istd {
            return true
        }
        let name = if istd { iname } else { "" }
        match &t {
            TyUnknown | TyVar(_) | TyNever => true
            TyPrim(p) => {
                // the operators of numbers and strings, and the types with a natural default (spec §9.7)
                if is_numeric(t) {
                    return operator_interface(name) || name == "Default"
                }
                if is_stringy(t) {
                    return name == "Plus" || name == "PlusAssign" || name == "Default"
                }
                p == "bool" && name == "Default"
            }
            TyParam(s) => {
                for b in this.bounds_of(s).iter() {
                    let bs = named_sym(b)
                    if bs >= 0 && (bs == iface || this.inter_extends(bs, iface)) {
                        return true
                    }
                }
                false
            }
            TyNamed { sym, .. } => {
                if sym == iface || this.inter_extends(sym, iface) {
                    return true
                }
                if name == "Default" && this.syms[sym].std && default_std(this.syms[sym].name) {
                    return true
                }
                let Some(ii) = this.info(sym) else { return true }
                if name == "Default" && this.infos[ii].kind == "struct" {
                    var seen = Set.new() as Set[int]
                    if this.auto_default(ii, t, seen) {
                        return true
                    }
                }
                let ifaces = this.infos[ii].interfaces.clone()
                for itf in ifaces.iter() {
                    let Some(s) = this.type_ref(itf) else { continue }
                    if s == iface || this.inter_extends(s, iface) {
                        return true
                    }
                }
                false
            }
            _ => false
        }
    }

    /// The symbol a written type names (`TName` only).
    fun type_ref(&this, t: &Type) -> int? {
        match &t.kind {
            TName { .. } => this.refs.get(t.id)
            _ => None
        }
    }

    /// A struct has an auto-generated `Default` when every field has a default value, is optional, or
    /// has a `Default` type (spec §9.7).
    fun auto_default(&mut this, ii: int, t: &Ty, seen: &mut Set[int]) -> bool {
        let sym = this.infos[ii].sym
        if seen.has(sym) {
            return false
        }
        let _ = seen.insert(sym)
        let env = this.env_for(ii, named_args(t))
        let Some(iface) = this.prelude("Default") else { return false }
        let fields = this.infos[ii].fields.clone()
        for f in fields.iter() {
            if f.default.is_some() {
                continue
            }
            if let TOption(_) = &f.ty.kind {
                continue
            }
            let raw = this.to_ty(f.ty)
            let sub = this.subst(raw, env)
            let ft = this.strip(sub)
            let fs = named_sym(ft)
            if fs >= 0 {
                if let Some(fi) = this.info(fs) {
                    if this.infos[fi].kind == "struct" && !this.syms[fs].std {
                        if !this.auto_default(fi, ft, seen) {
                            return false
                        }
                        continue
                    }
                }
            }
            if !this.implements(ft, iface) {
                return false
            }
        }
        true
    }

    fun inter_extends(&mut this, a: int, b: int) -> bool {
        var seen = Set.new() as Set[int]
        this.inter_extends_in(a, b, seen)
    }

    fun inter_extends_in(&mut this, a: int, b: int, seen: &mut Set[int]) -> bool {
        if a == b {
            return true
        }
        if seen.has(a) {
            return false
        }
        let _ = seen.insert(a)
        let Some(ii) = this.info(a) else { return false }
        if this.infos[ii].kind != "inter" {
            return false
        }
        var flat = [] as Vec[Type]
        for s in this.infos[ii].supers.iter() {
            match &s.kind {
                TIntersection(ms) => flat.extend(ms.clone())
                _ => flat.push(s.clone())
            }
        }
        for s in flat.iter() {
            let Some(sym) = this.type_ref(s) else { continue }
            if this.inter_extends_in(sym, b, seen) {
                return true
            }
        }
        false
    }

    // ---- prelude and type information ----

    fun prelude(&this, name: &str) -> int? { this.prelude_names.get(name) }

    fun is_prelude(&this, sym: int, name: &str) -> bool {
        match this.prelude(name) {
            Some(s) => s == sym
            None => false
        }
    }

    fun named(&this, name: &str, args: Vec[Ty]) -> Ty {
        match this.prelude(name) {
            Some(sym) => TyNamed { sym, args }
            None => TyUnknown
        }
    }

    fun option(&this, t: Ty) -> Ty { this.named("Option", [t]) }

    fun is_named_prelude(&this, t: &Ty, name: &str) -> bool {
        let s = this.strip(t)
        tag(s) == "named" && this.is_prelude(named_sym(s), name)
    }

    fun is_option(&this, t: &Ty) -> bool { this.is_named_prelude(t, "Option") }
    fun is_result(&this, t: &Ty) -> bool { this.is_named_prelude(t, "Result") }

    fun register_impls(&mut this, file: &File) {
        for itm in file.items.iter() {
            if let Impl(d) = itm {
                this.register_impl(d)
            }
        }
    }

    fun register_impl(&mut this, d: &ImplDecl) {
        let Some(sym) = this.type_ref(d.target) else { return }
        if this.syms[sym].kind == "builtin-type" {
            let name = this.syms[sym].name.clone()
            var list = this.prim_methods.get(name) ?? []
            let outer = this.generics(d.generics)
            for m in d.methods.iter() {
                list.push(MethodEntry { f: sig_fun(m), outer: outer.clone(), impl_target: None, from_inter: None })
            }
            this.prim_methods[name] = list
            return
        }
        var list = this.impls_by_target.get(sym) ?? []
        list.push(sig_impl(d))
        this.impls_by_target[sym] = list
    }

    fun generics(&this, gs: &Vec[GenericParam]) -> Vec[int] {
        var out = [] as Vec[int]
        for g in gs.iter() {
            if let Some(s) = this.decls.get(g.id) {
                out.push(s)
            }
        }
        out
    }

    /// The declaration a symbol points to.
    fun decl_of(&this, sym: int) -> Decl? {
        let Some(d) = this.syms[sym].decl else { return None }
        this.index.get(d)
    }

    fun info_kind(&mut this, sym: int) -> string {
        if sym < 0 {
            return ""
        }
        match this.info(sym) {
            Some(ii) => this.infos[ii].kind.clone()
            None => ""
        }
    }

    /// The type information of a struct, union, alias or interface (cached), as an index into `infos`.
    fun info(&mut this, sym: int) -> int? {
        if let Some(i) = this.info_of.get(sym) {
            return Some(i)
        }
        let Some(decl) = this.decl_of(sym) else { return None }
        var info = TypeInfo { sym, kind: "", generics: [], fields: [], variants: [], methods: [], interfaces: [], supers: [], alias: None }
        match decl {
            DType(d) => {
                info.generics = this.generics(d.generics)
                info.interfaces = d.impls.clone()
                match &d.body {
                    Struct(b) => {
                        info.kind = "struct"
                        for f in b.fields.iter() {
                            add_field(info.fields, f.clone())
                        }
                        for m in b.methods.iter() {
                            info.methods.push(MethodEntry { f: m.clone(), outer: info.generics.clone(), impl_target: None, from_inter: None })
                        }
                    }
                    Alias(t) => {
                        info.kind = "alias"
                        info.alias = Some(t.clone())
                    }
                }
            }
            DUnion(d) => {
                info.kind = "union"
                info.generics = this.generics(d.generics)
                info.interfaces = d.impls.clone()
                for v in d.variants.iter() {
                    add_variant(info.variants, v.clone())
                }
                for m in d.methods.iter() {
                    info.methods.push(MethodEntry { f: m.clone(), outer: info.generics.clone(), impl_target: None, from_inter: None })
                }
            }
            DInter(d) => {
                info.kind = "inter"
                info.generics = this.generics(d.generics)
                for m in (d.methods ?? []).iter() {
                    info.methods.push(MethodEntry { f: m.clone(), outer: info.generics.clone(), impl_target: None, from_inter: Some(sym) })
                }
                info.supers = d.supers.clone()
                if let Some(c) = &d.composition {
                    info.supers.push(c.clone())
                }
            }
            _ => return None
        }
        this.infos.push(info)
        let ii = this.infos.len() - 1
        this.info_of[sym] = ii
        for imp in (this.impls_by_target.get(sym) ?? []).iter() {
            let outer = this.generics(imp.generics)
            for m in imp.methods.iter() {
                this.infos[ii].methods.push(MethodEntry { f: m.clone(), outer: outer.clone(), impl_target: Some(imp.target.clone()), from_inter: None })
            }
            this.infos[ii].interfaces.extend(imp.interfaces.clone())
        }
        // default methods of implemented interfaces
        let ifaces = this.infos[ii].interfaces.clone()
        for itf in ifaces.iter() {
            let Some(isym) = this.type_ref(itf) else { continue }
            let Some(ji) = this.info(isym) else { continue }
            let methods = this.infos[ji].methods.clone()
            let outer = this.infos[ji].generics.clone()
            for m in methods.iter() {
                if m.f.body.is_some() {
                    this.infos[ii].methods.push(MethodEntry { f: m.f.clone(), outer: outer.clone(), impl_target: Some(itf.clone()), from_inter: m.from_inter })
                }
            }
        }
        Some(ii)
    }

    fun env_for(&this, ii: int, args: Vec[Ty]) -> Map[int, Ty] {
        var env = m{} as Map[int, Ty]
        var i = 0
        for g in this.infos[ii].generics.iter() {
            env[g] = args.get(i) ?? TyUnknown
            i += 1
        }
        env
    }

    fun bounds_of(&mut this, sym: int) -> Vec[Ty] {
        let Some(DGeneric(g)) = this.decl_of(sym) else { return [] }
        var out = [] as Vec[Ty]
        for b in g.bounds.iter() {
            out.push(this.to_ty(b))
        }
        out
    }

    fun field_of(&this, ii: int, name: &str) -> Field? { this.infos[ii].fields.find(#{ f, _ => f.name == name }) }
    fun variant_of(&this, ii: int, name: &str) -> Variant? { this.infos[ii].variants.find(#{ v, _ => v.name == name }) }

    // ---- Type → Ty ----

    fun to_ty(&mut this, t: &Type) -> Ty { this.to_ty_at(t, 0) }

    fun to_ty_list(&mut this, ts: &Vec[Type], depth: int) -> Vec[Ty] {
        var out = [] as Vec[Ty]
        for x in ts.iter() {
            out.push(this.to_ty_at(x, depth))
        }
        out
    }

    fun to_ty_at(&mut this, t: &Type, depth: int) -> Ty {
        match &t.kind {
            TName { path, args } => {
                if path.len() == 1 && path[0] == "Self" {
                    return this.self_stack.last() ?? TyUnknown
                }
                var sym = this.refs.get(t.id)
                // `ws.Message`: a type of an imported package
                if let Some(s) = sym {
                    if path.len() > 1 && this.syms[s].kind == "package" {
                        var cur: int? = Some(s)
                        var k = 1
                        for k < path.len() {
                            cur = match cur {
                                Some(c) => match this.syms[c].target {
                                    Some(scope) => this.scopes[scope].names.get(path[k])
                                    None => None
                                }
                                None => None
                            }
                            k += 1
                        }
                        if cur.is_none() && this.syms[s].target.is_some() {
                            let pkg = this.syms[s].detail ?? this.syms[s].name.clone()
                            this.error("E_UNDECLARED_TYPE", "package `${pkg}` has no type `${path.skip(1).join(".")}`", t.span)
                        }
                        sym = cur
                    }
                }
                let Some(s) = sym else { return TyUnknown }
                let kind = this.syms[s].kind.clone()
                if path.len() > 1 && (kind == "package" || kind == "import") {
                    return TyUnknown
                }
                let targs = this.to_ty_list(args, depth)
                match kind {
                    "builtin-type" => {
                        let name = this.syms[s].name.clone()
                        if name == "never" {
                            return TyNever
                        }
                        if name == "byte" {
                            return prim("u8")
                        }
                        TyPrim(name)
                    }
                    "generic" => TyParam(s)
                    "type" | "union" | "inter" => {
                        if type_level(this.syms[s].name) && this.syms[s].std {
                            return TyUnknown
                        }
                        let ii = this.info(s)
                        if let Some(i) = ii {
                            if this.infos[i].kind == "alias" && depth < 20 {
                                let Some(body) = this.infos[i].alias.clone() else { return TyUnknown }
                                let inner = this.to_ty_at(body, depth + 1)
                                let env = this.env_for(i, targs)
                                return this.subst(inner, env)
                            }
                        }
                        TyNamed { sym: s, args: this.fill_args(ii, targs) }
                    }
                    _ => TyUnknown
                }
            }
            TOption(inner) => {
                let x = this.to_ty_at(inner.get(), depth)
                this.option(x)
            }
            TRef { is_mut, inner } => TyRef { is_mut, inner: Box.new(this.to_ty_at(inner.get(), depth)) }
            TPtr { is_mut, inner } => TyPtr { is_mut, inner: Box.new(this.to_ty_at(inner.get(), depth)) }
            TTuple(elems) => {
                if elems.is_empty() {
                    return void_ty()
                }
                TyTuple(this.to_ty_list(elems, depth))
            }
            TRecord(fields) => {
                var out = [] as Vec[FieldTy]
                for f in fields.iter() {
                    out.push(FieldTy { name: f.name.clone(), ty: this.to_ty_at(f.ty, depth), optional: false })
                }
                sort_fields(out)
                TyRecord(out)
            }
            TFn { params, ret } => {
                let ps = this.to_ty_list(params, depth)
                TyFn { params: ps, ret: Box.new(this.to_ty_at(ret.get(), depth)), is_async: false }
            }
            TLiteral(l) => {
                let v: LitVal = match l {
                    LitStr(s) => LStr(s.clone())
                    LitInt(d) => LInt(d.clone())
                    LitBool(b) => LBool(b)
                }
                TyLit(v)
            }
            TUnion(ms) => TyUnion(this.to_ty_list(ms, depth))
            TTypeOf(_) => {
                let Some(s) = this.refs.get(t.id) else { return TyUnknown }
                if this.syms[s].kind == "global" { this.global_type(s) } else { TyUnknown }
            }
            TIntersection(_) | TError => TyUnknown
        }
    }

    /// Missing type arguments become fresh variables (`Vec` in `Vec.new()`).
    fun fill_args(&mut this, ii: int?, args: Vec[Ty]) -> Vec[Ty] {
        let Some(i) = ii else { return args }
        let n = this.infos[i].generics.len()
        if args.len() >= n {
            return args
        }
        var out = args
        for out.len() < n {
            out.push(this.fresh())
        }
        out
    }

    // ---- signatures ----

    /// The signature of `f` with `env` applied to its outer generics and fresh variables for its own.
    fun callable(&mut this, f: &FunDecl, env: &Map[int, Ty], self_ty: Ty?, explicit: Vec[Ty]?, at: Span?) -> Callable {
        let own = this.generics(f.generics)
        var full = env.clone()
        if let Some(ex) = &explicit {
            if ex.len() != own.len() {
                if let Some(sp) = at {
                    this.error("E_ARG_COUNT", "`${f.name}` takes ${own.len()} type argument${if own.len() == 1 { "" } else { "s" }}, found ${ex.len()}", sp)
                }
            }
        }
        var i = 0
        for g in own.iter() {
            let given = match &explicit {
                Some(ex) => ex.get(i)
                None => None
            }
            full[g] = given ?? this.fresh()
            i += 1
        }
        let pushed = self_ty.is_some()
        if let Some(s) = self_ty {
            this.self_stack.push(s)
        }
        var params = [] as Vec[ParamTy]
        for p in f.params.iter() {
            let raw = this.to_ty(p.ty)
            var ty = this.subst(raw, full)
            if p.variadic {
                ty = this.named("Slice", [ty])
            }
            params.push(ParamTy { name: p.name.clone(), ty, variadic: p.variadic })
        }
        var ret = match &f.ret {
            Some(r) => {
                let raw = this.to_ty(r)
                this.subst(raw, full)
            }
            None => void_ty()
        }
        if f.is_async {
            ret = this.named("Promise", [ret])
        }
        var bounds = [] as Vec[Bound]
        for g in own.iter() {
            var bs = [] as Vec[Ty]
            for b in this.bounds_of(g).iter() {
                bs.push(this.subst(b, full))
            }
            bounds.push(Bound { v: full.get(g) ?? TyUnknown, bounds: bs, span: at })
        }
        if pushed {
            let _ = this.self_stack.pop()
        }
        Callable { params, ret, is_async: f.is_async, bounds, receiver: f.receiver.clone(), decl: Some(f.id), env: full }
    }

    fun fn_type(&this, c: &Callable) -> Ty {
        TyFn { params: c.params.map(#{ p, _ => p.ty.clone() }), ret: Box.new(c.ret.clone()), is_async: c.is_async }
    }

    /// Finds method `name` on `recv` (a value of that type).
    fun find_method(&mut this, recv: &Ty, name: &str, explicit: Vec[Ty]?, at: Span) -> Callable? {
        let t = this.strip(recv)
        if let TyNamed { sym, .. } = &t {
            if let Some(ii) = this.info(sym) {
                let n = this.infos[ii].methods.len()
                var i = 0
                for i < n {
                    if this.infos[ii].methods[i].f.name == name {
                        let m = this.infos[ii].methods[i].clone()
                        return Some(this.method_callable(m, ii, t, explicit, at))
                    }
                    i += 1
                }
            }
        }
        if let TyPrim(p) = &t {
            let key = if is_stringy(t) { "string" } else { p.clone() }
            let list = this.prim_methods.get(key) ?? []
            if let Some(m) = list.find(#{ x, _ => x.f.name == name }) {
                var c = this.callable(m.f, no_env(), Some(t.clone()), explicit, Some(at))
                c.owner = Some(OName(key))
                c.is_dyn = false
                return Some(c)
            }
        }
        if let TyParam(ps) = &t {
            for b in this.bounds_of(ps).iter() {
                let bs = this.strip(b)
                let Some(bsym) = if tag(bs) == "named" { Some(named_sym(bs)) } else { None } else { continue }
                let Some(ii) = this.info(bsym) else { continue }
                let Some(m) = this.infos[ii].methods.find(#{ x, _ => x.f.name == name }) else { continue }
                let env = this.env_for(ii, named_args(bs))
                var c = this.callable(m.f, env, Some(t.clone()), explicit, Some(at))   // Self = the parameter
                c.owner = Some(OSym(bsym))
                c.is_dyn = true
                return Some(c)
            }
        }
        auto_method(t, name)
    }

    fun method_callable(&mut this, m: MethodEntry, ii: int, recv: &Ty, explicit: Vec[Ty]?, at: Span) -> Callable {
        let info_sym = this.infos[ii].sym
        let is_dyn = this.infos[ii].kind == "inter"
        var env = no_env()
        let owner = match m.from_inter {
            Some(fi) => if fi != info_sym { fi } else { info_sym }
            None => info_sym
        }
        if m.impl_target.is_some() && m.from_inter.is_none() {
            // impl[T] Box[T] { … }: bind the impl's generics by unifying its target with the receiver
            for g in m.outer.iter() {
                env[g] = this.fresh()
            }
            let Some(target) = &m.impl_target else { return this.callable(m.f, env, Some(recv.clone()), explicit, Some(at)) }
            let raw = this.to_ty(target)
            let tt = this.subst(raw, env)
            let _ = this.try_assign(recv, tt)
            var outer_bounds = [] as Vec[Bound]
            for g in m.outer.iter() {
                var bs = [] as Vec[Ty]
                for b in this.bounds_of(g).iter() {
                    bs.push(this.subst(b, env))
                }
                if !bs.is_empty() {
                    outer_bounds.push(Bound { v: env.get(g) ?? TyUnknown, bounds: bs, span: Some(at) })
                }
            }
            var c = this.callable(m.f, env, Some(recv.clone()), explicit, Some(at))
            c.owner = Some(OSym(owner))
            c.is_dyn = is_dyn
            c.outer_bounds = outer_bounds
            return c
        }
        let from_other = match m.from_inter {
            Some(fi) => fi != info_sym
            None => false
        }
        if from_other && m.impl_target.is_some() {
            // a default method of an implemented interface: bind the interface's generics from `impl I[X] for T`
            let Some(target) = &m.impl_target else { return this.callable(m.f, env, Some(recv.clone()), explicit, Some(at)) }
            let itf = this.to_ty(target)
            var i = 0
            for g in m.outer.iter() {
                env[g] = arg_at(itf, i)
                i += 1
            }
        } else {
            env = this.env_for(ii, named_args(recv))
        }
        var c = this.callable(m.f, env, Some(recv.clone()), explicit, Some(at))
        c.owner = Some(OSym(owner))
        c.is_dyn = is_dyn
        c
    }

    /// Static member of a type: a method without receiver, or a variant.
    fun find_static(&mut this, t0: &Ty, name: &str, explicit: Vec[Ty]?, at: Span) -> Static? {
        let t = this.prune(t0)
        let TyNamed { sym, args } = &t else { return None }
        let Some(ii) = this.info(sym) else { return None }
        if let Some(v) = this.variant_of(ii, name) {
            return Some(this.variant_type(ii, t, v))
        }
        let n = this.infos[ii].methods.len()
        var i = 0
        for i < n {
            if this.infos[ii].methods[i].f.name == name {
                let m = this.infos[ii].methods[i].clone()
                // `.[T]` on a static method without generics of its own supplies the type's (`Topic.new.[string]()`)
                if let Some(ex) = &explicit {
                    if m.f.generics.is_empty() {
                        let _ = this.eq_args(args, ex)
                        return Some(SCall(this.method_callable(m, ii, t, None, at)))
                    }
                }
                return Some(SCall(this.method_callable(m, ii, t, explicit, at)))
            }
            i += 1
        }
        None
    }

    /// A variant as a value: the union itself (unit variant) or its constructor.
    fun variant_type(&mut this, ii: int, t: &Ty, v: &Variant) -> Static {
        let env = this.env_for(ii, named_args(t))
        let Some(tuple) = &v.tuple else { return STy(t.clone()) }
        var params = [] as Vec[ParamTy]
        var i = 0
        for p in tuple.iter() {
            let raw = this.to_ty(p)
            params.push(ParamTy { name: "${i}", ty: this.subst(raw, env), variadic: false })
            i += 1
        }
        SCall(Callable { params, ret: t.clone(), receiver: None, decl: None, variant: Some(r{ owner: this.infos[ii].sym, variant: v.name.clone() }) })
    }

    fun static_type(&this, s: &Static) -> Ty {
        match s {
            SCall(c) => this.fn_type(c)
            STy(t) => t.clone()
        }
    }

    fun global_type(&mut this, sym: int) -> Ty {
        if let Some(known) = this.sym_types.get(sym) {
            return known
        }
        let Some(DLet(d)) = this.decl_of(sym) else { return TyUnknown }
        if let Some(ty) = &d.ty {
            let t = this.to_ty(ty)
            this.sym_types[sym] = t.clone()
            return t
        }
        if this.globals_in_progress.has(sym) {
            return TyUnknown
        }
        let _ = this.globals_in_progress.insert(sym)
        let saved = this.ctx.clone()
        this.ctx = blank_ctx()
        let ty = this.check_expr(d.value, None)
        this.ctx = saved
        this.sym_types[sym] = ty.clone()
        ty
    }

    fun fun_type(&mut this, sym: int, explicit: Vec[Ty]?, at: Span) -> Callable? {
        let Some(DFun(f)) = this.decl_of(sym) else { return None }
        Some(this.callable(f, m{}, None, explicit, Some(at)))
    }

    // ---- items ----

    fun check_item(&mut this, itm: &Item) {
        match itm {
            Fun(f) => this.check_fun(f, m{}, None)
            Let(d) => {
                let Some(sym) = this.decls.get(d.id) else { return }
                if let Some(ty) = &d.ty {
                    let t = this.to_ty(ty)
                    this.sym_types[sym] = t.clone()
                    let saved = this.ctx.clone()
                    this.ctx = blank_ctx()
                    let v = this.check_expr(d.value, Some(t.clone()))
                    this.expect_assign(d.value.span, v, t)
                    this.ctx = saved
                } else {
                    let _ = this.global_type(sym)
                }
            }
            Extern(_) => {}
            TypeDef(d) => {
                let methods = match &d.body {
                    Struct(b) => b.methods.clone()
                    Alias(_) => []
                }
                this.check_type_item(d.id, d.span, methods, d.impls)
            }
            Union(d) => this.check_type_item(d.id, d.span, d.methods.clone(), d.impls)
            Inter(d) => {
                let Some(sym) = this.decls.get(d.id) else { return }
                this.self_stack.push(TyParam(sym))
                for m in (d.methods ?? []).iter() {
                    if m.body.is_some() {
                        this.check_fun(m, no_env(), Some(TyParam(sym)))
                    }
                }
                let _ = this.self_stack.pop()
            }
            Impl(d) => {
                let target = this.to_ty(d.target)
                this.self_stack.push(target.clone())
                for m in d.methods.iter() {
                    this.check_fun(m, no_env(), Some(target.clone()))
                }
                let _ = this.self_stack.pop()
                let Some(tsym) = this.type_ref(d.target) else { return }
                let Some(ii) = this.info(tsym) else { return }
                this.check_interfaces(ii, d.interfaces, true, d.span)
            }
        }
    }

    fun check_type_item(&mut this, id: int, span: Span, methods: Vec[FunDecl], impls: &Vec[Type]) {
        let Some(sym) = this.decls.get(id) else { return }
        let Some(ii) = this.info(sym) else { return }
        let me: Ty = TyNamed { sym, args: this.infos[ii].generics.map(#{ g, _ => TyParam(g) }) }
        this.self_stack.push(me.clone())
        let fields = this.infos[ii].fields.clone()
        for f in fields.iter() {
            let Some(def) = &f.default else { continue }
            let fty = this.to_ty(f.ty)
            let saved = this.ctx.clone()
            this.ctx = blank_ctx()
            let v = this.check_expr(def, Some(fty.clone()))
            this.expect_assign(def.span, v, fty)
            this.ctx = saved
        }
        for m in methods.iter() {
            this.check_fun(m, no_env(), Some(me.clone()))
        }
        let _ = this.self_stack.pop()
        this.check_interfaces(ii, impls, false, span)
    }

    /// Every method without a default body must be implemented (E_MISSING_METHOD).
    fun check_interfaces(&mut this, ii: int, ifaces: &Vec[Type], is_impl: bool, at: Span) {
        for itf in ifaces.iter() {
            let Some(isym) = this.type_ref(itf) else { continue }
            let Some(ji) = this.info(isym) else { continue }
            if this.infos[ji].kind != "inter" {
                continue
            }
            if this.syms[isym].std && auto_interface(this.syms[isym].name) {
                continue
            }
            let required = this.infos[ji].methods.clone()
            for m in required.iter() {
                if m.f.body.is_some() {
                    continue
                }
                if !this.infos[ii].methods.any(#{ x, _ => x.f.name == m.f.name && x.from_inter.is_none() }) {
                    let msg = "`${this.syms[this.infos[ii].sym].name}` implements `${this.syms[isym].name}` but doesn't define `${m.f.name}`"
                    this.error("E_MISSING_METHOD", msg, if is_impl { itf.span } else { at })
                }
            }
        }
    }

    fun check_fun(&mut this, f: &FunDecl, env: &Map[int, Ty], self_ty: Ty?) {
        let Some(body) = &f.body else { return }
        let own = env.clone()
        let pushed = self_ty.is_some()
        if let Some(s) = &self_ty {
            this.self_stack.push(s.clone())
        }
        for p in f.params.iter() {
            let raw = this.to_ty(p.ty)
            var ty = this.subst(raw, own)
            if p.variadic {
                ty = this.named("Slice", [ty])
            }
            if let Some(sym) = this.decls.get(p.id) {
                this.sym_types[sym] = ty
            }
        }
        let ret = match &f.ret {
            Some(r) => {
                let raw = this.to_ty(r)
                this.subst(raw, own)
            }
            None => void_ty()
        }
        this.rets[f.id] = ret.clone()
        let is_main = f.name == "main" && !pushed
        let sites = this.infer_sites.len()
        let saved = this.ctx.clone()
        this.ctx = FnCtx { ret: ret.clone(), is_async: f.is_async || is_main, this_ty: if f.receiver.is_some() { self_ty.clone() } else { None }, loops: [], is_closure: false }
        let _ = this.check_body(body, ret)
        this.ctx = saved
        this.finish_inference(sites)
        if pushed {
            let _ = this.self_stack.pop()
        }
    }

    /// A function body: its value must match the declared result (spec §4.1).
    fun check_body(&mut this, body: &Block, ret: &Ty) -> Ty {
        let is_void = is_prim(this.prune(ret), "void")
        let value = this.check_stmts(body.stmts, if is_void { None } else { Some(ret.clone()) })
        if is_void {
            return value
        }
        let last = body.stmts.last()
        if let Some(ExprStmt(es)) = &last {
            let lt = this.types.get(es.expr.id) ?? void_ty()
            if is_prim(value, "void") && es.semi && this.ptag(lt) != "never" {
                this.error("E_INVALID_BLOCK_VALUE", "the body must end with a value of type `${this.show(ret)}`; the trailing `;` discards it", es.span)
                return value
            }
        }
        let at = match &last {
            Some(ExprStmt(es)) => es.expr.span
            _ => body.span
        }
        this.expect_assign_as(at, value, ret, "the body should produce")
        value
    }

    /// Defaults numeric literals and reports types that are still unknown (E_CANNOT_INFER_TYPE).
    fun finish_inference(&mut this, from: int) {
        var reported = Set.new() as Set[int]
        let sites = this.infer_sites.skip(from)
        this.infer_sites.truncate(from)
        for site in sites.iter() {
            var free = [] as Vec[int]
            free_vars(site.v, this.vars, free)
            for v in free.iter() {
                if this.vars[v].lit.is_some() {
                    continue
                }
                this.vars[v].bound = Some(TyUnknown)
                if reported.has(site.id) {
                    break            // one diagnostic per literal (`m{}` has keys and values)
                }
                let _ = reported.insert(site.id)
                this.error("E_CANNOT_INFER_TYPE", "can't infer the type of ${site.what}: add a type annotation, `as T`, or `.[T]`", site.span)
                break
            }
        }
        // remaining numeric literals default to int / f64 (spec §1.5)
        let lits = this.lit_vars.clone()
        this.lit_vars.clear()
        for v in lits.iter() {
            if this.vars[v].bound.is_some() {
                continue
            }
            let lit = this.var_lit(v)
            if lit != "" {
                this.vars[v].bound = Some(prim(if lit == "float" { "f64" } else { "int" }))
            }
        }
    }

    // ---- statements ----

    /// Checks statements; returns the block's value type (spec §4.1).
    fun check_stmts(&mut this, stmts: &Vec[Stmt], expected_last: Ty?) -> Ty {
        var value = void_ty()
        var diverged = false
        var i = 0
        for s in stmts.iter() {
            let is_last = i == stmts.len() - 1
            i += 1
            match s {
                ExprStmt(es) => {
                    let ty = this.check_expr(es.expr, if is_last && !es.semi { expected_last.clone() } else { None })
                    if this.ptag(ty) == "never" {
                        diverged = true
                    }
                    value = if is_last && !es.semi { ty } else { void_ty() }
                }
                Let(l) => {
                    value = void_ty()
                    let ty = match &l.ty {
                        Some(tt) => {
                            let t = this.to_ty(tt)
                            let v = this.check_expr(l.value, Some(t.clone()))
                            this.expect_assign(l.value.span, v, t)
                            t
                        }
                        None => this.check_expr(l.value, None)
                    }
                    if let Some(eb) = &l.else_branch {
                        let else_ty = this.check_stmts(eb.stmts, None)
                        if this.ptag(else_ty) != "never" && !this.block_diverges(eb) {
                            this.error("E_LET_ELSE_MUST_DIVERGE", "the `else` block of `let … else` must leave the scope: `return`, `break`, `continue` or `panic(…)`", eb.span)
                        }
                    }
                    this.bind_pattern(l.pattern, ty)
                }
            }
        }
        if diverged && is_prim(value, "void") { TyNever } else { value }
    }

    fun block_diverges(&this, b: &Block) -> bool {
        for s in b.stmts.iter() {
            if let ExprStmt(es) = s {
                let t = this.types.get(es.expr.id) ?? void_ty()
                if this.ptag(t) == "never" {
                    return true
                }
            }
        }
        false
    }
}

/// Adds a field, replacing an earlier one of the same name in place (stage 0 keeps fields in a Map).
fun add_field(fields: &mut Vec[Field], f: Field) {
    var i = 0
    for i < fields.len() {
        if fields[i].name == f.name {
            fields[i] = f
            return
        }
        i += 1
    }
    fields.push(f)
}

fun add_variant(variants: &mut Vec[Variant], v: Variant) {
    var i = 0
    for i < variants.len() {
        if variants[i].name == v.name {
            variants[i] = v
            return
        }
        i += 1
    }
    variants.push(v)
}

fun sort_fields(fields: &mut Vec[FieldTy]) {
    fields.sort_by(#{ a, b => if a.name < b.name { Less } else if a.name > b.name { Greater } else { Equal } })
}

fun lit_fits(v: &LitVal, p: &str) -> bool {
    match v {
        LStr(_) => p == "string" || p == "str"
        LBool(_) => p == "bool"
        LInt(_) => int_type(p) || p == "f32" || p == "f64"
    }
}

/// Auto-generated methods every type has (spec §9.7).
fun auto_method(t: &Ty, name: &str) -> Callable? {
    let ps = match name {
        "to_str" | "hash" | "clone" => [] as Vec[Ty]
        "eq" => [t.clone()]
        _ => return None
    }
    let ret = match name {
        "to_str" => prim("string")
        "clone" => t.clone()
        "eq" => prim("bool")
        _ => prim("u64")
    }
    var params = [] as Vec[ParamTy]
    var i = 0
    for p in ps.iter() {
        params.push(ParamTy { name: "p${i}", ty: p.clone(), variadic: false })
        i += 1
    }
    Some(Callable { params, ret, receiver: Some("&this"), decl: None, auto: Some(name.to_str()) })
}
