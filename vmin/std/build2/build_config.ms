package build2

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
            "name": Str(this.name),
            "version": Str(this.version),
            "main": Str(this.main),
            "deps": strings(this.deps),
            "dev_deps": strings(this.dev_deps),
            "scripts": Object(scripts),
            "sections": Object(this.sections),
        })
    }
}

