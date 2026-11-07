package errors_unmatched_delimiter

fun mismatched() {
    let x = (1 + 2]                             //~ E_UNMATCHED_DELIMITER
}

fun fine_after() {
    let y = 1                                   // recovery: this function parses normally
}
