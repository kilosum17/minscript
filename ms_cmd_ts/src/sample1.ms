package lexer_stress

import "std.io"
import "std.collections" as collections

/// Generic declarations use square brackets.
type Pair[A, B] = t(A, B)
type Response[T, E] =
    | Success(T)
    | Failure(E)

type User = {
    id: u64
    name: string
    active: bool
    tags: Vec[string]
    scores: Array[i32, 4]
}

inter Convert[From, To] = {
    fun convert(this, value: From) -> To
}

fun identity[T](value: T) -> T { value }
fun wrap[T, E](value: T) -> Result[T, E] { Ok(value) }
fun first[T](items: Vec[T]) -> Option[T] { items[0] }
fun parse_user(input: string) -> Result[User, string] {
    json.parse[User](input)
}

fun generic_examples() {
    let a: Vec[i32] = v[1, 2, 3]
    let b: Map[string, Vec[Option[User]]] = m{}
    let c: Result[Vec[Pair[string, i64]], string] = Ok(v[])
    let d = identity[User](_{ id: 1, name: "Ada", active: true, tags: v[], scores: a[0, 0, 0, 0] })
    let e = collections.collect[string](a)
    let f = json.parse[Response[User, string]]("{}")
    let index = a[0]
    let nested_index = b["users"][0]
    let comparison = a[0] < 10
    let spaced_comparison = a[0] < 10 && 10 >= 2
}

fun collection_examples() {
    let record = r{ id: 7, name: "Grace", active: true, ...defaults }
    let map = m{ "one": 1, "two": 2, dynamic_key: compute_value() }
    let set = s{ 1, 2, 3, 5, 8 }
    let tuple = t("answer", 42, true)
    let fixed = a[4, 8, 15, 16, 23, 42]
    let vector = v["red", "green", "blue"]
    let empty_vector = v[]
    let inferred = _{ host: "127.0.0.1", port: 8080 }
    let tagged = '1{ id: 99, label: "primary" }
    let fixed_index = fixed[2]
    let tuple_field = tuple.0.1
}

fun closure_examples() {
    let implicit = #{ it * 2 }
    let implicit_many = #{ it1 + it2 }
    let named = #{ value, index => value + index }
    let typed = (value: i32, factor: i32) -> i32 => value * factor
    let block = (x) => {
        let doubled = x * 2
        doubled
    }
    let captured = #[items, scale](x) => items.push(x * scale)
    let captured_block = #[state] {
        state.count += 1
        state.count
    }
}

fun operator_examples(mut value: i32) -> i32 {
    let arithmetic = (value + 10) * 3 / 2 % 7
    let bitwise = (value << 2) | (value >> 1) ^ 0x0F
    let logical = value > 0 && value < 100 || false
    let range = 1..10
    let inclusive_range = 1..=10
    value += 1
    value -= 2
    value *= 3
    value /= 2
    value %= 5
    value
}

fun string_examples(user: User) {
    let escaped = "quote: \" slash: \\ newline: \n tab: \t null: \0"
    let interpolated = "Hello ${user.name}, id=${user.id}"
    let nested_interpolation = "value=${format_value(compute(1, 2))}"
    let multiline = """
        first line
        second line: ${user.name}
        third line
        """
    let raw = r`C:\users\name\file.txt`
    let char_a = 'a'
    let char_newline = '\n'
    let unicode_char = '\u{1F600}'
}

fun control_flow(value: Option[i32]) -> i32 {
    let number = value or 0
    if number > 10 {
        return number
    } else if number == 10 {
        10
    } else {
        match number {
            0 => 1,
            1..=5 => 5,
            other if other > 5 => other,
            _ => 0
        }
    }
}

fun loops(items: Vec[i32]) {
    for item in items {
        if item == 0 { continue }
        println(item)
    }
    var count: i32 = 0
    while count < 3 {
        count += 1
    }
    loop {
        if count > 10 { break }
        count += 1
    }
}

fun comments_and_spacing() {
    // Line comment
    /// Documentation comment
    /* Block comment
       with a nested comment: /* nested */
       still inside the outer comment.
    */
    let left = 1 /* inline block */ + 2
    let chain = user
        .profile
        ?.display_name
    let fallback = user.or(None)
    let propagation = get_user()?
    let awaited = await fetch_user()?
}

fun main() {
    generic_examples()
    collection_examples()
    closure_examples()
    string_examples(_{ id: 1, name: "Ada", active: true, tags: v[], scores: a[0, 0, 0, 0] })
    println("lexer stress sample complete")
}
