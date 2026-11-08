// Compiles a MinScript file to JS and runs it (`ms run`). The generated module is written to a
// temporary directory and imported; it shares this process's runtime instance, so tests can capture
// output with `setOutput`. Running is `host.ts` (no compiler needed), re-exported here.

import "../prelude.ts"
import { loadProgram, lowerProgram, type FileDiagnostic, type LoadOptions } from "../loader.ts"
import { emitJs } from "./emit.ts"
export { loadJs, runFile, runJs, type RunResult } from "./host.ts"

export const RUNTIME_URL = new URL("./runtime.ts", import.meta.url).href

export type Compiled = { js: string | null, diagnostics: FileDiagnostic[] }

/** Loads the program (the entry file and every package it imports), runs every pass on every package,
 *  and returns one JS module, or the diagnostics that stopped compilation. */
/** `entryFn`: the function the module's `$main` calls, by name, or from the entry package's name. */
export function compileToJs(entry: string, opts: LoadOptions = {}, entryFn: string | ((pkg: string) => string) = "main"): Compiled {
    const program = loadProgram(entry, opts)
    if (program.diagnostics.length > 0) return { js: null, diagnostics: program.diagnostics }
    const fn = typeof entryFn === "string" ? entryFn : entryFn(program.main.name)
    return { js: emitJs(lowerProgram(program), RUNTIME_URL, fn), diagnostics: [] }
}

