package resolve_errors

// Resolver diagnostics, one case per function (`//~ CODE` on the expected line).

import "std.json"
import "std.time"
import "std.json"                               //~ E_DUPLICATE_DECLARATION

type Point = { x: int, y: int }
type Meters = f64

fun send(v: int) {}

fun undeclared_name() {
    let a = missing + 1                         //~ E_UNDECLARED_NAME
}

fun undeclared_in_call() {
    log.println(nothing_here)                   //~ E_UNDECLARED_NAME
}

fun undeclared_type(p: Pointt) {}               //~ E_UNDECLARED_TYPE

fun undeclared_assignment() {
    counter = 1                                 //~ E_UNDECLARED_ASSIGNMENT
}

fun not_a_type(x: undeclared_name) {}           //~ E_NOT_A_TYPE

fun uppercase_is_deferred() {
    send(Text("hi"))                            // `Text`: left for the type checker (no error here)
    let c = Close
}

fun use_before_declaration() {
    let a = b                                   //~ E_UNDECLARED_NAME
    let b = 1
}

fun same_scope_redeclaration() {
    let x = 1
    let x = 2                                   //~ E_DUPLICATE_BINDING
}

fun short_decl_redeclaration() {
    y := 1
    y := 2                                      //~ E_DUPLICATE_BINDING
}

fun param_redeclared_in_body(n: int) {
    let n = 2                                   //~ E_DUPLICATE_BINDING
}

fun duplicate_param(a: int, a: int) {}          //~ E_DUPLICATE_BINDING

fun duplicate_in_pattern(p: t(int, int)) {
    let t(v, v) = p                             //~ E_DUPLICATE_BINDING
}

fun inconsistent_or(p: t(int, int)) {
    match p {
        t(0, k) | t(j, 0) => k                  //~ E_INCONSISTENT_OR_BINDINGS
        _ => 0
    }
}

fun undeclared_main() {}

fun undeclared_main() {}                        //~ E_DUPLICATE_DECLARATION

fun it_outside_closure() {
    let x = it + 1                              //~ E_IT_OUTSIDE_CLOSURE
}

fun it_is_reserved() {
    let it2 = 5                                 //~ E_RESERVED_IDENT
}

fun this_outside_method() {
    let v = this                                //~ E_THIS_OUTSIDE_METHOD
}

type Counter = {
    n: int
    fun make() -> int { this.n }                //~ E_THIS_OUTSIDE_METHOD
}

fun self_outside_type() -> Self { panic("x") }  //~ E_SELF_OUTSIDE_TYPE

fun capture_global() {
    let f = #[undeclared_main]{ 1 }             //~ E_INVALID_CAPTURE
}

fun capture_undeclared() {
    let f = #[ghost]{ 1 }                       //~ E_UNDECLARED_NAME
}

fun sigil_shadows(t: int) {
    let pair = t(1, 2)                          //~ E_SIGIL_SHADOWS_BINDING
}

union Light = { Red  Amber  Green }

fun unknown_variant(l: Light) {
    match l {
        Light.Blue => 0                         //~ E_UNKNOWN_VARIANT
        _ => 1
    }
}

type Dup = {
    a: int
    a: string                                   //~ E_DUPLICATE_FIELD
}

type Clash = {
    size: int
    fun size(&this) -> int { 0 }                //~ E_DUPLICATE_METHOD
}

impl Clash {
    fun area(&this) -> int { 0 }
    fun area(&this) -> int { 1 }                //~ E_DUPLICATE_METHOD
}

inter Named = { fun label(&this) -> string }
inter Tagged = { fun label(&this) -> string }
type Both = { v: int }
impl Named for Both { fun label(&this) -> string { "n" } }
impl Tagged for Both { fun label(&this) -> string { "t" } }   //~ E_AMBIGUOUS_IMPL_METHOD

impl Vec[int] {                                 //~ E_ORPHAN_IMPL
    fun total(&this) -> int { 0 }
}

impl Stringer for json.Value {                  //~ E_ORPHAN_IMPL
    fun to_str(&this) -> string { "" }
}

impl Meters {                                   //~ E_METHODS_ON_STRUCTURAL
    fun km(&this) -> f64 { 0.0 }
}
