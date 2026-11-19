package build2

// The toolchain API that `mod.ms` imports (`import "build.*"`, spec §17): the project's `Config`, its
// scripts, and what `config()` may look at while it is evaluated (`target`, `env`).

import "std.json"
import "std.env" as std_env

fn strings(entries: Map[str, str]) -> json.Value {
    out := m{} as Map[str, json.Value]
    var all = out
    for k, v in entries {
        all[k] = Str(v)
    }
    Object(all)
}

/// Runs `config` as the toolchain evaluates mod.ms (§17.5): while it runs, `run` is the runtime
/// error E_SCRIPT_IN_EVAL. For toolchains written in MinScript.
pub fn evaluate(config: () -> Config) -> Config { _builtin() }

/// A tool: reads the config, writes its own section (and maybe scripts), returns the result.
pub type Tool = (Config) -> Config

/// A script's arguments: everything after `--` in `ms run <name> -- …`.
pub type Args {
    pub list: Vec[str] = []

    pub fn has(this, flag: str) -> bool { this.list.any(#{ a => a == flag }) }
    pub fn get(this, i: int) -> str? { this.list.get(i) }
    pub fn len(this) -> int { this.list.len() }
}

/// What `ms run <name>` runs (spec §17.3).
pub union Script {
    Shell(str)
    Package(str)
    Task((Args) -> Result[void, str])
}

/// A shell command line.
pub fn sh(cmd: str) -> Script { Shell(cmd) }

/// The `main` of a package of this project (`pkg("./tools/migrate")`).
pub fn pkg(path: str) -> Script { Package(path) }

/// Inline MinScript.
pub fn task(f: (Args) -> Result[void, str]) -> Script { Task(f) }

/// Runs a shell command now and waits for it (only inside a script: calling it while `config()` is
/// evaluated is the runtime error E_SCRIPT_IN_EVAL).
pub fn run(cmd: str) -> Result[void, str] { _builtin() }

pub union Os {
    Linux
    MacOs
    Windows
    Android
    Ios
    Web
    Other
}

/// The platform being built for.
pub type Target {
    pub os: Os
    pub arch: str
    /// "js" for now.
    pub back_end: str
}

pub let target: Target = current_target()

fn current_target() -> Target { _builtin() }

/// Environment variables (reads are part of the evaluation's cache key, §17.5).
pub type Env {
    pub fn get(this, name: str) -> str? { std_env.get(name) }
}

pub let env = Env {}

fn tester(){
    c := Config{}
    env2 := Env{}
    a := 20
    let c = a + 3
}
