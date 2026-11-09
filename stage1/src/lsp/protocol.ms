// The language server's plumbing: LSP messages over stdin / stdout (`Content-Length` framing,
// JSON-RPC), JSON helpers, file URIs, and positions.
//
// Positions: the compiler's spans are UTF-8 byte offsets; LSP positions are 0-based lines and UTF-16
// columns. `PosMap` converts between them.
package lsp

import "std.io"
import "std.json"
import "std.utf8"

// ---- messages ----

/// The next message (None at the end of the input).
pub async fun read_message() -> json.Value? {
    var length = -1
    // headers: lines up to an empty one (`\r\n\r\n`)
    var line = [] as Vec[u8]
    for {
        let b = await io.read_bytes(1)
        if b.is_empty() {
            return None
        }
        let c = b[0]
        if c == 10 {
            let text = utf8.decode(line).trim().to_str()
            line = []
            if text.is_empty() {
                if length >= 0 {
                    break
                }
                continue
            }
            if text.to_lower().starts_with("content-length:") {
                length = text.substring(15, text.len()).trim().to_int() ?? -1
            }
            continue
        }
        line.push(c)
    }
    let body = await io.read_bytes(length)
    match json.parse.[json.Value](utf8.decode(body)) {
        Ok(v) => Some(v)
        Err(e) => {
            io.eprintln("MinScript: an unreadable message: ${e}")
            Some(json.Value.Null)
        }
    }
}

pub fun send(v: &json.Value) {
    let body = json.stringify(v)
    io.print("Content-Length: ${utf8.encode(body).len()}\r\n\r\n${body}")
}

pub fun respond(id: &json.Value, result: json.Value) {
    send(obj([t("jsonrpc", jstr("2.0")), t("id", id.clone()), t("result", result)]))
}

pub fun respond_error(id: &json.Value, code: int, message: &str) {
    let err = obj([t("code", num(code)), t("message", jstr(message))])
    send(obj([t("jsonrpc", jstr("2.0")), t("id", id.clone()), t("error", err)]))
}

pub fun notify(method: &str, params: json.Value) {
    send(obj([t("jsonrpc", jstr("2.0")), t("method", jstr(method)), t("params", params)]))
}

// ---- JSON ----

pub fun obj(fields: Vec[t(string, json.Value)]) -> json.Value {
    var m = m{} as Map[string, json.Value]
    for f in fields.iter() {
        let t(k, v) = f
        m[k.clone()] = v.clone()
    }
    json.Value.Object(m)
}

pub fun jstr(s: &str) -> json.Value { json.Value.Str(s.to_str()) }
pub fun num(n: int) -> json.Value { json.Value.Number(n as f64) }
pub fun arr(xs: Vec[json.Value]) -> json.Value { json.Value.Array(xs) }

pub fun field(v: &json.Value, name: &str) -> json.Value {
    match v {
        json.Value.Object(fs) => fs.get(name) ?? json.Value.Null
        _ => json.Value.Null
    }
}

pub fun text_of(v: &json.Value) -> string {
    match v {
        json.Value.Str(s) => s.clone()
        _ => ""
    }
}

pub fun int_of(v: &json.Value) -> int {
    match v {
        json.Value.Number(n) => n as int
        _ => 0
    }
}

pub fun is_null(v: &json.Value) -> bool {
    match v {
        json.Value.Null => true
        _ => false
    }
}

// ---- file URIs ----

fun hex_digit(c: u8) -> int {
    if c >= 48 && c <= 57 { (c as int) - 48 } else if c >= 65 && c <= 70 { (c as int) - 55 } else if c >= 97 && c <= 102 { (c as int) - 87 } else { -1 }
}

