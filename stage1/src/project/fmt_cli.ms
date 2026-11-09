// `ms fmt [path…] [--check]` (spec §17.8), ported from minscript/src/fmt_cli.ts: formats .ms files in
// place, with the settings of the project's `fmt` section in mod.ms (`ms.fmt.setup(_{ indent: 2 })`).
// `--check` only reports the files that aren't formatted, and fails if there are any (for CI).
package project

import "std.fs"
import "std.io"
import "std.json"
import "app.fmt.{FmtOptions, format}"
import "app.loader.{join, resolve_from, is_dir}"

/// The `.ms` files at or under `path`, sorted (hidden folders, `node_modules` and `.git` skipped).
pub async fun ms_files(path: &str, out: &mut Vec[string]) {
    if !await is_dir(path) {
        if path.ends_with(".ms") && await fs.exists(path) {
            out.push(path.to_str())
        }
        return
    }
    var names = await fs.list_dir(path) or return
    names.sort()
    for e in names.iter() {
        if e.starts_with(".") || e == "node_modules" || e == ".git" {
            continue
        }
        await ms_files(join(path, e), out)
    }
}

/// `{ indent, max_width, trailing_commas }` (the `ms.fmt` Options) → FmtOptions.
pub fun fmt_options_from(section: &json.Value?) -> FmtOptions {
    var o = FmtOptions {}
    let Some(json.Value.Object(fields)) = section else { return o }
    if let Some(json.Value.Number(n)) = fields.get("indent") {
        o.indent = n as int
    }
    if let Some(json.Value.Number(n)) = fields.get("max_width") {
        o.max_width = n as int
    }
    if let Some(json.Value.Bool(b)) = fields.get("trailing_commas") {
        o.trailing_commas = b
    }
    o
}

/// The formatter settings for a file: its project's `fmt` section, or the defaults.
pub async fun fmt_options_for(tc: &Toolchain, file: &str, cache: &mut Map[string, FmtOptions]) -> FmtOptions {
    let Some(root) = await find_project_root(tc, file) else { return FmtOptions {} }
    if let Some(known) = cache.get(root) {
        return known
    }
    let p = await open_project(tc, root)
    let section = match &p.config {
        Some(c) => c.sections.get("fmt")
        None => None
    }
    let opts = fmt_options_from(section)
    cache[root.clone()] = opts.clone()
    opts
}

/// `ms fmt`. Returns the exit code.
pub async fun fmt_command(tc: &Toolchain, args: &Vec[string]) -> int {
    let check = args.contains("--check")
    let paths = args.filter(#{ a => a != "--check" })
    var files = [] as Vec[string]
    for p in (if paths.is_empty() { ["."] as Vec[string] } else { paths }).iter() {
        await ms_files(resolve_from(tc.cwd, p), files)
    }
    var cache = m{} as Map[string, FmtOptions]
    var changed = 0
    var failed = 0
    for file in files.iter() {
        let src = await fs.read_text(file) or continue
        let opts = await fmt_options_for(tc, file, cache)
        let r = format(src, opts)
        let Some(text) = r.text else {
            failed += 1
            io.eprintln("${show(tc, file)}:${r.span.line}:${r.span.col}: not formatted, it has a syntax error: ${r.code} ${r.message}")
            continue
        }
        if text == src {
            continue
        }
        changed += 1
        if check {
            io.println("${show(tc, file)}: not formatted")
        } else {
            let _ = await fs.write_text(file, text)
        }
    }
    let n = files.len()
    let s = if n == 1 { "" } else { "s" }
    if !check {
        let skipped = if failed > 0 { ", ${failed} skipped (syntax errors)" } else { "" }
        io.println("${changed} of ${n} file${s} formatted${skipped}")
    } else if changed == 0 && failed == 0 {
        io.println("${n} file${s}: all formatted")
    }
    if failed > 0 || (check && changed > 0) { 1 } else { 0 }
}
