// Types for the checker (spec §7, §9.5), ported from minscript/src/types.ts.
//
// `TyUnknown` is the gradual type: it comes from std packages without signatures yet and from earlier
// errors. It is compatible with everything and never produces a diagnostic.
//
// Borrows (`&T`, `&mut T`) are kept in types but are transparent for compatibility; whether a borrow
// is valid is the ownership pass's job.
//
// Stage 0's inference variables are mutable objects shared by every type that mentions them; here a
// variable is an index (`TyVar(id)`) into the checker's arena of `VarState`s, so every function that
// follows variables (prune, show, subst…) takes the arena.
package check

import "app.lexer.{json_quote}"
import "app.resolve.{Sym}"

pub union Ty = {
    /// "i8" … "u64", "isize", "usize", "int", "f32", "f64", "bool", "char", "string", "str", "void"
    TyPrim(string)
    TyNever
    TyUnknown
    /// struct, union, interface (including the prelude's Vec, Option…): the type's symbol
    TyNamed { sym: int, args: Vec[Ty] }
    /// a generic parameter, inside its declaration
    TyParam(int)
    /// an inference variable: an index into the checker's `vars`
    TyVar(int)
    /// never empty: `t()` is void
    TyTuple(Vec[Ty])
    /// sorted by name
    TyRecord(Vec[FieldTy])
    TyFn { params: Vec[Ty], ret: Box[Ty], is_async: bool }
    TyRef { is_mut: bool, inner: Box[Ty] }
    TyPtr { is_mut: bool, inner: Box[Ty] }
    /// a literal type: `"Admin"`, `404`
    TyLit(LitVal)
    /// a literal union: `"A" | "B"`
    TyUnion(Vec[Ty])
    /// a type used as a value: `User.new`, `Payment.Cash`
    TyMeta(Box[Ty])
    /// an imported package used as a value: `json`
    TyPackage { name: string, sym: int? }
}

/// The value of a literal type (stage 0: string | bigint | boolean); integers are decimal strings.
pub union LitVal = {
    LStr(string)
    LInt(string)
    LBool(bool)
}

pub type FieldTy = { pub name: string, pub ty: Ty, pub optional: bool }

/// An inference variable: what it is bound to, and whether it stands for a numeric literal
/// ("int" / "float"), which defaults to `int` / `f64` (spec §1.5).
pub type VarState = { pub bound: Ty?, pub lit: string? }

pub fun unknown() -> Ty { TyUnknown }
pub fun prim(name: &str) -> Ty { TyPrim(name.to_str()) }
pub fun void_ty() -> Ty { TyPrim("void") }

pub fun int_type(name: &str) -> bool {
    match name {
        "i8" | "i16" | "i32" | "i64" | "u8" | "u16" | "u32" | "u64" | "isize" | "usize" | "int" => true
        _ => false
    }
}

pub fun is_int(t: &Ty) -> bool {
    match t {
        TyPrim(n) => int_type(n)
        _ => false
    }
}

pub fun is_float(t: &Ty) -> bool {
    match t {
        TyPrim(n) => n == "f32" || n == "f64"
        _ => false
    }
}

pub fun is_numeric(t: &Ty) -> bool { is_int(t) || is_float(t) }

pub fun is_stringy(t: &Ty) -> bool {
    match t {
        TyPrim(n) => n == "string" || n == "str"
        _ => false
    }
}

pub fun is_prim(t: &Ty, name: &str) -> bool {
    match t {
        TyPrim(n) => n == name
        _ => false
    }
}

/// The inference variable `t` is, or -1.
pub fun var_of(t: &Ty) -> int {
    match t {
        TyVar(id) => id
        _ => -1
    }
}

/// The range of each integer type, for literals (spec §1.5), as decimal strings.
pub fun int_range(name: &str) -> t(string, string)? {
    match name {
        "i8" => Some(t("-128", "127"))
        "i16" => Some(t("-32768", "32767"))
        "i32" => Some(t("-2147483648", "2147483647"))
        "i64" | "isize" | "int" => Some(t("-9223372036854775808", "9223372036854775807"))
        "u8" => Some(t("0", "255"))
        "u16" => Some(t("0", "65535"))
        "u32" => Some(t("0", "4294967295"))
        "u64" | "usize" => Some(t("0", "18446744073709551615"))
        _ => None
    }
}

/// Compares two magnitudes written in decimal (no sign): -1, 0 or 1.
fun mag_cmp(a: &str, b: &str) -> int {
    var i = 0
    for i < a.len() - 1 && a.byte_at(i) == 48 {
        i += 1
    }
    var j = 0
    for j < b.len() - 1 && b.byte_at(j) == 48 {
        j += 1
    }
    let x = a.substring(i, a.len())
    let y = b.substring(j, b.len())
    if x.len() != y.len() {
        return if x.len() < y.len() { -1 } else { 1 }
    }
    var k = 0
    for k < x.len() {
        let c = x.byte_at(k)
        let d = y.byte_at(k)
        if c != d {
            return if c < d { -1 } else { 1 }
        }
        k += 1
    }
    0
}

