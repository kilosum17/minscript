package runtime

/// Lets other tasks run.
pub async fn yield() { _builtin() }

/// Ends the program with an exit code (`0`: success). It isn't a panic: `recover` doesn't stop it.
pub fn exit(code: int) -> never { _builtin() }

/// Runs a compiled program (an ES module exporting `$main`) in a new process: `args` are its
/// `env.args()`, its output goes to this process's, and the result is its exit code (101 after a
/// panic). For toolchains written in MinScript.
pub async fn run_module(js: str, args: Vec[str]) -> int { _builtin() }

/// What `run_module_result` reports about a finished program.
pub type ModuleResult {
    /// Its exit code (101 after a panic).
    pub code: int
    /// The int its entry function returned (0 otherwise): `ms test`'s main returns the failures.
    pub value: int
    /// Its standard output, when it was captured ("" otherwise).
    pub stdout: str
}

/// `run_module`, also reporting what the entry function returned; with `capture` the program's
/// standard output is collected instead of printed.
pub async fn run_module_result(js: str, args: Vec[str], capture: bool) -> ModuleResult { _builtin() }

/// Runs a command line with the system shell in the folder `dir` and returns its exit code.
pub fn shell(cmd: str, dir: str) -> int { _builtin() }
