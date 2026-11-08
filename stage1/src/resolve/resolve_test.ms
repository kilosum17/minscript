// Unit tests of the stage-1 resolver (`ms test` in stage1/). The differential test checks it against
// stage 0 on every file; these pin down single behaviours, without the prelude.
package resolve

import "std.testing.*"
import "std.utf8"
import "app.parser.{parse}"

fun resolved(src: &str) -> string {
    let p = parse(utf8.encode("package p\n${src}\n"))
    dump_resolution(resolve_package([p.file], None, ResolveOptions {}))
}

fun codes(src: &str) -> string {
    let p = parse(utf8.encode("package p\n${src}\n"))
    resolve_package([p.file], None, ResolveOptions {}).diagnostics.map(#{ d => d.code.clone() }).join(" ")
}

fun test_locals_shadowing_and_items() {
    let out = resolved("fun f(a: int) -> int {\n    let b = a\n    {\n        let a = b\n        a\n    }\n}")
    assert_true(out.contains("3:13    a → 2:7 param"), "the parameter")
    assert_true(out.contains("5:17    b → 3:9 local"), "the outer local")
    assert_true(out.contains("6:9     a → 5:13 local"), "the inner `a` shadows the parameter")
    assert_true(out.contains("2:10    int → builtin"), "a built-in type")
}

fun test_order_independent_items() {
    assert_eq(codes("fun f() -> int { g() }\nfun g() -> int { 1 }"), "")
    assert_eq(codes("fun f() {}\nfun f() {}"), "E_DUPLICATE_DECLARATION")
}

fun test_captures() {
    let out = resolved("fun f() {\n    var total = 0\n    let add = #{ total += it }\n}")
    assert_true(out.contains("closure captures total@3:9"), "a closure captures the outer local")
    assert_true(out.contains("it → implicit it"), "`it` is the closure's implicit parameter")
}

fun test_errors() {
    assert_eq(codes("fun f() { y = 1 }"), "E_UNDECLARED_ASSIGNMENT")
    assert_eq(codes("fun f() { let a = 1\n let a = 2 }"), "E_DUPLICATE_BINDING")
    assert_eq(codes("fun f() { this }"), "E_THIS_OUTSIDE_METHOD")
    assert_eq(codes("fun f(o: int) { match o { 1 | x => 0 } }"), "E_INCONSISTENT_OR_BINDINGS")
    assert_eq(codes("fun f() { let it = 1 }"), "E_RESERVED_IDENT")
}

fun test_deferred_names() {
    let out = resolved("fun f() { let s = Circle(1.0) }")
    assert_true(out.contains("Circle → deferred"), "an uppercase name may be a variant of the expected type")
}
