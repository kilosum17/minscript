// Unit tests of the stage-1 lexer (`ms test` in stage1/). The differential test (`ms run difftest`)
// checks it against stage 0 on every file of the repository; these pin down single behaviours.
package lexer

import "std.testing.*"
import "std.utf8"

fun kinds(src: &str) -> string {
    let res = lex(utf8.encode(src))
    res.tokens.map(#{ t => t.kind.clone() }).join(" ")
}

fun first_value(src: &str) -> string {
    let res = lex(utf8.encode(src))
    let Some(v) = &res.tokens[0].value else { return "-" }
    match v {
        Text(s) => s.clone()
        Int(d) => d.clone()
        Float(x) => "${x}"
    }
}

fun test_keywords_and_members() {
    assert_eq(kinds("let x = a.type"), "let Ident = Ident . Ident EOF")
    assert_eq(kinds("fun r() {}"), "fun Ident ( ) { } EOF")      // no sigil after `fun`
}

fun test_sigils() {
    assert_eq(kinds("r{} m{} s{} t() a[] _{} #{} #[]"), "r{ } m{ } s{ } t( ) a[ ] _{ } #{ } #[ ] EOF")
    assert_eq(kinds("a [0]"), "Ident [ Int ] EOF")
}

fun test_numbers() {
    assert_eq(first_value("0x1F"), "31")
    assert_eq(first_value("1_000"), "1000")
    assert_eq(first_value("18446744073709551616"), "18446744073709551616")   // past u64
    assert_eq(first_value("2.5e3"), "2500.0")
    let bad = lex(utf8.encode("12px"))
    assert_eq(bad.diagnostics[0].code, "E_INVALID_NUMBER")
}

fun test_templates() {
    assert_eq(kinds("\"a\${x}b\${y}c\""), "TemplateHead Ident TemplateMiddle Ident TemplateTail EOF")
    assert_eq(first_value("\"tab\\there\""), "tab\there")
}

fun test_matching_closers() {
    let res = lex(utf8.encode("f(b[1])"))           // (`a[` would be the array sigil)
    assert_eq(res.tokens[1].closer ?? -1, 6)
    assert_eq(res.tokens[3].closer ?? -1, 5)
}

fun test_recovery() {
    let res = lex(utf8.encode("f(a]"))
    assert_eq(res.diagnostics.len(), 1)
    assert_eq(res.diagnostics[0].code, "E_UNMATCHED_DELIMITER")
    assert_eq(kinds("f(a]"), "Ident ( Ident ) EOF")                // the wrong closer becomes the expected one
}

fun test_columns_count_code_points() {
    let res = lex(utf8.encode("\"é😀\" x"))
    assert_eq(res.tokens[1].span.col, 6)
    assert_eq(res.tokens[1].span.start, 9)
}
