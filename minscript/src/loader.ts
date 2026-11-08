// Loading a program: the entry package and every package it imports (spec §8.1).
//
// - A folder is a package: all its `.ms` files. The entry is a file or a folder: a folder's `package main`
//   files are the main package (a project's `main`, spec §17.6); a `main` *file* is a package of its
//   own, so a folder of example programs works.
// - Imports: `"std.x"` is a folder under std/; `"app.x"` is a folder under the program's root (the
//   entry file's folder); `"./x"` / `"../x"` are relative to the importing file. `"std.io.println"` and
//   `"std.io.{a, b}"` name items of a package; `"pkg.*"` imports all its pub items. Any other path is an
//   external dependency, which isn't supported yet: it stays opaque (its members are `unknown`).
// - The package graph must be acyclic (E_IMPORT_CYCLE). Packages are analysed in dependency order,
//   each with the results of everything it can reach; every pass runs on every package.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type * as A from "./ast.ts"
import { checkPackage, type CheckedDep, type CheckResult } from "./check.ts"
import type { Diagnostic } from "./diagnostic.ts"
import type * as H from "./hir.ts"
import { lowerPackage } from "./lower.ts"
import { checkOwnership } from "./ownership.ts"
import { parse, type ParseResult } from "./parser.ts"
import { loadPrelude } from "./prelude.ts"
import { resolvePackage, type LoadedImport, type Resolution } from "./resolve.ts"
import type { Span } from "./token.ts"

export const STD_DIR = fileURLToPath(new URL("../std/", import.meta.url))

export type SourceFile = { path: string, text: string, parsed: ParseResult }

export type Package = {
    /** Qualified name: "main", "std.json", "app.models" (items are named `<name>.<item>`, except in main). */
    name: string
    dir: string
    files: SourceFile[]
    links: Map<A.Import, { dep: Package, item: string | null, items: string[] | null, glob: boolean }>
    res?: Resolution
    checked?: CheckResult
}

/** `pass`: which stage reported it (`load`: a bad import, found while loading). */
export type FileDiagnostic = Diagnostic & { file: string, pass: "load" | "parse" | "resolve" | "check" | "ownership" }

export type Program = {
    main: Package
    /** Every loaded package, dependencies first; `main` is last. */
    packages: Package[]
    /** Diagnostics of every pass of every package, with the file each belongs to. */
    diagnostics: FileDiagnostic[]
}

export type LoadOptions = {
    /** Reads a file (the language server passes its open editors). Default: the file system. */
    read?: (path: string) => string | null
    /** Lists a folder's `.ms` files (the language server adds unsaved editors). Default: the file system. */
    list?: (dir: string) => string[]
    /** The folder `app.x` imports start from. Default: the entry's folder (src/project.ts passes `main`). */
    appRoot?: string
    /** `path:` dependencies from mod.ms: import root name → folder (`"utils"` → /work/utils). */
    deps?: Map<string, string>
}

// ---------------------------------------------------------------------------------------------

type Located =
    | { kind: "package", dir: string, name: string, item: string | null, items: string[] | null, glob: boolean }
    | { kind: "external" }
    | { kind: "error", message: string }

function isDir(path: string): boolean {
    try { return statSync(path).isDirectory() } catch { return false }
}

function isPackageDir(dir: string): boolean {
    try {
        return statSync(dir).isDirectory() && readdirSync(dir).some((f) => f.endsWith(".ms"))
    } catch {
        return false
    }
}

function qualifiedName(dir: string, appRoot: string, deps?: Map<string, string>): string {
    for (const [name, root] of deps ?? []) {
        const rel = relative(root, dir)
        if (!rel.startsWith("..")) return rel === "" ? name : `${name}.${rel.split(/[\\/]/).join(".")}`
    }
    const std = relative(STD_DIR, dir)
    if (!std.startsWith("..") && std !== "") return `std.${std.split(/[\\/]/).join(".")}`
    const rel = relative(appRoot, dir)
    if (!rel.startsWith("..") && rel !== "") return `app.${rel.split(/[\\/]/).join(".")}`
    return `local.${dir.split(/[\\/]/).filter(Boolean).slice(-2).join(".")}`
}

