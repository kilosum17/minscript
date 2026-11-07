package app.users

import "std.log"
import "std.json"                       // binds `json`
import "std.io.println"                 // binds one item
import "std.io.{print, println, read_line}"
import "std.collections.*"              // glob: every pub item
import "app.models" as models
import "./helpers"                      // relative to this folder
import "../shared/util" as util
import pub "./log"                      // re-export
import pub "std.time.{Duration, Instant}"

pub let MAX_CONNECTIONS: i32 = 10_000
pub let SYSTEM_NAME: string = "MinScript-Engine"
let sessions = Ref(m{ "admin": 0 })     // Ref[Map[string, int]]: the only way to have mutable global state
pub let VERSION = "0.2.0"

pub fun handler() {
    let u = models.User { id: 1, name: "Ted" }
    util.check(u)
    println(json.stringify(u))
}

fun private_helper() {}
