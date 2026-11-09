package log

// The same functions as the prelude's `log`, as a package (`import "std.log"`).

pub fun println(...args: &Stringer) { _builtin() }
pub fun print(...args: &Stringer) { _builtin() }
pub fun info(...args: &Stringer) { _builtin() }
pub fun debug(...args: &Stringer) { _builtin() }
pub fun warn(...args: &Stringer) { _builtin() }
pub fun error(...args: &Stringer) { _builtin() }
