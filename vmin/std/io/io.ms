package io

// Console input and output. `log` (in the prelude) is the usual way to print; these write plain text.

/// Prints the arguments, separated by spaces, followed by a newline.
pub fn println(...args: Stringer) { _builtin() }

/// Prints the arguments, separated by spaces, without a newline.
pub fn print(...args: Stringer) { _builtin() }

/// Prints to standard error.
pub fn eprintln(...args: Stringer) { _builtin() }

/// Reads one line from standard input, without its line break; "" at the end of the input.
pub async fn read_line() -> str { _builtin() }
