import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { lex } from "./lexer.ts"
import type { Token } from "./token.ts"

// ---- helpers ----------------------------------------------------------------------------------

/** Compact token list without EOF: `kind` or `kind value`. */
function toks(src: string): string[] {
    const { tokens } = lex(src)
    return tokens.slice(0, -1).map(show)
}

function show(t: Token): string {
    if (t.value === undefined) return t.kind
    return `${t.kind} ${typeof t.value === "string" ? JSON.stringify(t.value) : String(t.value)}`
}

/** Tokens of a source that must lex without diagnostics. */
function clean(src: string): string[] {
    const res = lex(src)
    assert.deepEqual(res.diagnostics.map((d) => `${d.code}@${d.span.line}:${d.span.col}`), [], `unexpected diagnostics for ${JSON.stringify(src)}`)
    return res.tokens.slice(0, -1).map(show)
}

function codes(src: string): string[] {
    return lex(src).diagnostics.map((d) => d.code)
}

function value(src: string): unknown {
    const res = lex(src)
    assert.deepEqual(res.diagnostics, [])
    return res.tokens[0]!.value
}

// ---- tests ------------------------------------------------------------------------------------

describe("source", () => {
    test("empty input is just EOF", () => {
        const { tokens, diagnostics } = lex("")
        assert.equal(tokens.length, 1)
        assert.equal(tokens[0]!.kind, "EOF")
        assert.deepEqual(diagnostics, [])
    })

    test("BOM is skipped and columns start after it", () => {
        const { tokens } = lex("\uFEFFlet x")
        assert.equal(tokens[0]!.kind, "let")
        assert.equal(tokens[0]!.span.start, 3)
        assert.equal(tokens[0]!.span.col, 1)
    })

    test("CRLF is a newline; CRLF inside strings becomes LF", () => {
        const { tokens } = lex("a\r\nb")
        assert.equal(tokens[1]!.nl_before, true)
        assert.equal(tokens[1]!.span.line, 2)
        assert.equal(value("r\"x\r\ny\""), "x\ny")
        assert.equal(value("\"\"\"\r\n  a\r\n  b\r\n  \"\"\""), "a\nb")
    })

    test("spans are byte offsets; columns count code points", () => {
        const { tokens } = lex(`"é😀" x`)
        assert.deepEqual(tokens[0]!.span, { start: 0, end: 8, line: 1, col: 1 })
        assert.equal(tokens[1]!.span.start, 9)
        assert.equal(tokens[1]!.span.col, 6)
    })

    test("accepts bytes as well as strings", () => {
        const { tokens } = lex(new TextEncoder().encode("let x = 1"))
        assert.equal(tokens.length, 5)
    })
})

describe("whitespace flags", () => {
    test("nl_before and ws_before", () => {
        const { tokens } = lex("a b\nc(d)")
        const [a, b, c, lp, d] = tokens
        assert.deepEqual([a!.ws_before, a!.nl_before], [false, false])
        assert.deepEqual([b!.ws_before, b!.nl_before], [true, false])
        assert.deepEqual([c!.ws_before, c!.nl_before], [true, true])
        assert.deepEqual([lp!.ws_before, d!.ws_before], [false, false])
    })

    test("a comment counts as whitespace", () => {
        const { tokens } = lex("1/*x*/+2")
        assert.equal(tokens[1]!.kind, "+")
        assert.equal(tokens[1]!.ws_before, true)
    })

    test("a newline inside a block comment counts as a newline", () => {
        const { tokens } = lex("a /* x\n y */ b")
        assert.equal(tokens[1]!.nl_before, true)
        assert.equal(tokens[1]!.span.line, 2)
    })

    test("a line comment keeps the following newline", () => {
        const { tokens } = lex("a // c\nb")
        assert.equal(tokens[1]!.nl_before, true)
    })
})

describe("comments", () => {
    test("line, doc and block comments go to trivia", () => {
        const { trivia, tokens } = lex("/// doc\n// line\n//// not doc\n/* a /* nested */ b */ x")
        assert.deepEqual(trivia.map((t) => t.kind), ["doc", "line", "line", "block"])
        assert.equal(trivia[3]!.text, "/* a /* nested */ b */")
        assert.equal(tokens[0]!.kind, "Ident")
    })

    test("`//` inside a string is not a comment", () => {
        assert.deepEqual(clean(`"http://x" // c`), [`String "http://x"`])
    })

    test("unterminated block comment", () => {
        const res = lex("x /* a /* b */ c")
        assert.deepEqual(res.diagnostics.map((d) => d.code), ["E_UNTERMINATED_COMMENT"])
        assert.equal(res.diagnostics[0]!.span.col, 3)
        assert.equal(res.tokens.length, 2)
    })
})

