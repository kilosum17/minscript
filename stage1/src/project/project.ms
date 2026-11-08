// Projects (spec §17), ported from minscript/src/project.ts: a folder with a `mod.ms`. Its `config()`
// is evaluated on the JS back end, and the result says where `package main` lives, which `path:`
// dependencies exist, and what scripts `ms run <name>` can run.
//
// A folder without a mod.ms is a project too, with the defaults: `main` is `./src` if it exists, and
// the folder itself otherwise (§17.6).
//
// Stage 0 runs `config()` in its own process and reads the value back. Here it runs in a child
// process (`runtime.run_module_result`): a generated file in `package mod` calls
// `build.evaluate(config)` and prints `describe()` as JSON after a marker line, and a `task` script
// runs through another generated entry that evaluates `config()` again and calls the task (§17.5).
package project

import "std.fs"
import "std.io"
import "std.json"
import "std.runtime"
import "std.utf8"
import "app.ast.{File, Item}"
import "app.parser.{parse}"
import "app.loader.{LoadOptions, FileDiagnostic, load_program, lower_program, join, resolve_from, dirname, basename, is_dir}"
import "app.hir"
import "app.js"

pub let MOD_FILE = "mod.ms"

/// Where the toolchain's own files are: std (with the prelude) and the runtime the generated JavaScript imports.
pub type Toolchain = {
    pub std_dir: string
    /// The runtime the modules this toolchain runs import (an absolute `file://` URL).
    pub runtime_url: string
    /// The runtime `js` writes into its output (`--runtime`, which may be relative to where the module will be).
    pub output_runtime_url: string
    pub cwd: string
}

/// A script from `Config.scripts` (spec §17.3). A `task` runs in the process that evaluates mod.ms.
pub union Script = {
    Shell(string)
    Package(string)
    Task
}

pub type ProjectConfig = {
    pub name: string
    pub version: string
    pub main: string
    pub deps: Map[string, string]
    pub dev_deps: Map[string, string]
    pub scripts: Map[string, Script]
    /// Tool sections, as JSON.
    pub sections: Map[string, json.Value]
    /// The whole configuration as `Config.describe()` gives it (what `ms config` prints).
    pub described: json.Value
}

pub type Project = {
    pub root: string
    /// None: no mod.ms (the defaults apply).
    pub mod_file: string?
    pub config: ProjectConfig?
    /// The folder holding `package main`; also the root of `app.x` imports.
    pub main_dir: string
    /// `path:` dependencies: import root → folder.
    pub deps: Map[string, string]
    /// Diagnostics from compiling mod.ms, or messages from evaluating it.
    pub diagnostics: Vec[FileDiagnostic]
    pub errors: Vec[string]
}

/// The nearest folder at or above `start` (a file or folder) that has a mod.ms.
pub async fun find_project_root(tc: &Toolchain, start: &str) -> string? {
    var dir = resolve_from(tc.cwd, start)
    if !await is_dir(dir) {
        dir = dirname(dir)
    }
    for {
        if await fs.exists(join(dir, MOD_FILE)) {
            return Some(dir)
        }
        let up = dirname(dir)
        if up == dir {
            return None
        }
        dir = up
    }
}

/// §17.6: `Config.main`, else `./src` if it exists, else the root.
pub async fun default_main_dir(root: &str, main: &str) -> string {
    if main != "" {
        return resolve_from(root, main)
    }
    let src = join(root, "src")
    if await is_dir(src) { src } else { root.to_str() }
}

/// The `path:` entries of a deps map, as folders (registry and `git:` deps aren't fetched yet).
pub fun path_deps(root: &str, deps: &Map[string, string]) -> Map[string, string] {
    var out = m{} as Map[string, string]
    for name, spec in deps {
        if spec.starts_with("path:") {
            out[name.clone()] = resolve_from(root, spec.substring(5, spec.len()))
        }
    }
    out
}

/// Opens the project at `root`: evaluates its mod.ms, if it has one.
pub async fun open_project(tc: &Toolchain, root: &str) -> Project {
    let dir = resolve_from(tc.cwd, root)
    let mod_file = join(dir, MOD_FILE)
    var project = Project {
        root: dir.clone(), mod_file: None, config: None, main_dir: await default_main_dir(dir, ""),
        deps: m{}, diagnostics: [], errors: [],
    }
    if !await fs.exists(mod_file) {
        return project
    }
    project.mod_file = Some(mod_file.clone())
    let ev = await evaluate_config(tc, mod_file)
    project.diagnostics = ev.diagnostics
    if let Some(e) = ev.error {
        project.errors.push(e)
    }
    if let Some(c) = ev.config {
        project.main_dir = await default_main_dir(dir, c.main)
        project.deps = path_deps(dir, c.deps)
        project.config = Some(c)
    }
    project
}

pub type Evaluated = { pub config: ProjectConfig?, pub diagnostics: Vec[FileDiagnostic], pub error: string? }

/// The generated file's path, next to mod.ms.
fun harness_path(mod_file: &str) -> string { join(dirname(mod_file), "__ms_mod_main.ms") }

