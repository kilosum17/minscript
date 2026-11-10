// E_SECTION_CONFLICT: two tools write the same section (§17.4).
package mod

import "build.*"
import "ms.fmt"

pub fn config() -> Config {
    let c = Config { name: "conflict", version: "0.1.0" }
    c.tools([fmt.setup(_{ indent: 2 }), fmt.setup(_{ indent: 4 })])
}
