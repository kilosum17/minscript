// `run`, `js`, `config` and `check` (spec §17.3): programs, projects and scripts. Ported from
// minscript/src/project_cli.ts (and the `check` command of src/cli.ts).
package project

import "std.env"
import "std.fs"
import "std.io"
import "std.runtime"
import "app.loader.{LoadOptions, FileDiagnostic, load_program, join, resolve_from, dirname, relative, is_dir}"

/// A path as the user would type it here: relative below the current folder, absolute elsewhere.
pub fun show(tc: &Toolchain, p: &str) -> string {
    let r = relative(tc.cwd, p)
    if r.is_empty() { "." } else if r.starts_with("..") { p.to_str() } else { r }
}

pub fun print_diagnostics(tc: &Toolchain, ds: &Vec[FileDiagnostic]) {
    for d in ds.iter() {
        io.eprintln("${show(tc, d.file)}:${d.span.line}:${d.span.col}: error ${d.code}: ${d.message}")
    }
}

/// Opens a project and reports why it can't be used.
pub async fun open(tc: &Toolchain, root: &str) -> Project? {
    let p = await open_project(tc, root)
    print_diagnostics(tc, p.diagnostics)
    for e in p.errors.iter() {
        io.eprintln("error: ${e}")
    }
    if p.diagnostics.is_empty() && p.errors.is_empty() { Some(p) } else { None }
}

fun pad_end(s: &str, width: int) -> string {
    var out = s.to_str()
    for out.len() < width {
        out = "${out} "
    }
    out
}

fun describe_script(s: &Script) -> string {
    match s {
        Shell(cmd) => cmd.clone()
        Package(path) => "pkg ${path}"
        Task => "task"
    }
}

/// `ms run`, `ms js` and `ms config`. Returns the exit code.
pub async fun run_program_command(tc: &Toolchain, command: &str, argv: &Vec[string]) -> int {
    var before = [] as Vec[string]
    var after = [] as Vec[string]
    var dashed = false
    for a in argv.iter() {
        if !dashed && a == "--" {
            dashed = true
        } else if dashed {
            after.push(a.clone())
        } else {
            before.push(a.clone())
        }
    }
    let target = before.get(0)
    var args = if dashed { before.skip(1) } else { argv.skip(1) }
    if dashed {
        args.extend(after)
    }

    if command == "config" {
        let start = target ?? "."
        let Some(root) = await find_project_root(tc, start) else {
            io.eprintln("no mod.ms at or above ${start}")
            return 1
        }
        let Some(p) = await open(tc, root) else { return 1 }
        let Some(c) = &p.config else { return 1 }
        io.println(config_json(c))
        return 0
    }

    // `ms run` alone: the scripts of the project here
    let Some(name) = target else {
        let found = match await find_project_root(tc, ".") {
            Some(root) => await open(tc, root)
            None => None
        }
        var listed = false
        if let Some(p) = &found {
            if let Some(c) = &p.config {
                if !c.scripts.is_empty() {
                    io.println("scripts in ${show(tc, p.mod_file ?? "")}:")
                    for k, s in c.scripts {
                        io.println("  ${pad_end(k, 12)} ${describe_script(s)}")
                    }
                    listed = true
                }
            }
        }
        if !listed {
            io.println("no scripts here")
        }
        io.println("`ms run <script>` runs one; `ms run .` (or a folder, or a file) runs the program")
        return 0
    }

    // `ms run <name>`: a script, when the name isn't a path
    let looks_like_path = name.contains("/") || name.ends_with(".ms") || name == "." || name == ".."
    if command == "run" && !looks_like_path && !await fs.exists(resolve_from(tc.cwd, name)) {
        let found = match await find_project_root(tc, ".") {
            Some(root) => await open(tc, root)
            None => None
        }
        let Some(p) = found else {
            io.eprintln("no script `${name}`, and no file or folder of that name")
            return 1
        }
        let has = match &p.config {
            Some(c) => c.scripts.has(name)
            None => false
        }
        if !has {
            let loc = match &p.config {
                Some(_) => " in ${show(tc, p.mod_file ?? "")}"
                None => ""
            }
            io.eprintln("no script `${name}`${loc}, and no file or folder of that name")
            return 1
        }
        return await run_script(tc, p, name, args)
    }
    await run_program(tc, command, resolve_from(tc.cwd, name), args)
}

/// The entry and load options for a path: a project, a plain folder, or a single file.
pub async fun entry_for(tc: &Toolchain, path: &str) -> t(string, LoadOptions)? {
    if let Some(root) = await find_project_root(tc, path) {
        let Some(p) = await open(tc, root) else { return None }
        let in_main = if await is_dir(path) { path == root || path == p.main_dir } else { dirname(path) == p.main_dir }
        let entry = if in_main { p.main_dir.clone() } else { path.to_str() }
        return Some(t(entry, program_options(p)))
    }
    if await is_dir(path) {
        let main = await default_main_dir(path, "")
        return Some(t(main.clone(), LoadOptions { app_root: Some(main) }))
    }
    Some(t(path.to_str(), LoadOptions {}))
}

