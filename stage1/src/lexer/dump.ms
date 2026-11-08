// The token dump (`.tokens` format), ported from minscript/src/dump.ts: byte-for-byte the same text,
// so stage 0 and stage 1 can be compared.
//
//   4:5     nl let
//   4:9     ws Ident "a"
//   5:20       ( → 5:31
package lexer

pub fun dump(res: &LexResult) -> string {
    var out = ""
    for tok in res.tokens.iter() {
        var line = "${pad("${tok.span.line}:${tok.span.col}", 8)}${if tok.nl_before { "nl" } else if tok.ws_before { "ws" } else { "  " }} ${tok.kind}"
        if let Some(v) = &tok.value {
            line += " ${format_value(v)}"
        }
        if tok.multiline {
            line += " \"\"\""
        }
        if let Some(c) = tok.closer {
            let closer = &res.tokens[c]
            line += " → ${closer.span.line}:${closer.span.col}"
        }
        out += line
        out += "\n"
    }
    if !res.trivia.is_empty() {
        out += "\n-- trivia --\n"
        for t in res.trivia.iter() {
            out += "${pad("${t.span.line}:${t.span.col}", 8)}${t.kind} ${json_quote(t.text)}\n"
        }
    }
    if !res.diagnostics.is_empty() {
        out += "\n-- diagnostics --\n"
        for d in res.diagnostics.iter() {
            out += "${pad("${d.span.line}:${d.span.col}", 8)}${d.code} ${d.message}\n"
        }
    }
    out
}

fun format_value(v: &Value) -> string {
    match v {
        Text(s) => json_quote(s)
        Int(digits) => digits.clone()
        Float(x) => js_number(x)
    }
}

/// A float as JavaScript's `String(x)` writes it (the stage-0 dump format): `1` for 1.0.
fun js_number(x: f64) -> string {
    let s = "${x}"
    s.strip_suffix(".0").to_str()
}

fun pad(s: string, width: int) -> string {
    var out = s
    for out.len() < width {
        out += " "
    }
    out
}

/// `JSON.stringify` of a string.
pub fun json_quote(s: &str) -> string {
    var out = "\""
    for c in s.chars() {
        let code = c as int
        out += match code {
            34 => "\\\""
            92 => "\\\\"
            10 => "\\n"
            13 => "\\r"
            9 => "\\t"
            8 => "\\b"
            12 => "\\f"
            _ => if code < 32 { "\\u${hex4(code)}" } else { c.to_str() }
        }
    }
    out + "\""
}

fun hex4(n: int) -> string {
    let digits = "0123456789abcdef"
    var out = ""
    var v = n
    var i = 0
    for i < 4 {
        let d = v % 16
        out = "${digits.substring(d, d + 1)}${out}"
        v = v / 16
        i += 1
    }
    out
}
