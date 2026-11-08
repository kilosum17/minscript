// Unit tests of the stage-1 checker (`ms test` in stage1/). The differential test checks it against
// stage 0 on every file; these pin down single behaviours, with a small prelude.
package check

import "std.testing.*"
import "std.utf8"
import "app.parser.{parse, parse_from}"
import "app.resolve.{resolve_package, ResolveOptions}"

fun mini_prelude() -> string {
    ["package std", "pub union Option[T] = { Some(T)  None }", "pub union Result[T, E] = { Ok(T)  Err(E) }",
        "pub type Vec[T] = { pub fun len(&this) -> int { 0 } }", ""].join("\n")
}

/// The `.types` dump of `src` (in a package of its own), and its checker diagnostic codes.
fun checked(src: &str) -> t(string, string) {
    let pp = parse(utf8.encode(mini_prelude()))
    let prelude = resolve_package([pp.file], None, ResolveOptions { std: true, package_name: "std" })
    let p = parse_from(utf8.encode("package p\n${src}\n"), pp.next_id)
    let res = resolve_package([p.file], Some(prelude.clone()), ResolveOptions {})
    let c = check_package([p.file], res, pp.file, prelude)
    t(dump_types(res, c), c.diagnostics.map(#{ d => d.code.clone() }).join(" "))
}

fun test_literals_default_and_flow() {
    let t(out, codes) = checked("fun f() {\n    let n = 1\n    let x = 2.5\n    let xs = [n]\n    var s = \"a\"\n    s += \"b\"\n}")
    assert_eq(codes, "")
    assert_true(out.contains("3:9     n: int"), "an integer literal defaults to int")
    assert_true(out.contains("4:9     x: f64"), "a float literal defaults to f64")
    assert_true(out.contains("5:9     xs: Vec[int]"), "a Vec literal takes its elements' type")
}

fun test_generic_calls_and_closures() {
    let t(out, codes) = checked("fun id[T](x: T) -> T { x }\nfun f() {\n    let a = id(\"s\")\n    let g = #{ k: int => k + 1 }\n}")
    assert_eq(codes, "")
    assert_true(out.contains("a: string"), "the generic is bound by the argument")
    assert_true(out.contains("g: (int) -> int"), "a closure's type")
}

fun test_variants_from_the_expected_type() {
    let t(_, codes) = checked("union Shape = { Dot  Line(int) }\nfun f(n: int) -> Shape {\n    if n > 0 { Line(n) } else { Dot }\n}")
    assert_eq(codes, "")
    let t(_, unknown) = checked("fun f() { let s = Line(1) }")
    assert_eq(unknown, "E_CANNOT_INFER_VARIANT")
}

fun test_errors() {
    assert_eq(checked("fun f() -> int { \"s\" }").1, "E_TYPE_MISMATCH")
    assert_eq(checked("fun f() { let xs = [] }").1, "E_CANNOT_INFER_TYPE")
    assert_eq(checked("fun f(o: int?) -> int {\n    match o { Some(v) => v }\n}").1, "E_NON_EXHAUSTIVE_MATCH")
    assert_eq(checked("fun f() { let n: u8 = 300 }").1, "E_INT_OUT_OF_RANGE")
    assert_eq(checked("fun f(a: int) { let b = a(1) }").1, "E_NOT_CALLABLE")
    assert_eq(checked("fun g(a: int) {}\nfun f() { g() }").1, "E_ARG_COUNT")
}

fun test_decimal_ranges_and_widening() {
    assert_eq(dec_cmp("-129", "-128"), -1)
    assert_eq(dec_cmp("18446744073709551615", "18446744073709551614"), 1)
    assert_eq(dec_cmp("007", "7"), 0)
    assert_eq(dec_neg("0"), "0")
    assert_eq(dec_neg("-5"), "5")
    assert_true(widens("u8", "i16") && widens("i32", "f64") && widens("int", "i64"), "lossless widenings")
    assert_true(!widens("i64", "i32") && !widens("u32", "i32") && !widens("i8", "u16"), "lossy ones")
}
