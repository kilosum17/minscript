package env

/// An environment variable, if it is set.
pub fn get(name: str) -> str? { _builtin() }

/// Sets an environment variable for this process.
pub fn set(name: str, value: str) { _builtin() }

/// The command-line arguments after the program name (`ms run prog -- a b`).
pub fn args() -> Vec[str] { _builtin() }

/// The current working directory (an absolute path).
pub fn cwd() -> str { _builtin() }
