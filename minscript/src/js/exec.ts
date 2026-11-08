// Runs a compiled program module in its own process: `node src/js/exec.ts <module.mjs> [args…]`
// (what `std.runtime.run_module` starts). Same behaviour as `ms run`: panics are printed, a deadlock is
// detected, and the exit code is 101 after a panic.

import { readFileSync } from "node:fs"
import { runJs } from "./run.ts"
import { setArgs } from "./runtime.ts"

const [file, ...args] = process.argv.slice(2)
if (file === undefined) {
    console.error("usage: node exec.ts <module.mjs> [args…]")
    process.exit(2)
}
setArgs(args)
const result = await runJs(readFileSync(file, "utf8"))
// drain stdout / stderr before exiting (on a pipe, Node writes them asynchronously)
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()))
await new Promise<void>((resolve) => process.stderr.write("", () => resolve()))
process.exit(result.exitCode)
