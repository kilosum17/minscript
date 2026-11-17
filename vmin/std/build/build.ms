package build

// The toolchain API that `mod.ms` imports (`import "build.*"`, spec §17): the project's `Config`, its
// scripts, and what `config()` may look at while it is evaluated (`target`, `env`).

import "std.json"
import "std.env" as std_env

/// The project configuration that `mod.ms`'s `config()` returns (spec §17.2).
pub type Config {
    pub name: str
    pub version: str
    /// The folder holding `package main`. Empty: `./src` if it exists, else the project root (§17.6).
    pub main: str = ""
    pub deps: Map[str, str] = m{}
    pub dev_deps: Map[str, str] = m{}
    pub scripts: Map[str, Script] = m{}
    sections: Map[str, json.Value] = m{}

    /// Applies each tool in order (§17.4).
    pub fn tools(this, ts: Vec[Tool]) -> Config {
        var c = this
        for tool in ts {
            c = tool(c)
        }
        c
    }

    /// Stores a tool's settings under its section name. A section belongs to one tool: writing one
    /// that is already set is E_SECTION_CONFLICT (§17.4).
    pub fn set_section[T](*this, name: str, value: T) {
        if this.sections.has(name) {
            panic("E_SECTION_CONFLICT: two tools write the section `${name}`")
        }
        this.sections[name] = json.to_value(value)
    }

    /// Reads a tool's settings back with their type.
    pub fn section[T](this, name: str) -> Result[T, json.Error] {
        let v = this.sections.get(name) or return Err(json.Error { message: "no section `${name}`" })
        json.from_value.[T](v)
    }

    /// A tool's settings as untyped JSON.
    pub fn raw_section(this, name: str) -> json.Value? {
        this.sections.get(name)
    }

    /// The configuration as `ms config` prints it: each script is `{ "sh": cmd }`, `{ "pkg": path }`
    /// or `{ "task": "<MinScript>" }`.
    pub fn describe(this) -> json.Value {
        var scripts = m{} as Map[str, json.Value]
        for k, s in this.scripts {
            let entry: json.Value = match s {
                Shell(cmd) => Object(m{ "sh": Str(cmd) })
                Package(path) => Object(m{ "pkg": Str(path) })
                Task(_) => Object(m{ "task": Str("<MinScript>") })
            }
            scripts[k] = entry
        }
        Object(m{
            "name": Str(this.name)
            "version": Str(this.version)
            "main": Str(this.main)
            "deps": strings(this.deps)
            "dev_deps": strings(this.dev_deps)
            "scripts": Object(scripts)
            "sections": Object(this.sections)
        })
    }
}

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