/// Printed before the configuration, so what `config()` prints itself can be told apart.
let CONFIG_MARKER = "\n@@ms-config@@"

fun config_harness() -> string {
    [
        "package mod",
        "",
        "import \"std.build\" as ms_build",
        "import \"std.json\" as ms_json",
        "import \"std.io\" as ms_io",
        "",
        "pub fun ms_config_main() -> int {",
        "    let r = recover { ms_build.evaluate(config) }",
        "    match r {",
        "        Ok(c) => ms_io.print(\"\\n@@ms-config@@{\\\"config\\\":\${ms_json.stringify(c.describe())}}\")",
        "        Err(p) => ms_io.print(\"\\n@@ms-config@@{\\\"error\\\":\${ms_json.stringify(p.message)}}\")",
        "    }",
        "    0",
        "}",
        "",
    ].join("\n")
}

/// What `config_harness` prints after the marker.
type Outcome = { config: json.Value? = None, error: string? = None }

/// Whether the `package mod` files next to mod.ms declare a `config` function, and the package mod.ms declares.
async fun mod_shape(mod_file: &str) -> t(string, bool) {
    let dir = dirname(mod_file)
    var declared = ""
    var has_config = false
    let names = await fs.list_dir(dir) or return t("", false)
    for n in names.iter() {
        if !n.ends_with(".ms") || n.ends_with("_test.ms") {
            continue
        }
        let path = join(dir, n)
        let bytes = await fs.read_file(path) or continue
        let f = parse(bytes).file
        let pkg = if f.package_path.is_empty() { "main" } else { f.package_path.join(".") }
        if path == mod_file {
            declared = pkg.clone()
        }
        if pkg != "mod" {
            continue
        }
        for itm in f.items.iter() {
            if let Fun(fd) = itm {
                if fd.name == "config" && fd.receiver.is_none() {
                    has_config = true
                }
            }
        }
    }
    t(declared, has_config)
}

/// Compiles mod.ms (with `build` and whatever it imports) and runs its `config()` (spec §17.5).
pub async fun evaluate_config(tc: &Toolchain, mod_file: &str) -> Evaluated {
    let t(declared, has_config) = await mod_shape(mod_file)
    if declared != "mod" || !has_config {
        // the same checks as stage 0, after compiling mod.ms as it is
        let plain = await compile_to_js(tc, mod_file, LoadOptions {}, "config", true)
        if !plain.diagnostics.is_empty() {
            return Evaluated { config: None, diagnostics: plain.diagnostics, error: None }
        }
        let why = if declared != "mod" { "must declare `package mod`" } else { "has no `pub fun config() -> Config`" }
        return Evaluated { config: None, diagnostics: [], error: Some("${mod_file} ${why}") }
    }
    var extra = m{} as Map[string, string]
    extra[harness_path(mod_file)] = config_harness()
    let compiled = await compile_to_js(tc, mod_file, LoadOptions { extra }, "ms_config_main", true)
    let Some(code) = compiled.js else {
        return Evaluated { config: None, diagnostics: compiled.diagnostics, error: None }
    }
    let r = await runtime.run_module_result(code, [], true)
    let Some(at) = last_index_of(r.stdout, CONFIG_MARKER) else {
        io_print(r.stdout)
        return Evaluated { config: None, diagnostics: [], error: Some("evaluating ${mod_file}: it stopped with exit code ${r.code}") }
    }
    io_print(r.stdout.substring(0, at))            // what config() printed itself
    let payload = r.stdout.substring(at + CONFIG_MARKER.len(), r.stdout.len())
    let outcome = json.parse.[Outcome](payload) or e => {
        return Evaluated { config: None, diagnostics: [], error: Some("evaluating ${mod_file}: ${e}") }
    }
    if let Some(message) = outcome.error {
        return Evaluated { config: None, diagnostics: [], error: Some("evaluating ${mod_file}: ${message}") }
    }
    let Some(v) = outcome.config else {
        return Evaluated { config: None, diagnostics: [], error: Some("evaluating ${mod_file}: no configuration") }
    }
    Evaluated { config: Some(from_described(v)), diagnostics: [], error: None }
}

fun io_print(text: &str) {
    if !text.is_empty() {
        io.print(text)
    }
}

fun last_index_of(s: &str, needle: &str) -> int? {
    var found: int? = None
    var from = 0
    for let Some(k) = s.find(needle, from) {
        found = Some(k)
        from = k + 1
    }
    found
}

fun field(v: &json.Value, name: &str) -> json.Value {
    match v {
        Object(fields) => fields.get(name) ?? json.Value.Null
        _ => json.Value.Null
    }
}

fun text_of(v: &json.Value) -> string {
    match v {
        Str(s) => s.clone()
        _ => ""
    }
}

fun strings_of(v: &json.Value) -> Map[string, string] {
    var out = m{} as Map[string, string]
    if let Object(fields) = v {
        for k, x in fields {
            out[k.clone()] = text_of(x)
        }
    }
    out
}

