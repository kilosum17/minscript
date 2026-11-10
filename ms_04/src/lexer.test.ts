// Unit tests for lexer rules that snapshots don't pin down well (spec §1).

import assert from "node:assert/strict";
import { test } from "node:test";
import { lex } from "./lexer.ts";

const kinds = (src: string) => lex(src).tokens.map((t) => t.kind);
const values = (src: string) => lex(src).tokens.filter((t) => t.value !== undefined).map((t) => t.value);
const codes = (src: string) => lex(src).diagnostics.map((d) => d.code);

test('""" strips the closing line\'s indentation and drops the first and last lines', () => {
    assert.deepEqual(values('"""\n    a\n      b\n    """'), ["a\n  b"]);
});

test('""" closing after text strips nothing', () => {
    assert.deepEqual(values('"""\n  a\n  b"""'), ["  a\n  b"]);
});

test('""" lines indented less lose only what they share with the closing line', () => {
    assert.deepEqual(values('"""\n    a\n  b\n    """'), ["a\nb"]);
});

test("escapes are never stripped and don't count as line breaks", () => {
    assert.deepEqual(values('"""\n  \\ta\\n  b\n  """'), ["\ta\n  b"]);
});

test("CRLF becomes LF inside strings", () => {
    assert.deepEqual(values('"""\r\n  a\r\n  b\r\n  """'), ["a\nb"]);
});

test("templates balance and record their tail", () => {
    const r = lex('"a${f(x)}b${y}c"');
    assert.deepEqual(r.tokens.map((t) => t.kind), ["TemplateHead", "Ident", "(", "Ident", ")", "TemplateMiddle", "Ident", "TemplateTail", "EOF"]);
    assert.equal(r.tokens[0]!.match, 7);
    assert.deepEqual(r.diagnostics, []);
});

test("an unclosed opener at EOF gets a synthetic closer and one diagnostic", () => {
    const r = lex("f(a, [b");
    assert.deepEqual(r.tokens.map((t) => t.kind + (t.synthetic ? "*" : "")), ["Ident", "(", "Ident", ",", "[", "Ident", "]*", ")*", "EOF"]);
    assert.deepEqual(r.diagnostics.map((d) => d.code), ["E_UNMATCHED_DELIMITER", "E_UNMATCHED_DELIMITER"]);
});

test("a mismatched closer is lexed as the expected one", () => {
    assert.deepEqual(kinds("(a]"), ["(", "Ident", ")", "EOF"]);
    assert.deepEqual(codes("(a]"), ["E_UNMATCHED_DELIMITER"]);
});

test("sigils glue only to a one-letter name, and not after `.` or `fn`", () => {
    assert.deepEqual(kinds("t(1) t (1) x.t(1) fn t(x)"), [
        "t(", "Int", ")", "Ident", "(", "Int", ")", "Ident", ".", "Ident", "(", "Int", ")", "fn", "Ident", "(", "Ident", ")", "EOF",
    ]);
});

test("byte literals: b' glued, values are u8", () => {
    assert.deepEqual(values("b'a' b'\\n' b'\\x80' b'\\''"), [97, 10, 128, 39]);
    assert.deepEqual(kinds("b 'a'"), ["Ident", "Char", "EOF"]);
});

test("keywords after `.` are identifiers; contextual keywords are identifiers", () => {
    assert.deepEqual(kinds("x.lock shared once lock"), ["Ident", ".", "Ident", "Ident", "Ident", "lock", "EOF"]);
});

test("number lexing rules (§1.5)", () => {
    assert.deepEqual(kinds("1..10"), ["Int", "..", "Int", "EOF"]);
    assert.deepEqual(kinds("t.0.1"), ["Ident", ".", "Int", ".", "Int", "EOF"]);
    assert.deepEqual(values("1_000 0xFF 2.5e-3"), [1000n, 255n, 0.0025]);
    assert.deepEqual(codes("x = .5"), ["E_INVALID_NUMBER"]);
    assert.deepEqual(codes("x.5"), []);
});

test("nlBefore counts newlines inside block comments", () => {
    const r = lex("a /* \n */ b");
    assert.equal(r.tokens[1]!.nlBefore, true);
});
