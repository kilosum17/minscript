// stage1: the self-hosted MinScript compiler. `bin/ms1.js` runs the seed (seed/stage1.mjs, stage 1
// compiled by stage 1); stage 0 (../minscript) is the reference the difftest compares it with.
package mod

import "build.*"

pub fun config() -> Config {
    Config {
        name: "stage1"
        version: "0.0.1"
        scripts: m{
            // stage 0 and stage 1 must produce the same output on every file (tools/difftest.sh)
            "difftest": sh("bash tools/difftest.sh")
            // rebuild seed/stage1.mjs with the current seed (it must be a fixpoint)
            "reseed": sh("bash tools/seed.sh")
        }
    }
}
