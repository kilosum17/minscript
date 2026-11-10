// Lexer diagnostics (spec §18.1): one case per function, annotated with the expected code.
package errors

fn numbers() {
    a := .5                     //~ E_INVALID_NUMBER
    b := 0b102                  //~ E_INVALID_NUMBER
    c := 12px                   //~ E_INVALID_NUMBER
    d := 1_                     //~ E_INVALID_NUMBER
    e := 0x                     //~ E_INVALID_NUMBER
}

fn chars() {
    a := 'ab'                   //~ E_INVALID_CHAR
    b := ''                     //~ E_INVALID_CHAR
    c := b''                    //~ E_INVALID_CHAR
}

fn bytes() {
    a := b'é'                   //~ E_BYTE_LITERAL_NOT_ASCII
    b := b'\xFF'
    c := b'\q'                  //~ E_INVALID_ESCAPE
}

fn escapes() {
    a := "\q"                   //~ E_INVALID_ESCAPE
    b := "\xFF"                 //~ E_INVALID_ESCAPE
    c := "\u{110000}"           //~ E_INVALID_ESCAPE
}

fn unterminated() {
    a := "abc                   //~ E_UNTERMINATED_STRING
    b := 1
}

fn template_newline() {
    a := "x${                   //~ E_UNTERMINATED_STRING
        y }"
}

fn tagged_record() {
    r := '1{ id: 1 }            //~ E_TAGGED_RECORD_REMOVED
}

fn unknown_character() {
    a := @b                     //~ E_UNKNOWN_CHARACTER
    c := `d`                    //~ E_UNKNOWN_CHARACTER E_UNKNOWN_CHARACTER
}

fn delimiters() {
    f(a, b]                     //~ E_UNMATCHED_DELIMITER
}
