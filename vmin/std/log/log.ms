package log

// The prelude's `log` functions as a package (`import "std.log"`).

pub fn println(...args: Stringer) { _builtin() }
pub fn print(...args: Stringer) { _builtin() }
pub fn info(...args: Stringer) { _builtin() }
pub fn debug(...args: Stringer) { _builtin() }
pub fn warn(...args: Stringer) { _builtin() }
pub fn error(...args: Stringer) { _builtin() }
