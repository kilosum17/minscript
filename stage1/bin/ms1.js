#!/usr/bin/env node
// `ms1`: the MinScript toolchain written in MinScript. It runs the seed (seed/stage1.mjs: stage 1
// compiled by stage 1) with the runtime in ../runtime. The same commands
// as `ms`: `ms1 run`, `check`, `test`, `js`, `config`, scripts, and the per-file dumps (`ms1 help`).
// std is ../std unless MS_STD says otherwise; the runtime is ../runtime (MS_RUNTIME, for the programs
// it runs).
import { fileURLToPath } from "node:url"
import { setArgs } from "../runtime/runtime.ts"
import { runFile } from "../runtime/host.ts"

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
process.env.MS_STD ??= here("../std")
process.env.MS_RUNTIME ??= here("../runtime/runtime.ts")
setArgs(process.argv.slice(2))
const result = await runFile(process.env.MS1_SEED ?? here("../seed/stage1.mjs"))
// drain stdout / stderr before exiting (on a pipe, Node writes them asynchronously)
await new Promise((resolve) => process.stdout.write("", resolve))
await new Promise((resolve) => process.stderr.write("", resolve))
process.exit(result.exitCode)
