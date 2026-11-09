package utf8

// UTF-8 text from bytes, and back (spec §10.4). Invalid sequences decode to U+FFFD.

/// The text of a byte sequence.
pub fun decode(bytes: &Slice[u8]) -> string { _builtin() }

/// The text of `bytes[start..end]` (clamped to the bytes), without copying them first.
pub fun decode_range(bytes: &Slice[u8], start: int, end: int) -> string { _builtin() }

/// The bytes of a string (the same as `s.bytes()`).
pub fun encode(s: &str) -> Vec[u8] { _builtin() }

/// The number of bytes of the UTF-8 sequence that starts with `lead` (1 for a continuation byte).
pub fun sequence_length(lead: u8) -> int {
    let b = lead as int
    if b >= 0xf0 { 4 } else if b >= 0xe0 { 3 } else if b >= 0xc0 { 2 } else { 1 }
}
