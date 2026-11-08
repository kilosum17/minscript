package env

/// An environment variable, if it is set.
pub fun get(name: &str) -> string? { _builtin() }

/// Sets an environment variable for this process.
pub fun set(name: &str, value: &str) { _builtin() }

/// The command-line arguments after the program name.
pub fun args() -> Vec[string] { _builtin() }

/// The current working directory (an absolute path).
pub fun cwd() -> string { _builtin() }
