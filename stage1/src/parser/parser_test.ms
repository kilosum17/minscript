// Unit tests of the stage-1 parser (`ms test` in stage1/). The differential test checks it against
// stage 0 on every file; these pin down single behaviours.
package parser

import "std.testing.*"
import "std.utf8"
import "app.ast.{print_file}"

fun ast_of(src: &str) -> string {
    let res = parse(utf8.encode("package p\n${src}\n"))
    print_file(res.file)
}

fun codes(src: &str) -> string {
    let res = parse(utf8.encode("package p\n${src}\n"))
    res.diagnostics.map(#{ d => d.code.clone() }).join(" ")
}

fun test_precedence() {
    assert_eq(ast_of("let a = 1 + 2 * 3"), "(file p (let a (+ 1 (* 2 3))))\n")
    assert_eq(ast_of("let b = x ?? y as int"), "(file p (let b (?? x (as y int))))\n")
}

fun test_functions_and_types() {
    assert_eq(ast_of("fun f[T: Stringer](x: &T, ...rest: int) -> T? { x }"),
        "(file p (fun f (generics (T Stringer)) (params (x (& T)) (...rest int)) (-> (Option T)) (block x)))\n")
}

fun test_closures_and_postfix() {
    assert_eq(ast_of("fun g() { xs.map(#{ n => n * 2 })?.len() }"),
        "(file p (fun g (params) (block (call (?. (call (. xs map) (closure (params n) (* n 2))) len)))))\n")
}

fun test_newlines_end_statements() {
    assert_eq(ast_of("fun h() {\n    a\n    -1\n}"), "(file p (fun h (params) (block a (- 1))))\n")
    assert_eq(ast_of("fun h() {\n    a\n        .b()\n}"), "(file p (fun h (params) (block (call (. a b)))))\n")
}

fun test_patterns() {
    assert_eq(ast_of("fun k(v: int?) { match v { Some(1..=5) | None => 0, _ => 1 } }"),
        "(file p\n  (fun k (params (v (Option int))) (block (match v (=> (| (Some (..= 1 5)) None) 0) (=> _ 1)))))\n")   // wider than 100: broken
}

fun test_one_diagnostic_per_mistake() {
    assert_eq(codes("fun a() { let v: Vec<int> = [] }"), "E_ANGLE_GENERICS")
    assert_eq(codes("fun b() { while x { } }"), "E_RESERVED_KEYWORD")
    assert_eq(codes("fun c() { let f = (a) => a }"), "E_ARROW_CLOSURE")
}

fun test_recovery_keeps_going() {
    // a broken item doesn't hide the next one
    let res = parse(utf8.encode("package p\nfun a( {\nfun b() { 1 }\n"))
    assert_true(res.diagnostics.len() >= 1, "the error is reported")
    assert_true(print_file(res.file).contains("(fun b"), "the next function is still parsed")
}