/// Compares two signed decimal integers: -1, 0 or 1.
pub fun dec_cmp(a: &str, b: &str) -> int {
    let an = a.starts_with("-")
    let bn = b.starts_with("-")
    if an != bn {
        return if an { -1 } else { 1 }
    }
    let c = mag_cmp(if an { a.substring(1, a.len()) } else { a }, if bn { b.substring(1, b.len()) } else { b })
    if an { -c } else { c }
}

/// `-v` for a decimal integer (BigInt semantics: `-0` is `0`).
pub fun dec_neg(v: &str) -> string {
    if v.starts_with("-") {
        return v.substring(1, v.len()).to_str()
    }
    if mag_cmp(v, "0") == 0 { v.to_str() } else { "-${v}" }
}

fun bits(name: &str) -> int {
    match name {
        "i8" | "u8" => 8
        "i16" | "u16" => 16
        "i32" | "u32" => 32
        "i64" | "u64" => 64
        _ => 0
    }
}

/// Implicit lossless widening (spec §9.5): `from` converts to `to` without `as`.
pub fun widens(from: &str, to: &str) -> bool {
    if from == to {
        return true
    }
    if from == "int" {
        return to == "i64"
    }
    if to == "f64" {
        return match from {
            "i32" | "u32" | "f32" | "i16" | "i8" | "u16" | "u8" => true
            _ => false
        }
    }
    let a = bits(from)
    let b = bits(to)
    if a == 0 || b == 0 {
        return false
    }
    let sf = from.starts_with("i")
    let st = to.starts_with("i")
    if sf == st {
        return b > a
    }
    !sf && st && b >= 2 * a        // uN → i(2N)
}

/// Follows bound inference variables.
pub fun prune_ty(t: &Ty, vars: &Vec[VarState]) -> Ty {
    var cur = t.clone()
    for {
        let id = var_of(cur)
        if id < 0 {
            return cur
        }
        match &vars[id].bound {
            Some(b) => cur = b.clone()
            None => return cur
        }
    }
}

/// Removes borrows: `&mut &T` → `T`.
pub fun strip_ty(t: &Ty, vars: &Vec[VarState]) -> Ty {
    var cur = prune_ty(t, vars)
    for {
        let next = match &cur {
            TyRef { inner, .. } => prune_ty(inner.get(), vars)
            _ => return cur
        }
        cur = next
    }
}

