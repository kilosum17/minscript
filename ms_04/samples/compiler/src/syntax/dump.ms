package syntax

// The token dump (the `.tokens` snapshot format of the TypeScript compiler, src/dump.ts): one
// token per line, `line:col kind [value] [flags]`. Columns count code points (spec §1.1).

import "std.json"

/// Byte offsets → 1-based lines and columns.
pub type LineMap {
    src: str
    starts: Vec[int] = [0]

    pub fn new(src: str) -> LineMap {
        var starts = [0] as Vec[int]
        for i in 0..src.len() {
            if src.byte_at(i) == b'\n' { starts.push(i + 1) }
        }
        LineMap { src, starts }
    }

    pub fn line(this, offset: int) -> int {
        var lo = 0
        var hi = this.starts.len() - 1
        for lo < hi {
            mid := (lo + hi + 1) / 2
            if this.starts[mid] <= offset { lo = mid } else { hi = mid - 1 }
        }
        lo + 1
    }

    /// The column of `offset`: code points since the line start, plus one.
    pub fn col(this, offset: int) -> int {
        start := this.starts[this.line(offset) - 1]
        var col = 1
        var i = start
        for i < offset && i < this.src.len() {
            if (this.src.byte_at(i) & 0xc0) != 0x80 { col += 1 }
            i += 1
        }
        col
    }
}

/// How a value prints: what `JSON.stringify` writes in the TypeScript dump.
fn value_text(v: Value) -> str? {
    match v {
        NoValue => None
        Name(s) => Some(json.stringify(s))
        Int(digits) => Some(digits)
        Float(f) => Some(json.stringify(f))
        Text(s) => Some(json.stringify(s))
        Byte(b) => Some("${b}")
    }
}

/// The dump of a token list.
pub fn dump_tokens(src: str, tokens: Vec[Token]) -> str {
    lines := LineMap.new(src)
    var out = [] as Vec[str]
    for t in tokens {
        var s = "${lines.line(t.start)}:${lines.col(t.start)} ${t.kind}"
        // the value, unless it is the kind itself (an identifier spelled `Ident`)
        if let Some(v) = value_text(t.value) {
            let same = match t.value {
                Name(n) => n == t.kind
                Text(x) => x == t.kind
                _ => false
            }
            if !same { s += " ${v}" }
        }
        var flags = [] as Vec[str]
        if t.nl { flags.push("nl") } else if t.ws { flags.push("ws") }
        if t.closer >= 0 { flags.push("match=${t.closer}") }
        if t.multiline { flags.push("multiline") }
        if t.synthetic { flags.push("synthetic") }
        if !flags.is_empty() { s += " [${flags.join(" ")}]" }
        out.push(s)
    }
    out.join("\n") + "\n"
}
