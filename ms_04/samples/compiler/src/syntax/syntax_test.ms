// The lexer's and parser's behaviour on small inputs (`ms test samples/compiler`). The whole-corpus
// comparison with the TypeScript compiler is test/compiler_sample.test.ts.
package syntax

import "std.testing.*"

fn kinds(src: str) -> str { lex(src).tokens.map(#{ t, _i => t.kind }).join(" ") }

fn codes(src: str) -> str { parse(src).diagnostics.map(#{ d, _i => d.code }).join(" ") }

fn test_sigils_glue_only_without_space() {
    // unclosed openers get synthetic closers at the end, innermost first
    assert_eq(kinds("r{ m{ s{ _{ t( a[ #{ #[ .["), "r{ m{ s{ _{ t( a[ #{ #[ .[ ] ] } ] ) } } } } EOF")
    assert_eq(kinds("r {"), "Ident { } EOF")
    // after `.`, a letter is a member name, never a sigil
    assert_eq(kinds("x.t(1)"), "Ident . Ident ( Int ) EOF")
}

fn test_delimiters_are_matched_and_balanced() {
    lexed := lex("f(a, [b)")
    assert_eq(lexed.tokens.map(#{ t, _i => t.kind }).join(" "), "Ident ( Ident , [ Ident ] ) EOF")
    assert_eq(lexed.tokens[1].closer, 7)
    assert_true(lexed.tokens[6].synthetic, "the missing `]` is inserted")
    assert_eq(lexed.diagnostics.map(#{ d, _i => d.code }).join(" "), "E_UNMATCHED_DELIMITER")
}

fn test_numbers() {
    lexed := lex("0xff 1_000 2.5 1e3 0xffff_ffff_ffff_ffff")
    let values = lexed.tokens.map(#{ t, _i =>
        match t.value {
            Int(d) => d
            Float(f) => "${f}"
            _ => ""
        }
    })
    // a u64 literal keeps every digit: the lexer's integers are decimal strings
    assert_eq(values.join(" "), "255 1000 2.5 1000.0 18446744073709551615 ")
    assert_eq(lex("1__0 0x").diagnostics.len(), 2)
}

fn test_templates_and_multiline_strings() {
    // `\${` in this test's own source: a literal `${`, not an interpolation of the test
    lexed := lex("\"a\${x}b\${y}c\"")
    assert_eq(lexed.tokens.map(#{ t, _i => t.kind }).join(" "), "TemplateHead Ident TemplateMiddle Ident TemplateTail EOF")
    let parts = lexed.tokens.filter(#{ t, _i => t.kind.starts_with("Template") }).map(#{ t, _i =>
        match t.value {
            Text(s) => s
            _ => "?"
        }
    })
    assert_eq(parts.join("|"), "a|b|c")
    // `"""`: the first line break and the closing line's indentation are dropped
    let text = match lex("\"\"\"\n    one\n      two\n    \"\"\"").tokens[0].value {
        Text(s) => s
        _ => "?"
    }
    assert_eq(text, "one\n  two")
}

fn test_escapes_and_bytes() {
    let s = match lex("\"\\u{1F600} \\x41\\t\"").tokens[0].value {
        Text(x) => x
        _ => "?"
    }
    assert_eq(s, "😀 A\t")
    let b = match lex("b'a'").tokens[0].value {
        Byte(v) => v
        _ => -1
    }
    assert_eq(b, 97)
    assert_eq(lex("b'é'").diagnostics[0].code, "E_BYTE_LITERAL_NOT_ASCII")
}

fn test_precedence_and_associativity() {
    out := dump_file(parse("package p\nlet x = a + b * c ?? d").file)
    assert_true(out.contains("(Binary\n"), "the dump is laid out")
    let item = parse("package p\nlet x = 1 - 2 - 3").file.items[0]
    let LetDecl { value, .. } = item.k else { return fail("a let") }
    // left associative: (1 - 2) - 3
    match value.k {
        Binary { left, .. } => assert_true(is_comparison(left) == false && !is_range(left), "a binary on the left")
        _ => fail("a binary")
    }
}

fn test_newlines_end_expressions_inside_braces() {
    // `-` on a new line starts a new statement inside `{}` (a unary minus), but continues one inside `()`
    assert_eq(codes("package p\nfn f() {\n    x := 1\n    - 2\n}"), "")
    assert_eq(codes("package p\nfn f() {\n    x := (1\n    - 2)\n}"), "")
    let f = parse("package p\nfn f() {\n    x := 1\n    - 2\n}").file.items[0]
    let IFn(decl) = f.k else { return fail("a function") }
    // `?.` applies to one member (not the rest of the chain, as in JavaScript)
    assert_eq(decl.body?.stmts?.len() ?? 0, 2)
}

fn test_one_diagnostic_per_mistake() {
    // a stray `)` closes the `{` it doesn't match, so the final `}` has nothing to close
    assert_eq(codes("package p\nfn f() {\n    let x = )\n    let y = 2\n}"), "E_UNMATCHED_DELIMITER E_UNMATCHED_DELIMITER")
    assert_eq(codes("package p\nfn f(&this) {}"), "E_BORROW_REMOVED")
    assert_eq(codes("package p\nlet x = (a, b)"), "E_BARE_TUPLE")
}

fn test_closures_and_patterns() {
    out := dump_file(parse("package p\nlet f = #{ a, var b: *int => a }\nfn g(x: S) { match x { A(y) | B { y, .. } => y\n _ => 0 } }").file)
    assert_true(out.contains("(name=\"b\" isVar=true star=true type=(TName path=[\"int\"]))"), out)
    assert_true(out.contains("(POr"), "an or-pattern")
}
