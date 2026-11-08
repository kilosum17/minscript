// The resolution dump (`.refs` format), ported from minscript/src/resolve_dump.ts: one line per use,
// deferred name and closure, in source order.
//
//   5:9     x → 3:9 local
//   6:5     log → prelude package std.log
//   7:13    Cash → deferred
//   9:14    closure captures count@3:5, total@4:5
package resolve

import "app.lexer.{Span, json_quote}"

fun target_text(sym: &Sym) -> string {
    if sym.std {
        return "prelude"
    }
    let loc = match sym.span {
        Some(s) => "${s.line}:${s.col} "
        None => ""
    }
    match sym.kind {
        "builtin-type" => "builtin"
        "prelude-type" | "prelude-value" => "prelude"
        "this" => "this"
        "implicit" => "implicit ${if sym.name == "it1" { "it" } else { sym.name.clone() }}"
        "package" | "import" => "${loc}${sym.kind} ${json_quote(sym.detail ?? "")}".trim().to_str()
        _ => "${loc}${sym.kind}"
    }
}

fun pos(span: Span) -> string {
    var s = "${span.line}:${span.col}"
    for s.len() < 8 {
        s += " "
    }
    s
}

/// A line of the dump, with its sort key (source offset, then: closures, uses, deferred).
type Line = r{ at: int, order: int, seq: int, text: string }

pub fun dump_resolution(res: &Resolution) -> string {
    var lines = [] as Vec[Line]
    var seq = 0
    for _, ref in res.refs {
        lines.push(r{ at: ref.span.start, order: 0, seq, text: "${pos(ref.span)}${ref.label} → ${target_text(res.symbols[ref.sym])}" })
        seq += 1
    }
    for d in res.deferred.iter() {
        lines.push(r{ at: d.span.start, order: 1, seq, text: "${pos(d.span)}${d.label} → deferred" })
        seq += 1
    }
    for _, c in res.captures {
        if c.syms.is_empty() {
            continue
        }
        let list = c.syms.map(#{ i =>
            let s = &res.symbols[i]
            match s.span {
                Some(sp) => "${s.name}@${sp.line}:${sp.col}"
                None => if s.name == "it1" { "it" } else { s.name.clone() }
            }
        })
        lines.push(r{ at: c.span.start, order: -1, seq, text: "${pos(c.span)}closure captures ${list.join(", ")}" })
        seq += 1
    }
    // stage 0 sorts stably by (offset, order): `seq` keeps the insertion order of ties
    lines.sort_by(#{ a, b =>
        if a.at != b.at {
            if a.at < b.at { Less } else { Greater }
        } else if a.order != b.order {
            if a.order < b.order { Less } else { Greater }
        } else if a.seq < b.seq { Less } else if a.seq > b.seq { Greater } else { Equal }
    })
    var out = lines.map(#{ l => l.text.clone() })
    if !res.diagnostics.is_empty() {
        out.push("")
        out.push("-- diagnostics --")
        for d in res.diagnostics.iter() {
            out.push("${pos(d.span)}${d.code} ${d.message}")
        }
    }
    "${out.join("\n")}\n"
}
