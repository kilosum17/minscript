// v0.2 forms removed in v0.4 (spec §18.2): each is reported once, with a fix-it, and parsed as
// the intended form.
package errors

fun old_fn() {}                 //~ E_RESERVED_KEYWORD

fn mut_param(mut x: int) {}     //~ E_MUT_REMOVED

type Receivers {
    n: int

    fn a(mut this) {}           //~ E_MUT_REMOVED
    fn b(&this) {}              //~ E_BORROW_REMOVED
    fn c(&mut this) {}          //~ E_BORROW_REMOVED
    fn d(self) {}               //~ E_UNKNOWN_RECEIVER
}

fn borrow_param(x: &str) {}     //~ E_BORROW_REMOVED

fn borrow_mut_param(x: &mut Vec[int]) {}    //~ E_BORROW_REMOVED

fn borrow_return() -> &str { "" }           //~ E_BORROW_REMOVED

fn star_type() {
    let v: *int = 1             //~ E_STAR_TYPE_NOT_PARAM
}

type StarField {
    p: *int                     //~ E_STAR_TYPE_NOT_PARAM
}

fn capture_list() {
    n := 1
    f := #[n]{ it + n }         //~ E_CAPTURE_LIST_REMOVED
}

type EqualsBody = { id: int }   //~ E_TYPE_EQUALS_BODY

union EqualsUnion = { A  B }    //~ E_TYPE_EQUALS_BODY

inter EqualsInter = { fn f(this) }          //~ E_TYPE_EQUALS_BODY

type PipeUnion = | A | B(int)   //~ E_LEADING_PIPE_UNION

fn shared_let() {
    shared let x = 1            //~ E_SHARED_IMMUTABLE
}

shared let G = 1                //~ E_SHARED_IMMUTABLE

fn mut_patterns() {
    let mut x = 1               //~ E_MUT_REMOVED
    if let Some(mut y) = f() {} //~ E_MUT_REMOVED
    g := #{ mut acc, z => acc } //~ E_MUT_REMOVED
}

fn prefix_borrows() {
    f(&x)                       //~ E_BORROW_REMOVED
    g(&mut y)                   //~ E_BORROW_REMOVED
    h(*p)                       //~ E_BORROW_REMOVED
}

fn angle_generics() {
    let v: Vec<int> = []        //~ E_ANGLE_GENERICS
    x := parse<User>(s)         //~ E_ANGLE_GENERICS
    m := m{} as Map<str, Vec<int>>          //~ E_ANGLE_GENERICS E_ANGLE_GENERICS
}

fn arrow_closures() {
    f := (a) => a + 1           //~ E_ARROW_CLOSURE
    g := fn(x) { x }            //~ E_ARROW_CLOSURE
}

fn old_loops() {
    while x {}                  //~ E_RESERVED_KEYWORD
    loop { break }              //~ E_RESERVED_KEYWORD
}