/// `Config.describe()`'s JSON → the configuration.
fun from_described(v: json.Value) -> ProjectConfig {
    var scripts = m{} as Map[string, Script]
    if let Object(entries) = field(v, "scripts") {
        for k, s in entries {
            let script: Script = if let Str(cmd) = field(s, "sh") {
                Shell(cmd)
            } else if let Str(path) = field(s, "pkg") {
                Package(path)
            } else {
                Task
            }
            scripts[k.clone()] = script
        }
    }
    var sections = m{} as Map[string, json.Value]
    if let Object(entries) = field(v, "sections") {
        sections = entries
    }
    ProjectConfig {
        name: text_of(field(v, "name")), version: text_of(field(v, "version")), main: text_of(field(v, "main")),
        deps: strings_of(field(v, "deps")), dev_deps: strings_of(field(v, "dev_deps")), scripts, sections,
        described: v,
    }
}

/// What `ms config` prints (as `JSON.stringify(…, null, 2)`).
pub fun config_json(c: &ProjectConfig) -> string { pretty(c.described, "") }

fun pretty(v: &json.Value, indent: &str) -> string {
    let inner = "${indent}  "
    match v {
        json.Value.Array(xs) => {
            if xs.is_empty() {
                return "[]"
            }
            let parts = xs.map(#{ x => "${inner}${pretty(x, inner)}" })
            "[\n${parts.join(",\n")}\n${indent}]"
        }
        Object(fields) => {
            if fields.is_empty() {
                return "{}"
            }
            var parts = [] as Vec[string]
            for k, x in fields {
                parts.push("${inner}${json.stringify(k)}: ${pretty(x, inner)}")
            }
            "{\n${parts.join(",\n")}\n${indent}}"
        }
        _ => json.stringify(v)
    }
}

/// Load options for the project's program: `app.` starts at `main`, and `path:` deps are visible.
pub fun program_options(p: &Project) -> LoadOptions {
    LoadOptions { app_root: Some(p.main_dir.clone()), deps: p.deps.clone() }
}

/// The generated file that runs the `task` script `name` (in the process that evaluates mod.ms).
fun task_harness(name: &str) -> string {
    let quoted = json.stringify(name)
    [
        "package mod",
        "",
        "import \"std.build\" as ms_build",
        "import \"std.env\" as ms_env",
        "import \"std.io\" as ms_io",
        "",
        "pub fun ms_task_main() -> int {",
        "    let c = ms_build.evaluate(config)",
        "    let Some(script) = c.scripts.get(${quoted}) else { return 1 }",
        "    match script {",
        "        ms_build.Script.Task(f) => match f(ms_build.Args { list: ms_env.args() }) {",
        "            Ok(_) => 0",
        "            Err(e) => {",
        "                ms_io.eprintln(\"error: script `${name}` failed: \${e}\")",
        "                1",
        "            }",
        "        }",
        "        _ => 1",
        "    }",
        "}",
        "",
    ].join("\n")
}

/// Runs the `task` script `name` of the project whose mod.ms is `mod_file`; the result is the exit code.
pub async fun run_task(tc: &Toolchain, mod_file: &str, name: &str, args: &Vec[string]) -> int {
    var extra = m{} as Map[string, string]
    extra[harness_path(mod_file)] = task_harness(name)
    let compiled = await compile_to_js(tc, mod_file, LoadOptions { extra }, "ms_task_main", true)
    let Some(code) = compiled.js else {
        print_diagnostics(tc, compiled.diagnostics)
        return 1
    }
    let r = await runtime.run_module_result(code, args, false)
    if r.code != 0 { r.code } else { r.value }
}

pub type Compiled = { pub js: string?, pub diagnostics: Vec[FileDiagnostic] }

/// Loads the program (the entry and every package it imports), runs every pass on every package, and
/// returns one JS module, or the diagnostics that stopped compilation. `entry_fn` is the function the
/// module's `$main` calls; with `in_package`, it is named in the entry package (`mod.config`).
pub async fun compile_to_js(tc: &Toolchain, entry: &str, opts: LoadOptions, entry_fn: &str, in_package: bool) -> Compiled {
    await compile_with(tc, entry, opts, entry_fn, in_package, tc.runtime_url)
}

/// `compile_to_js`, importing the runtime from `runtime_url`.
pub async fun compile_with(tc: &Toolchain, entry: &str, opts: LoadOptions, entry_fn: &str, in_package: bool, runtime_url: &str) -> Compiled {
    let loaded = await load_program(entry, tc.std_dir, opts)
    let program = loaded or e => {
        return Compiled { js: None, diagnostics: [FileDiagnostic { file: entry.to_str(), code: "E_LOAD", message: e, span: r{ start: 0, end: 0, line: 1, col: 1 }, pass: "load" }] }
    }
    if !program.diagnostics.is_empty() {
        return Compiled { js: None, diagnostics: program.diagnostics }
    }
    let pkg = program.packages[program.main].name.clone()
    let fn_name = if in_package && pkg != "main" { "${pkg}.${entry_fn}" } else { entry_fn.to_str() }
    var lowered = lower_program(program)
    hir.compute_witnesses(lowered)
    Compiled { js: Some(js.emit_js(lowered, program.syms(), program.vars(), runtime_url, fn_name)), diagnostics: [] }
}