fun show_list(ts: &Vec[Ty], vars: &Vec[VarState], syms: &Vec[Sym]) -> string {
    ts.map(#{ x, _ => show_ty(x, vars, syms) }).join(", ")
}

pub fun show_lit(v: &LitVal) -> string {
    match v {
        LStr(s) => json_quote(s)
        LInt(d) => d.clone()
        LBool(b) => if b { "true" } else { "false" }
    }
}

pub fun show_ty(t: &Ty, vars: &Vec[VarState], syms: &Vec[Sym]) -> string {
    let p = prune_ty(t, vars)
    match p {
        TyPrim(n) => n
        TyNever => "never"
        TyUnknown => "unknown"
        TyNamed { sym, args } => {
            let s = &syms[sym]
            if s.name == "Option" && s.std && args.len() == 1 {
                return "${show_ty(args[0], vars, syms)}?"
            }
            if args.is_empty() { s.name.clone() } else { "${s.name}[${show_list(args, vars, syms)}]" }
        }
        TyParam(sym) => syms[sym].name.clone()
        TyVar(id) => match vars[id].lit {
            Some(l) => if l == "int" { "{integer}" } else { "{float}" }
            None => "_"
        }
        TyTuple(elems) => "t(${show_list(elems, vars, syms)})"
        TyRecord(fields) => "r{ ${fields.map(#{ f, _ => "${f.name}: ${show_ty(f.ty, vars, syms)}" }).join(", ")} }"
        TyFn { params, ret, .. } => "(${show_list(params, vars, syms)}) -> ${show_ty(ret.get(), vars, syms)}"
        TyRef { is_mut, inner } => "&${if is_mut { "mut " } else { "" }}${show_ty(inner.get(), vars, syms)}"
        TyPtr { is_mut, inner } => "*${if is_mut { "mut " } else { "" }}${show_ty(inner.get(), vars, syms)}"
        TyLit(v) => show_lit(v)
        TyUnion(members) => members.map(#{ m, _ => show_ty(m, vars, syms) }).join(" | ")
        TyMeta(inner) => "type ${show_ty(inner.get(), vars, syms)}"
        TyPackage { name, .. } => "package ${name}"
    }
}

/// Substitutes generic parameters (`env`: generic symbol → type).
pub fun subst_ty(t: &Ty, env: &Map[int, Ty], vars: &Vec[VarState]) -> Ty {
    if env.is_empty() {
        return t.clone()
    }
    let p = prune_ty(t, vars)
    match p {
        TyParam(sym) => env.get(sym) ?? TyParam(sym)
        TyNamed { sym, args } => {
            if args.is_empty() {
                return TyNamed { sym, args }
            }
            TyNamed { sym, args: args.map(#{ a, _ => subst_ty(a, env, vars) }) }
        }
        TyTuple(elems) => TyTuple(elems.map(#{ e, _ => subst_ty(e, env, vars) }))
        TyRecord(fields) => TyRecord(fields.map(#{ f, _ => FieldTy { name: f.name.clone(), ty: subst_ty(f.ty, env, vars), optional: f.optional } }))
        TyFn { params, ret, is_async } => TyFn { params: params.map(#{ x, _ => subst_ty(x, env, vars) }), ret: Box.new(subst_ty(ret.get(), env, vars)), is_async }
        TyRef { is_mut, inner } => TyRef { is_mut, inner: Box.new(subst_ty(inner.get(), env, vars)) }
        TyPtr { is_mut, inner } => TyPtr { is_mut, inner: Box.new(subst_ty(inner.get(), env, vars)) }
        TyUnion(members) => TyUnion(members.map(#{ m, _ => subst_ty(m, env, vars) }))
        TyMeta(inner) => TyMeta(Box.new(subst_ty(inner.get(), env, vars)))
        other => other
    }
}

/// Does variable `v` occur in `t`?
pub fun occurs(v: int, t: &Ty, vars: &Vec[VarState]) -> bool {
    let p = prune_ty(t, vars)
    match p {
        TyVar(id) => id == v
        TyNamed { args, .. } => args.any(#{ a, _ => occurs(v, a, vars) })
        TyTuple(elems) => elems.any(#{ e, _ => occurs(v, e, vars) })
        TyRecord(fields) => fields.any(#{ f, _ => occurs(v, f.ty, vars) })
        TyFn { params, ret, .. } => params.any(#{ x, _ => occurs(v, x, vars) }) || occurs(v, ret.get(), vars)
        TyRef { inner, .. } => occurs(v, inner.get(), vars)
        TyPtr { inner, .. } => occurs(v, inner.get(), vars)
        _ => false
    }
}

/// Collects the unbound inference variables of a type, in first-seen order.
pub fun free_vars(t: &Ty, vars: &Vec[VarState], out: &mut Vec[int]) {
    let p = prune_ty(t, vars)
    match p {
        TyVar(id) => {
            if !out.contains(id) {
                out.push(id)
            }
        }
        TyNamed { args, .. } => {
            for a in args.iter() {
                free_vars(a, vars, out)
            }
        }
        TyTuple(elems) => {
            for e in elems.iter() {
                free_vars(e, vars, out)
            }
        }
        TyRecord(fields) => {
            for f in fields.iter() {
                free_vars(f.ty, vars, out)
            }
        }
        TyFn { params, ret, .. } => {
            for x in params.iter() {
                free_vars(x, vars, out)
            }
            free_vars(ret.get(), vars, out)
        }
        TyRef { inner, .. } => free_vars(inner.get(), vars, out)
        TyPtr { inner, .. } => free_vars(inner.get(), vars, out)
        _ => {}
    }
}

/// The kind of a type, named as stage 0 names it (`t.k`): "prim", "never", "unknown", "named", …
pub fun tag(t: &Ty) -> string {
    match t {
        TyPrim(_) => "prim"
        TyNever => "never"
        TyUnknown => "unknown"
        TyNamed { .. } => "named"
        TyParam(_) => "param"
        TyVar(_) => "var"
        TyTuple(_) => "tuple"
        TyRecord(_) => "record"
        TyFn { .. } => "fn"
        TyRef { .. } => "ref"
        TyPtr { .. } => "ptr"
        TyLit(_) => "lit"
        TyUnion(_) => "union"
        TyMeta(_) => "meta"
        TyPackage { .. } => "package"
    }
}

/// The symbol of a named type, or -1.
pub fun named_sym(t: &Ty) -> int {
    match t {
        TyNamed { sym, .. } => sym
        _ => -1
    }
}

/// The type arguments of a named type (empty for other types).
pub fun named_args(t: &Ty) -> Vec[Ty] {
    match t {
        TyNamed { args, .. } => args.clone()
        _ => []
    }
}

/// Argument `i` of a named type, or unknown.
pub fun arg_at(t: &Ty, i: int) -> Ty {
    match t {
        TyNamed { args, .. } => args.get(i) ?? TyUnknown
        _ => TyUnknown
    }
}

/// The name of a primitive type ("" for other types).
pub fun prim_name(t: &Ty) -> string {
    match t {
        TyPrim(n) => n.clone()
        _ => ""
    }
}
