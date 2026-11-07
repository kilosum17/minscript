package errors_literals

fun bare_tuple() {
    let p = (1, 2)                              //~ E_BARE_TUPLE
}

fun bare_tuple_return() -> (int, int) {         //~ E_BARE_TUPLE
    t(1, 2)
}

fun bare_tuple_pattern() {
    let (w, h) = dims()                         //~ E_BARE_TUPLE
}

fun bare_brace_map() {
    let m = { "a": 1, "b": 2 }                  //~ E_BARE_BRACE_LITERAL
}

fun bare_brace_record() {
    configure({ host: "localhost", port: 80 })  //~ E_BARE_BRACE_LITERAL
}

fun tagged_record() {
    let r = '1{ id: 1, name: "x" }              //~ E_TAGGED_RECORD_REMOVED
}

fun record_bad_key() {
    let r = r{ 1: "one" }                       //~ E_INVALID_RECORD_KEY
}

fun leading_dot_float() {
    let f = .5                                  //~ E_INVALID_NUMBER
}

fun bad_hex() {
    let h = 0x                                  //~ E_INVALID_NUMBER
}

fun bad_binary() {
    let b = 0b102                               //~ E_INVALID_NUMBER
}

fun bad_escape() {
    let s = "bad \q escape"                     //~ E_INVALID_ESCAPE
}

fun unterminated_string() {
    let s = "never closed                       //~ E_UNTERMINATED_STRING
}

fun bad_char() {
    let c = 'ab'                                //~ E_INVALID_CHAR
}

fun empty_char() {
    let c = ''                                  //~ E_INVALID_CHAR
}
