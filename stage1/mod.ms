// stage1: the self-hosted MinScript compiler. Compiled by stage 0 (../minscript) for now.
package mod

import "build.*"

pub fun config() -> Config {
    Config {
        name: "stage1"
        version: "0.0.1"
        scripts: m{
            // stage 0 and stage 1 must produce the same output on every file (tools/difftest.sh)
            "difftest": sh("bash tools/difftest.sh")
        }
    }
}
