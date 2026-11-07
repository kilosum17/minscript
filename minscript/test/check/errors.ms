package check_errors

// Type-checker diagnostics, one case per function (`//~ CODE` on the expected line).

type Point = { x: int, y: int }
type User = { id: u64, name: string, email: string?, active: bool = true }

union Shape = {
    Circle { r: f64 }
    Square(f64)
    Empty
}

union Light = { Red  Amber  Green }

inter Named = { fun label(&this) -> string }
type Plain = { v: int }

fun takes_int(n: int) -> int { n }
fun area(s: Shape) -> f64 { 0.0 }
fun needs_named[T: Named](x: T) -> string { x.label() }
async fun fetch() -> string { "x" }

fun mismatch_let() {
    let a: int = "hello"                        //~ E_TYPE_MISMATCH
}

fun mismatch_arg() {
    takes_int("five")                           //~ E_TYPE_MISMATCH
}

fun mismatch_return() -> int {
    return "x"                                  //~ E_TYPE_MISMATCH
}

fun mismatch_body() -> string {
    42                                          //~ E_TYPE_MISMATCH
}

fun mismatch_field() {
    let p = Point { x: 1, y: "two" }            //~ E_TYPE_MISMATCH
}

fun mismatch_numbers(a: i64, b: u8) {
    let c: u8 = a                               //~ E_TYPE_MISMATCH
}

fun widening_is_fine(a: i32, b: u8) {
    let c: i64 = a                              // i32 → i64: lossless
    let d: u32 = b                              // u8 → u32: lossless
    let e: f64 = a                              // i32 → f64: lossless
}

fun not_truthy(n: int, s: string) {
    if n { }                                    //~ E_NOT_TRUTHY
}

fun truthy_option(o: int?, r: Result[int, string]) {
    if o && r { }                               // Option and Result are truthy
}

fun bad_operands(p: Point) {
    let x = p + 1                               //~ E_INVALID_OPERANDS
}

fun string_concat(a: string, b: &str) {
    let s = a + b                               // string + &str is fine
}

fun invalid_cast(p: Point) {
    let n = p as int                            //~ E_INVALID_CAST
}

fun numeric_cast(big: i64) {
    let small = big as u8                       // a cast: fine
    let annotated = [] as Vec[int]              // an annotation: fine
}

fun try_option_in_int_fn(o: int?) -> int {
    let v = o?                                  //~ E_INVALID_TRY
    v
}

fun try_wrong_error(r: Result[int, string]) -> Result[int, int] {
    let v = r?                                  //~ E_INVALID_TRY
    Ok(v)
}

fun arg_count() {
    takes_int(1, 2)                             //~ E_ARG_COUNT
}

fun not_callable(p: Point) {
    p(1)                                        //~ E_NOT_CALLABLE
}

fun unknown_field(p: Point) {
    let z = p.z                                 //~ E_UNKNOWN_FIELD
}

fun unknown_static() {
    let s = Shape.Triangle                      //~ E_UNKNOWN_MEMBER
}

fun missing_field() {
    let u = User { id: 1 }                      //~ E_MISSING_FIELD
}

fun optional_and_default_fields() {
    let u = User { id: 1, name: "Ann" }         // email: None, active: true
}

fun unknown_struct_field() {
    let p = Point { x: 1, y: 2, z: 3 }          //~ E_UNKNOWN_FIELD
}

fun cannot_infer_vec() {
    let v = []                                  //~ E_CANNOT_INFER_TYPE
}

fun inferred_later_is_fine() {
    var v = []
    v.push(1)
}

fun cannot_infer_struct() {
    let c = _{ a: 1 }                           //~ E_CANNOT_INFER_STRUCT_TYPE
}

fun cannot_infer_variant() {
    let x = Blue                                //~ E_CANNOT_INFER_VARIANT
}

fun inferred_variants() {
    let s: Shape = Empty                        // spec §7.6
    let a = area(Square(2.0))
    let b = area(Circle { r: 1.0 })
}

fun trailing_semicolon() -> int {
    5;                                          //~ E_INVALID_BLOCK_VALUE
}

fun await_outside_async() {
    let s = await fetch()                       //~ E_AWAIT_OUTSIDE_ASYNC
}

async fun select_not_promise(n: int) {
    select {
        x = n => log.println(x)                 //~ E_SELECT_ARM_NOT_PROMISE
    }
}

fun string_index(s: string) {
    let c = s[0]                                //~ E_NOT_INDEXABLE
}

fun not_iterable(n: int) {
    for x in n { }                              //~ E_NOT_ITERABLE
}

fun non_exhaustive_union(l: Light) -> int {
    match l {                                   //~ E_NON_EXHAUSTIVE_MATCH
        Red => 1
        Amber => 2
    }
}

fun non_exhaustive_bool(b: bool) -> int {
    match b {                                   //~ E_NON_EXHAUSTIVE_MATCH
        true => 1
    }
}

fun non_exhaustive_int(n: int) -> int {
    match n {                                   //~ E_NON_EXHAUSTIVE_MATCH
        0 => 1
        1 => 2
    }
}

fun exhaustive_ok(o: int?, l: Light) -> int {
    let a = match o { Some(v) => v, None => 0 }
    let b = match l { Red => 1, Amber => 2, Green => 3 }
    a + b
}

fun unknown_variant_pattern(l: Light) -> int {
    match l {
        Blue => 0                               //~ E_UNKNOWN_VARIANT
        _ => 1
    }
}

impl Named for Plain {}                         //~ E_MISSING_METHOD

fun bound_not_satisfied(p: Point) {
    let s = needs_named(p)                      //~ E_BOUND_NOT_SATISFIED
}

fun int_out_of_range() {
    let b: u8 = 300                             //~ E_INT_OUT_OF_RANGE
}

fun let_else_must_diverge(o: int?) {
    let Some(v) = o else { log.println("none") }   //~ E_LET_ELSE_MUST_DIVERGE
}

fun or_rhs_must_match_return(o: int?) -> Result[int, string] {
    let v = o or 5                              //~ E_TYPE_MISMATCH
    Ok(v)
}

fun nullish_fallback_type(o: int?) {
    let v = o ?? "zero"                         //~ E_TYPE_MISMATCH
}

fun branch_types(c: bool) {
    let v = if c { 1 } else { "one" }           //~ E_TYPE_MISMATCH
}