describe("identifiers and keywords", () => {
    test("keywords lex as their own kind; prelude names are identifiers", () => {
        assert.deepEqual(clean("let var fun Some nil Self Selfish this_x _ _x"), [
            "let", "var", "fun", `Ident "Some"`, "nil", "Self", `Ident "Selfish"`, `Ident "this_x"`, "_", `Ident "_x"`,
        ])
    })

    test("reserved keywords are lexed as keywords (the parser reports them)", () => {
        assert.deepEqual(clean("while loop yield macro where dyn"), ["while", "loop", "yield", "macro", "where", "dyn"])
    })

    test("a keyword after `.` or `?.` is an identifier", () => {
        assert.deepEqual(clean("x.or(1) y?.in z.as.[T]"), [
            `Ident "x"`, ".", `Ident "or"`, "(", "Int 1", ")",
            `Ident "y"`, "?.", `Ident "in"`,
            `Ident "z"`, ".", `Ident "as"`, ".[", `Ident "T"`, "]",
        ])
    })

    test("implicit params are plain identifiers", () => {
        assert.deepEqual(clean("it it1 it10 it01"), [`Ident "it"`, `Ident "it1"`, `Ident "it10"`, `Ident "it01"`])
    })

    test("non-ASCII identifier characters are rejected", () => {
        const res = lex("let café = 1")
        assert.deepEqual(res.diagnostics.map((d) => d.code), ["E_UNKNOWN_CHARACTER"])
        assert.deepEqual(res.tokens.slice(0, -1).map(show), ["let", `Ident "caf"`, "=", "Int 1"])
    })

    test("stray characters", () => {
        assert.deepEqual(codes("a # b"), ["E_UNKNOWN_CHARACTER"])
        assert.deepEqual(codes("a ` b"), ["E_UNKNOWN_CHARACTER"])
        assert.deepEqual(codes("$x"), ["E_UNKNOWN_CHARACTER"])
    })
})

describe("sigils", () => {
    test("glued sigils are single tokens", () => {
        assert.deepEqual(clean(`r{} m{} s{} t() a[] _{} #{} #[x]{} f.[T]() r"raw"`), [
            "r{", "}", "m{", "}", "s{", "}", "t(", ")", "a[", "]", "_{", "}", "#{", "}",
            "#[", `Ident "x"`, "]", "{", "}",
            `Ident "f"`, ".[", `Ident "T"`, "]", "(", ")",
            `RawString "raw"`,
        ])
    })

    test("not glued, or part of a longer name: ordinary identifiers", () => {
        assert.deepEqual(clean("a [0] t (1) data[0] cat(1) rr{}"), [
            `Ident "a"`, "[", "Int 0", "]", `Ident "t"`, "(", "Int 1", ")",
            `Ident "data"`, "[", "Int 0", "]", `Ident "cat"`, "(", "Int 1", ")",
            `Ident "rr"`, "{", "}",
        ])
    })

    test("no glue after `.`, `?.`, `fun`, `type`, `union`, `inter`", () => {
        assert.deepEqual(clean("o.a[0] o?.t(1) fun t() type r{} union s{} inter m{}"), [
            `Ident "o"`, ".", `Ident "a"`, "[", "Int 0", "]",
            `Ident "o"`, "?.", `Ident "t"`, "(", "Int 1", ")",
            "fun", `Ident "t"`, "(", ")",
            "type", `Ident "r"`, "{", "}",
            "union", `Ident "s"`, "{", "}",
            "inter", `Ident "m"`, "{", "}",
        ])
    })

    test("sigils record their matching closer", () => {
        const { tokens } = lex("t(a, r{ b: [1] })")
        assert.equal(tokens[0]!.match, tokens.length - 2)
        assert.equal(tokens[tokens[3]!.match!]!.kind, "}")
    })
})

