// Runs a compiled program module in its own process: `node src/js/exec.ts <module.mjs> [args…]`
// (what `std.runtime.run_module` starts). The module exports `$main`; a panic or a thrown error is
// printed and gives exit code 101. With `MS_EXEC_RESULT` set, what `$main` returned (an int) is
// written to that file, for `runtime.run_module_result`.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { caught, ExitRequest, MsPanic } from "./runtime.ts";
import { closeResources, setArgs } from "./stdlib.ts";

const [file, ...args] = process.argv.slice(2);
if (file === undefined) {
    console.error("usage: node exec.ts <module.mjs> [args…]");
    process.exit(2);
}
setArgs(args);
const resultFile = process.env.MS_EXEC_RESULT;
delete process.env.MS_EXEC_RESULT; // not for the program's own children

let code = 0;
let value: unknown;
try {
    const mod = (await import(pathToFileURL(resolve(file)).href)) as { $main: () => unknown };
    value = await mod.$main();
} catch (e) {
    if (e instanceof ExitRequest) code = e.code;
    else {
        const what = e instanceof MsPanic ? caught(e).message : e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        process.stderr.write(`panic: ${what}\n`);
        code = 101;
    }
} finally {
    closeResources();
}
if (resultFile) writeFileSync(resultFile, typeof value === "number" || typeof value === "bigint" ? String(value) : "0");
// drain stdout / stderr before exiting (on a pipe, Node writes them asynchronously)
await new Promise<void>((r) => process.stdout.write("", () => r()));
await new Promise<void>((r) => process.stderr.write("", () => r()));
process.exit(code);
