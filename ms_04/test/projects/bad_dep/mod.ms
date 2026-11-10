// E_BAD_DEP_SPEC: a dependency value that is neither a semver range nor `path:` / `git:` (§17.2).
package mod

import "build.*"

pub fn config() -> Config {
    Config { name: "bad_dep", version: "0.1.0", deps: m{ "http": "latest please" } }
}
