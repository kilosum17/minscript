package lexer_demo

import "std.io" as io

type Box[T] = { value: T }

// Generic type arguments now use square brackets.
inter Convert[From, To] = {
    fun convert(this, value: From) -> To
}

type User = {
    id: i64,
    name: string,
    roles: Vec[string],
    matrix: Array[i32, 4],
}

fun identity[T](value: T) -> T { value }

fun parse_user(input: string) -> Result[User, string] {
    json.parse[User](input)
}

fun collect_ids(users: Vec[User]) -> Vec[i64] {
    users.map[i64](#{ it.id })
}

fun main() {
    // Generic calls and nested generic types do not use angle brackets.
    var long_string = "This is a long \n string ${name} and ${age}"
    var multiline = """
        Multiline string with \t ${one+it}
        Multiline string with \t ${two}
        """
    
    // let parsed: Result[User, string] = parse_user("{\"id\":1}")
    let nested: Map[string, Vec[Option[User]]] = m{
        "admins": v[User.new(_{ id: 1, name: "Ada", roles: v["admin"] })],
        "guests": v[],
    }

    // Collection sigils are fused; ordinary brackets remain available for indexing.
    let fixed = a[10, 20, 30]
    let growable = v[1, 2, 3, 4]
    let first = growable[0]
    let record = r{ ...base, id: 7, name: "Grace" } //...base not supported yet
    let lookup = m{ "one": 1, "two": 2 }
    let unique = s{ 1, 2, 3 }
    let pair = t("age", 42)
    let inferred = _{ host: "localhost", port: 8080 }
    let tagged = _{ id: 1, label: "primary" } //'{} not supported yet

    let doubled = #{ it * 2 }
    let add = #{ left, right => left + right }
    let capture = #[growable]{x => growable.push(x)}
    let explicit = #{x: i32, y: i32 => x + y}

    let text = "Hello ${record.name}, count=${growable.len()}"
    let multi = """first line
second line ${first}
"""
    let raw = "C:\\users\\name\\file"

    // not supporting 1_000.5e-2
    let number = 0.001 
    // TODO 0xFF
    let hex = 0
    let binary = 0 // 0b1010
    let octal = 0  // 0o17
    let tuple_index = pair.0.1
    let range = 0 // 1..10
    let inclusive = 0 // 1..=10

    if parsed.is_ok() {
        println(text)
    } else {
        println("parse failed")
    }

    for {
        println("Infinite")   
    }
    
    for i in 1..10 {

    }

    let done = false
    for done == true {

    }
    
    for user in users {}
    for user,idx in users{}
    for key, val in map {}
    
    let role_info = match user.role { // , commas not required but can be used
        Admin => "Admin",
        Staff => "Staff",
        _ => "Other",
    } 

    let is_adult = match age {
        age > 18 => true
        _ => false
    }

    // Keywords after a dot are ordinary member names.
    let fallback = parsed.or(None)
    let propagated = await load_user()?
}
