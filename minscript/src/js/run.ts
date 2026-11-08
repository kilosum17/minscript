// Compiles a MinScript file to JS and runs it (`ms run`). The generated module is written to a
// temporary directory and imported; it shares this process's runtime instance, so tests can capture
// output with `setOutput`.

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import "../prelude.ts"
import { loadProgram, lowerProgram, type FileDiagnostic, type LoadOptions } from "../loader.ts"
import { emitJs } from "./emit.ts"
import { closeResources, Panic, resetOutput, setOutput } from "./runtime.ts"

const RUNTIME_URL = new URL("./runtime.ts", import.meta.url).href

export type Compiled = { js: string | null, diagnostics: FileDiagnostic[] }

/** Loads the program (the entry file and every package it imports), runs every pass on every package,
 *  and returns one JS module, or the diagnostics that stopped compilation. */
export function compileToJs(entry: string, opts: LoadOptions = {}): Compiled {
    const program = loadProgram(entry, opts)
    if (program.diagnostics.length > 0) return { js: null, diagnostics: program.diagnostics }
    return { js: emitJs(lowerProgram(program), RUNTIME_URL), diagnostics: [] }
}

/** Writes a compiled module to the temp directory and imports it, without running `main`. */
export async function loadJs(js: string): Promise<{ $main: () => Promise<unknown> }> {
    const dir = join(tmpdir(), "minscript-run")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${createHash("sha256").update(js).digest("hex").slice(0, 16)}.mjs`)
    writeFileSync(file, js)
    return await import(pathToFileURL(file).href) as { $main: () => Promise<unknown> }
}

export type RunResult = { exitCode: number, panic: string | null }

/** Imports a compiled module and awaits its `main`. A panic that escapes `main` gives exit code 101. */
export async function runJs(js: string, onOutput?: (line: string) => void): Promise<RunResult> {
    if (onOutput) setOutput(onOutput)
    const print = onOutput ?? ((l: string) => console.error(l))
    const describe = (e: unknown) => (e instanceof Panic ? e.message : e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    // a panic in a task nobody awaits: the task is dropped, the program goes on (spec §9.8)
    const onRejection = (e: unknown) => print(`panic in task: ${describe(e)}`)
    process.on("unhandledRejection", onRejection)
    try {
        const mod = await loadJs(js)
        // `main` waiting on something nothing can complete: the event loop empties (spec §9.10 Deadlock)
        const deadlock = new Promise<"deadlock">((resolve) => {
            const check = () => resolve("deadlock")
            process.once("beforeExit", check)
        })
        const outcome = await Promise.race([mod.$main().then(() => "done" as const), deadlock])
        if (outcome === "deadlock") {
            print("panic: Deadlock: `main` is waiting, and no task, timer or I/O can wake it")
            return { exitCode: 101, panic: "Deadlock" }
        }
        return { exitCode: 0, panic: null }
    } catch (e) {
        print(`panic: ${describe(e)}`)
        return { exitCode: 101, panic: describe(e) }
    } finally {
        process.off("unhandledRejection", onRejection)
        process.removeAllListeners("beforeExit")
        closeResources()             // servers and sockets the program left open (tasks can't be cancelled on JS yet)
        if (onOutput) resetOutput()
    }
}
