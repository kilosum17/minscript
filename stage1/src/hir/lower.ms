// Lowering: AST + resolver / checker results → HIR, ported from minscript/src/lower.ts.
//
// Lowering never re-derives a type rule: it reads the checker's decisions (expression types, call
// targets, member targets, inferred variants). Anything it can't lower becomes an `unsupported` node
// (and never a crash), so gaps are visible in `.hir` dumps.
//
// Stage 0 follows `Sym.decl` to AST nodes (a struct's fields, a union's variants, a function's
// parameters); here an index (`index`, declaration id → what lowering needs of it) answers that.
//
// This file: state, names, items, statements, patterns, coercions. `lower_expr.ms`: expressions,
// calls and control flow.
package hir

import "app.lexer.{Span}"
import "app.ast.*"
import "app.resolve.{Sym, Scope, Resolution}"
import "app.check.{CheckResult, CheckedDep, CallInfo, MemberTarget, VariantRef, Owner, Ty, VarState, prune_ty, strip_ty, pruned, stripped, tag, named_sym, named_args, arg_at, is_int, is_float, is_numeric, is_stringy, is_prim, prim, void_ty, unknown, dec_neg}"

/// What lowering needs of a function declaration.
type FunInfo = { name: string, params: Vec[Param], generics: int, builtin: bool }

/// What lowering needs of a declaration (by node id).
union LDecl = {
    LStruct { fields: Vec[Field], methods: Vec[string] }
    LUnionD(Vec[Variant])
    LInterD
    LFunD(FunInfo)
}

type Lowerer = {
    /// the program's symbols, inference variables, merged side tables and moves (read-only, shared)
    syms: Ref[Vec[Sym]]
    vars: Ref[Vec[VarState]]
    tables: Ref[Tables]
    moves: Ref[Set[int]]
    captures: Map[int, Vec[int]]
    types: Map[int, Ty]
    sym_types: Map[int, Ty]
    open: Set[int]
    deferred: Set[int]
    prelude_names: Map[string, int]
    /// the names of each imported package's scope (`Sym.target`), for `pkg.Type` in field types
    pkg_names: Map[int, Map[string, int]] = m{}
    package_name: string
    implicit_by_owner: Map[int, Vec[int]] = m{}
    fun_names: Map[int, string] = m{}
    index: Map[int, LDecl] = m{}
    temp_count: int = 0
    /// the result type of the function (or closure) being lowered
    ret: Ty
    current_file: string?
}

/// The qualified prefix of a package's items: none for `main`, `std.` for the prelude, else `<package>.`.
pub fun package_prefix(name: &str) -> string {
    if name == "main" { "" } else if name == "std" { "std." } else { "${name}." }
}

/// Lowers the files of one package (`main`) to HIR. `prelude` is the prelude's resolution and file.
pub fun lower_package(files: &Vec[File], res: &Resolution, checked: &CheckResult, prelude_file: &File, prelude: &Resolution, moves: Set[int]) -> Program {
    let shared = package_shared(prelude, res, checked, moves)
    lower_loaded(files, res, checked, prelude_file, prelude, "main", [], [], [], 0, shared)
}

/// What every package's lowering reads and nobody changes any more: the program's arenas (the last
/// analysed package's symbols, scopes and inference variables), its merged side tables, and the
/// clones that are moves. `Ref`s, so each lowering reads them in place (spec §9.9).
pub type Shared = {
    pub syms: Ref[Vec[Sym]]
    pub scopes: Ref[Vec[Scope]]
    pub vars: Ref[Vec[VarState]]
    pub tables: Ref[Tables]
    pub moves: Ref[Set[int]]
}

/// `Shared` for one package lowered on its own (the prelude, or a file with `ms hir`): its arenas,
/// and the prelude's and its own tables.
pub fun package_shared(prelude: &Resolution, res: &Resolution, checked: &CheckResult, moves: Set[int]) -> Shared {
    var tables = Tables {}
    merge_refs(prelude, tables.refs, tables.decls)
    merge_refs(res, tables.refs, tables.decls)
    merge_checked(checked, tables)
    Shared {
        syms: Ref(res.symbols.clone()), scopes: Ref(res.scopes.clone()), vars: Ref(checked.vars.clone()),
        tables: Ref(tables), moves: Ref(moves),
    }
}

/// The resolver's and checker's side tables lowering reads, merged over packages: node ids are
/// unique across a program, so they merge. A dependency's expressions lowered elsewhere (an imported
/// struct's field defaults, `= None`) use its checker's decisions this way.
pub type Tables = {
    pub refs: Map[int, int] = m{}
    pub decls: Map[int, int] = m{}
    pub calls: Map[int, CallInfo] = m{}
    pub members: Map[int, MemberTarget] = m{}
    pub variants: Map[int, VariantRef] = m{}
    pub rets: Map[int, Ty] = m{}
}

fun merge_checked(c: &CheckResult, into: &mut Tables) {
    for id, x in c.calls {
        into.calls[id] = x.clone()
    }
    for id, x in c.members {
        into.members[id] = x.clone()
    }
    for id, x in c.variants {
        into.variants[id] = x.clone()
    }
    for id, x in c.rets {
        into.rets[id] = x.clone()
    }
}

/// The tables of the prelude (its resolution) and of every analysed package, merged once for a whole
/// program's lowering (each package then reads them instead of merging its dependencies').
pub fun merge_program_tables(prelude: &Resolution, packages: &Vec[CheckedDep]) -> Tables {
    var out = Tables {}
    merge_refs(prelude, out.refs, out.decls)
    for d in packages.iter() {
        merge_refs(d.res, out.refs, out.decls)
        merge_checked(d.checked, out)
    }
    out
}

/// A resolution's refs and declarations, added to the merged ones (read in place).
fun merge_refs(r: &Resolution, refs: &mut Map[int, int], decls: &mut Map[int, int]) {
    for id, rf in r.refs {
        refs[id] = rf.sym
    }
    for id, s in r.decls {
        decls[id] = s
    }
}

