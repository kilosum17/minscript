// A program of several packages (src/loader.ts): `app.models` is a folder of two files, `./util`
// is imported relative to this file, and `std.json` is a std package written in MinScript.
package main

import "app.models"
import "app.models.{Role, describe}"
import "./util"
import "std.json"

fun main() {
    var team = [] as Vec[models.User]
    team.push(models.User.new(1, "Ted", Admin))       // `Admin` inferred from the parameter type
    team.push(models.User.new(2, "Ann", Guest))

    let role: Role = Operator
    team.push(models.User { id: 3, name: "Bo", role })

    for u in team.iter() {
        log.println(describe(u))
    }

    admins := team.filter(#{ u => u.is_admin() }).len()
    log.println("admins: ${admins}, total id: ${util.sum(team.map(#{ u => u.id }))}")

    let text = json.stringify(team[0])
    log.println(text)
    let back = json.parse.[models.User](text) or e => {
        log.error("bad json: ${e}")
        return
    }
    log.println("round trip: ${back.name} ${util.shout(back.name)}")

    let missing = json.parse.[models.User]("{\"id\": 9}")
    if let Err(e) = missing {
        log.println("error: ${e.message}")
    }
}
