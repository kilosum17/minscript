package fmt

// The formatter's settings in mod.ms (spec §17.4): `c.tools([fmt.setup(_{ indent: 4 })])`.
// The formatter itself isn't written yet; it will read these with `cfg.section.[fmt.Options]("fmt")`.

import "build.{Config, Tool}"

pub type Options = {
    pub indent: int = 4
    pub max_width: int = 100
    pub trailing_commas: bool = true
}

pub fun setup(o: Options) -> Tool {
    #[o]{ mut c =>
        c.set_section("fmt", o)
        c
    }
}
