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

/// What `run_module_result` reports about a finished program.
pub type ModuleResult = {
    /// Its exit code (101 after a panic).
    pub code: int
    /// The int its entry function returned (0 if it returned something else): `ms test`'s generated
    /// main returns the number of failed tests.
    pub value: int
    /// Its standard output, when it was captured ("" otherwise).
    pub stdout: string
}

/// `run_module` for toolchains written in MinScript: also reports what the entry function returned,
/// and with `capture` the program's standard output is collected instead of printed (its standard
/// error still goes to this process's).
pub async fun run_module_result(js: &str, args: &Vec[string], capture: bool) -> ModuleResult { _builtin() }

/// Runs a command line with the system shell in the folder `dir`, sharing this process's terminal,
/// and returns its exit code.
pub fun shell(cmd: &str, dir: &str) -> int { _builtin() }
