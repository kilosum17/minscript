// Pass 8, mechanism selection (spec §15.2, Appendix A.2). Each test/mechanism/*.ms has:
// - a `.mech` snapshot of `ms mech` (UPDATE_SNAPSHOTS=1 rewrites it);
// - a `.out`: what it prints, which must be the same with and without pass 8 (`--no-mech`), since
//   choosing a move or skipping a uniqueness check must never change what a program means.
// The A.2 sample must also copy less with pass 8: the second call moves, so `push` writes in place.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "test", "mechanism");
const cli = join(root, "src", "cli.ts");
const update = process.env.UPDATE_SNAPSHOTS === "1";
const exec = promisify(execFile);

async function ms(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
        return await exec(process.execPath, [cli, ...args], { cwd: root, timeout: 30_000 });
    } catch (e) {
        const x = e as { stdout?: string; stderr?: string };
        return { stdout: x.stdout ?? "", stderr: x.stderr ?? "" };
    }
}

for (const name of readdirSync(dir).filter((n) => n.endsWith(".ms")).sort()) {
    const file = join(dir, name);
    const base = file.replace(/\.ms$/, "");
    test(`mech ${name}`, async () => {
        const { stdout } = await ms("mech", file);
        if (update) writeFileSync(`${base}.mech`, stdout);
        assert.equal(stdout, readFileSync(`${base}.mech`, "utf8"));
    });
    if (existsSync(`${base}.out`)) {
        test(`run ${name} with and without pass 8`, async () => {
            const expected = readFileSync(`${base}.out`, "utf8");
            const on = await ms("run", file);
            const off = await ms("run", "--no-mech", file);
            assert.equal(on.stdout + on.stderr, expected);
            assert.equal(off.stdout + off.stderr, expected);
        });
    }
}

test("A.2: the second call moves, so it copies nothing", async () => {
    const copies = async (...flags: string[]) => {
        const { stderr } = await ms("run", "--stats", ...flags, join(dir, "copy_on_write.ms"));
        return Number(/copies: (\d+)/.exec(stderr)?.[1]);
    };
    // the first call copies the shared Config header and its `tags`; without pass 8 the second does too
    assert.equal(await copies(), 2);
    assert.equal(await copies("--no-mech"), 4);
});
