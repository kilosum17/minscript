package runtime

/// Lets other tasks run (spec §9.6).
pub async fun yield() { _builtin() }

/// Runs a compiled MinScript program (an ES module from the JS back end, which exports `$main`) in a
/// new process, as `ms run` would: `args` are its `env.args()`, its output goes to this process's
/// stdout / stderr, and the result is its exit code (101 after a panic). For compilers written in
/// MinScript (spec §14.2).
pub async fun run_module(js: &str, args: &Vec[string]) -> int { _builtin() }

/// Ends the program with an exit code (`0`: success). It isn't a panic: `recover` doesn't stop it.
pub fun exit(code: int) -> never { _builtin() }