async fun run_program(tc: &Toolchain, command: &str, path: &str, args: &Vec[string]) -> int {
    if !await fs.exists(path) {
        io.eprintln("no such file or folder: ${show(tc, path)}")
        return 2
    }
    let Some(found) = await entry_for(tc, path) else { return 1 }
    let t(entry, opts) = found
    let runtime_url = if command == "js" { tc.output_runtime_url.clone() } else { tc.runtime_url.clone() }
    let compiled = await compile_with(tc, entry, opts, "main", false, runtime_url)
    print_diagnostics(tc, compiled.diagnostics)
    let Some(code) = compiled.js else { return 1 }
    if command == "js" {
        io.print(code)
        return 0
    }
    await runtime.run_module(code, args)
}

/// `ms <name>`: the script `name` of the project here, if there is one (None: no such script).
pub async fun run_script_shorthand(tc: &Toolchain, name: &str, argv: &Vec[string]) -> int? {
    let root = await find_project_root(tc, ".") or return None
    let p = await open_project(tc, root)
    let has = match &p.config {
        Some(c) => c.scripts.has(name)
        None => false
    }
    if !has {
        return None
    }
    var rest = [] as Vec[string]
    var dropped = false
    for a in argv.iter() {
        if a == "--" && !dropped {
            dropped = true
            continue
        }
        rest.push(a.clone())
    }
    Some(await run_script(tc, p, name, rest))
}

/// A shell word: `it's` → `'it'\''s'`.
fun quote(a: &str) -> string { "'${a.replace("'", "'\\''")}'" }

async fun run_script(tc: &Toolchain, p: Project, name: &str, args: &Vec[string]) -> int {
    let Some(c) = &p.config else { return 1 }
    let Some(script) = c.scripts.get(name) else { return 1 }
    match script {
        Shell(cmd) => {
            let quoted = args.map(#{ a => quote(a) }).join(" ")
            let line = if quoted.is_empty() { cmd } else { "${cmd} ${quoted}" }
            runtime.shell(line, p.root)
        }
        Package(path) => await run_program(tc, "run", resolve_from(p.root, path), args)
        Task => await run_task(tc, p.mod_file ?? "", name, args)
    }
}

/// `ms check [<path>…]`: each path's program, with its imports. Returns the exit code.
pub async fun check_command(tc: &Toolchain, paths: &Vec[string]) -> int {
    var failed = false
    for path in (if paths.is_empty() { ["."] as Vec[string] } else { paths.clone() }).iter() {
        let Some(found) = await entry_for(tc, resolve_from(tc.cwd, path)) else {
            failed = true
            continue
        }
        let t(entry, opts) = found
        let loaded = await load_program(entry, tc.std_dir, opts)
        let program = loaded or e => {
            io.eprintln(e)
            return 1
        }
        print_diagnostics(tc, program.diagnostics)
        if !program.diagnostics.is_empty() {
            failed = true
            continue
        }
        let n = program.order.len()
        io.println("${path}: ok (${n} package${if n == 1 { "" } else { "s" }}, ${program.file_count()} files)")
    }
    if failed { 1 } else { 0 }
}

/// The toolchain options every program command takes (`--std <dir>`, `--runtime <url>`, before any
/// `--`), and the remaining arguments. `--std` defaults to `$MS_STD`. `--runtime` is for the output of
/// `js` only: the modules the toolchain runs itself import `$MS_RUNTIME`, else `<std>/../runtime/runtime.ts`.
pub fun toolchain_options(argv: &Vec[string]) -> Result[t(Toolchain, Vec[string]), string] {
    var std_dir = env.get("MS_STD") ?? ""
    var output_url = ""
    var rest = [] as Vec[string]
    var i = 0
    for i < argv.len() {
        if argv[i] == "--" {
            rest.extend(argv.skip(i))
            break
        }
        if (argv[i] == "--std" || argv[i] == "--runtime") && i + 1 < argv.len() {
            if argv[i] == "--std" {
                std_dir = argv[i + 1].clone()
            } else {
                output_url = argv[i + 1].clone()
            }
            i += 2
            continue
        }
        rest.push(argv[i].clone())
        i += 1
    }
    if std_dir.is_empty() {
        return Err("needs `--std <path to the std folder>` (or MS_STD)")
    }
    let cwd = env.cwd()
    let std = resolve_from(cwd, std_dir)
    // the runtime the modules this toolchain runs import: `$MS_RUNTIME` (bin/ms1.js sets it to its
    // own), else the one next to std
    let runtime_url = match env.get("MS_RUNTIME") {
        Some(r) => if r.starts_with("file:") { r } else { "file://${resolve_from(cwd, r)}" }
        None => "file://${resolve_from(std, "../runtime/runtime.ts")}"
    }
    let output_runtime_url = if output_url.is_empty() { runtime_url.clone() } else { output_url }
    Ok(t(Toolchain { std_dir: std, runtime_url, output_runtime_url, cwd }, rest))
}
