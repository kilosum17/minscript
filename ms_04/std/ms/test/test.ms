package test

// The test runner's settings in mod.ms (§17.4): `c.tools([test.setup(_{ reporter: "dots" })])`.
// The runner itself is `std.testing.run_all` (it imports nothing, so every package can be tested).

import "build.{Config, Tool, sh}"

pub type Options {
    pub parallel: bool = false
    /// "spec" (one line per test) or "dots".
    pub reporter: str = "spec"
}

/// Stores the settings, and adds `ms run test` unless the project defines its own.
pub fn setup(o: Options) -> Tool {
    #{ c: Config =>
        var out = c
        if !out.scripts.has("test") {
            out.scripts["test"] = sh("ms test${if o.parallel { " --parallel" } else { "" }}")
        }
        out.set_section("test", o)
        out
    }
}
