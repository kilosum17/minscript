// Resolver diagnostics (spec §8.7, §18.3): the file is one package, resolved with the prelude.
package errors

import "std.json"
import "std.time"                             //~ E_DUPLICATE_DECLARATION

fn time() {}

fn undeclared() {
    log.println(nope)                         //~ E_UNDECLARED_NAME
    missing = 1                               //~ E_UNDECLARED_ASSIGNMENT
}

fn types(a: Nope, b: string) {}               //~ E_UNDECLARED_TYPE E_STRING_TYPE_REMOVED

fn not_a_type(a: undeclared) {}               //~ E_NOT_A_TYPE

fn package_as_type(a: json) {}                //~ E_NOT_A_TYPE

let DUP = 1
let DUP = 2                                   //~ E_DUPLICATE_DECLARATION

fn two_params(x: int, x: int) {}              //~ E_DUPLICATE_BINDING

fn redeclared_param(p: int) {
    let p = 2                                 //~ E_DUPLICATE_BINDING
}

fn var_copy(p: int) -> int {
    var p = p                                 // allowed: the body's first use of `p` (§5.1)
    p += 1
    p
}

fn var_copy_late(p: int) -> int {
    q := p
    var p = q                                 //~ E_DUPLICATE_BINDING
    p
}

fn shadow_inner(x: int) {
    if x > 0 { let x = 1 }                    // an inner scope may shadow
}

fn pattern_twice() {
    let t(a, a) = t(1, 2)                     //~ E_DUPLICATE_BINDING
}

fn or_bindings(v: Shape) -> int {
    match v {
        Circle(r) | Square(s) => 0            //~ E_INCONSISTENT_OR_BINDINGS
        _ => 1
    }
}

fn implicit_outside() {
    log.println(it)                           //~ E_IT_OUTSIDE_CLOSURE
}

fn implicit_in_named(xs: Vec[int]) {
    ys := xs.map(#{ x => it })                //~ E_IT_IN_NAMED_CLOSURE
}

fn reserved() {
    it := 1                                   //~ E_RESERVED_IDENT
}

fn no_receiver() {
    this.x                                    //~ E_THIS_OUTSIDE_METHOD
}

fn self_outside() -> Self {}                  //~ E_SELF_OUTSIDE_TYPE

fn sigil_shadow(t: int) {
    x := t(1, 2)                              //~ E_SIGIL_SHADOWS_BINDING
}

union Shape { Circle(f64)  Square(f64) }

fn unknown_variant(s: Shape) -> int {
    match s {
        Shape.Triangle => 0                   //~ E_UNKNOWN_VARIANT
        _ => 1
    }
}

type Dup {
    a: int
    a: str                                    //~ E_DUPLICATE_FIELD

    fn m(this) {}
    fn m(this) {}                             //~ E_DUPLICATE_METHOD
    fn a(this) {}                             //~ E_DUPLICATE_METHOD
}

fn literal_fields() {
    r := r{ x: 1, x: 2 }                      //~ E_DUPLICATE_FIELD
}

type Alias = Vec[int]
impl Alias { fn f(this) {} }                  //~ E_METHODS_ON_STRUCTURAL

impl int { fn double(this) -> int { this * 2 } }            //~ E_ORPHAN_IMPL

impl Stringer for str { fn to_str(this) -> str { this } }   //~ E_ORPHAN_IMPL

inter Walks { fn go(this) }
inter Drives { fn go(this) }
type Both: Walks, Drives { n: int }           //~ E_AMBIGUOUS_IMPL_METHOD

#[effects(keeps: [nope])]                     //~ E_UNDECLARED_NAME
fn attributed(v: int) {}
