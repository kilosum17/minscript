// calc: a tiny expression language, built the way the v0.4 spec wants compilers built (§12):
// tokens and AST nodes are identity values, names are interned Symbols, passes attach their
// results through `once` fields, and scopes are persistent maps. `ms run samples/calc [file.calc…]`.
package mod

import "build.*"

pub fn config() -> Config {
    Config {
        name: "calc"
        version: "0.1.0"
        scripts: m{
            "demo": sh("ms run .")
            "test": sh("ms test .")
        }
    }
}
