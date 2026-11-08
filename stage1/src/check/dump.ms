// The checker dump (`.types` format), ported from minscript/src/check_dump.ts: the inferred type of
// every binding (locals, parameters, closure parameters, pattern bindings, globals), in source order,
// followed by the checker's diagnostics.
//
//   12:9    total: int
//   13:24   it: string        (implicit closure parameters are listed at their first use)
package check

import "app.lexer.{Span}"
import "app.resolve.{Resolution}"

fun pos(span: Span) -> string {
    var s = "${span.line}:${span.col}"
    for s.len() < 8 {
        s += " "
    }
    s
}

type Line = r{ at: int, seq: int, text: string }

fun dumped_kind(kind: &str) -> bool {
    match kind {
        "local" | "param" | "closure-param" | "implicit" | "global" => true
        _ => false
    }
}

pub fun dump_types(res: &Resolution, checked: &CheckResult) -> string {
    // an implicit parameter has no declaration: it is shown at its first use
    var first_use = m{} as Map[int, Span]
    for _, rf in res.refs {
        if res.symbols[rf.sym].kind != "implicit" {
            continue
        }
        let earlier = match first_use.get(rf.sym) {
            Some(prev) => prev.start <= rf.span.start
            None => false
        }
        if !earlier {
            first_use[rf.sym] = rf.span
        }
    }
    var lines = [] as Vec[Line]
    var seq = 0
    for sym, ty in checked.symbols {
        if sym < res.first_own {
            continue
        }
        let s = &res.symbols[sym]
        if !dumped_kind(s.kind) {
            continue
        }
        let Some(span) = s.span ?? first_use.get(sym) else { continue }
        let name = if s.kind == "implicit" && s.name == "it1" { "it" } else { s.name.clone() }
        lines.push(r{ at: span.start, seq, text: "${pos(span)}${name}: ${show_ty(ty, checked.vars, res.symbols)}" })
        seq += 1
    }
    lines.sort_by(#{ a, b =>
        if a.at != b.at {
            if a.at < b.at { Less } else { Greater }
        } else if a.seq < b.seq { Less } else if a.seq > b.seq { Greater } else { Equal }
    })
    var out = lines.map(#{ l, _ => l.text.clone() })
    if !checked.diagnostics.is_empty() {
        out.push("")
        out.push("-- diagnostics --")
        for d in checked.diagnostics.iter() {
            out.push("${pos(d.span)}${d.code} ${d.message}")
        }
    }
    "${out.join("\n")}\n"
}
