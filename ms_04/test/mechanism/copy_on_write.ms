// Appendix A.2: value semantics and copy-on-write. The first call shares `a` (it is used again);
// the second moves `b` (its last use), so `with_tag` writes `c.tags` in place.
package main

type Config {
    name: str
    tags: Vec[str]
}

fn load_config() -> Config { Config { name: "app", tags: [] } }

fn with_tag(base: Config, t: str) -> Config {
    var c = base
    c.tags.push(t)
    c
}

fn main() {
    a := load_config()
    b := with_tag(a, "x")
    log.println(a.tags.len(), b.tags.len())
    c := with_tag(b, "y")
    log.println(c.tags.len())
}
