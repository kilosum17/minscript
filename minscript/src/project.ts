// Projects (spec §17): a folder with a `mod.ms`. Its `config()` is evaluated on the JS back end, and
// the result says where `package main` lives, which `path:` dependencies exist, and what scripts
// `ms run <name>` can run.
//
// A folder without a mod.ms is a project too, with the defaults: `main` is `./src` if it exists, and
// the folder itself otherwise (§17.6).

import { existsSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import "./prelude.ts"
import { loadProgram, lowerProgram, type FileDiagnostic, type LoadOptions } from "./loader.ts"
import { emitJs } from "./js/emit.ts"

export const MOD_FILE = "mod.ms"

/** A script from `Config.scripts` (spec §17.3). `fn` is the compiled closure of a `task`. */
export type Script =
    | { kind: "Shell", cmd: string }
    | { kind: "Package", path: string }
    | { kind: "Task", fn: (args: unknown) => unknown }

export type ProjectConfig = {
    name: string
    version: string
    main: string
    deps: Map<string, string>
    devDeps: Map<string, string>
    scripts: Map<string, Script>
    /** Tool sections, as JSON. */
    sections: Record<string, unknown>
}

export type Project = {
    root: string
    /** null: no mod.ms (the defaults apply). */
    modFile: string | null
    config: ProjectConfig | null
    /** The folder holding `package main`; also the root of `app.x` imports. */
    mainDir: string
    /** `path:` dependencies: import root → folder. */
    deps: Map<string, string>
    /** Diagnostics from compiling mod.ms, or messages from evaluating it. */
    diagnostics: FileDiagnostic[]
    errors: string[]
}

const isDir = (p: string) => { try { return statSync(p).isDirectory() } catch { return false } }

/** The nearest folder at or above `start` (a file or folder) that has a mod.ms. */
export function findProjectRoot(start: string): string | null {
    let dir = resolve(start)
    if (!isDir(dir)) dir = dirname(dir)
    for (;;) {
        if (existsSync(join(dir, MOD_FILE))) return dir
        const up = dirname(dir)
        if (up === dir) return null
        dir = up
    }
}

/** §17.6: `Config.main`, else `./src` if it exists, else the root. */
export function defaultMainDir(root: string, main = ""): string {
    if (main !== "") return resolve(root, main)
    return isDir(join(root, "src")) ? join(root, "src") : root
}

/** The `path:` entries of a deps map, as folders (registry and `git:` deps aren't fetched yet). */
export function pathDeps(root: string, deps: Map<string, string>): Map<string, string> {
    const out = new Map<string, string>()
    for (const [name, spec] of deps) if (spec.startsWith("path:")) out.set(name, resolve(root, spec.slice(5)))
    return out
}

/** Opens the project at `root`: evaluates its mod.ms, if it has one. */
export async function openProject(root: string, opts: LoadOptions = {}): Promise<Project> {
    root = resolve(root)
    const modFile = join(root, MOD_FILE)
    const project: Project = { root, modFile: null, config: null, mainDir: defaultMainDir(root), deps: new Map(), diagnostics: [], errors: [] }
    if (!existsSync(modFile)) return project
    project.modFile = modFile
    const ev = await evaluateConfig(modFile, opts)
    project.diagnostics = ev.diagnostics
    if (ev.error) project.errors.push(ev.error)
    if (ev.config) {
        project.config = ev.config
        project.mainDir = defaultMainDir(root, ev.config.main)
        project.deps = pathDeps(root, ev.config.deps)
    }
    return project
}

/** Compiles mod.ms (with `build` and whatever it imports) and runs its `config()` (spec §17.5). */
export async function evaluateConfig(modFile: string, opts: LoadOptions = {}): Promise<{ config: ProjectConfig | null, diagnostics: FileDiagnostic[], error: string | null }> {
    const program = loadProgram(modFile, opts)
    if (program.diagnostics.length > 0) return { config: null, diagnostics: program.diagnostics, error: null }
    if (program.main.name !== "mod") return { config: null, diagnostics: [], error: `${modFile} must declare \`package mod\`` }
    const hir = lowerProgram(program)
    if (!hir.funs.some((f) => f.name === "mod.config")) return { config: null, diagnostics: [], error: `${modFile} has no \`pub fun config() -> Config\`` }
    const { loadJs, RUNTIME_URL } = await import("./js/run.ts")
    const rt = await import("./js/runtime.ts")
    const mod = await loadJs(emitJs(hir, RUNTIME_URL, "mod.config"))
    rt.setEvaluating(true)
    try {
        return { config: fromConfigValue(await mod.$main()), diagnostics: [], error: null }
    } catch (e) {
        return { config: null, diagnostics: [], error: `evaluating ${modFile}: ${e instanceof Error ? e.message : String(e)}` }
    } finally {
        rt.setEvaluating(false)
    }
}

type Any = any   // eslint-disable-line @typescript-eslint/no-explicit-any

/** The runtime value of a `build.Config` → TS. */
function fromConfigValue(v: Any): ProjectConfig {
    const strings = (m: Any) => new Map<string, string>([...m.entries()].map(([k, x]: [string, string]) => [k, x]))
    const scripts = new Map<string, Script>()
    for (const [k, s] of v.scripts.entries() as Iterable<[string, Any]>) {
        if (s.$v === "Shell") scripts.set(k, { kind: "Shell", cmd: s.$f[0] })
        else if (s.$v === "Package") scripts.set(k, { kind: "Package", path: s.$f[0] })
        else scripts.set(k, { kind: "Task", fn: s.$f[0] })
    }
    return {
        name: v.name, version: v.version, main: v.main,
        deps: strings(v.deps), devDeps: strings(v.dev_deps), scripts,
        sections: Object.fromEntries([...v.sections.entries()].map(([k, x]: [string, Any]) => [k, jsonOf(x)])),
    }
}

/** A `json.Value` → plain JSON. */
function jsonOf(v: Any): unknown {
    switch (v.$v) {
        case "Null": return null
        case "Array": return v.$f[0].map(jsonOf)
        case "Object": return Object.fromEntries([...v.$f[0].entries()].map(([k, x]: [string, Any]) => [k, jsonOf(x)]))
        default: return v.$f[0]
    }
}

/** What `ms config` prints. */
export function configJson(c: ProjectConfig): string {
    const scripts = Object.fromEntries([...c.scripts].map(([k, s]) => [k, s.kind === "Shell" ? { sh: s.cmd } : s.kind === "Package" ? { pkg: s.path } : { task: "<MinScript>" }]))
    return JSON.stringify({
        name: c.name, version: c.version, main: c.main,
        deps: Object.fromEntries(c.deps), dev_deps: Object.fromEntries(c.devDeps), scripts, sections: c.sections,
    }, null, 2)
}

/** Load options for the project's program: `app.` starts at `main`, and `path:` deps are visible. */
export function programOptions(p: Project, opts: LoadOptions = {}): LoadOptions {
    return { ...opts, appRoot: p.mainDir, deps: p.deps }
}
