package main

import "std.runtime"

// `runtime.run_module_result`: the exit code, the int the entry function returned, and (with
// `capture`) the program's standard output.
async fun main() {
    let r = await runtime.run_module_result("export async function $main() { console.log('captured'); return 7 }", [], true)
    log.println("code ${r.code}, value ${r.value}, stdout ${r.stdout.trim()}")
    let shown = await runtime.run_module_result("export async function $main() { console.log('printed') }", [], false)
    log.println("code ${shown.code}, value ${shown.value}, stdout '${shown.stdout}'")
    let failed = await runtime.run_module_result("export async function $main() { throw new Error('boom') }", [], true)
    log.println("code ${failed.code}, value ${failed.value}")
    let status = runtime.shell("exit 3", ".")
    log.println("shell ${status}")
}