/// Lowers a package of a loaded program: `package_name` prefixes its items (none for `main`), `deps[i]`
/// for `i` in `reach` are the packages it can reach, `file_names[k]` names `files[k]` in panic
/// locations, and temporaries are numbered after `first_temp`. `shared`: what it reads of the program.
pub fun lower_loaded(files: &Vec[File], res: &Resolution, checked: &CheckResult, prelude_file: &File, prelude: &Resolution, package_name: &str, deps: &Vec[CheckedDep], reach: &Vec[int], file_names: Vec[string], first_temp: int, shared: &Shared) -> Program {
    var caps = m{} as Map[int, Vec[int]]
    for id, c in res.captures {
        caps[id] = c.syms.clone()
    }
    var deferred = Set.new() as Set[int]
    for d in res.deferred.iter() {
        let _ = deferred.insert(d.id)
    }
    var l = Lowerer {
        syms: shared.syms, vars: shared.vars, tables: shared.tables, moves: shared.moves,
        captures: caps, types: checked.types.clone(), sym_types: checked.symbols.clone(),
        open: res.open.clone(), deferred, prelude_names: prelude.scopes[prelude.pkg_scope].names.clone(),
        package_name: package_name.to_str(), ret: void_ty(), current_file: None, temp_count: first_temp,
    }
    let scopes = shared.scopes.get()
    var implicit = [] as Vec[t(int, int)]
    for s in shared.syms.get().iter() {
        if s.kind == "package" {
            if let Some(scope) = s.target {
                if !l.pkg_names.has(scope) {
                    l.pkg_names[scope] = scopes[scope].names.clone()
                }
            }
        }
        if s.kind != "implicit" {
            continue
        }
        let Some(owner) = scopes[s.scope].closure else { continue }
        implicit.push(t(owner, s.id))
    }
    for pair in implicit.iter() {
        let t(owner, id) = pair
        var list = l.implicit_by_owner.get(owner) ?? []
        if !list.contains(id) {
            list.push(id)
        }
        l.implicit_by_owner[owner] = list
    }
    l.index_file(prelude_file)
    for i in reach.iter() {
        for f in deps[i].files.iter() {
            l.index_file(f)
        }
    }
    for f in files.iter() {
        l.index_file(f)
    }
    l.name_items(prelude_file, "std.")
    for i in reach.iter() {
        for f in deps[i].files.iter() {
            l.name_items(f, package_prefix(deps[i].res.package_name))
        }
    }
    for f in files.iter() {
        l.name_items(f, package_prefix(l.package_name))
    }
    var program = Program {}
    let interfaces = l.collect_interfaces(files)
    var k = 0
    for f in files.iter() {
        l.current_file = file_names.get(k)
        k += 1
        for itm in f.items.iter() {
            l.lower_item(itm, program, interfaces)
        }
    }
    program.temps = l.temp_count
    program
}

fun fun_info(f: &FunDecl) -> FunInfo {
    FunInfo { name: f.name.clone(), params: f.params.clone(), generics: f.generics.len(), builtin: is_builtin_body(f) }
}

/// A std function implemented by the runtime: its body is just `_builtin()`.
fun is_builtin_body(f: &FunDecl) -> bool {
    let Some(b) = &f.body else { return false }
    if b.stmts.len() != 1 {
        return false
    }
    let ExprStmt(es) = &b.stmts[0] else { return false }
    let Call { callee, .. } = &es.expr.kind else { return false }
    match &callee.get().kind {
        Ident(name) => name == "_builtin"
        _ => false
    }
}

fun is_float_type(t: &Type) -> bool {
    match &t.kind {
        TName { path, .. } => path.len() == 1 && (path[0] == "f64" || path[0] == "f32")
        _ => false
    }
}

fun is_option_type(t: &Type) -> bool {
    match &t.kind {
        TOption(_) => true
        TName { path, .. } => path.len() == 1 && path[0] == "Option"
        _ => false
    }
}

fun type_path(t: &Type) -> string {
    match &t.kind {
        TName { path, .. } => path.join(".")
        _ => "?"
    }
}

fun bx(s: Shape?) -> Box[Shape]? {
    match s {
        Some(x) => Some(Box.new(x))
        None => None
    }
}

fun has_float(s: &Shape?) -> bool {
    match s {
        Some(SFloat) => true
        Some(SVec(x)) | Some(SOpt(x)) | Some(SMap(x)) => match x {
            Some(inner) => has_float(Some(inner.get().clone()))
            None => false
        }
        _ => false
    }
}

fun mk(ty: Ty, span: Span, kind: HKind) -> HExpr { HExpr { ty, span, kind } }

fun hblock(stmts: Vec[HStmt], value: HExpr?) -> HBlock {
    HBlock { stmts, value: match value {
        Some(v) => Some(Box.new(v))
        None => None
    } }
}

fun field_e(ty: Ty, span: Span, object: HExpr, name: &str) -> HExpr {
    mk(ty, span, KField { object: Box.new(object), name: name.to_str() })
}

fun lit_e(v: HLit, ty: Ty, span: Span) -> HExpr { mk(ty, span, KLit(v)) }

fun is_place_kind(k: &HKind) -> bool {
    match k {
        KLocal { .. } | KField { .. } | KIndex { .. } | KGlobal(_) => true
        _ => false
    }
}

/// The first `this` node inside a body (stage 0 walks the body's objects for one).
fun this_in_block(b: &Block) -> int? {
    for s in b.stmts.iter() {
        let found = match s {
            Let(l) => match this_in(l.value) {
                Some(x) => Some(x)
                None => match &l.else_branch {
                    Some(eb) => this_in_block(eb)
                    None => None
                }
            }
            ExprStmt(es) => this_in(es.expr)
        }
        if found.is_some() {
            return found
        }
    }
    None
}

fun this_in_opt(e: &Box[Expr]?) -> int? {
    match e {
        Some(x) => this_in(x.get())
        None => None
    }
}

fun this_in_list(es: &Vec[Expr]) -> int? {
    for x in es.iter() {
        if let Some(f) = this_in(x) {
            return Some(f)
        }
    }
    None
}

