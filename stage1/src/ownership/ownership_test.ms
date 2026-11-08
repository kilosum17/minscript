// Unit tests of the stage-1 ownership pass (`ms test` in stage1/). The differential test checks it
// against stage 0 on every file; these pin down single behaviours, with a small prelude.
package ownership

import "std.testing.*"
import "std.utf8"
import "app.parser.{parse, parse_from}"
import "app.resolve.{resolve_package, ResolveOptions}"
import "app.check.{check_package}"

fun mini_prelude() -> string {
    ["package std", "pub union Option[T] = { Some(T)  None }", "pub type Vec[T] = { pub fun len(&this) -> int { 0 } }", ""].join("\n")
}

fun decls() -> string {
    ["type User = { name: string }", "fun take(u: User) {}", "fun look(u: &User) {}", "fun store(f: (int) -> int) {}"].join("\n")
}

/// Ownership diagnostics of `src` as `CODE@line`, lines counted from the first line of `src`.
fun codes(src: &str) -> string {
    let pp = parse(utf8.encode(mini_prelude()))
    let prelude = resolve_package([pp.file], None, ResolveOptions { std: true, package_name: "std" })
    let p = parse_from(utf8.encode("package p\n${decls()}\n${src}\n"), pp.next_id)
    let res = resolve_package([p.file], Some(prelude.clone()), ResolveOptions {})
    let checked = check_package([p.file], res, pp.file, prelude)
    let ds = check_ownership([p.file], res, checked)
    ds.map(#{ d => "${d.code}@${d.span.line - 5}" }).join(" ")
}

fun test_moves_and_branches() {
    assert_eq(codes("fun f() {\n let u = User { name: \"a\" }\n take(u)\n look(u)\n}"), "E_USE_AFTER_MOVE@4")
    assert_eq(codes("fun f(c: bool) {\n let u = User { name: \"a\" }\n if c { take(u) }\n look(u)\n}"), "E_USE_AFTER_MOVE@4")
    assert_eq(codes("fun f(c: bool) {\n let u = User { name: \"a\" }\n if c { take(u) } else { take(u) }\n}"), "")
    assert_eq(codes("fun f(c: bool) {\n let u = User { name: \"a\" }\n if c {\n take(u)\n return\n }\n look(u)\n}"), "")
}

fun test_loops_run_twice() {
    assert_eq(codes("fun f() {\n let u = User { name: \"a\" }\n for i in [1, 2] {\n take(u)\n }\n}"), "E_USE_AFTER_MOVE@4")
}

fun test_mutability() {
    assert_eq(codes("fun f() {\n let n = 1\n n = 2\n}"), "E_ASSIGN_IMMUTABLE@3")
    assert_eq(codes("fun f() {\n var n = 1\n n = 2\n}"), "")
    assert_eq(codes("fun f(u: &User) {\n u.name = \"b\"\n}"), "E_ASSIGN_IMMUTABLE@2")
}

fun test_borrows_and_closures() {
    assert_eq(codes("fun f(u: &User) -> User {\n u\n}"), "E_MOVE_OUT_OF_BORROW@2")
    assert_eq(codes("fun f() {\n let k = 3\n store(#{ it * k })\n}"), "E_CLOSURE_ESCAPES_BORROW@3")
    assert_eq(codes("fun f() {\n let k = 3\n store(#[k]{ it * k })\n}"), "")
}

fun test_borrow_types() {
    assert_eq(find_borrow_type_text("&mut Vec[int]"), "&mut Vec[int]")
    assert_eq(find_borrow_type_text("Vec[Slice[u8]]?"), "Slice[u8]")
    assert_eq(find_borrow_type_text("t(int, string)"), "")
}

/// The borrow `find_borrow_type` finds in a written type ("" for none).
fun find_borrow_type_text(ty: &str) -> string {
    let p = parse(utf8.encode("package p\nlet x: ${ty} = 0\n"))
    let Some(Let(d)) = p.file.items.get(0) else { return "?" }
    let Some(t) = &d.ty else { return "?" }
    find_borrow_type(t) ?? ""
}