/// `file:///a/b%20c.ms` → `/a/b c.ms` (None: not a file URI).
pub fun uri_path(uri: &str) -> string? {
    if !uri.starts_with("file://") {
        return None
    }
    let raw = utf8.encode(uri.substring(7, uri.len()))
    var out = [] as Vec[u8]
    var i = 0
    for i < raw.len() {
        if raw[i] == 37 && i + 2 < raw.len() {
            let hi = hex_digit(raw[i + 1])
            let lo = hex_digit(raw[i + 2])
            if hi >= 0 && lo >= 0 {
                out.push((hi * 16 + lo) as u8)
                i += 3
                continue
            }
        }
        out.push(raw[i])
        i += 1
    }
    Some(utf8.decode(out))
}

/// `/a/b c.ms` → `file:///a/b%20c.ms` (as Node's `pathToFileURL` writes it).
pub fun path_uri(path: &str) -> string {
    let hex = "0123456789ABCDEF"
    var out = "file://"
    for b in utf8.encode(path).iter() {
        let keep = (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || (b >= 48 && b <= 57) || b == 47 || b == 45 || b == 46 || b == 95 || b == 126
            || b == 33 || b == 36 || b == 38 || b == 39 || b == 40 || b == 41 || b == 42 || b == 43 || b == 44 || b == 59 || b == 61 || b == 58 || b == 64
        if keep {
            out = "${out}${utf8.decode([b])}"
        } else {
            let n = b as int
            out = "${out}%${hex.substring(n / 16, n / 16 + 1)}${hex.substring(n % 16, n % 16 + 1)}"
        }
    }
    out
}

// ---- positions ----

/// Byte offsets ↔ LSP positions (line, UTF-16 column) of one text.
pub type PosMap = {
    bytes: Vec[u8]
    /// the byte offset of each line's start
    line_starts: Vec[int] = [0]
}

pub fun pos_map(text: &str) -> PosMap {
    var p = PosMap { bytes: utf8.encode(text) }
    var i = 0
    for i < p.bytes.len() {
        if p.bytes[i] == 10 {
            p.line_starts.push(i + 1)
        }
        i += 1
    }
    p
}

impl PosMap {
    fun line_of(&this, offset: int) -> int {
        var lo = 0
        var hi = this.line_starts.len() - 1
        for lo < hi {
            let mid = (lo + hi + 1) / 2
            if this.line_starts[mid] <= offset {
                lo = mid
            } else {
                hi = mid - 1
            }
        }
        lo
    }

    /// UTF-16 units of the bytes `from..to`.
    fun units(&this, from: int, to: int) -> int {
        var n = 0
        var i = from
        let end = if to < this.bytes.len() { to } else { this.bytes.len() }
        for i < end {
            let b = this.bytes[i]
            if b < 128 || b >= 192 {
                n += 1
            }
            if b >= 240 {
                n += 1
            }
            i += 1
        }
        n
    }

    pub fun position(&this, offset0: int) -> json.Value {
        let offset = if offset0 > this.bytes.len() { this.bytes.len() } else if offset0 < 0 { 0 } else { offset0 }
        let line = this.line_of(offset)
        obj([t("line", num(line)), t("character", num(this.units(this.line_starts[line], offset)))])
    }

    pub fun range(&this, start: int, end: int) -> json.Value {
        obj([t("start", this.position(start)), t("end", this.position(if end > start { end } else { start }))])
    }

    /// The byte offset of an LSP position.
    pub fun offset(&this, pos: &json.Value) -> int {
        let line = int_of(field(pos, "line"))
        let ch = int_of(field(pos, "character"))
        if line >= this.line_starts.len() {
            return this.bytes.len()
        }
        var i = this.line_starts[line]
        var units = 0
        for i < this.bytes.len() && units < ch {
            let b = this.bytes[i]
            if b == 10 {
                break
            }
            // step over one character
            let len = if b < 128 { 1 } else if b >= 240 { 4 } else if b >= 224 { 3 } else { 2 }
            units += if b >= 240 { 2 } else { 1 }
            i += len
        }
        i
    }
}
