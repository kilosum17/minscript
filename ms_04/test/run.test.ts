// The JS back end (spec §16): every program in examples/run/ (a file with a `.out` beside it) and
// every examples/packages/*/ with a main.out is compiled and run, and what it prints must match.
// Programs that need std packages not written yet (step 10) are skipped by name, with the reason.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

const NEEDS_STD: Record<string, string> = {
    "exit.ms": "std.process",
    "json_value_field.ms": "std.json",
    "run_module.ms": "std.runtime",
    "run_module_result.ms": "std.runtime",
    "std_packages.ms": "std.json, std.env, …",
    "ws_echo.ms": "std.net.ws",
    "app": "std.json",
};

const entries: [string, string, string][] = [];
const runDir = join(root, "examples", "run");
for (const n of readdirSync(runDir).sort()) {
    if (n.endsWith(".ms") && existsSync(join(runDir, n.replace(/\.ms$/, ".out")))) entries.push([n, join(runDir, n), join(runDir, n.replace(/\.ms$/, ".out"))]);
}
const pkgDir = join(root, "examples", "packages");
for (const n of readdirSync(pkgDir).sort()) {
    if (existsSync(join(pkgDir, n, "main.out"))) entries.push([n, join(pkgDir, n), join(pkgDir, n, "main.out")]);
}

const run = promisify(execFile);

for (const [name, entry, expected] of entries) {
    const skip = NEEDS_STD[name] ? `needs ${NEEDS_STD[name]}` : false;
    test(`run ${name}`, { skip }, async () => {
        let out: string;
        try {
            const r = await run(process.execPath, [cli, "run", entry], { cwd: root, timeout: 30_000 });
            out = r.stdout + r.stderr;
        } catch (e) {
            const x = e as { stdout?: string; stderr?: string };
            out = (x.stdout ?? "") + (x.stderr ?? "");
        }
        assert.equal(out, readFileSync(expected, "utf8"));
    });
}
