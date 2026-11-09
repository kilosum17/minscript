package errors_declarations

import "std.log"

var counter = 0                                 //~ E_GLOBAL_VAR

log.println("hello")                            //~ E_TOP_LEVEL_STATEMENT

@inline                                         //~ E_ATTRIBUTES_RESERVED
fun attributed() {}

import "std.io"                                 //~ E_IMPORT_AFTER_ITEM

fun old_while() {
    while x < 3 { }                             //~ E_RESERVED_KEYWORD
}

fun old_loop() {
    loop { }                                    //~ E_RESERVED_KEYWORD
}

fun keyword_as_name() {
    let match = 1                               //~ E_KEYWORD_AS_IDENT
}

fun brace_on_next_line()                        //~ E_OPEN_BRACE_NEWLINE
{
}

fun old_return_colon(): int { 1 }               //~ E_UNEXPECTED_TOKEN

type OldUnion =
    | A                                         //~ E_LEADING_PIPE_UNION
    | B

fun ref_param_prefix(&items: Vec[int]) {}       //~ E_INVALID_PARAM

fun self_receiver(mut self) {}                  //~ E_UNKNOWN_RECEIVER

fun variadic_not_last(...xs: int, y: int) {}    //~ E_VARIADIC_NOT_LAST

type Fields = {
    pub id: int
    pub id2 int                                 //~ E_EXPECTED_COLON
}
