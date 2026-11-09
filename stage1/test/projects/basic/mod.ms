// A project (spec §17): `main` defaults to ./src, `shared` is a `path:` dependency, and three kinds
// of scripts. `ms config test/projects/basic` prints the evaluated config.
package mod

import "build.*"
import "ms.fmt"

pub fun config() -> Config {
    var c = Config {
        name: "basic"
        version: "0.1.0"
        deps: m{
            "shared": "path:../shared"
            "http": "^2.1.0"                    // registry: not fetched yet, and not imported here
        }
        scripts: m{
            "hello": sh("echo hello from a shell script")
            "gen": pkg("./tools/gen")
            "check": task(#{ args =>
                log.println("task args: ${args.len()}, verbose: ${args.has("--verbose")}")
                Ok()
            })
        }
    }

    if env.get("BASIC_EXTRA") {
        c.deps["extra"] = "path:../extra"
    }

    c.tools([fmt.setup(_{ indent: 2 })])
}
