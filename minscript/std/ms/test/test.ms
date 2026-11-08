package test

// The test runner's settings in mod.ms (spec §17.4): `c.tools([test.setup(_{ parallel: true })])`.

import "build.{Config, Tool, sh}"

pub type Options = {
    pub parallel: bool = false
    pub reporter: string = "spec"
}

/// Stores the settings, and adds `ms run test` unless the project defines its own.
pub fun setup(o: Options) -> Tool {
    #[o]{ mut c =>
        if !c.scripts.has("test") {
            c.scripts["test"] = sh("ms test${if o.parallel { " --parallel" } else { "" }}")
        }
        c.set_section("test", o)
        c
    }
}
