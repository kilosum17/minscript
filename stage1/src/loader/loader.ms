// Loading a program: the entry package and every package it imports (spec §8.1), ported from
// minscript/src/loader.ts.
//
// - A folder is a package: all its `.ms` files. The entry is a file or a folder: a folder's `package main`
//   files are the main package; a `main` *file* is a package of its own.
// - Imports: `"std.x"` is a folder under std/; `"app.x"` is a folder under the program's root (the
//   entry file's folder); `"./x"` / `"../x"` are relative to the importing file. `"std.io.println"` and
//   `"std.io.{a, b}"` name items of a package; `"pkg.*"` imports all its pub items. Any other path is an
//   external dependency, which isn't supported yet: it stays opaque.
// - The package graph must be acyclic (E_IMPORT_CYCLE). Packages are analysed in dependency order,
//   each with the results of everything it can reach; every pass runs on every package.
//
// Stage 1's arenas make one program one chain: each package's resolution continues the symbol arena
// of the package analysed before it, and its checker continues the inference variables, so the last
// package's arenas hold everything (`syms()`, `vars()`). Node ids are unique across the program.
//
// `LoadOptions` are stage 0's: `app_root` and `deps` come from a project (src/project/), `test_dir`
// and `extra` from `ms test`. Stage 0's `read` / `list` overrides are `extra`: files that exist only in
// memory (`ms test`'s generated file), read and listed as if they were on disk.
package loader

import "std.fs"
import "std.env"
import "std.utf8"
import "app.lexer.{Span}"
import "app.ast.{File, collect_spans}"
import "app.parser.{parse_from, ParseResult}"
import "app.resolve.{Sym, Resolution, ResolveOptions, LoadedImport, resolve_package, resolve_loaded}"
import "app.check.{CheckResult, CheckedDep, VarState, check_loaded}"
import "app.ownership.{check_ownership}"
import "app.hir"

pub type SourceFile = { pub path: string, pub parsed: ParseResult }

/// An import of a package that was found: which package (index into `packages`) and items.
pub type Link = { pub import_id: int, pub dep: int, pub item: string?, pub items: Vec[string]?, pub glob: bool }

pub type Package = {
    /// "main", "std.json", "app.models"
    pub name: string
    pub dir: string
    pub files: Vec[SourceFile]
    pub links: Vec[Link] = []
    /// its index in `analysed` (-1: not analysed)
    pub slot: int = -1
}

/// pass: "load", "parse", "resolve", "check" or "ownership"
pub type FileDiagnostic = { pub file: string, pub code: string, pub message: string, pub span: Span, pub pass: string }

pub type Program = {
    /// the main package (an index into `packages`)
    pub main: int
    /// every package, in the order they were found
    pub packages: Vec[Package]
    /// the loaded packages in dependency order (main last), as stage 0's `packages`
    pub order: Vec[int]
    /// the results of each analysed package, by slot
    pub analysed: Vec[CheckedDep]
    pub diagnostics: Vec[FileDiagnostic]
    pub prelude_file: File
    pub prelude: Resolution
    pub prelude_checked: CheckResult
    pub std_dir: string
    pub cwd: string
    /// what lowering and the back end read once everything is analysed: the program's arenas (the
    /// last analysed package's), its merged side tables and the clones that are moves (`freeze`)
    pub shared: hir.Shared
}

impl Program {
    pub fun file_count(&this) -> int {
        var n = 0
        for i in this.order.iter() {
            n += this.packages[i].files.len()
        }
        n
    }
}

pub type LoadOptions = {
    /// The folder `app.x` imports start from. None: the entry's folder (a project passes its `main`).
    pub app_root: string? = None
    /// `path:` dependencies from mod.ms: import root name → folder (`"utils"` → /work/utils).
    pub deps: Map[string, string] = m{}
    /// The folder whose `*_test.ms` files are included (`ms test`). Others' tests never are.
    pub test_dir: string? = None
    /// Files that exist only in memory: absolute path → text.
    pub extra: Map[string, string] = m{}
}

