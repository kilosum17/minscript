package lint

// The linter's settings in mod.ms (spec §18.4): `c.tools([lint.setup(_{ deny: ["L_IMPLICIT_COPY"] })])`.
// Each lint is `allow` (off), `warn` (its default) or `deny` (an error); `strict` denies every lint
// that warns.

import "build.{Config, Tool}"

pub type Options {
    pub allow: Vec[str] = []
    pub warn: Vec[str] = []
    pub deny: Vec[str] = []
    pub strict: bool = false
}

pub fn setup(o: Options) -> Tool {
    #{ c: Config =>
        var out = c
        out.set_section("lint", o)
        out
    }
}
