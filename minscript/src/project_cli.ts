// `ms run`, `ms js` and `ms config` (spec §17.3): programs, projects and scripts. Used by src/cli.ts.

import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import type { FileDiagnostic, LoadOptions } from "./loader.ts"
import { configJson, defaultMainDir, findProjectRoot, openProject, programOptions, type Project } from "./project.ts"

const isDir = (p: string) => { try { return statSync(p).isDirectory() } catch { return false } }
/** A path as the user would type it here: relative below the current folder, absolute elsewhere. */
export const show = (p: string) => { const r = relative(process.cwd(), p); return r === "" ? "." : r.startsWith("..") ? p : r }

export function printDiagnostics(ds: FileDiagnostic[]): void {
    for (const d of ds) console.error(`${show(d.file)}:${d.span.line}:${d.span.col}: ${d.severity} ${d.code}: ${d.message}`)
}

/** Opens a project and reports why it can't be used. */
export async function open(root: string): Promise<Project | null> {
    const p = await openProject(root)
    printDiagnostics(p.diagnostics)
    for (const e of p.errors) console.error(`error: ${e}`)
    return p.diagnostics.length > 0 || p.errors.length > 0 ? null : p
}

export async function runProgramCommand(command: "run" | "js" | "config", argv: string[]): Promise<number> {
    const dash = argv.indexOf("--")
    const before = dash < 0 ? argv : argv.slice(0, dash)
    const target = before[0]
    const args = dash < 0 ? argv.slice(1) : [...before.slice(1), ...argv.slice(dash + 1)]

    if (command === "config") {
        const root = findProjectRoot(target ?? ".")
        if (root === null) { console.error(`no ${"mod.ms"} at or above ${target ?? "."}`); return 1 }
        const p = await open(root)
        if (p === null || p.config === null) return 1
        console.log(configJson(p.config))
        return 0
    }

    // `ms run` alone: the scripts of the project here
    if (target === undefined) {
        const root = findProjectRoot(".")
        const p = root ? await open(root) : null
        if (p?.config && p.config.scripts.size > 0) {
            console.log(`scripts in ${show(p.modFile!)}:`)
            for (const [name, s] of p.config.scripts) console.log(`  ${name.padEnd(12)} ${s.kind === "Shell" ? s.cmd : s.kind === "Package" ? `pkg ${s.path}` : "task"}`)
        } else {
            console.log("no scripts here")
        }
        console.log("`ms run <script>` runs one; `ms run .` (or a folder, or a file) runs the program")
        return 0
    }

    // `ms run <name>`: a script, when the name isn't a path
    const looksLikePath = target.includes("/") || target.endsWith(".ms") || target === "." || target === ".."
    if (command === "run" && !looksLikePath && !existsSync(target)) {
        const root = findProjectRoot(".")
        const p = root ? await open(root) : null
        const script = p?.config?.scripts.get(target)
        if (!p || !script) {
            console.error(`no script \`${target}\`${p?.config ? ` in ${show(p.modFile!)}` : ""}, and no file or folder of that name`)
            return 1
        }
        return await runScript(p, target, args)
    }
    return await runProgram(command, resolve(target), args)
}

/** The entry and load options for a path: a project, a plain folder, or a single file. */
export async function entryFor(path: string): Promise<{ entry: string, opts: LoadOptions } | null> {
    const root = findProjectRoot(path)
    if (root !== null) {
        const p = await open(root)
        if (p === null) return null
        const inMain = isDir(path) ? path === root || path === p.mainDir : dirname(path) === p.mainDir
        return { entry: inMain ? p.mainDir : path, opts: programOptions(p) }
    }
    if (isDir(path)) { const main = defaultMainDir(path); return { entry: main, opts: { appRoot: main } } }
    return { entry: path, opts: {} }
}

async function runProgram(command: "run" | "js", path: string, args: string[]): Promise<number> {
    if (!existsSync(path)) { console.error(`no such file or folder: ${show(path)}`); return 2 }
    const found = await entryFor(path)
    if (found === null) return 1
    const { compileToJs, runJs } = await import("./js/run.ts")
    const compiled = compileToJs(found.entry, found.opts)
    printDiagnostics(compiled.diagnostics)
    if (compiled.js === null) return 1
    if (command === "js") { process.stdout.write(compiled.js); return 0 }
    const { setArgs } = await import("./js/runtime.ts")
    setArgs(args)
    return (await runJs(compiled.js)).exitCode
}

/** `ms <name>`: the script `name` of the project here, if there is one (null: no such script). */
export async function runScriptShorthand(name: string, argv: string[]): Promise<number | null> {
    const root = findProjectRoot(".")
    if (root === null) return null
    const p = await openProject(root)
    if (!p.config?.scripts.has(name)) return null
    const dash = argv.indexOf("--")
    return await runScript(p, name, dash < 0 ? argv : [...argv.slice(0, dash), ...argv.slice(dash + 1)])
}

async function runScript(p: Project, name: string, args: string[]): Promise<number> {
    const script = p.config!.scripts.get(name)!
    switch (script.kind) {
        case "Shell": {
            const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")
            const r = spawnSync(`${script.cmd}${quoted ? ` ${quoted}` : ""}`, { shell: true, stdio: "inherit", cwd: p.root })
            return r.status ?? 1
        }
        case "Package": return await runProgram("run", resolve(p.root, script.path), args)
        case "Task": {
            const { setArgs } = await import("./js/runtime.ts")
            setArgs(args)
            let result: any = script.fn({ $t: "std.build.Args", list: [...args] })   // eslint-disable-line @typescript-eslint/no-explicit-any
            if (result instanceof Promise) result = await result
            if (result?.$v === "Err") { console.error(`error: script \`${name}\` failed: ${result.$f[0]}`); return 1 }
            return 0
        }
    }
}