union Located = {
    LPackage { dir: string, name: string, item: string?, items: Vec[string]?, glob: bool }
    LExternal
    LError(string)
}

type Loader = {
    opts: LoadOptions
    std_dir: string
    cwd: string
    app_root: string = ""
    by_dir: Map[string, int] = m{}
    packages: Vec[Package] = []
    ordered: Vec[int] = []
    visiting: Set[int] = Set.new()
    diagnostics: Vec[FileDiagnostic] = []
    next_id: int
    prelude_file: File
    prelude: Resolution
    prelude_checked: CheckResult
    analysed: Vec[CheckedDep] = []
}

/// Loads and analyses the program at `entry` (a file or a folder). `std_dir` is the std folder
/// (with `prelude.ms`).
pub async fun load_program(entry: &str, std_dir: &str, opts: LoadOptions) -> Result[Program, string] {
    let cwd = env.cwd()
    let std = resolve_from(cwd, std_dir)
    let prelude_path = join(std, "prelude.ms")
    let bytes = await fs.read_file(prelude_path) or e => return Err("can't read the prelude: ${e}")
    let parsed = parse_from(bytes, 0)
    let prelude = resolve_package([parsed.file], None, ResolveOptions { std: true, package_name: "std" })
    // the prelude's own functions are checked (and lowered) too: they start the program's arenas
    var own = prelude.clone()
    let prelude_checked = check_loaded([parsed.file], own, parsed.file, prelude, [], [], [])
    var l = Loader { opts, std_dir: std, cwd: cwd.clone(), next_id: parsed.next_id, prelude_file: parsed.file, prelude, prelude_checked }
    let path = resolve_from(cwd, entry)
    let main = if await is_dir(path) { await l.load_folder(path) } else { await l.load_file(path) }
    let shared = l.freeze()
    Ok(Program {
        main, packages: l.packages, order: l.ordered, analysed: l.analysed, diagnostics: l.diagnostics,
        prelude_file: l.prelude_file, prelude: l.prelude, prelude_checked: l.prelude_checked, std_dir: l.std_dir, cwd, shared,
    })
}

pub async fun is_dir(path: &str) -> bool {
    match await fs.stat(path) {
        Ok(s) => s.dir
        Err(_) => false
    }
}

