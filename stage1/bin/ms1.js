#!/usr/bin/env node
// `ms1`: the MinScript toolchain written in MinScript. It runs the seed (seed/stage1.mjs: stage 1
// compiled by stage 1) with the shared runtime; stage 0's compiler isn't involved. The same commands
// as `ms`: `ms1 run`, `check`, `test`, `js`, `config`, scripts, and the per-file dumps (`ms1 help`).
// std is ../minscript/std unless MS_STD says otherwise.
import { fileURLToPath } from "node:url"
import { setArgs } from "../../minscript/src/js/runtime.ts"
import { runFile } from "../../minscript/src/js/host.ts"

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
process.env.MS_STD ??= here("../../minscript/std")
setArgs(process.argv.slice(2))
const result = await runFile(process.env.MS1_SEED ?? here("../seed/stage1.mjs"))
// drain stdout / stderr before exiting (on a pipe, Node writes them asynchronously)
await new Promise((resolve) => process.stdout.write("", resolve))
await new Promise((resolve) => process.stderr.write("", resolve))
process.exit(result.exitCode)
