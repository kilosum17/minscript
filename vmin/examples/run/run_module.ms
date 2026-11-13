package main

import "std.runtime"
import "std.env"

// `runtime.run_module` runs a compiled module in a child process and returns its exit code.
async fn main() {
    let ok = await runtime.run_module("export async function $main() { console.log('child says hi') }", [])
    log.println("exit ${ok}")
    let failed = await runtime.run_module("export async function $main() { throw new Error('boom') }", [])
    log.println("exit ${failed}")
    log.println(env.cwd().starts_with("/"))
}
