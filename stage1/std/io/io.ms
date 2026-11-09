package io

// Console input and output. `log` (in the prelude) is the usual way to print; these write plain text.

/// Prints the arguments, separated by spaces, followed by a newline.
pub fun println(...args: &Stringer) { _builtin() }

/// Prints the arguments, separated by spaces, without a newline.
pub fun print(...args: &Stringer) { _builtin() }

/// Prints to standard error.
pub fun eprintln(...args: &Stringer) { _builtin() }

/// Reads one line from standard input, without its line break; "" at the end of the input.
pub async fun read_line() -> string { _builtin() }

/// The next `n` bytes of standard input (fewer at its end), for protocols that frame their messages by
/// length. Don't mix it with `read_line` on the same input.
pub async fun read_bytes(n: int) -> Vec[u8] { _builtin() }
