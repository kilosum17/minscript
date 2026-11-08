// Runs a compiled program module in its own process: `node src/js/exec.ts <module.mjs> [args…]`
// (what `std.runtime.run_module` starts). Same behaviour as `ms run`: panics are printed, a deadlock is
// detected, and the exit code is 101 after a panic. With `MS_EXEC_RESULT` set, the entry function's
// int result is written to that file (`runtime.run_module_result`).

import { readFileSync, writeFileSync } from "node:fs"
import { runJs } from "./run.ts"
import { setArgs } from "./runtime.ts"

const [file, ...args] = process.argv.slice(2)
if (file === undefined) {
    console.error("usage: node exec.ts <module.mjs> [args…]")
    process.exit(2)
}
setArgs(args)
const resultFile = process.env.MS_EXEC_RESULT
delete process.env.MS_EXEC_RESULT              // not for the program's own children
const result = await runJs(readFileSync(file, "utf8"))
// `runtime.run_module_result`: what the entry function returned (an int), for the parent
if (resultFile) {
    const v = result.value
    writeFileSync(resultFile, typeof v === "number" || typeof v === "bigint" ? String(v) : "0")
}
// drain stdout / stderr before exiting (on a pipe, Node writes them asynchronously)
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()))
await new Promise<void>((resolve) => process.stderr.write("", () => resolve()))
process.exit(result.exitCode)
