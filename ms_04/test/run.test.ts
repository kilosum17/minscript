// The JS back end (spec §16): every program in examples/run/ (a file with a `.out` beside it) and
// every examples/packages/*/ with a main.out is compiled and run, and what it prints (stdout and
// stderr, in the order written) must match.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

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

/** What `ms run entry` prints, stdout and stderr interleaved as written (one pipe for both). */
export async function merged(entry: string, cmd = "run"): Promise<string> {
    const q = (x: string) => `'${x.replace(/'/g, "'\\''")}'`;
    try {
        const r = await run("/bin/sh", ["-c", `${q(process.execPath)} ${q(cli)} ${cmd} ${q(entry)} 2>&1`], { cwd: root, timeout: 30_000 });
        return r.stdout;
    } catch (e) {
        return (e as { stdout?: string }).stdout ?? "";
    }
}

for (const [name, entry, expected] of entries) {
    test(`run ${name}`, async () => {
        assert.equal(await merged(entry), readFileSync(expected, "utf8"));
    });
}
