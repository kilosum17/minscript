package errors_closures

fun arrow_single() {
    let f = (a) => a                            //~ E_ARROW_CLOSURE
}

fun arrow_multi() {
    let f = (a, b) => { a + b }                 //~ E_ARROW_CLOSURE
}

fun arrow_typed() {
    let f = (a: i32) -> i32 => a * 2            //~ E_ARROW_CLOSURE
}

fun fun_expression() {
    let f = items.map(fun(x) { x * 2 })         //~ E_ARROW_CLOSURE
}

fun capture_not_glued() {
    let f = #[x] { it + x }                     //~ E_CAPTURE_NOT_GLUED
}

fun capture_old_arrow_form() {
    let f = #[x](a) => a + x                    //~ E_CAPTURE_NOT_GLUED
}

fun it_in_named() {
    let f = #{ a => a + it }                    //~ E_IT_IN_NAMED_CLOSURE
}

fun header_on_second_line() {
    let f = #{
        n => n * 2                              //~ E_CLOSURE_HEADER_LINE
    }
}

fun bad_capture() {
    let f = #[x.y]{ it }                        //~ E_INVALID_CAPTURE
}
