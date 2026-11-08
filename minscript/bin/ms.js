#!/usr/bin/env node
// The `ms` command. Node runs the compiler's TypeScript sources directly (type stripping), so there is
// no build step: `npm link` in this folder puts `ms` on the PATH.

const [major, minor] = process.versions.node.split(".").map(Number)
if (major < 23 || (major === 23 && minor < 6)) {
    console.error(`ms needs Node 23.6 or newer (to run TypeScript directly); this is Node ${process.versions.node}`)
    process.exit(2)
}
await import("../src/cli.ts")
