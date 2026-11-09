package build

// The toolchain API that `mod.ms` imports (`import "build.*"`, spec §17): the project's `Config`, its
// scripts, and what `config()` may look at while it is evaluated (`target`, `env`).

import "std.json"
import "std.env" as std_env

/// The project configuration that `mod.ms`'s `config()` returns (spec §17.2).
pub type Config = {
    pub name: string
    pub version: string
    /// The folder holding `package main`. Empty: `./src` if it exists, else the project root (§17.6).
    pub main: string = ""
    pub deps: Map[string, string] = m{}
    pub dev_deps: Map[string, string] = m{}
    pub scripts: Map[string, Script] = m{}
    sections: Map[string, json.Value] = m{}

    /// Applies each tool in order (§17.4).
    pub fun tools(mut this, ts: Vec[Tool]) -> Config {
        var c = this
        for tool in ts {
            c = tool(c)
        }
        c
    }

    /// Stores a tool's settings under its section name.
    pub fun set_section[T](&mut this, name: string, value: &T) {
        this.sections[name] = json.to_value(value)
    }

    /// Reads a tool's settings back with their type.
    pub fun section[T](&this, name: string) -> Result[T, json.Error] {
        let v = this.sections.get(name) or return Err(json.Error { message: "no section `${name}`" })
        json.from_value.[T](v)
    }

    /// A tool's settings as untyped JSON.
    pub fun raw_section(&this, name: string) -> json.Value? {
        this.sections.get(name)
    }

    /// The configuration as `ms config` prints it: each script is `{ "sh": cmd }`, `{ "pkg": path }`
    /// or `{ "task": "<MinScript>" }` (for toolchains written in MinScript, §17.5).
    pub fun describe(&this) -> json.Value {
        var scripts = m{} as Map[string, json.Value]
        for k, s in this.scripts {
            let entry: json.Value = match s {
                Shell(cmd) => json.Value.Object(m{ "sh": json.Value.Str(cmd.clone()) })
                Package(path) => json.Value.Object(m{ "pkg": json.Value.Str(path.clone()) })
                Task(_) => json.Value.Object(m{ "task": json.Value.Str("<MinScript>") })
            }
            scripts[k.clone()] = entry
        }
        json.Value.Object(m{
            "name": json.Value.Str(this.name.clone())
            "version": json.Value.Str(this.version.clone())
            "main": json.Value.Str(this.main.clone())
            "deps": strings(this.deps)
            "dev_deps": strings(this.dev_deps)
            "scripts": json.Value.Object(scripts)
            "sections": json.Value.Object(this.sections.clone())
        })
    }
}

fun strings(entries: &Map[string, string]) -> json.Value {
    var out = m{} as Map[string, json.Value]
    for k, v in entries {
        out[k.clone()] = json.Value.Str(v.clone())
    }
    json.Value.Object(out)
}

/// Runs `config` as the toolchain evaluates mod.ms (§17.5): while it runs, `run` is the runtime
/// error E_SCRIPT_IN_EVAL. For toolchains written in MinScript.
pub fun evaluate(config: () -> Config) -> Config { _builtin() }

/// A tool: reads the config, writes its own section (and maybe scripts), returns the result.
pub type Tool = (Config) -> Config

/// A script's arguments: everything after `--` in `ms run <name> -- …`.
pub type Args = {
    pub list: Vec[string] = []

    pub fun has(&this, flag: string) -> bool { this.list.any(#{ a => a == flag }) }
    pub fun get(&this, i: int) -> string? { this.list.get(i) }
    pub fun len(&this) -> int { this.list.len() }
}

/// What `ms run <name>` runs (spec §17.3).
pub union Script = {
    Shell(string)
    Package(string)
    Task((&Args) -> Result[void, string])
}

/// A shell command line.
pub fun sh(cmd: string) -> Script { Shell(cmd) }

/// The `main` of a package of this project (`pkg("./tools/migrate")`).
pub fun pkg(path: string) -> Script { Package(path) }

/// Inline MinScript.
pub fun task(f: (&Args) -> Result[void, string]) -> Script { Task(f) }

/// Runs a shell command now and waits for it (only inside a script: calling it while `config()` is
/// evaluated is the runtime error E_SCRIPT_IN_EVAL).
pub fun run(cmd: string) -> Result[void, string] { _builtin() }

pub union Os = {
    Linux
    MacOs
    Windows
    Android
    Ios
    Web
    Other
}

/// The platform being built for.
pub type Target = {
    pub os: Os
    pub arch: string
    /// "js" for now.
    pub back_end: string
}

pub let target: Target = current_target()

fun current_target() -> Target { _builtin() }

/// Environment variables (reads are part of the evaluation's cache key, §17.5).
pub type Env = {
    pub fun get(&this, name: string) -> string? { std_env.get(name) }
}

pub let env = Env {}
