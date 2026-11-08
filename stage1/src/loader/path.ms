// POSIX path helpers (as Node's `path` module computes them, for the loader).
package loader

fun segments(p: &str) -> Vec[string] {
    var out = [] as Vec[string]
    for part in p.split("/").iter() {
        if part.is_empty() || part == "." {
            continue
        }
        if part == ".." {
            if !out.is_empty() && out.last() != Some("..") {
                let _ = out.pop()
                continue
            }
            if p.starts_with("/") {
                continue                // `/..` is `/`
            }
        }
        out.push(part.to_str())
    }
    out
}

/// `a/./b/../c` → `a/c` (an absolute path stays absolute; an empty result is ".").
pub fun normalize(p: &str) -> string {
    let segs = segments(p)
    if p.starts_with("/") {
        return "/${segs.join("/")}"
    }
    if segs.is_empty() { "." } else { segs.join("/") }
}

pub fun join(a: &str, b: &str) -> string {
    if a.is_empty() {
        return normalize(b)
    }
    normalize("${a}/${b}")
}

/// `b` against the absolute folder `base` (an absolute `b` stays as it is).
pub fun resolve_from(base: &str, b: &str) -> string {
    if b.starts_with("/") { normalize(b) } else { normalize("${base}/${b}") }
}

pub fun dirname(p: &str) -> string {
    var end = p.len()
    for end > 1 && p.byte_at(end - 1) == 47 {
        end -= 1
    }
    var i = end - 1
    for i >= 0 && p.byte_at(i) != 47 {
        i -= 1
    }
    if i < 0 {
        return "."
    }
    if i == 0 {
        return "/"
    }
    p.substring(0, i).to_str()
}

pub fun basename(p: &str) -> string {
    let segs = segments(p)
    segs.last() ?? ""
}

/// The path from the absolute folder `from` to the absolute path `to` ("" when they are the same).
pub fun relative(from: &str, to: &str) -> string {
    let f = segments(from)
    let t = segments(to)
    var common = 0
    for common < f.len() && common < t.len() && f[common] == t[common] {
        common += 1
    }
    var parts = [] as Vec[string]
    var i = common
    for i < f.len() {
        parts.push("..")
        i += 1
    }
    i = common
    for i < t.len() {
        parts.push(t[i].clone())
        i += 1
    }
    parts.join("/")
}
