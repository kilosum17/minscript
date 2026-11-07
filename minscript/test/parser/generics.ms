package parser_generics

// declarations
fun identity[T](value: T) -> T { value }
fun pair[A, B](a: A, b: B) -> t(A, B) { t(a, b) }
fun largest[T: PartialOrd[T]](items: &Vec[T]) -> &T { items.max() }
fun copy_all[T: Reader & Writer](src: &mut T, dst: &mut T) {}
fun trailing[T, U,](x: T, y: U) {}

type Box[T] = { value: T }
type Pair[A, B] = r{ first: A, second: B }

union Response[T, E] = {
    Success(T)
    Failure(E)
}

inter Convert[From, To] = {
    fun convert(&this, value: From) -> To
}

impl[T] Box[T] {
    pub fun get(&this) -> &T { &this.value }
}

impl[T: Stringer] Vec[T] {
    pub fun join_all(&this) -> string { this.map(#{ it.to_str() }).join(", ") }
}

// type positions
fun types(
    a: Vec[int],
    b: Map[string, Vec[User?]],
    c: Promise[Result[User, string]],
    d: Array[i32, 4],
    e: std.col.Vec[u8],
    f: Result[Vec[Pair[string, i64]], string],
    g: (Vec[int]) -> Map[string, int],
) {}

fun main() {
    // explicit generic arguments in expressions: `.[ ]`
    let user = json.parse.[User](json_str)
    let ids = collect.[i64](items)
    let v1 = Vec.new.[u8]()
    let v2 = Vec.[u8].new()
    let m1 = Map.[string, Vec[int]].new()
    let b1 = Box.[i32]{ value: 1 }
    let p1 = parse_user.[User]("{\"id\":1}")
    let chained = data.decode.[Config]().unwrap().host
    let nested = convert.[Vec[u8], Response[User, string]](bytes)

    // inferred: no `.[ ]` needed
    let u: Result[User, json.Error] = json.parse(json_str)

    // `<` and `>` are always comparisons
    let c1 = a<b
    let c2 = a < b && c > d
    let c3 = (x<y) == true                     // parentheses required: `<` and `==` share a non-associative level

    // `[` after an expression is indexing (expression position)
    let i1 = list[0]
    let i2 = matrix[i][j]
    let i3 = get_list()[0]
    let i4 = map["key"]
}