/** Where an import path points (spec §8.1). */
function locate(path: string, fromDir: string, appRoot: string, deps: Map<string, string>): Located {
    let clean = path.replace(/@.*$/, "")               // tool imports pin a version: "acme.lint@^1.2"
    let glob = false
    let items: string[] | null = null
    if (clean.endsWith(".*")) { glob = true; clean = clean.slice(0, -2) }
    const brace = /^(.*)\.\{(.*)\}$/.exec(clean)
    if (brace) { clean = brace[1]!; items = brace[2]!.split(",").map((x) => x.trim()).filter(Boolean) }

    if (clean.startsWith("./") || clean.startsWith("../")) {
        const dir = resolve(fromDir, clean)
        if (isPackageDir(dir)) return { kind: "package", dir, name: qualifiedName(dir, appRoot, deps), item: null, items, glob }
        return { kind: "error", message: `no package at \`${path}\` (looked for a folder of .ms files at ${dir})` }
    }
    // `build` (the toolchain API for mod.ms) and the first-party `ms.*` tools ship with the toolchain,
    // in std (spec §17.5)
    const first = clean.split(".")[0]
    const segs = first === "build" || first === "ms" ? ["std", ...clean.split(".")] : clean.split(".")
    const dep = deps.get(segs[0]!)
    const root = dep ?? (segs[0] === "std" ? STD_DIR : segs[0] === "app" ? appRoot : null)
    if (root === null) return { kind: "external" }
    const rest = segs.slice(1)
    if (rest.length === 0 && dep === undefined) return { kind: "error", message: `\`${path}\` names a root, not a package` }
    const dir = join(root, ...rest)
    if (isPackageDir(dir)) return { kind: "package", dir, name: qualifiedName(dir, appRoot, deps), item: null, items, glob }
    if (!glob && items === null && rest.length >= (dep === undefined ? 2 : 1)) {
        const parent = join(root, ...rest.slice(0, -1))
        if (isPackageDir(parent)) return { kind: "package", dir: parent, name: qualifiedName(parent, appRoot, deps), item: rest[rest.length - 1]!, items: null, glob }
    }
    if (dep !== undefined) return { kind: "error", message: `no package \`${clean}\` in the dependency \`${segs[0]}\` (${dep})` }
    return { kind: "error", message: `no package \`${clean}\`${segs[0] === "std" ? " in std" : ` (looked for the folder \`${rest.join("/")}/\` next to the entry file)`}` }
}

// ---------------------------------------------------------------------------------------------

export function loadProgram(entry: string, opts: LoadOptions = {}): Program {
    return new Loader(opts).load(resolve(entry))
}

class Loader {
    private readonly read: (path: string) => string | null
    private readonly list: (dir: string) => string[]
    private readonly byDir = new Map<string, Package>()
    private readonly ordered: Package[] = []
    private readonly visiting = new Set<Package>()
    private readonly diagnostics: FileDiagnostic[] = []
    private appRoot = ""
    private readonly opts: LoadOptions

    constructor(opts: LoadOptions) {
        this.opts = opts
        this.read = opts.read ?? ((p) => { try { return readFileSync(p, "utf8") } catch { return null } })
        this.list = opts.list ?? ((dir) => { try { return readdirSync(dir).filter((f) => f.endsWith(".ms")) } catch { return [] } })
    }

    load(entry: string): Program {
        if (isDir(entry)) return this.loadFolder(entry)
        this.appRoot = this.opts.appRoot ?? dirname(entry)
        const text = this.read(entry) ?? ""
        const parsed = parse(text)
        const name = parsed.file.package.join(".") || "main"
        let main: Package
        if (name === "main") {
            main = { name: "main", dir: dirname(entry), files: [{ path: entry, text, parsed }], links: new Map() }
        } else {
            main = this.packageAt(dirname(entry), name, entry, { path: entry, text, parsed })
        }
        this.visit(main)
        for (const p of this.ordered) this.analyse(p)
        return { main, packages: this.ordered, diagnostics: this.diagnostics }
    }

    /** A folder entry: its `package main` files are the main package. */
    private loadFolder(dir: string): Program {
        this.appRoot = this.opts.appRoot ?? dir
        const files: SourceFile[] = []
        for (const f of [...new Set(this.list(dir))].sort()) {
            const path = join(dir, f)
            const text = this.read(path)
            if (text === null) continue
            const parsed = parse(text)
            if ((parsed.file.package.join(".") || "main") === "main") files.push({ path, text, parsed })
        }
        const main: Package = { name: "main", dir, files, links: new Map() }
        this.byDir.set(dir, main)
        if (files.length === 0) {
            this.report(dir, "E_NO_MAIN", `no \`package main\` file in ${dir}`, { start: 0, end: 0, line: 1, col: 1 } as Span)
            return { main, packages: [], diagnostics: this.diagnostics }
        }
        this.visit(main)
        for (const p of this.ordered) this.analyse(p)
        return { main, packages: this.ordered, diagnostics: this.diagnostics }
    }

    /** All `.ms` files of a folder (for the entry package: those declaring the same package). */
    private packageAt(dir: string, name: string, entry?: string, entryFile?: SourceFile): Package {
        const files: SourceFile[] = entryFile ? [entryFile] : []
        for (const f of [...new Set(this.list(dir))].sort()) {
            const path = join(dir, f)
            if (path === entry) continue
            const text = this.read(path)
            if (text === null) continue
            const parsed = parse(text)
            if (entryFile && parsed.file.package.join(".") !== entryFile.parsed.file.package.join(".")) continue
            files.push({ path, text, parsed })
        }
        const pkg: Package = { name, dir, files, links: new Map() }
        this.byDir.set(dir, pkg)
        return pkg
    }

    /** Depth-first: dependencies are added to `ordered` before the packages that import them. */
    private visit(pkg: Package): void {
        this.visiting.add(pkg)
        for (const file of pkg.files) {
            for (const imp of file.parsed.file.imports) {
                const loc = locate(imp.path, dirname(file.path), this.appRoot, this.opts.deps ?? new Map())
                if (loc.kind === "external") continue
                if (loc.kind === "error") {
                    this.report(file.path, "E_UNKNOWN_IMPORT", loc.message, imp.span)
                    continue
                }
                let dep = this.byDir.get(loc.dir)
                if (dep === undefined) {
                    dep = this.packageAt(loc.dir, loc.name)
                    if (dep.files.some((f) => f.parsed.file.package.join(".") === "main")) {
                        this.report(file.path, "E_IMPORT_MAIN", `\`${imp.path}\` is a \`package main\` folder; main can't be imported`, imp.span)
                    }
                    this.visit(dep)
                } else if (this.visiting.has(dep)) {
                    this.report(file.path, "E_IMPORT_CYCLE", `import cycle: \`${pkg.name}\` imports \`${dep.name}\`, which imports \`${pkg.name}\` back (directly or through other packages); move the shared items into a third package`, imp.span)
                    continue
                }
                pkg.links.set(imp, { dep, item: loc.item, items: loc.items, glob: loc.glob })
            }
        }
        this.visiting.delete(pkg)
        this.ordered.push(pkg)
    }

    private report(file: string, code: string, message: string, span: Span): void {
        this.diagnostics.push({ file, code, message, span: { ...span }, severity: "error", pass: "load" })
    }

    /** Everything a package can reach through its imports (for the checker and lowering). */
    reachable(pkg: Package, out = new Set<Package>()): Set<Package> {
        for (const { dep } of pkg.links.values()) {
            if (out.has(dep)) continue
            out.add(dep)
            this.reachable(dep, out)
        }
        return out
    }

    private analyse(pkg: Package): void {
        const asts = pkg.files.map((f) => f.parsed.file)
        const imports = new Map<A.Import, LoadedImport>()
        for (const [imp, link] of pkg.links) {
            if (link.dep.res) imports.set(imp, { pkg: link.dep.res, path: link.dep.name, item: link.item, items: link.items, glob: link.glob })
        }
        const res = resolvePackage(asts, { packageName: pkg.name, imports })
        const deps: CheckedDep[] = [...this.reachable(pkg)].filter((d) => d.res && d.checked)
            .map((d) => ({ files: d.files.map((f) => f.parsed.file), res: d.res!, checked: d.checked! }))
        const checked = checkPackage(asts, res, loadPrelude(), deps)
        const owned = checkOwnership(asts, res, checked)
        pkg.res = res
        pkg.checked = checked
        for (const f of pkg.files) for (const d of f.parsed.diagnostics) this.diagnostics.push({ ...d, file: f.path, pass: "parse" })
        const passes = [["resolve", res.diagnostics], ["check", checked.diagnostics], ["ownership", owned.diagnostics]] as const
        for (const [pass, list] of passes) for (const d of list) this.diagnostics.push({ ...d, file: attribute(d.span, pkg.files), pass })
    }
}

