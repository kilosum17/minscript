// shop: a small order-processing service. Workers take orders from a queue, check and price each
// one in parallel, charge a payment gateway and book the sale into shared store state.
// `ms run samples/shop`.
package mod

import "build.*"
import "ms.fmt"

pub fn config() -> Config {
    var c = Config {
        name: "shop"
        version: "0.1.0"
        scripts: m{
            "demo": sh("ms run .")
            "check": task(#{ args =>
                run("ms test .")?
                if args.has("--strict") {
                    run("ms lint . --deny L_IMPLICIT_COPY")?
                }
                Ok()
            })
        }
    }
    if env.get("CI") {
        c.scripts["ci"] = sh("ms test . --reporter junit")
    }
    c.tools([fmt.setup(_{ indent: 4 })])
}
