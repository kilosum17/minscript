package syntax

import "std.testing.*"

fn test_tokens_are_views_of_the_source() {
    src := "let x = 12"
    let t(toks, errs) = lex(src)
    assert_true(errs.is_empty(), "no errors")
    assert_eq(toks.len(), 5)                        // let x = 12 <eof>
    assert_eq(toks[3].text, "12")
    assert_eq(toks[3].span.start, 8)
}

fn test_names_are_interned_tokens_are_not() {
    let t(toks, _) = lex("a + a")
    assert_true(toks[0].name == toks[2].name, "one Symbol per text")
    assert_true(toks[0] != toks[2], "two occurrences, two tokens (different spans)")
}

fn test_tokens_key_a_map_by_span() {
    let t(toks, _) = lex("a a")
    var seen = m{} as Map[Token, int]
    for tok, i in toks { seen[tok] = i }
    assert_eq(seen.len(), 3)                        // a, a and <eof>: same text, different spans
}

fn test_parse_precedence() {
    let t(toks, _) = lex("1 + 2 * 3")
    let t(stmts, errs) = parse(toks)
    assert_true(errs.is_empty(), "no errors")
    let Some(PrintStmt(Bin(top))) = stmts.first() else { fail("expected a binary expression") }
    assert_eq(top.op, "+")
    assert_true(match top.right { Bin(r) => r.op == "*", _ => false }, "* binds tighter")
}

fn test_one_error_per_bad_line() {
    let t(toks, _) = lex("print (1 +\nprint 2")
    let t(stmts, errs) = parse(toks)
    assert_eq(errs.len(), 1)
    assert_eq(stmts.len(), 1)                       // the second line still parses
}