describe("numbers", () => {
    test("integers", () => {
        assert.deepEqual(clean("0 123 1_000_000 0xFF 0xdead_BEEF 0b1010 0o17"), [
            "Int 0", "Int 123", "Int 1000000", "Int 255", "Int 3735928559", "Int 10", "Int 15",
        ])
    })

    test("integers are bigints (range is checked later)", () => {
        assert.equal(value("18446744073709551616"), 18446744073709551616n)
    })

    test("floats", () => {
        assert.deepEqual(clean("1.5 1e9 2.5e-3 6.02E+23 1_000.5"), [
            "Float 1.5", "Float 1000000000", "Float 0.0025", "Float 6.02e+23", "Float 1000.5",
        ])
    })

    test("`.` joins the number only before a digit", () => {
        assert.deepEqual(clean("1..10 1..=2 1.to_str() 1.5.abs()"), [
            "Int 1", "..", "Int 10", "Int 1", "..=", "Int 2",
            "Int 1", ".", `Ident "to_str"`, "(", ")",
            "Float 1.5", ".", `Ident "abs"`, "(", ")",
        ])
    })

    test("after a member `.`, only digits: tuple indexing", () => {
        assert.deepEqual(clean("t.0.1 x?.1 (p).0"), [
            `Ident "t"`, ".", "Int 0", ".", "Int 1",
            `Ident "x"`, "?.", "Int 1",
            "(", `Ident "p"`, ")", ".", "Int 0",
        ])
    })

    test("unary minus is an operator", () => {
        assert.deepEqual(clean("-42 -0.5"), ["-", "Int 42", "-", "Float 0.5"])
    })

    test("invalid numbers", () => {
        for (const src of ["0x", "0b102", "0o8", "12px", "1e", "1_", "1__", "0x_1", "1.5_", "2.5e_1"]) {
            assert.ok(codes(src).includes("E_INVALID_NUMBER"), src)
        }
        assert.deepEqual(codes("x = .5"), ["E_INVALID_NUMBER"])
        assert.deepEqual(toks("x = .5"), [`Ident "x"`, "=", "Float 0.5"])
    })

    test("`.5` after a value is member access, not an invalid float", () => {
        assert.deepEqual(clean("t.5"), [`Ident "t"`, ".", "Int 5"])
    })

    test("an invalid number is one token", () => {
        assert.deepEqual(toks("0b102 + 1"), ["Int 0", "+", "Int 1"])
    })
})

describe("operators", () => {
    test("maximal munch", () => {
        const all = "... ..= .. . ??= ?? ?. ? :== := : <<= << <= < >>= >> >= > == => = != ! -> -= -- - += ++ + *= * /= / %= % && &= & || |= | ^= ^ ~ , ; @"
        assert.deepEqual(clean(all), all.split(" "))
    })

    test("glued operator runs", () => {
        assert.deepEqual(clean("a>>b a<b x:==1 a??=b"), [
            `Ident "a"`, ">>", `Ident "b"`, `Ident "a"`, "<", `Ident "b"`,
            `Ident "x"`, ":==", "Int 1", `Ident "a"`, "??=", `Ident "b"`,
        ])
    })

    test("`]]` is two closers", () => {
        assert.deepEqual(clean("Vec[Vec[int]]"), [`Ident "Vec"`, "[", `Ident "Vec"`, "[", `Ident "int"`, "]", "]"])
    })
})