async fun is_package_dir(dir: &str) -> bool {
    if !await is_dir(dir) {
        return false
    }
    match await fs.list_dir(dir) {
        Ok(names) => names.any(#{ n => n.ends_with(".ms") })
        Err(_) => false
    }
}


fun package_name_of(f: &File) -> string {
    let name = f.package_path.join(".")
    if name.is_empty() { "main" } else { name }
}

fun dotted(rel: &str) -> string { rel.split("/").join(".") }

impl Loader {
    /// Everything is analysed: the program's arenas (they moved on to the last analysed package) are
    /// final, and the side tables are merged once, as `Ref`s that lowering and the back end read.
    fun freeze(&mut this) -> hir.Shared {
        var moves = Set.new() as Set[int]
        for d in this.analysed.iter() {
            for id in d.moves.iter() {
                let _ = moves.insert(id)
            }
        }
        let tables = hir.merge_program_tables(this.prelude, this.analysed)
        let n = this.analysed.len()
        if n == 0 {
            return hir.Shared {
                syms: Ref(this.prelude.symbols.clone()), scopes: Ref(this.prelude.scopes.clone()),
                vars: Ref(this.prelude_checked.vars.clone()), tables: Ref(tables), moves: Ref(moves),
            }
        }
        hir.Shared {
            syms: Ref(this.analysed[n - 1].res.symbols.drain()), scopes: Ref(this.analysed[n - 1].res.scopes.drain()),
            vars: Ref(this.analysed[n - 1].checked.vars.drain()), tables: Ref(tables), moves: Ref(moves),
        }
    }

    /// A folder's `.ms` files (with the in-memory ones), sorted, without `*_test.ms` unless it is the
    /// folder under test.
    async fun source_files(&this, dir: &str) -> Vec[string] {
        var names = await fs.list_dir(dir) or return []
        for path, _ in this.opts.extra {
            if dirname(path) == dir {
                names.push(basename(path))
            }
        }
        let tests = this.opts.test_dir == Some(dir.to_str())
        var out = [] as Vec[string]
        for n in names.iter() {
            if n.ends_with(".ms") && (tests || !n.ends_with("_test.ms")) && !out.contains(n) {
                out.push(n.clone())
            }
        }
        out.sort()
        out
    }

    fun qualified_name(&this, dir: &str) -> string {
        for name, root in this.opts.deps {
            let rel = relative(root, dir)
            if !rel.starts_with("..") {
                return if rel == "" { name.clone() } else { "${name}.${dotted(rel)}" }
            }
        }
        let std = relative(this.std_dir, dir)
        if !std.starts_with("..") && std != "" {
            return "std.${dotted(std)}"
        }
        let rel = relative(this.app_root, dir)
        if !rel.starts_with("..") && rel != "" {
            return "app.${dotted(rel)}"
        }
        let segs = segments(dir)
        let n = segs.len()
        "local.${segs.skip(if n >= 2 { n - 2 } else { 0 }).join(".")}"
    }

    /// Where an import path points (spec §8.1).
    async fun locate(&this, path: &str, from_dir: &str) -> Located {
        var clean = match path.find("@", 0) {
            Some(k) => path.substring(0, k).to_str()             // tool imports pin a version: "acme.lint@^1.2"
            None => path.to_str()
        }
        var glob = false
        var items: Vec[string]? = None
        if clean.ends_with(".*") {
            glob = true
            clean = clean.substring(0, clean.len() - 2).to_str()
        }
        if clean.ends_with("}") {
            var at = -1
            var from = 0
            for let Some(k) = clean.find(".{", from) {
                at = k
                from = k + 1
            }
            if at >= 0 {
                var list = [] as Vec[string]
                for raw in clean.substring(at + 2, clean.len() - 1).split(",").iter() {
                    let x = raw.trim()
                    if !x.is_empty() {
                        list.push(x.to_str())
                    }
                }
                items = Some(list)
                clean = clean.substring(0, at).to_str()
            }
        }
        if clean.starts_with("./") || clean.starts_with("../") {
            let dir = resolve_from(from_dir, clean)
            if await is_package_dir(dir) {
                return LPackage { dir: dir.clone(), name: this.qualified_name(dir), item: None, items, glob }
            }
            return LError("no package at `${path}` (looked for a folder of .ms files at ${dir})")
        }
        // `build` (the toolchain API for mod.ms) and the first-party `ms.*` tools ship with the toolchain, in std
        let parts = clean.split(".").map(#{ s => s.to_str() })
        let first = parts[0].clone()
        var segs = if first == "build" || first == "ms" { ["std"] as Vec[string] } else { [] as Vec[string] }
        segs.extend(parts)
        let dep = this.opts.deps.get(segs[0])
        let root = match &dep {
            Some(d) => d.clone()
            None => if segs[0] == "std" { this.std_dir.clone() } else if segs[0] == "app" { this.app_root.clone() } else { return LExternal }
        }
        let rest = segs.skip(1)
        if rest.is_empty() && dep.is_none() {
            return LError("`${path}` names a root, not a package")
        }
        let dir = join(root, rest.join("/"))
        if await is_package_dir(dir) {
            return LPackage { dir: dir.clone(), name: this.qualified_name(dir), item: None, items, glob }
        }
        if !glob && items.is_none() && rest.len() >= (if dep.is_none() { 2 } else { 1 }) {
            let parent = join(root, rest.take(rest.len() - 1).join("/"))
            if await is_package_dir(parent) {
                return LPackage { dir: parent.clone(), name: this.qualified_name(parent), item: Some(rest[rest.len() - 1].clone()), items: None, glob: false }
            }
        }
        if let Some(d) = &dep {
            return LError("no package `${clean}` in the dependency `${segs[0]}` (${d})")
        }
        let hint = if segs[0] == "std" { " in std" } else { " (looked for the folder `${rest.join("/")}/` next to the entry file)" }
        LError("no package `${clean}`${hint}")
    }

    async fun parse_file(&mut this, path: &str) -> SourceFile? {
        let bytes = match this.opts.extra.get(path) {
            Some(text) => utf8.encode(text)
            None => await fs.read_file(path) or return None
        }
        let parsed = parse_from(bytes, this.next_id)
        this.next_id = parsed.next_id
        Some(SourceFile { path: path.to_str(), parsed })
    }

    async fun load_file(&mut this, entry: &str) -> int {
        this.app_root = this.opts.app_root ?? dirname(entry)
        let file = await this.parse_file(entry) ?? SourceFile { path: entry.to_str(), parsed: parse_from(utf8.encode(""), this.next_id) }
        let name = package_name_of(file.parsed.file)
        let main = if name == "main" {
            this.packages.push(Package { name: "main", dir: dirname(entry), files: [file] })
            this.packages.len() - 1
        } else {
            // the name it has when imported (`std.json`, `app.models`); outside every root, the declared name
            let q = this.qualified_name(dirname(entry))
            await this.package_at(dirname(entry), if q.starts_with("local.") { name } else { q }, Some(file))
        }
        await this.visit(main)
        for i in this.ordered.clone().iter() {
            this.analyse(i)
        }
        main
    }

    /// A folder entry: its `package main` files are the main package.
    async fun load_folder(&mut this, dir: &str) -> int {
        let main_dir = dir.to_str()
        this.app_root = this.opts.app_root ?? main_dir.clone()
        var files = [] as Vec[SourceFile]
        for f in (await this.source_files(main_dir)).iter() {
            let Some(sf) = await this.parse_file(join(main_dir, f)) else { continue }
            if package_name_of(sf.parsed.file) == "main" {
                files.push(sf)
            }
        }
        let empty = files.is_empty()
        this.packages.push(Package { name: "main", dir: main_dir.clone(), files })
        let main = this.packages.len() - 1
        this.by_dir[main_dir.clone()] = main
        if empty {
            this.report(main_dir, "E_NO_MAIN", "no `package main` file in ${main_dir}", r{ start: 0, end: 0, line: 1, col: 1 })
            return main
        }
        await this.visit(main)
        for i in this.ordered.clone().iter() {
            this.analyse(i)
        }
        main
    }

    /// All `.ms` files of a folder (for the entry package: those declaring the same package).
    async fun package_at(&mut this, dir: &str, name: &str, entry: SourceFile?) -> int {
        var files = [] as Vec[SourceFile]
        let entry_path = match &entry {
            Some(e) => e.path.clone()
            None => ""
        }
        let entry_pkg = match &entry {
            Some(e) => Some(package_name_of(e.parsed.file))
            None => None
        }
        if let Some(e) = entry {
            files.push(e)
        }
        for f in (await this.source_files(dir)).iter() {
            let path = join(dir, f)
            if path == entry_path {
                continue
            }
            let Some(sf) = await this.parse_file(path) else { continue }
            if let Some(p) = &entry_pkg {
                if package_name_of(sf.parsed.file) != p {
                    continue
                }
            }
            files.push(sf)
        }
        this.packages.push(Package { name: name.to_str(), dir: dir.to_str(), files })
        let i = this.packages.len() - 1
        this.by_dir[dir.to_str()] = i
        i
    }

    /// Depth-first: dependencies are added to `ordered` before the packages that import them.
    async fun visit(&mut this, pkg: int) {
        let _ = this.visiting.insert(pkg)
        var f = 0
        for f < this.packages[pkg].files.len() {
            let file_path = this.packages[pkg].files[f].path.clone()
            let imports = this.packages[pkg].files[f].parsed.file.imports.clone()
            f += 1
            for imp in imports.iter() {
                let loc = await this.locate(imp.path, dirname(file_path))
                var found: t(string, string, string?, Vec[string]?, bool)? = None
                match loc {
                    LPackage { dir, name, item, items, glob } => found = Some(t(dir, name, item, items, glob))
                    LError(message) => this.report(file_path, "E_UNKNOWN_IMPORT", message, imp.span)
                    LExternal => {}
                }
                let Some(target) = found else { continue }
                let t(dir, name, item, items, glob) = target
                var dep = -1
                match this.by_dir.get(dir) {
                    None => {
                        dep = await this.package_at(dir, name, None)
                        if this.packages[dep].files.any(#{ x => package_name_of(x.parsed.file) == "main" }) {
                            this.report(file_path, "E_IMPORT_MAIN", "`${imp.path}` is a `package main` folder; main can't be imported", imp.span)
                        }
                        await this.visit(dep)
                    }
                    Some(d) => {
                        dep = d
                        if this.visiting.has(d) {
                            let msg = "import cycle: `${this.packages[pkg].name}` imports `${this.packages[d].name}`, which imports `${this.packages[pkg].name}` back (directly or through other packages); move the shared items into a third package"
                            this.report(file_path, "E_IMPORT_CYCLE", msg, imp.span)
                            continue
                        }
                    }
                }
                this.packages[pkg].links.push(Link { import_id: imp.id, dep, item, items, glob })
            }
        }
        let _ = this.visiting.remove(pkg)
        this.ordered.push(pkg)
    }

    fun report(&mut this, file: &str, code: &str, message: string, span: Span) {
        this.diagnostics.push(FileDiagnostic { file: file.to_str(), code: code.to_str(), message, span, pass: "load" })
    }

    /// Everything a package can reach through its imports, in first-reached order (for the checker and lowering).
    fun reachable(&this, pkg: int, out: &mut Vec[int]) {
        for link in this.packages[pkg].links.iter() {
            if out.contains(link.dep) {
                continue
            }
            out.push(link.dep)
            this.reachable(link.dep, out)
        }
    }

    /// The analysed slots of the packages `pkg` can reach.
    fun reach_slots(&this, pkg: int) -> Vec[int] {
        var all = [] as Vec[int]
        this.reachable(pkg, all)
        var out = [] as Vec[int]
        for d in all.iter() {
            let s = this.packages[d].slot
            if s >= 0 {
                out.push(s)
            }
        }
        out
    }

    fun analyse(&mut this, pkg: int) {
        // the files' syntax trees move to the analysed package (nothing reads them from `packages` after
        // loading); the source files keep their paths and parse diagnostics
        var asts = [] as Vec[File]
        var paths = [] as Vec[string]
        var parse_diags = [] as Vec[FileDiagnostic]
        var k = 0
        for k < this.packages[pkg].files.len() {
            let path = this.packages[pkg].files[k].path.clone()
            for d in this.packages[pkg].files[k].parsed.diagnostics.iter() {
                parse_diags.push(FileDiagnostic { file: path.clone(), code: d.code.clone(), message: d.message.clone(), span: d.span, pass: "parse" })
            }
            let f = &mut this.packages[pkg].files[k].parsed.file
            asts.push(File { id: f.id, span: f.span, package_path: f.package_path.clone(), imports: f.imports.drain(), items: f.items.drain() })
            paths.push(path)
            k += 1
        }
        let name = this.packages[pkg].name.clone()
        var imports = m{} as Map[int, LoadedImport]
        for link in this.packages[pkg].links.iter() {
            let slot = this.packages[link.dep].slot
            if slot < 0 {
                continue
            }
            imports[link.import_id] = LoadedImport {
                pkg_scope: this.analysed[slot].res.pkg_scope, path: this.packages[link.dep].name.clone(),
                item: link.item.clone(), items: link.items.clone(), glob: link.glob,
            }
        }
        // the arenas move on from the package analysed before (only the last package holds them)
        let n = this.analysed.len()
        let opts = ResolveOptions { package_name: name }
        var res = if n == 0 {
            resolve_loaded(asts, this.prelude, this.prelude.symbols.clone(), this.prelude.scopes.clone(), imports, opts)
        } else {
            let syms = this.analysed[n - 1].res.symbols.drain()
            let scopes = this.analysed[n - 1].res.scopes.drain()
            resolve_loaded(asts, this.prelude, syms, scopes, imports, opts)
        }
        let reach = this.reach_slots(pkg)
        let vars = if n == 0 { this.prelude_checked.vars.clone() } else { this.analysed[n - 1].checked.vars.drain() }
        var checked = check_loaded(asts, res, this.prelude_file, this.prelude, this.analysed, reach, vars)
        let owned = check_ownership(asts, res, checked)
        this.diagnostics.extend(parse_diags)
        var spans = [] as Vec[Set[string]]
        if asts.len() > 1 {
            for f in asts.iter() {
                spans.push(collect_spans(f))
            }
        }
        let passes = [t("resolve", res.diagnostics.clone()), t("check", checked.diagnostics.clone()), t("ownership", owned.diagnostics)]
        for entry in passes.iter() {
            let t(pass, list) = entry
            for d in list.iter() {
                let file = attribute(d.span, paths, spans)
                this.diagnostics.push(FileDiagnostic { file, code: d.code.clone(), message: d.message.clone(), span: d.span, pass: pass.to_str() })
            }
        }
        this.analysed.push(CheckedDep { files: asts, res, checked, moves: owned.moves })
        this.packages[pkg].slot = this.analysed.len() - 1
    }
}

/// Which file of a package a resolver / checker diagnostic belongs to: the one with a node at that span.
fun attribute(span: Span, paths: &Vec[string], spans: &Vec[Set[string]]) -> string {
    if paths.len() == 1 {
        return paths[0].clone()
    }
    let key = "${span.start}:${span.end}:${span.line}"
    var i = 0
    for i < paths.len() {
        if spans[i].has(key) {
            return paths[i].clone()
        }
        i += 1
    }
    paths[0].clone()
}

/// How a file is named in panic locations: std files as `std/…`, others relative to the current folder.
fun display_path(p: &Program, path: &str) -> string {
    let std = relative(p.std_dir, path)
    if !std.starts_with("..") {
        return "std/${std}"
    }
    let rel = relative(p.cwd, path)
    if rel.starts_with("..") { path.to_str() } else { rel }
}

/// Lowers every package of a loaded program into one HIR program: the prelude's functions written in
/// MinScript (spec §10.1), then each package, dependencies first.
pub fun lower_program(p: &Program) -> hir.Program {
    // the prelude is lowered with its own arenas; every package with the program's
    let own = hir.package_shared(p.prelude, p.prelude, p.prelude_checked, Set.new())
    let prelude = hir.lower_loaded([p.prelude_file.clone()], p.prelude, p.prelude_checked, p.prelude_file, p.prelude, "std", [], [], ["std/prelude.ms"], 0, own)
    var out = hir.Program { funs: prelude.funs.filter(#{ f => !f.builtin }) }
    var temps = prelude.temps
    for i in p.order.iter() {
        let pkg = &p.packages[i]
        if pkg.slot < 0 {
            continue
        }
        var all = [] as Vec[int]
        reachable_in(p, i, all)
        var reach = [] as Vec[int]
        for d in all.iter() {
            if p.packages[d].slot >= 0 {
                reach.push(p.packages[d].slot)
            }
        }
        let names = pkg.files.map(#{ f => display_path(p, f.path) })
        let a = &p.analysed[pkg.slot]
        let lowered = hir.lower_loaded(a.files, a.res, a.checked, p.prelude_file, p.prelude, pkg.name, p.analysed, reach, names, temps, p.shared)
        temps = lowered.temps
        out.types.extend(lowered.types)
        out.funs.extend(lowered.funs)
        out.globals.extend(lowered.globals)
    }
    out.temps = temps
    out
}

fun reachable_in(p: &Program, pkg: int, out: &mut Vec[int]) {
    for link in p.packages[pkg].links.iter() {
        if out.contains(link.dep) {
            continue
        }
        out.push(link.dep)
        reachable_in(p, link.dep, out)
    }
}
