// `ms fmt [path…] [--check]` (spec §17.8): formats .ms files in place, with the settings of the
// project's `fmt` section in mod.ms (`ms.fmt.setup(_{ indent: 2 })`). `--check` only reports the
// files that aren't formatted, and fails if there are any (for CI).

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { DEFAULT_FMT, format, type FmtOptions } from "./fmt.ts"
import { findProjectRoot, openProject } from "./project.ts"
import { show } from "./project_cli.ts"

const SKIP = new Set(["node_modules", ".git"])

function msFiles(path: string, out: string[] = []): string[] {
    let st
    try { st = statSync(path) } catch { return out }
    if (st.isFile()) { if (path.endsWith(".ms")) out.push(path); return out }
    for (const e of readdirSync(path).sort()) {
        if (e.startsWith(".") || SKIP.has(e)) continue
        msFiles(join(path, e), out)
    }
    return out
}

/** The formatter settings for a file: its project's `fmt` section, or the defaults. */
export async function fmtOptionsFor(file: string, cache = new Map<string, FmtOptions>()): Promise<FmtOptions> {
    const root = findProjectRoot(file)
    if (root === null) return DEFAULT_FMT
    const known = cache.get(root)
    if (known) return known
    const p = await openProject(root)
    const opts = fmtOptionsFrom(p.config?.sections["fmt"])
    cache.set(root, opts)
    return opts
}

/** `{ indent, max_width, trailing_commas }` (the `ms.fmt` Options) → FmtOptions. */
export function fmtOptionsFrom(section: unknown): FmtOptions {
    const s = (section ?? {}) as Record<string, unknown>
    return {
        indent: typeof s["indent"] === "number" ? s["indent"] : DEFAULT_FMT.indent,
        maxWidth: typeof s["max_width"] === "number" ? s["max_width"] : DEFAULT_FMT.maxWidth,
        trailingCommas: typeof s["trailing_commas"] === "boolean" ? s["trailing_commas"] : DEFAULT_FMT.trailingCommas,
    }
}

export async function runFmt(args: string[]): Promise<number> {
    const check = args.includes("--check")
    const paths = args.filter((a) => a !== "--check")
    const files = (paths.length > 0 ? paths : ["."]).flatMap((p) => msFiles(resolve(p)))
    const cache = new Map<string, FmtOptions>()
    let changed = 0, failed = 0
    for (const file of files) {
        const src = readFileSync(file, "utf8")
        const r = format(src, await fmtOptionsFor(file, cache))
        if (r.text === null) {
            failed++
            const d = r.diagnostics[0]!
            console.error(`${show(file)}:${d.span.line}:${d.span.col}: not formatted, it has a syntax error: ${d.code} ${d.message}`)
            continue
        }
        if (r.text === src) continue
        changed++
        if (check) console.log(`${show(file)}: not formatted`)
        else writeFileSync(file, r.text)
    }
    if (!check) console.log(`${changed} of ${files.length} file${files.length === 1 ? "" : "s"} formatted${failed ? `, ${failed} skipped (syntax errors)` : ""}`)
    else if (changed === 0 && failed === 0) console.log(`${files.length} file${files.length === 1 ? "" : "s"}: all formatted`)
    return failed > 0 || (check && changed > 0) ? 1 : 0
}