fun elems_exprs(elems: &Vec[Elem]) -> Vec[Expr] {
    elems.map(#{ el => match el {
        EValue(x) => x.clone()
        ESpread { expr, .. } => expr.clone()
    } })
}

fun items_exprs(items: &Vec[RecordItem]) -> Vec[Expr] {
    var out = [] as Vec[Expr]
    for f in items.iter() {
        match f {
            RField(rf) => {
                if let Some(v) = &rf.value {
                    out.push(v.clone())
                }
            }
            RSpread { expr, .. } => out.push(expr.clone())
        }
    }
    out
}

/// The node id of a `this` inside an expression (any one: they all name the method's receiver).
fun this_in(e: &Expr) -> int? {
    match &e.kind {
        This => Some(e.id)
        Paren(x) | Await(x) | Try(x) => this_in(x.get())
        Unary { expr, .. } | As { expr, .. } => this_in(expr.get())
        Return(v) => this_in_opt(v)
        Break { value, .. } => this_in_opt(value)
        Template(parts) => {
            for p in parts.iter() {
                if let Interp(x) = p {
                    if let Some(f) = this_in(x) {
                        return Some(f)
                    }
                }
            }
            None
        }
        VecLit(elems) | ArrayLit(elems) | TupleLit(elems) | SetLit(elems) => this_in_list(elems_exprs(elems))
        RecordLit(items) | Inferred(items) => this_in_list(items_exprs(items))
        StructLit { ty, fields } => this_in(ty.get()) ?? this_in_list(items_exprs(fields))
        MapLit(entries) => {
            for en in entries.iter() {
                let f = match en {
                    MEntry(me) => this_in(me.key) ?? this_in(me.value)
                    MSpread { expr, .. } => this_in(expr)
                }
                if f.is_some() {
                    return f
                }
            }
            None
        }
        Closure { body, .. } => this_in_block(body)
        Binary { left, right, .. } => this_in(left.get()) ?? this_in(right.get())
        Assign { target, value, .. } => this_in(target.get()) ?? this_in(value.get())
        RangeExpr { start, end, .. } => this_in_opt(start) ?? this_in_opt(end)
        Or { expr, rhs, .. } => this_in(expr.get()) ?? this_in(rhs.get())
        Member { object, .. } | OptMember { object, .. } => this_in(object.get())
        Call { callee, args } => this_in(callee.get()) ?? this_in_list(elems_exprs(args))
        IndexExpr { object, index } => this_in(object.get()) ?? this_in(index.get())
        GenericApply { target, .. } => this_in(target.get())
        If { cond, then, else_branch } => {
            let c = match cond {
                CExpr(x) => this_in(x.get())
                CLet(lc) => this_in(lc.value.get())
            }
            c ?? this_in_block(then) ?? this_in_opt(else_branch)
        }
        Match { subject, arms } => {
            if let Some(f) = this_in_opt(subject) {
                return Some(f)
            }
            for arm in arms.iter() {
                let f = (match &arm.test {
                    Some(t) => this_in(t)
                    None => None
                }) ?? (match &arm.guard {
                    Some(g) => this_in(g)
                    None => None
                }) ?? this_in(arm.body)
                if f.is_some() {
                    return f
                }
            }
            None
        }
        Select { arms, else_branch } => {
            for arm in arms.iter() {
                let f = this_in(arm.expr) ?? this_in(arm.body)
                if f.is_some() {
                    return f
                }
            }
            this_in_opt(else_branch)
        }
        For { expr, body, .. } => this_in_opt(expr) ?? this_in_block(body)
        BlockExpr(b) | Unsafe(b) | Recover(b) => this_in_block(b)
        _ => None
    }
}

impl Lowerer {
    // ---- the declaration index and names ----

    fun index_fun(&mut this, f: &FunDecl) {
        this.index[f.id] = LFunD(fun_info(f))
    }

