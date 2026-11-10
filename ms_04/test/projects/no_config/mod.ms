// E_CONFIG_FAILED: a mod.ms must declare `pub fn config() -> Config` (§17.1).
package mod

import "build.*"

pub fn settings() -> Config { Config { name: "x", version: "0.1.0" } }
