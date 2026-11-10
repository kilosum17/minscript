// Other parser diagnostics (spec §18.2).
package errors

import "std.io"

fn first() {}

import "std.json"               //~ E_IMPORT_AFTER_ITEM

x := 1                          //~ E_TOP_LEVEL_STATEMENT

fn keyword_as_ident() {
    let type = 1                //~ E_KEYWORD_AS_IDENT
}

fn brace_newline()
{                               //~ E_OPEN_BRACE_NEWLINE
}

fn variadic(...xs: int, y: int) {}          //~ E_VARIADIC_NOT_LAST

fn missing_colon(x) {}          //~ E_EXPECTED_COLON

fn invalid_param(*x: int) {}    //~ E_INVALID_PARAM

type MissingFieldColon {
    name str                    //~ E_EXPECTED_COLON
}

fn short_decl() {
    a.b := 1                    //~ E_SHORT_DECL_TARGET
    let c := 2                  //~ E_SHORT_DECL_TARGET
}

fn closure_header() {
    f := #{
        x => x + 1              //~ E_CLOSURE_HEADER_LINE
    }
}

fn generic_args_newline() {
    v := Vec
        .[u8].new()             //~ E_GENERIC_ARGS_NEWLINE
}

fn empty_type_args() {
    v := Vec.[]()               //~ E_EXPECTED_TYPE_ARGUMENTS
    let w: Vec[] = []           //~ E_EXPECTED_TYPE_ARGUMENTS
}

fn non_associative() {
    x := a < b < c              //~ E_NON_ASSOCIATIVE_OPERATOR
}

fn mixed_nullish() {
    x := a ?? b || c            //~ E_MIXED_NULLISH
    y := (a ?? b) || c
}

fn assignment_target() {
    f() = 1                     //~ E_INVALID_ASSIGNMENT_TARGET
}

fn invalid_pattern() {
    let [a] = x                 //~ E_INVALID_PATTERN
}

fn record_key() {
    r := r{ 1: 2 }              //~ E_INVALID_RECORD_KEY
}

fn bare_tuples() {
    t := (1, 2)                 //~ E_BARE_TUPLE
    u := ()                     //~ E_BARE_TUPLE
}

fn bare_brace() {
    b := { a: 1 }               //~ E_BARE_BRACE_LITERAL
}

fn struct_in_header() {
    if x == P { a: 1 } { }      //~ E_STRUCT_LITERAL_IN_HEADER
}

fn reserved_operators() {
    i++                         //~ E_RESERVED_OPERATOR
    j := ~k                     //~ E_RESERVED_OPERATOR
}

fn selects() {
    select { }                  //~ E_SELECT_EMPTY
    select { else => a(), b = c() => d() }  //~ E_SELECT_ELSE_NOT_LAST
}

fn unexpected() {
    a b                         //~ E_UNEXPECTED_TOKEN
}

#[effects(keeps)]               //~ E_INVALID_ATTRIBUTE
fn attributed() {}

#[effects(keeps: [v])] fn same_line() {}    //~ E_INVALID_ATTRIBUTE