    fun index_file(&mut this, file: &File) {
        for itm in file.items.iter() {
            match itm {
                Fun(f) => this.index_fun(f)
                Extern(d) => {
                    for f in d.funs.iter() {
                        this.index_fun(f)
                    }
                }
                TypeDef(d) => {
                    if let Struct(b) = &d.body {
                        this.index[d.id] = LStruct { fields: b.fields.clone(), methods: b.methods.map(#{ m => m.name.clone() }) }
                        for m in b.methods.iter() {
                            this.index_fun(m)
                        }
                    }
                }
                Union(d) => {
                    this.index[d.id] = LUnionD(d.variants.clone())
                    for m in d.methods.iter() {
                        this.index_fun(m)
                    }
                }
                Inter(d) => {
                    this.index[d.id] = LInterD
                    for m in (d.methods ?? []).iter() {
                        this.index_fun(m)
                    }
                }
                Impl(d) => {
                    for m in d.methods.iter() {
                        this.index_fun(m)
                    }
                }
                Let(_) => {}
            }
        }
    }

    fun decl_of(&this, sym: int) -> LDecl? {
        let Some(d) = this.syms.get()[sym].decl else { return None }
        this.index.get(d)
    }

    fun struct_fields(&this, sym: int) -> Vec[Field]? {
        match this.decl_of(sym) {
            Some(LStruct { fields, .. }) => Some(fields)
            _ => None
        }
    }

    fun union_variant(&this, sym: int, name: &str) -> Variant? {
        match this.decl_of(sym) {
            Some(LUnionD(vs)) => vs.find(#{ v => v.name == name })
            _ => None
        }
    }

    fun fun_decl(&this, id: int) -> FunInfo? {
        match this.index.get(id) {
            Some(LFunD(f)) => Some(f)
            _ => None
        }
    }

    fun owner_name(&this, owner: &Owner) -> string {
        match owner {
            OName(n) => if n == "auto" { "auto" } else { "std.${n}" }
            OSym(s) => if this.syms.get()[s].std { "std.${this.syms.get()[s].name}" } else { this.syms.get()[s].name.clone() }
        }
    }

    fun name_items(&mut this, file: &File, prefix: &str) {
        for itm in file.items.iter() {
            match itm {
                Fun(f) => { this.fun_names[f.id] = "${prefix}${f.name}" }
                Extern(d) => {
                    for f in d.funs.iter() {
                        this.fun_names[f.id] = "${prefix}${f.name}"
                    }
                }
                TypeDef(d) => {
                    if let Struct(b) = &d.body {
                        for m in b.methods.iter() {
                            this.fun_names[m.id] = "${prefix}${d.name}.${m.name}"
                        }
                    }
                }
                Union(d) => {
                    for m in d.methods.iter() {
                        this.fun_names[m.id] = "${prefix}${d.name}.${m.name}"
                    }
                }
                Inter(d) => {
                    for m in (d.methods ?? []).iter() {
                        this.fun_names[m.id] = "${prefix}${d.name}.${m.name}"
                    }
                }
                Impl(d) => {
                    for m in d.methods.iter() {
                        this.fun_names[m.id] = "${prefix}${type_path(d.target)}.${m.name}"
                    }
                }
                Let(_) => {}
            }
        }
    }

    fun fun_name(&this, decl: int, owner: &Owner?) -> string {
        if let Some(n) = this.fun_names.get(decl) {
            return n
        }
        let name = match this.fun_decl(decl) {
            Some(f) => f.name
            None => "?"
        }
        match owner {
            Some(o) => "${this.owner_name(o)}.${name}"
            None => name
        }
    }

    /// The qualified name of a top-level item (`std.Vec`, `User` in main).
    fun type_name(&this, sym: int) -> string {
        let s = &this.syms.get()[sym]
        if s.std {
            return "std.${s.name}"
        }
        "${package_prefix(s.pkg ?? this.package_name)}${s.name}"
    }

    /// Interfaces each local type implements (`type X: I` and `impl I for X`), for dynamic dispatch.
    fun collect_interfaces(&this, files: &Vec[File]) -> Map[int, Vec[string]] {
        var out = m{} as Map[int, Vec[string]]
        for file in files.iter() {
            for itm in file.items.iter() {
                let t(target, ifaces) = match itm {
                    TypeDef(d) => t(this.tables.get().decls.get(d.id), d.impls.clone())
                    Union(d) => t(this.tables.get().decls.get(d.id), d.impls.clone())
                    Impl(d) => match &d.target.kind {
                        TName { .. } => t(this.tables.get().refs.get(d.target.id), d.interfaces.clone())
                        _ => t(None, [] as Vec[Type])
                    }
                    _ => t(None, [] as Vec[Type])
                }
                let Some(ts) = target else { continue }
                var list = out.get(ts) ?? []
                for itf in ifaces.iter() {
                    if let TName { .. } = &itf.kind {
                        if let Some(s) = this.tables.get().refs.get(itf.id) {
                            list.push(this.type_name(s))
                        }
                    }
                }
                out[ts] = list
            }
        }
        out
    }

    // ---- helpers ----

    fun prune(&this, t: &Ty) -> Ty { prune_ty(t, this.vars.get()) }
    fun strip(&this, t: &Ty) -> Ty { strip_ty(t, this.vars.get()) }

    fun ty(&this, id: int) -> Ty { this.prune(this.types.get(id) ?? unknown()) }

    fun display(&this, sym: int) -> string {
        let s = &this.syms.get()[sym]
        if s.name == "it1" { "it" } else if s.kind == "this" { "this" } else { s.name.clone() }
    }

    fun temp(&mut this, name: &str, ty: Ty) -> HLocal {
        this.temp_count += 1
        HLocal { sym: -this.temp_count, name: "$${name}", ty, mutable: false }
    }

    fun local_of(&this, sym: int) -> HLocal {
        HLocal { sym, name: this.display(sym), ty: this.prune(this.sym_types.get(sym) ?? unknown()), mutable: this.syms.get()[sym].mutable }
    }

    fun refl(&this, l: &HLocal, span: Span) -> HExpr { mk(l.ty.clone(), span, KLocal { sym: l.sym, name: l.name.clone() }) }

    fun sym_ref(&this, sym: int, ty: Ty, span: Span) -> HExpr { mk(ty, span, KLocal { sym, name: this.display(sym) }) }

    fun unsupported(&this, what: string, span: Span, ty: Ty) -> HExpr { mk(ty, span, KUnsupported(what)) }

    fun block_expr(&this, b: HBlock, ty: Ty, span: Span) -> HExpr {
        if b.stmts.is_empty() {
            if let Some(v) = &b.value {
                return v.get().clone()
            }
        }
        mk(ty, span, KBlock(b))
    }

    fun variant_e(&this, owner: int, variant: &str, fields: Vec[HExpr], ty: Ty, span: Span) -> HExpr {
        mk(ty, span, KVariant { union_name: this.type_name(owner), variant: variant.to_str(), fields })
    }

    fun option_sym(&this) -> int { this.prelude_names.get("Option") ?? -1 }

    fun option_kind(&this, t: &Ty) -> string {
        let s = this.strip(t)
        let sym = named_sym(s)
        if sym < 0 || !this.syms.get()[sym].std {
            return ""
        }
        if this.syms.get()[sym].name == "Option" { "option" } else if this.syms.get()[sym].name == "Result" { "result" } else { "" }
    }

    fun is_big(&this, t: &Ty) -> bool {
        let s = this.strip(t)
        is_prim(s, "i64") || is_prim(s, "u64")
    }

    /// A record or tuple made only of Copy values (numbers, bools, chars, literals, nested such): its
    /// fields can be assigned, so storing it elsewhere must copy it.
    fun is_copy_aggregate(&this, t: &Ty, depth: int) -> bool {
        let s = this.strip(t)
        let k = tag(s)
        if depth > 0 && ((k == "prim" && !is_stringy(s)) || k == "lit" || k == "union") {
            return true
        }
        if depth > 8 {
            return false
        }
        match s {
            TyRecord(fields) => !fields.is_empty() && fields.all(#{ f => this.is_copy_aggregate(f.ty, depth + 1) })
            TyTuple(elems) => elems.all(#{ x => this.is_copy_aggregate(x, depth + 1) })
            _ => false
        }
    }

    /// Coerces a value to the type it flows into: the only coercion with a runtime effect on JS is int → i64 / u64.
    fun coerce(&mut this, e: HExpr, to: Ty?, store: bool) -> HExpr {
        let Some(to_ty) = to else { return e }
        let target = this.strip(to_ty)
        let from = this.strip(e.ty)
        // a Copy record / tuple read from a place and stored elsewhere is a copy (not for `&T`)
        if store && is_place_kind(e.kind) && this.is_copy_aggregate(from, 0) && tag(pruned(to_ty, this.vars.get())) != "ref" {
            let ty = e.ty.clone()
            let span = e.span
            return mk(ty, span, KCopy(Box.new(e)))
        }
        if this.is_big(target) && is_int(from) && !this.is_big(from) {
            if let KLit(LBig(_)) = &e.kind {
                return HExpr { ty: target, span: e.span, kind: e.kind }
            }
            let span = e.span
            return mk(target, span, KWiden(Box.new(e)))
        }
        // a float given as an interface (`&Stringer`): convert it while its type is known (`2.0`, not `2`)
        let tsym = named_sym(target)
        if tsym >= 0 && this.float_shape(from).is_some() && this.syms.get()[tsym].name == "Stringer" {
            if let Some(LInterD) = this.decl_of(tsym) {
                return this.to_str(e)
            }
        }
        if let TyRecord(ffields) = &from {
            if tsym >= 0 {
                if let Some(dfields) = this.struct_fields(tsym) {
                    if let KRecord(given) = &e.kind {
                        return this.struct_from_fields(tsym, dfields, given.clone(), None, e.span, target)
                    }
                    // a record value (not a literal): copy its fields into the struct (spec §7.4)
                    let span = e.span
                    let tmp = this.temp("rec", e.ty.clone())
                    var given = [] as Vec[HField]
                    for f in ffields.iter() {
                        given.push(HField { name: f.name.clone(), value: field_e(f.ty.clone(), span, this.refl(tmp, span), f.name) })
                    }
                    let value = this.struct_from_fields(tsym, dfields, given, None, span, target.clone())
                    return this.block_expr(hblock([HLet { local: tmp, value: e }], Some(value)), target, span)
                }
            }
        }
        e
    }

    fun truthy(&this, e: HExpr) -> HExpr {
        let of = this.option_kind(e.ty)
        if of == "" {
            return e
        }
        let span = e.span
        mk(prim("bool"), span, KTruthy { expr: Box.new(e), of })
    }

    fun to_str(&this, e: HExpr) -> HExpr {
        if is_stringy(this.strip(e.ty)) {
            return e
        }
        let shape = match this.float_shape(e.ty) {
            Some(SFloat) => None
            other => other
        }
        let span = e.span
        mk(prim("string"), span, KToStr { expr: Box.new(e), shape })
    }

    // ---- shapes ----

    /// The shape of a field's type (None: plain data needs no conversion).
    fun ast_shape(&this, t: &Type) -> Shape? {
        match &t.kind {
            TOption(inner) => return Some(SOpt(bx(this.ast_shape(inner.get()))))
            TRef { inner, .. } => return this.ast_shape(inner.get())
            TName { .. } => {}
            _ => return None
        }
        let TName { path, args } = &t.kind else { return None }
        var found = this.tables.get().refs.get(t.id)
        // `json.Value`: a type of an imported package (as the checker's `to_ty` finds it)
        if let Some(first) = found {
            if path.len() > 1 && this.syms.get()[first].kind == "package" {
                var k = 1
                for k < path.len() {
                    found = match found {
                        Some(c) => match this.syms.get()[c].target {
                            Some(scope) => match this.pkg_names.get(scope) {
                                Some(names) => names.get(path[k])
                                None => None
                            }
                            None => None
                        }
                        None => None
                    }
                    k += 1
                }
            }
        }
        let Some(sym) = found else { return None }
        let s = &this.syms.get()[sym]
        let arg = #{ i: int => match args.get(i) {
            Some(x) => this.ast_shape(x)
            None => None
        } }
        if s.std && (s.name == "Vec" || s.name == "Slice" || s.name == "Array") {
            return Some(SVec(bx(arg(0))))
        }
        if s.std && s.name == "Option" {
            return Some(SOpt(bx(arg(0))))
        }
        if s.std && s.name == "Map" {
            return Some(SMap(bx(arg(1))))
        }
        if s.kind == "type" || s.kind == "union" {
            return Some(SStruct(this.type_name(sym)))
        }
        if s.kind == "builtin-type" {
            if s.name == "f32" || s.name == "f64" {
                return Some(SFloat)
            }
            if s.name == "i64" || s.name == "u64" {
                return Some(SI64)
            }
            return Some(SPrim(s.name.clone()))
        }
        None
    }

    fun ty_shape(&this, t: &Ty) -> Shape? {
        let s = this.strip(t)
        match &s {
            TyParam(p) => return Some(SParam(p))
            TyPrim(n) => {
                if is_float(s) {
                    return Some(SFloat)
                }
                return Some(if n == "i64" || n == "u64" { SI64 } else { SPrim(n.clone()) })
            }
            TyNamed { sym, args } => {
                let arg = #{ i: int => match args.get(i) {
                    Some(x) => this.ty_shape(x)
                    None => None
                } }
                let st = this.syms.get()[sym].std
                let name = this.syms.get()[sym].name.clone()
                if st && (name == "Vec" || name == "Slice" || name == "Array") {
                    return Some(SVec(bx(arg(0))))
                }
                if st && name == "Option" {
                    return Some(SOpt(bx(arg(0))))
                }
                if st && name == "Map" {
                    return Some(SMap(bx(arg(1))))
                }
                Some(SStruct(this.type_name(sym)))
            }
            _ => None
        }
    }

    /// The shape of a type with floats in it (a float, or floats in Vec / Option / Map), else None.
    fun float_shape(&this, t: &Ty) -> Shape? {
        let shape = this.ty_shape(t)
        if has_float(shape) { shape } else { None }
    }

    // ---- items ----

    fun field_defs(&mut this, fields: &Vec[Field], with_defaults: bool) -> Vec[FieldDef] {
        var out = [] as Vec[FieldDef]
        for f in fields.iter() {
            let shape = this.ast_shape(f.ty)
            var default: HExpr? = None
            if with_defaults {
                if let Some(d) = &f.default {
                    default = Some(this.expr(d))
                }
            }
            out.push(FieldDef { name: f.name.clone(), optional: is_option_type(f.ty), float: is_float_type(f.ty), shape, default })
        }
        out
    }

    fun lower_item(&mut this, itm: &Item, p: &mut Program, interfaces: &Map[int, Vec[string]]) {
        match itm {
            Fun(f) => p.funs.push(this.lower_fun(f, [])),
            Extern(d) => {
                for f in d.funs.iter() {
                    var params = [] as Vec[HLocal]
                    for x in f.params.iter() {
                        if let Some(s) = this.tables.get().decls.get(x.id) {
                            params.push(this.local_of(s))
                        }
                    }
                    p.funs.push(HFun { name: this.fun_name(f.id, None), params, recv: None, ret: this.ret_ty(f), is_async: f.is_async, body: None, abi: Some(d.abi.clone()), file: None, span: f.span })
                }
            }
            Let(d) => {
                let ty = match this.tables.get().decls.get(d.id) {
                    Some(sym) => this.prune(this.sym_types.get(sym) ?? unknown())
                    None => unknown()
                }
                this.ret = unknown()
                let raw = this.expr(d.value)
                let value = this.coerce(raw, Some(ty.clone()), true)
                p.globals.push(HGlobal { name: "${package_prefix(this.package_name)}${d.name}", ty, value })
            }
            TypeDef(d) => {
                let Struct(b) = &d.body else { return }
                let sym = this.tables.get().decls.get(d.id)
                let ifaces = match sym {
                    Some(s) => interfaces.get(s) ?? []
                    None => []
                }
                let name = match sym {
                    Some(s) => this.type_name(s)
                    None => d.name.clone()
                }
                let fields = this.field_defs(b.fields, true)
                p.types.push(TDStruct { name, fields, interfaces: ifaces })
                for m in b.methods.iter() {
                    p.funs.push(this.lower_fun(m, d.generics))
                }
            }
            Union(d) => {
                let sym = this.tables.get().decls.get(d.id)
                let name = match sym {
                    Some(s) => this.type_name(s)
                    None => d.name.clone()
                }
                let ifaces = match sym {
                    Some(s) => interfaces.get(s) ?? []
                    None => []
                }
                var variants = [] as Vec[VariantDef]
                for v in d.variants.iter() {
                    let fields = match &v.fields {
                        Some(fs) => this.field_defs(fs, false)
                        None => {
                            var out = [] as Vec[FieldDef]
                            var i = 0
                            for t in (v.tuple ?? []).iter() {
                                out.push(FieldDef { name: "${i}", optional: false, float: is_float_type(t), shape: None, default: None })
                                i += 1
                            }
                            out
                        }
                    }
                    variants.push(VariantDef { name: v.name.clone(), fields, positional: v.fields.is_none() })
                }
                p.types.push(TDUnion { name, variants, interfaces: ifaces })
                for m in d.methods.iter() {
                    p.funs.push(this.lower_fun(m, d.generics))
                }
            }
            Inter(d) => {
                let methods = d.methods ?? []
                p.types.push(TDInter { name: d.name.clone(), methods: methods.map(#{ m => m.name.clone() }) })
                for m in methods.iter() {
                    if m.body.is_some() {
                        p.funs.push(this.lower_fun(m, d.generics))
                    }
                }
            }
            Impl(d) => {
                for m in d.methods.iter() {
                    p.funs.push(this.lower_fun(m, d.generics))
                }
            }
        }
    }

    fun ret_ty(&this, f: &FunDecl) -> Ty {
        if f.ret.is_none() {
            return void_ty()
        }
        this.prune(this.tables.get().rets.get(f.id) ?? unknown())
    }

    fun lower_fun(&mut this, f: &FunDecl, outer: &Vec[GenericParam]) -> HFun {
        var generics = [] as Vec[int]
        for g in outer.iter() {
            if let Some(s) = this.tables.get().decls.get(g.id) {
                generics.push(s)
            }
        }
        for g in f.generics.iter() {
            if let Some(s) = this.tables.get().decls.get(g.id) {
                generics.push(s)
            }
        }
        var params = [] as Vec[HLocal]
        for p in f.params.iter() {
            if let Some(s) = this.tables.get().decls.get(p.id) {
                params.push(this.local_of(s))
            }
        }
        var this_sym: int? = None
        if let Some(b) = &f.body {
            if let Some(id) = this_in_block(b) {
                if let Some(s) = this.tables.get().refs.get(id) {
                    if this.syms.get()[s].kind == "this" {
                        this_sym = Some(s)
                    }
                }
            }
        }
        let recv = match f.receiver {
            None => None
            Some(_) => match this_sym {
                Some(s) => Some(this.local_of(s))
                None => Some(this.temp("this", unknown()))
            }
        }
        let ret = this.ret_ty(f)
        this.ret = ret.clone()
        let body = match &f.body {
            Some(b) => Some(this.body(b, ret.clone()))
            None => None
        }
        HFun {
            name: this.fun_name(f.id, None), params, recv, ret, is_async: f.is_async, body, abi: None, span: f.span,
            builtin: is_builtin_body(f), generics, file: this.current_file.clone(),
        }
    }

    /// A function or closure body: the tail value is coerced to the result type.
    fun body(&mut this, b: &Block, ret: Ty) -> HBlock {
        var out = this.stmts(b.stmts)
        if let Some(v) = &out.value {
            let value = v.get().clone()
            out.value = Some(Box.new(this.coerce(value, Some(ret), true)))
        }
        out
    }

    // ---- statements ----

    fun stmts(&mut this, stmts: &Vec[Stmt]) -> HBlock {
        var out = [] as Vec[HStmt]
        var value: HExpr? = None
        var i = 0
        for s in stmts.iter() {
            let last = i == stmts.len() - 1
            i += 1
            match s {
                ExprStmt(es) => {
                    let e = this.expr(es.expr)
                    if last && !es.semi {
                        value = Some(e)
                    } else {
                        out.push(HDo(e))
                    }
                }
                Let(l) => this.let_stmt(l, out)
            }
        }
        hblock(out, value)
    }

    fun let_stmt(&mut this, s: &LetStmt, out: &mut Vec[HStmt]) {
        var target: Ty? = None
        if let PBind { .. } = &s.pattern.kind {
            if let Some(sym) = this.tables.get().decls.get(s.pattern.id) {
                target = this.sym_types.get(sym)
            }
        }
        let raw = this.expr(s.value)
        let value = this.coerce(raw, target, true)
        if let Some(eb) = &s.else_branch {
            return this.let_else(s, eb, value, out)
        }
        this.destructure(s.pattern, value, out)
    }

    /// Irrefutable destructuring: one `let` per binding (through a temporary).
    fun destructure(&mut this, p: &Pattern, value: HExpr, out: &mut Vec[HStmt]) {
        match &p.kind {
            PBind { .. } => {
                if let Some(sym) = this.tables.get().decls.get(p.id) {
                    out.push(HLet { local: this.local_of(sym), value })
                }
            }
            PWild => out.push(HDo(value))
            _ => {
                let tmp = this.temp("v", value.ty.clone())
                out.push(HLet { local: tmp.clone(), value })
                var paths = [] as Vec[t(int, Vec[string])]
                this.paths(p, [], paths)
                for entry in paths.iter() {
                    let t(sym, path) = entry
                    var e = this.refl(tmp, p.span)
                    for step in path.iter() {
                        e = field_e(unknown(), p.span, e, step)
                    }
                    let local = this.local_of(sym)
                    e.ty = local.ty.clone()
                    out.push(HLet { local, value: e })
                }
            }
        }
    }

    /// Each binding of an irrefutable pattern, with its field path (`t(a, r{ b })` → a: ["0"], b: ["1", "b"]).
    fun paths(&this, p: &Pattern, path: Vec[string], out: &mut Vec[t(int, Vec[string])]) {
        match &p.kind {
            PBind { .. } => {
                if let Some(s) = this.tables.get().decls.get(p.id) {
                    out.push(t(s, path))
                }
            }
            PTuple { elems, .. } => {
                var i = 0
                for x in elems.iter() {
                    var next = path.clone()
                    next.push("${i}")
                    this.paths(x, next, out)
                    i += 1
                }
            }
            PStruct { fields, .. } => {
                for f in fields.iter() {
                    var next = path.clone()
                    next.push(f.name.clone())
                    match &f.pattern {
                        Some(fp) => this.paths(fp, next, out)
                        None => {
                            if let Some(s) = this.tables.get().decls.get(f.id) {
                                out.push(t(s, next))
                            }
                        }
                    }
                }
            }
            PCall { args, .. } => {
                var i = 0
                for x in args.iter() {
                    var next = path.clone()
                    next.push("${i}")
                    this.paths(x, next, out)
                    i += 1
                }
            }
            _ => {}
        }
    }

    /// `let P = e else { … }` → `let $t = match e { P => t(bindings…), _ => else }`, then the bindings.
    fun let_else(&mut this, s: &LetStmt, eb: &Block, value: HExpr, out: &mut Vec[HStmt]) {
        var binds = [] as Vec[int]
        this.bindings_of(s.pattern, binds)
        let pattern = this.pattern(s.pattern, value.ty)
        let else_block = this.stmts(eb.stmts)
        let else_expr = this.block_expr(else_block, TyNever, eb.span)
        if binds.len() == 1 {
            let local = this.local_of(binds[0])
            let body = this.refl(local, s.span)
            let m = mk(local.ty.clone(), s.span, KMatch { subject: Box.new(value), arms: [
                HArm { pattern, guard: None, body },
                HArm { pattern: QWild, guard: None, body: else_expr },
            ] })
            out.push(HLet { local, value: m })
            return
        }
        let tuple_ty: Ty = TyTuple(binds.map(#{ b => this.local_of(b).ty }))
        let tmp = this.temp("v", tuple_ty.clone())
        let tuple = mk(tuple_ty.clone(), s.span, KTuple(binds.map(#{ b => this.refl(this.local_of(b), s.span) })))
        out.push(HLet { local: tmp.clone(), value: mk(tuple_ty, s.span, KMatch { subject: Box.new(value), arms: [
            HArm { pattern, guard: None, body: tuple },
            HArm { pattern: QWild, guard: None, body: else_expr },
        ] }) })
        var i = 0
        for b in binds.iter() {
            let local = this.local_of(b)
            let v = field_e(local.ty.clone(), s.span, this.refl(tmp, s.span), "${i}")
            out.push(HLet { local, value: v })
            i += 1
        }
    }

    fun add_binding(&this, id: int, out: &mut Vec[int]) {
        if let Some(s) = this.tables.get().decls.get(id) {
            if !out.contains(s) {
                out.push(s)
            }
        }
    }

    fun bindings_of(&this, p: &Pattern, out: &mut Vec[int]) {
        match &p.kind {
            PBind { .. } => this.add_binding(p.id, out)
            PCall { args, .. } => {
                for a in args.iter() {
                    this.bindings_of(a, out)
                }
            }
            PStruct { fields, .. } => {
                for f in fields.iter() {
                    match &f.pattern {
                        Some(fp) => this.bindings_of(fp, out)
                        None => this.add_binding(f.id, out)
                    }
                }
            }
            PTuple { elems, .. } => {
                for x in elems.iter() {
                    this.bindings_of(x, out)
                }
            }
            POr(alts) => {
                if let Some(first) = alts.get(0) {
                    this.bindings_of(first, out)
                }
            }
            _ => {}
        }
    }

    // ---- patterns ----

    fun pat_lit(&this, e: &Expr) -> HLit {
        match &e.kind {
            Int(v) => LBig(v.clone())
            Float(x) => LNum(x)
            Str { value, .. } => LStr(value.clone())
            Char(c) => LStr(c.clone())
            Bool(b) => LBool(b)
            Unary { expr, .. } => match this.pat_lit(expr.get()) {
                LBig(d) => LBig(dec_neg(d))
                LNum(x) => LNum(-x)
                other => other
            }
            _ => LUnit
        }
    }

    fun pattern(&mut this, p: &Pattern, ty: &Ty) -> HPat {
        let t = this.strip(ty)
        match &p.kind {
            PWild | PError => QWild
            PBind { .. } => match this.tables.get().decls.get(p.id) {
                Some(s) => QBind(this.local_of(s))
                None => QWild
            }
            PLit(v) => {
                if let Nil = &v.get().kind {
                    return QVariant { union_name: "std.Option", variant: "None", fields: [] }
                }
                QLit(this.pat_lit(v.get()))
            }
            PRange { op, start, end } => {
                let s = match start {
                    Some(x) => Some(this.pat_lit(x.get()))
                    None => None
                }
                let e = match end {
                    Some(x) => Some(this.pat_lit(x.get()))
                    None => None
                }
                QRange { start: s, end: e, inclusive: op == "..=" }
            }
            POr(alts) => {
                var out = [] as Vec[HPat]
                for x in alts.iter() {
                    out.push(this.pattern(x, ty))
                }
                QOr(out)
            }
            PTuple { elems, .. } => {
                let tys = match &t {
                    TyTuple(ts) => Some(ts.clone())
                    _ => None
                }
                let n = match &tys {
                    Some(ts) => ts.len()
                    None => elems.len()
                }
                var out = [] as Vec[HPat]
                var i = 0
                for x in elems.iter() {
                    let et = match &tys {
                        Some(ts) => ts.get(i) ?? unknown()
                        None => unknown()
                    }
                    out.push(this.pattern(x, et))
                    i += 1
                }
                for out.len() < n {
                    out.push(QWild)
                }
                QTuple(out)
            }
            PPath(_) | PCall { .. } | PStruct { .. } => this.constructor_pattern(p)
        }
    }

    fun constructor_pattern(&mut this, p: &Pattern) -> HPat {
        if let Some(v) = this.tables.get().variants.get(p.id) {
            return this.variant_pattern(p, v)
        }
        // no checker info (the value's type is unknown): name the variant directly
        let sym = this.tables.get().refs.get(p.id)
        if let Some(s) = sym {
            if this.syms.get()[s].kind == "variant" {
                if let Some(o) = this.syms.get()[s].owner {
                    return this.variant_pattern(p, r{ owner: o, variant: this.syms.get()[s].name.clone() })
                }
            }
        }
        let path_kind = match &p.kind {
            PPath(path) => Some(t(path.clone(), [] as Vec[Pattern]))
            PCall { path, args, .. } => Some(t(path.clone(), args.clone()))
            _ => None
        }
        if let Some(pk) = path_kind {
            let t(path, args) = pk
            var fields = [] as Vec[HPat]
            if path.len() == 1 && (sym.is_none() || this.syms.get()[sym ?? 0].kind == "union") {
                for x in args.iter() {
                    fields.push(this.pattern(x, unknown()))
                }
                return QVariant { union_name: "?", variant: path[0].clone(), fields }
            }
            if path.len() >= 2 {
                for x in args.iter() {
                    fields.push(this.pattern(x, unknown()))
                }
                return QVariant { union_name: path.take(path.len() - 1).join("."), variant: path[path.len() - 1].clone(), fields }
            }
        }
        if let PStruct { fields, .. } = &p.kind {
            var out = [] as Vec[HPatField]
            for f in fields.iter() {
                let pat = match &f.pattern {
                    Some(fp) => this.pattern(fp, unknown())
                    None => match this.tables.get().decls.get(f.id) {
                        Some(s) => QBind(this.local_of(s))
                        None => QWild
                    }
                }
                out.push(HPatField { name: f.name.clone(), pattern: pat })
            }
            return QFields(out)
        }
        QWild
    }

    fun variant_pattern(&mut this, p: &Pattern, v: VariantRef) -> HPat {
        let vdecl = this.union_variant(v.owner, v.variant)
        let union_name = this.type_name(v.owner)
        match &p.kind {
            PCall { args, .. } => {
                let n = match &vdecl {
                    Some(vd) => match &vd.tuple {
                        Some(ts) => ts.len()
                        None => args.len()
                    }
                    None => args.len()
                }
                var fields = [] as Vec[HPat]
                for x in args.iter() {
                    fields.push(this.pattern(x, unknown()))
                }
                for fields.len() < n {
                    fields.push(QWild)
                }
                QVariant { union_name, variant: v.variant.clone(), fields }
            }
            PStruct { fields: given, .. } => {
                let names = match &vdecl {
                    Some(vd) => match &vd.fields {
                        Some(fs) => fs.map(#{ f => f.name.clone() })
                        None => given.map(#{ f => f.name.clone() })
                    }
                    None => given.map(#{ f => f.name.clone() })
                }
                var fields = [] as Vec[HPat]
                for name in names.iter() {
                    let Some(f) = given.find(#{ x => x.name == name }) else {
                        fields.push(QWild)
                        continue
                    }
                    fields.push(match &f.pattern {
                        Some(fp) => this.pattern(fp, unknown())
                        None => match this.tables.get().decls.get(f.id) {
                            Some(s) => QBind(this.local_of(s))
                            None => QWild
                        }
                    })
                }
                QVariant { union_name, variant: v.variant.clone(), fields }
            }
            _ => QVariant { union_name, variant: v.variant.clone(), fields: [] }
        }
    }
}