describe("strings", () => {
    test("escapes", () => {
        assert.equal(value(String.raw`"\n\r\t\0\\\"\'\$\x41\u{1F600}"`), "\n\r\t\0\\\"'$A😀")
    })

    test("invalid escapes", () => {
        assert.deepEqual(codes(String.raw`"\q"`), ["E_INVALID_ESCAPE"])
        assert.deepEqual(codes(String.raw`"\xFF"`), ["E_INVALID_ESCAPE"])
        assert.deepEqual(codes(String.raw`"\x4"`), ["E_INVALID_ESCAPE"])
        assert.deepEqual(codes(String.raw`"\u41"`), ["E_INVALID_ESCAPE"])
        assert.deepEqual(codes(String.raw`"\u{D800}"`), ["E_INVALID_ESCAPE"])
        assert.deepEqual(codes(String.raw`"\u{110000}"`), ["E_INVALID_ESCAPE"])
        assert.deepEqual(codes(String.raw`"\u{1234567}"`), ["E_INVALID_ESCAPE"])
        // the string itself is still one token, with the character kept
        assert.deepEqual(toks(String.raw`"a\qb"`), [`String "aqb"`])
    })

    test("interpolation produces template tokens", () => {
        assert.deepEqual(clean(`"a\${x}b\${y + 1}c"`), [
            `TemplateHead "a"`, `Ident "x"`, `TemplateMiddle "b"`, `Ident "y"`, "+", "Int 1", `TemplateTail "c"`,
        ])
    })

    test("braces and strings nest inside an interpolation", () => {
        assert.deepEqual(clean(`"\${ r{ a: "}" }.a }"`), [
            `TemplateHead ""`, "r{", `Ident "a"`, ":", `String "}"`, "}", ".", `Ident "a"`, `TemplateTail ""`,
        ])
        assert.deepEqual(clean(`"o \${ "i \${d} e" } x"`), [
            `TemplateHead "o "`, `TemplateHead "i "`, `Ident "d"`, `TemplateTail " e"`, `TemplateTail " x"`,
        ])
    })

    test("`$` without `{`, and `\\$`, are literal", () => {
        assert.deepEqual(clean(`"$5 \\\${x}"`), [`String "$5 \${x}"`])
    })

    test("unterminated string ends at the newline", () => {
        const res = lex(`let s = "abc\nlet t = 1`)
        assert.deepEqual(res.diagnostics.map((d) => d.code), ["E_UNTERMINATED_STRING"])
        assert.deepEqual(res.tokens.slice(0, -1).map(show), ["let", `Ident "s"`, "=", `String "abc"`, "let", `Ident "t"`, "=", "Int 1"])
    })

    test("a single-line string's interpolation can't span lines", () => {
        const res = lex(`x = "a\${ b\ny = 1`)
        assert.deepEqual(res.diagnostics.map((d) => d.code), ["E_UNTERMINATED_STRING"])
        assert.deepEqual(res.tokens.slice(0, -1).map(show), [
            `Ident "x"`, "=", `TemplateHead "a"`, `Ident "b"`, `TemplateTail ""`, `Ident "y"`, "=", "Int 1",
        ])
    })

    test("unterminated string at EOF", () => {
        assert.deepEqual(codes(`"abc`), ["E_UNTERMINATED_STRING"])
        assert.deepEqual(codes(`"""abc`), ["E_UNTERMINATED_STRING"])
        assert.deepEqual(codes(`r"abc`), ["E_UNTERMINATED_STRING"])
        // unterminated interpolation: a synthetic tail keeps templates balanced
        const res = lex(`"""a\${b`)
        assert.deepEqual(res.diagnostics.map((d) => d.code), ["E_UNTERMINATED_STRING"])
        assert.deepEqual(res.tokens.slice(0, -1).map((t) => t.kind), ["TemplateHead", "Ident", "TemplateTail"])
    })

    test("raw strings: no escapes or interpolation, may span lines", () => {
        assert.equal(value(String.raw`r"C:\a\${x}"`), String.raw`C:\a\${x}`)
        assert.equal(value(`r"a\nb"`), "a\nb")
    })
})

describe("multi-line strings", () => {
    test("first newline dropped, closing-line indentation stripped", () => {
        const src = `"""\n    first\n      second\n    """`
        assert.equal(value(src), "first\n  second")
    })

    test("closing quotes after text: nothing stripped", () => {
        assert.equal(value(`"""\n  a\n  b"""`), "  a\n  b")
    })

    test("one line, with quotes inside", () => {
        assert.equal(value(`"""say "hi" ""ok"""`), `say "hi" ""ok`)
    })

    test("blank lines and less-indented lines", () => {
        assert.equal(value(`"""\n    a\n\n  b\n    """`), "a\n\nb")
    })

    test("escapes are not line breaks and are never stripped", () => {
        assert.equal(value(`"""\n    a\\n    b\n    \\tc\n    """`), "a\n    b\n\tc")
    })

    test("interpolation across lines", () => {
        const res = lex(`"""\n    hi \${\n  name\n}!\n    bye\n    """`)
        assert.deepEqual(res.diagnostics, [])
        assert.deepEqual(res.tokens.slice(0, -1).map(show), [`TemplateHead "hi "`, `Ident "name"`, `TemplateTail "!\\nbye"`])
        assert.equal(res.tokens[0]!.multiline, true)
        assert.equal(res.tokens[2]!.multiline, true)
    })

    test("empty", () => {
        assert.equal(value(`""""""`), "")
        assert.equal(value(`"""\n"""`), "")
    })

    test("line numbers continue after a multi-line string", () => {
        const { tokens } = lex(`"""\na\nb\n"""\nx`)
        assert.equal(tokens[1]!.span.line, 5)
        assert.equal(tokens[1]!.nl_before, true)
    })
})

