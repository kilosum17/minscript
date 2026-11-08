// std/build's tests: the parts of the mod.ms API written in MinScript.
package build

import "std.testing.*"

fun test_args() {
    let a = Args { list: ["--publish", "x"] }
    assert_true(a.has("--publish"), "has the flag")
    assert_true(!a.has("--dry-run"), "doesn't have another flag")
    assert_eq(a.len(), 2)
    assert_eq(a.get(1) ?? "", "x")
}

fun test_tools_run_in_order() {
    var c = Config { name: "t", version: "0.0.1" }
    let first: Tool = #{ mut cfg =>
        cfg.deps["a"] = "path:./a"
        cfg
    }
    let second: Tool = #{ mut cfg =>
        cfg.deps["a"] = "path:./b"            // sees and overwrites the first tool's entry
        cfg
    }
    c = c.tools([first, second])
    assert_eq(c.deps.get("a") ?? "", "path:./b")
}

type Opts = { level: int = 1  name: string = "x" }

fun test_sections() {
    var c = Config { name: "t", version: "0.0.1" }
    c.set_section("demo", Opts { level: 3 })
    let back = assert_ok(c.section.[Opts]("demo"))
    assert_eq(back.level, 3)
    assert_eq(back.name, "x")
    let _ = assert_err(c.section.[Opts]("nope"))
}

fun test_scripts() {
    match sh("echo hi") {
        Shell(cmd) => assert_eq(cmd, "echo hi")
        _ => fail("sh makes a Shell script")
    }
}
