package errors_operators

fun chained_comparison() {
    let x = a < b < c                           //~ E_NON_ASSOCIATIVE_OPERATOR
}

fun chained_equality() {
    let x = a == b == c                         //~ E_NON_ASSOCIATIVE_OPERATOR
}

fun mixed_comparison() {
    let x = a < b == true                       //~ E_NON_ASSOCIATIVE_OPERATOR
}

fun chained_range() {
    let x = 1..2..3                             //~ E_NON_ASSOCIATIVE_OPERATOR
}

fun nullish_with_or() {
    let x = a ?? b || c                         //~ E_MIXED_NULLISH
}

fun nullish_with_and() {
    let x = a && b ?? c                         //~ E_MIXED_NULLISH
}

fun increment() {
    i++                                         //~ E_RESERVED_OPERATOR
}

fun decrement() {
    --i                                         //~ E_RESERVED_OPERATOR
}

fun tilde() {
    let x = ~mask                               //~ E_RESERVED_OPERATOR
}

fun word_operators() {
    if a and b { }                              //~ E_UNEXPECTED_TOKEN
}

fun bad_assignment_target() {
    1 = x                                       //~ E_INVALID_ASSIGNMENT_TARGET
}

fun call_assignment_target() {
    f() = 3                                     //~ E_INVALID_ASSIGNMENT_TARGET
}

fun short_decl_pattern() {
    t(a, b) := pair                             //~ E_SHORT_DECL_TARGET
}

fun short_decl_member() {
    user.name := "Ted"                          //~ E_SHORT_DECL_TARGET
}

fun let_with_short_decl() {
    let x := 5                                  //~ E_SHORT_DECL_TARGET
}
