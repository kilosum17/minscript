// Type checker diagnostics (spec §13.5, §18.3): the file is one package, checked with the prelude.
package errors

type Point {
    x: int
    y: int = 0

    fn len(this) -> int { this.x + this.y }
}

union Shape { Circle(f64)  Square(f64)  Empty }

fn mismatch() {
    let n: int = "five"                       //~ E_TYPE_MISMATCH
    let ok: f64 = 1                           // an integer literal may be a float
    var s: str = "a"
    s = 1                                     //~ E_TYPE_MISMATCH
}

fn returns() -> int {
    "x"                                       //~ E_TYPE_MISMATCH
}

fn discarded() -> int {
    5;                                        //~ E_INVALID_BLOCK_VALUE
}

fn no_value(c: bool) -> int {
    if c { return 1 }                         //~ E_INVALID_BLOCK_VALUE
}

fn operands(p: Point) {
    a := p + 1                                //~ E_INVALID_OPERANDS
    b := "a" - "b"                            //~ E_INVALID_OPERANDS
    c := 1 & 2.5                              //~ E_INVALID_OPERANDS
    d := 5 ?? 1                               //~ E_INVALID_OPERANDS
}

fn try_option(o: int?) -> Result[int, str] {
    Ok(o?)                                    //~ E_INVALID_TRY
}

fn try_value(n: int) -> int? {
    Some(n?)                                  //~ E_INVALID_TRY
}

fn add(a: int, b: int) -> int { a + b }

fn arg_count() {
    add(1)                                    //~ E_ARG_COUNT
    add(1, 2, 3)                              //~ E_ARG_COUNT
}

fn not_callable(n: int) {
    n(1)                                      //~ E_NOT_CALLABLE
}

fn fields(p: Point) {
    p.z                                       //~ E_UNKNOWN_FIELD
    q := Point { x: 1, w: 2 }                 //~ E_UNKNOWN_FIELD
    r := Point { y: 1 }                       //~ E_MISSING_FIELD
    s := Point.nope()                         //~ E_UNKNOWN_MEMBER
}

inter Named { fn name(this) -> str }
type Nameless: Named { n: int }               //~ E_MISSING_METHOD

fn show[T: Named](x: T) -> str { x.name() }

fn bound() {
    show(Point { x: 1 })                      //~ E_BOUND_NOT_SATISFIED
}

fn hold[T](x: T) {}

fn unique_arg(q: Queue[int]) {
    hold(q.subscribe())                       //~ E_UNIQUE_TYPE_ARG
    let v: Vec[Sub[int]] = []                 // Vec admits Unique items
}

type Handle: Unique { id: int }               //~ E_UNIQUE_IMPL

inter Maker { fn make[U](this) -> U }

fn not_dyn_safe(m: Maker) {
    m.make()                                  //~ E_NOT_DYN_SAFE E_CANNOT_INFER_GENERIC
}

fn cannot_infer() {
    v := []                                   //~ E_CANNOT_INFER_TYPE
    w := []
    w.push(1)                                 // inferred from later code
}

fn cannot_infer_struct() {
    p := _{ x: 1 }                            //~ E_CANNOT_INFER_STRUCT_TYPE
}

fn cannot_infer_variant() {
    s := Circle(1.0)                          //~ E_CANNOT_INFER_VARIANT
    let t: Shape = Circle(1.0)                // inferred from the expected type
}

fn unknown_variant(s: Shape) -> int {
    match s {
        Triangle => 0                         //~ E_UNKNOWN_VARIANT
        _ => 1
    }
}

fn casts(p: Point) {
    a := 3.7 as int
    b := p as int                             //~ E_INVALID_CAST
}

fn ranges() {
    let a: u8 = 300                           //~ E_INT_OUT_OF_RANGE
    let b: i8 = -128
}

fn truthy(n: int, s: str, o: int?) {
    if n { }                                  //~ E_NOT_TRUTHY
    if !s { }                                 //~ E_NOT_TRUTHY
    if o { }
}

fn nullish(a: str?, b: str?) {
    let x: str = a || b                       //~ E_USE_NULLISH
    let y: str = a ?? "none"
}

fn let_else(o: int?) {
    let Some(v) = o else { log.println("none") }    //~ E_LET_ELSE_MUST_DIVERGE
}

fn indexing(s: str, t: t(int, int)) {
    a := s[0]                                 //~ E_NOT_INDEXABLE
    b := t[0]                                 //~ E_NOT_INDEXABLE
}

fn iterating(s: str, n: int) {
    for c in s { }                            //~ E_NOT_ITERABLE
    for c in s.chars() { }
}

fn exhaustive(s: Shape, b: bool, o: Shape?) -> int {
    a := match s {                            //~ E_NON_EXHAUSTIVE_MATCH
        Circle(_) => 1
        Square(_) => 2
    }
    c := match b {                            //~ E_NON_EXHAUSTIVE_MATCH
        true => 1
    }
    d := match o {                            //~ E_NON_EXHAUSTIVE_MATCH
        Some(Circle(_)) | Some(Square(_)) => 1
        None => 0
    }
    e := match o {
        Some(Circle(_)) | Some(Square(_)) | Some(Empty) => 1
        None => 0
    }
    0
}

async fn waits() -> int { 1 }

fn not_async() {
    n := await waits()                        //~ E_AWAIT_OUTSIDE_ASYNC
}

async fn selects(n: int) {
    select {
        v = waits() => log.println(v)
        n => log.println(0)                   //~ E_SELECT_ARM_NOT_PROMISE
    }
}

type Plain {
    once ty: str                              //~ E_ONCE_OUTSIDE_IDENTITY
}

type Node: Identity {
    name: str
    once ty: str
}

fn identity_fields(n: Node) {
    n.ty = "int"                              // a once field: written once
    n.name = "other"                          //~ E_ASSIGN_IDENTITY_FIELD
}

shared var hits = 0

fn locks(n: int) {
    var plain = 0
    lock hits { hits += 1 }
    lock plain { plain += 1 }                 //~ E_LOCK_NOT_SHARED
}

#[effects(keeps: [v])]                        //~ E_ATTRIBUTE_NOT_ALLOWED
fn attributed(v: int) {}

#[inline]                                     //~ E_UNKNOWN_ATTRIBUTE
fn inlined() {}
