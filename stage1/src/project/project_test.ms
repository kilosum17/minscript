package project

import "std.testing.*"
import "std.json"
import "app.parser.{parse}"
import "std.utf8"

fun test_pretty_matches_json_stringify() {
    let v = json.parse.[json.Value]("{\"a\":1,\"b\":{},\"c\":[],\"d\":[true,\"x\"],\"e\":{\"f\":null}}") or return fail("parses")
    let want = "{\n  \"a\": 1,\n  \"b\": {},\n  \"c\": [],\n  \"d\": [\n    true,\n    \"x\"\n  ],\n  \"e\": {\n    \"f\": null\n  }\n}"
    assert_eq(pretty(v, ""), want)
}

fun test_path_deps() {
    let deps = path_deps("/work/app", m{ "shared": "path:../shared", "http": "^2.1.0", "local": "path:./lib" })
    assert_eq(deps.len(), 2)
    assert_eq(deps.get("shared") ?? "", "/work/shared")
    assert_eq(deps.get("local") ?? "", "/work/app/lib")
}

fun test_quote() {
    assert_eq(quote("a b"), "'a b'")
    assert_eq(quote("it's"), "'it'\\''s'")
}

fun test_marker() {
    assert_eq(last_index_of("x\n@@ms-config@@a\n@@ms-config@@b", CONFIG_MARKER) ?? -1, 16)
    assert_true(last_index_of("nothing", CONFIG_MARKER).is_none(), "no marker")
}

fun test_signature_problems() {
    let src = "package x\nfun test_ok() {}\nfun test_args(n: int) {}\nfun test_ret() -> int { 1 }\nfun test_gen[T]() {}\n"
    let f = parse(utf8.encode(src)).file
    var problems = [] as Vec[string]
    for itm in f.items.iter() {
        if let Fun(fd) = itm {
            problems.push(signature_problem(fd) ?? "ok")
        }
    }
    assert_eq(problems.len(), 4)
    assert_eq(problems[0], "ok")
    assert_eq(problems[1], "test `test_args` takes no parameters")
    assert_eq(problems[2], "test `test_ret` returns nothing (fail it with an assertion or a panic)")
    assert_eq(problems[3], "test `test_gen` can't be generic")
}

fun test_harness_text() {
    let tests = PackageTests { dir: "/d", pkg: "models", tests: [TestFn { name: "test_a", is_async: false }, TestFn { name: "test_b", is_async: true }], problems: [] }
    let text = harness(tests, "src/models", "spec")
    assert_true(text.starts_with("package models\n\nimport \"std.testing\" as ms_testing\n"), text)
    assert_true(text.contains("ms_testing.TestFn.Sync(#{ test_a() })"), text)
    assert_true(text.contains("ms_testing.TestFn.Async(#{ test_b() })"), text)
    assert_true(text.contains("await ms_testing.run_all(\"src/models\", ["), text)
}
