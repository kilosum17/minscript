// Unit tests of the stage-1 lowering (`ms test` in stage1/). The differential test checks it against
// stage 0 on every file; these pin down single behaviours, with a small prelude.
package hir

import "std.testing.*"
import "std.utf8"
import "app.parser.{parse, parse_from}"
import "app.resolve.{resolve_package, ResolveOptions}"
import "app.check.{check_package}"

fun mini_prelude() -> string {
    ["package std", "pub union Option[T] = { Some(T)  None }", "pub union Result[T, E] = { Ok(T)  Err(E) }",
        "pub type Vec[T] = { pub fun len(&this) -> int { 0 } }", ""].join("\n")
}

/// The HIR dump of `src` (in a package of its own).
fun lowered(src: &str) -> string {
    let pp = parse(utf8.encode(mini_prelude()))
    let prelude = resolve_package([pp.file], None, ResolveOptions { std: true, package_name: "std" })
    let p = parse_from(utf8.encode("package p\n${src}\n"), pp.next_id)
    let res = resolve_package([p.file], Some(prelude.clone()), ResolveOptions {})
    let checked = check_package([p.file], res, pp.file, prelude)
    dump_hir(lower_package([p.file], res, checked, pp.file, prelude, Set.new()), checked.vars, res.symbols)
}

fun test_functions_and_types() {
    let out = lowered("type P = { x: int, y: int = 2 }\nfun make() -> P { P { x: 1 } }")
    assert_true(out.contains("(struct P (fields x y))"), "a struct type")
    assert_true(out.contains("(fun make (params) -> P (do (struct P (x 1) (y 2))))"), "defaults are filled in")
}

fun test_sugar_becomes_match() {
    let out = lowered("fun f(o: int?) -> int { o ?? 0 }")
    assert_true(out.contains("(match o ((ok $v) $v) (_ 0))"), "`??` is a match")
    let tried = lowered("fun g(o: int?) -> int? {\n    let v = o?\n    Some(v + 1)\n}")
    assert_true(tried.contains("((ok $v) $v)") && tried.contains("(_ (return $t))"), "`?` returns the failure")
}

fun test_loops_and_shadowing() {
    let out = lowered("fun f() {\n    var total = 0\n    for i in 0..3 {\n        let total = i\n    }\n}")
    assert_true(out.contains("(step (+= $i 1))"), "a range is a counter loop")
    assert_true(out.contains("total'2"), "a shadowing local gets a suffix")
}

fun test_variants_and_literals() {
    let out = lowered("union S = { A  B(int) }\nfun f(n: int) -> S { if n > 0 { B(n) } else { A } }\nfun g() -> f64 { 2.0 }")
    assert_true(out.contains("(S.B n)") && out.contains("S.A"), "inferred variants are qualified")
    assert_true(out.contains("(do 2.0)"), "an integral float prints with `.0`")
}
