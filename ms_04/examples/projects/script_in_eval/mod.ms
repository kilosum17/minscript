// Calling `run` while config() is evaluated is E_SCRIPT_IN_EVAL (spec §17.3): evaluating the
// configuration must not execute anything.
package mod

import "build.*"

pub fn config() -> Config {
    let _ = run("echo this must not run")
    Config { name: "bad", version: "0.0.1" }
}