describe("characters", () => {
    test("valid", () => {
        assert.deepEqual(clean(String.raw`'a' '\n' '\'' '\\' '\u{1F600}' '😀' '1'`), [
            `Char "a"`, `Char "\\n"`, `Char "'"`, `Char "\\\\"`, `Char "😀"`, `Char "😀"`, `Char "1"`,
        ])
    })

    test("invalid", () => {
        assert.deepEqual(codes("''"), ["E_INVALID_CHAR"])
        assert.deepEqual(codes("'ab'"), ["E_INVALID_CHAR"])
        assert.deepEqual(codes("'a"), ["E_INVALID_CHAR"])
        assert.deepEqual(codes("'a b'"), ["E_INVALID_CHAR", "E_INVALID_CHAR"])
    })

    test("'ab' recovers as one token", () => {
        assert.deepEqual(toks("'ab' + 1"), [`Char "a"`, "+", "Int 1"])
    })

    test("tagged records are rejected and recovered as `r{`", () => {
        const res = lex("'1{ id: 1 }")
        assert.deepEqual(res.diagnostics.map((d) => d.code), ["E_TAGGED_RECORD_REMOVED"])
        assert.deepEqual(res.tokens.slice(0, -1).map(show), ["r{", `Ident "id"`, ":", "Int 1", "}"])
        assert.equal(res.tokens[0]!.match, 4)
    })
})

describe("delimiters", () => {
    test("openers point at their closers", () => {
        const { tokens } = lex("f(x[1], { b })")
        const at = (i: number) => tokens[tokens[i]!.match!]!
        assert.equal(at(1).kind, ")")
        assert.equal(at(1).span.col, 14)
        assert.equal(at(3).kind, "]")
        assert.equal(at(7).kind, "}")
        assert.equal(tokens[0]!.match, undefined)
    })

    test("mismatched closer is reported once and replaced by the expected one", () => {
        const res = lex("{ x = (1 + 2] }")
        assert.deepEqual(res.diagnostics.map((d) => `${d.code}@${d.span.col}`), ["E_UNMATCHED_DELIMITER@13"])
        const kinds = res.tokens.map((t) => t.kind)
        assert.deepEqual(kinds, ["{", "Ident", "=", "(", "Int", "+", "Int", ")", "}", "EOF"])
        assert.equal(res.tokens[3]!.match, 7)
        assert.equal(res.tokens[0]!.match, 8)
    })

    test("a closer for an outer opener closes the inner ones", () => {
        const res = lex("{ f(1 }")
        assert.deepEqual(res.diagnostics.map((d) => `${d.code}@${d.span.col}`), ["E_UNMATCHED_DELIMITER@4"])
        assert.equal(res.tokens[0]!.match, 4)
    })

    test("stray closer with nothing open is dropped", () => {
        const res = lex("a ) b")
        assert.deepEqual(res.diagnostics.map((d) => d.code), ["E_UNMATCHED_DELIMITER"])
        assert.deepEqual(res.tokens.slice(0, -1).map(show), [`Ident "a"`, `Ident "b"`])
    })

    test("unclosed at EOF", () => {
        const res = lex("fun f() {\n  g(")
        assert.deepEqual(res.diagnostics.map((d) => `${d.code}@${d.span.line}:${d.span.col}`), [
            "E_UNMATCHED_DELIMITER@2:4", "E_UNMATCHED_DELIMITER@1:9",
        ])
    })

    test("`)` can't close an interpolation", () => {
        const res = lex(`"\${ a ) }"`)
        assert.deepEqual(res.diagnostics.map((d) => d.code), ["E_UNMATCHED_DELIMITER"])
        assert.deepEqual(res.tokens.slice(0, -1).map((t) => t.kind), ["TemplateHead", "Ident", "TemplateTail"])
    })

    test("`}` closes an interpolation through an unclosed `(`", () => {
        const res = lex(`"\${ f(a }"`)
        assert.deepEqual(res.diagnostics.map((d) => d.code), ["E_UNMATCHED_DELIMITER"])
        assert.deepEqual(res.tokens.slice(0, -1).map((t) => t.kind), ["TemplateHead", "Ident", "(", "Ident", "TemplateTail"])
    })
})

describe("robustness", () => {
    test("every prefix of a tricky input lexes, ends with EOF, and makes progress", () => {
        const src = `fun f() { x := "a\${ r{ b: '1' } }c" + """\n  m \${t.0.1}\n  """ /* c /* d */ */ 0x1F #[&mut y]{ it } }`
        for (let i = 0; i <= src.length; i++) {
            const res = lex(src.slice(0, i))
            const last = res.tokens[res.tokens.length - 1]!
            assert.equal(last.kind, "EOF")
            for (let k = 1; k < res.tokens.length; k++) {
                assert.ok(res.tokens[k]!.span.start >= res.tokens[k - 1]!.span.end, `overlapping tokens at prefix ${i}`)
            }
        }
    })

    test("deterministic", () => {
        const src = `let s = "a\${b}c"\nlet t = t(1, 2)`
        assert.deepEqual(lex(src), lex(src))
    })
})
