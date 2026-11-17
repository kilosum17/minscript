package fmt

// The formatter's settings in mod.ms (spec §17.4): `c.tools([fmt.setup(_{ indent: 4 })])`.

import "build.{Config, Tool}"

pub type Options {
    pub indent: int = 4
    pub max_width: int = 100
    pub trailing_commas: bool = true
}

pub fn setup(o: Options) -> Tool {
    #{ c: Config =>
        var out = c
        out.set_section("fmt", o)
        out
    }
}
