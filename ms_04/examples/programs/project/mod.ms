// Project file example (spec §17). Must parse like any other MinScript file.
package mod

import "build.*"
import "ms.fmt"
import "ms.test"
// A third-party tool pins its version in the import (spec §17.5). Registry packages aren't fetched
// yet, so it is commented out here to keep the project runnable:
// import "acme.lint@^1.2"

pub fn config() -> Config {
    var c = Config {
        name: "sample1"
        version: "1.0.1"
        main: "./src"

        deps: m{
            "http": "^2.1.0"
            "utils": "path:../utils"
            "orm": "git:github.com/acme/orm#v0.4.1"
        }

        dev_deps: m{
            "mock": "^0.2"
        }

        scripts: m{
            "dev": sh("ms build --target js --watch --hot")
            "test": sh("ms test --parallel")
            "migrate": pkg("./tools/migrate")
            "release": task(#{ args =>
                run("ms test")?
                run("ms build --target native --release")?
                if args.has("--publish") {
                    run("ms publish")?
                }
                Ok()
            })
        }
    }

    if target.os == Os.Android {
        c.deps["android.ui"] = "^0.3.0"
    }

    if env.get("CI") {
        c.scripts["ci"] = sh("ms test --reporter junit")
    }

    c.tools([
        fmt.setup(_{ indent: 4 }),
        test.setup(_{ parallel: true }),
        // lint.setup(_{ strict: true, warn: ["L_IMPLICIT_COPY"] }),
    ])
}
