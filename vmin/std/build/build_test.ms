// std/build's tests: the parts of the mod.ms API written in MinScript.
package build

import "std.testing.*"
import "std.json"

fn test_args() {
    let a = Args { list: ["--publish", "x"] }
    assert_true(a.has("--publish"), "has the flag")
    assert_true(!a.has("--dry-run"), "doesn't have another flag")
    assert_eq(a.len(), 2)
    assert_eq(a.get(1) ?? "", "x")
}

fn test_tools_run_in_order() {
    var c = Config { name: "t", version: "0.0.1" }
    let first: Tool = #{ cfg: Config =>
        var out = cfg
        out.deps["a"] = "path:./a"
        out
    }
    let second: Tool = #{ cfg: Config =>
        var out = cfg
        out.deps["a"] = "path:./b"            // sees and overwrites the first tool's entry
        out
    }
    c = c.tools([first, second])
    assert_eq(c.deps.get("a") ?? "", "path:./b")
}

type Opts { level: int = 1, name: str = "x" }

fn test_sections() {
    var c = Config { name: "t", version: "0.0.1" }
    c.set_section("demo", Opts { level: 3 })
    let back = assert_ok(c.section.[Opts]("demo"))
    assert_eq(back.level, 3)
    assert_eq(back.name, "x")
    // a real `Opts`: the witness of `T` reaches json.from_value through the generic `section[T]`
    assert_eq(back.to_str(), "build.Opts { level: 3, name: \"x\" }")
    let _ = assert_err(c.section.[Opts]("nope"))
}

fn test_scripts() {
    match sh("echo hi") {
        Shell(cmd) => assert_eq(cmd, "echo hi")
        _ => fail("sh makes a Shell script")
    }
}

fn test_describe() {
    var c = Config { name: "t", version: "0.0.1", deps: m{ "a": "path:./a" } }
    c.scripts["hi"] = sh("echo hi")
    c.scripts["gen"] = pkg("./gen")
    c.scripts["go"] = task(#{ _ => Ok() })
    c.set_section("demo", Opts { level: 3 })
    text := json.stringify(c.describe())
    want := "{\"name\":\"t\",\"version\":\"0.0.1\",\"main\":\"\",\"deps\":{\"a\":\"path:./a\"},\"dev_deps\":{},"
    assert_eq(text, want + "\"scripts\":{\"hi\":{\"sh\":\"echo hi\"},\"gen\":{\"pkg\":\"./gen\"},\"go\":{\"task\":\"<MinScript>\"}},\"sections\":{\"demo\":{\"level\":3,\"name\":\"x\"}}}")
}

fn test_evaluate() {
    let c = evaluate(#{ Config { name: "ok", version: "1.0.0" } })
    assert_eq(c.name, "ok")
    // `run` while config() is evaluated is E_SCRIPT_IN_EVAL
    let r = recover {
        evaluate(#{
            let _ = run("echo this must not run")
            Config { name: "bad", version: "0.0.1" }
        })
    }
    match r {
        Ok(_) => fail("run while evaluating panics")
        Err(p) => assert_true(p.message.starts_with("E_SCRIPT_IN_EVAL"), p.message)
    }
}
