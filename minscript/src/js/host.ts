// Running a compiled module (the JS back end's output, an ES module exporting `$main`) with the
// runtime: panics, deadlocks and exit codes, as `ms run` does. It depends on the runtime only, not on
// the compiler, so a compiler written in MinScript runs with it (`exec.ts`, stage 1's seed).

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { closeResources, ExitRequest, Panic, resetOutput, setOutput } from "./runtime.ts"

type Module = { $main: () => Promise<unknown> }

/** Writes a compiled module to the temp directory and imports it, without running `main`. */
export async function loadJs(js: string): Promise<{ $main: () => Promise<unknown> }> {
    const dir = join(tmpdir(), "minscript-run")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${createHash("sha256").update(js).digest("hex").slice(0, 16)}.mjs`)
    writeFileSync(file, js)
    return await import(pathToFileURL(file).href) as { $main: () => Promise<unknown> }
}

/** `value`: what `$main` returned (`ms test`'s generated main returns the number of failures). */
export type RunResult = { exitCode: number, panic: string | null, value?: unknown }

/** Imports a compiled module and awaits its `main`. A panic that escapes `main` gives exit code 101. */
export async function runJs(js: string, onOutput?: (line: string) => void): Promise<RunResult> {
    return runModule(() => loadJs(js), onOutput)
}

/** Runs a compiled module where it is (so its relative imports resolve from its own folder). */
export async function runFile(path: string, onOutput?: (line: string) => void): Promise<RunResult> {
    return runModule(async () => await import(pathToFileURL(path).href) as Module, onOutput)
}

async function runModule(load: () => Promise<Module>, onOutput?: (line: string) => void): Promise<RunResult> {
    if (onOutput) setOutput(onOutput)
    const print = onOutput ?? ((l: string) => console.error(l))
    const describe = (e: unknown) => (e instanceof Panic ? `${e.message}${e.file ? ` (at ${e.file}:${e.line})` : ""}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    // a panic in a task nobody awaits: the task is dropped, the program goes on (spec §9.8)
    const onRejection = (e: unknown) => { if (!(e instanceof Panic && e.kind === "Cancelled")) print(`panic in task: ${describe(e)}`) }
    process.on("unhandledRejection", onRejection)
    try {
        const mod = await load()
        // `main` waiting on something nothing can complete: the event loop empties (spec §9.10 Deadlock)
        const deadlock = new Promise<"deadlock">((resolve) => {
            const check = () => resolve("deadlock")
            process.once("beforeExit", check)
        })
        let value: unknown
        const outcome = await Promise.race([mod.$main().then((v) => { value = v; return "done" as const }), deadlock])
        if (outcome === "deadlock") {
            print("panic: Deadlock: `main` is waiting, and no task, timer or I/O can wake it")
            return { exitCode: 101, panic: "Deadlock" }
        }
        return { exitCode: 0, panic: null, value }
    } catch (e) {
        if (e instanceof ExitRequest) return { exitCode: e.code, panic: null }
        print(`panic: ${describe(e)}`)
        return { exitCode: 101, panic: describe(e) }
    } finally {
        process.off("unhandledRejection", onRejection)
        process.removeAllListeners("beforeExit")
        closeResources()             // servers and sockets the program left open
        if (onOutput) resetOutput()
    }
}
