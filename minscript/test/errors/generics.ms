package errors_generics

fun angle_in_type() {
    let v: Vec<int> = []                        //~ E_ANGLE_GENERICS
}

fun angle_nested_type() {
    let m: Map<string, Vec<int>> = m{}          //~ E_ANGLE_GENERICS
}

fun angle_decl<T>(x: T) -> T { x }              //~ E_ANGLE_GENERICS

type Box<T> = { value: T }                      //~ E_ANGLE_GENERICS

fun angle_call() {
    let u = json.parse<User>(s)                 //~ E_ANGLE_GENERICS
}

fun turbofish() {
    let u = parse::<User>(s)                    //~ E_ANGLE_GENERICS
}

fun bracket_call_without_dot() {
    let u = json.parse[User](s)                 // valid syntax: index then call (the resolver will complain); no parser error
}

fun generic_on_new_line() {
    let v = Vec.new
        .[u8]()                                 //~ E_GENERIC_ARGS_NEWLINE
}

fun empty_generic_args() {
    let v = Vec.new.[]()                        //~ E_EXPECTED_TYPE_ARGUMENTS
}
