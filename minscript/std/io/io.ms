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
