package main

import "./opts.{Opts, Level}"

fn main() {
    var extra = m{} as Map[str, str]
    extra["k"] = "v"
    let o = Opts { extra }
    log.println(o.root ?? "no root", o.limit ?? 0, o.tags.join(","), o.extra.len())
    match o.level {
        Low => log.println("low")
        High(n) => log.println("high ${n}")
    }
}