/** Which file of a package a resolver / checker diagnostic belongs to: the one with a node at that span. */
function attribute(span: Span, files: SourceFile[]): string {
    if (files.length === 1) return files[0]!.path
    for (const f of files) if (hasSpan(f.parsed.file, span)) return f.path
    return files[0]!.path
}

function hasSpan(root: unknown, span: Span): boolean {
    const seen = new Set<object>()
    const stack: unknown[] = [root]
    while (stack.length > 0) {
        const x = stack.pop()
        if (typeof x !== "object" || x === null || seen.has(x)) continue
        seen.add(x)
        const s = (x as { span?: Span }).span
        if (s && s.start === span.start && s.end === span.end && s.line === span.line) return true
        for (const v of Object.values(x)) if (typeof v === "object" && v !== null) stack.push(v)
    }
    return false
}

// ---------------------------------------------------------------------------------------------

/** Lowers every package of a loaded program into one HIR program (dependencies first). */
export function lowerProgram(program: Program): H.Program {
    const out: H.Program = { types: [], funs: [], globals: [] }
    const loader = new Loader({})
    for (const pkg of program.packages) {
        if (!pkg.res || !pkg.checked) continue
        const deps = [...loader.reachable(pkg)].filter((d) => d.res).map((d) => ({ files: d.files.map((f) => f.parsed.file), res: d.res!, name: d.name }))
        const p = lowerPackage(pkg.files.map((f) => f.parsed.file), pkg.res, pkg.checked, loadPrelude(), pkg.name, deps)
        out.types.push(...p.types)
        out.funs.push(...p.funs)
        out.globals.push(...p.globals)
    }
    return out
}

export function existsFile(path: string): boolean {
    return existsSync(path)
}
