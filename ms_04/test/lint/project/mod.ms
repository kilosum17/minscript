// Lint levels from mod.ms (§18.4): `allow` silences a lint, `deny` makes it an error.
package mod

import "build.*"

pub fn config() -> Config {
    var c = Config { name: "lint_levels", version: "0.1.0" }
    c.tools([lint.setup(_{ allow: ["L_NESTED_LOCK"], deny: ["L_INT_NOT_PORTABLE"] })])
}
