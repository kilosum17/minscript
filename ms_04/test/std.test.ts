// std (spec §14.4, §17.7): every std package loads and checks cleanly, std's own tests pass under
// `ms test`, and so do the MinScript tests of the prelude, the samples and the projects. The failing
// example's report must match `report.out` (timings shown as `…`). Both samples run to the end.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { frontEnd } from "../src/pipeline.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");
const exec = promisify(execFile);

async function ms(...args: string[]): Promise<{ code: number; out: string }> {
    try {
        const r = await exec("/bin/sh", ["-c", `'${process.execPath}' '${cli}' ${args.map((a) => `'${a}'`).join(" ")} 2>&1`], { cwd: root, timeout: 60_000 });
        return { code: 0, out: r.stdout };
    } catch (e) {
        const x = e as { code?: number; stdout?: string };
        return { code: x.code ?? 1, out: x.stdout ?? "" };
    }
}

function stdFiles(dir: string, out: string[] = []): string[] {
    for (const n of readdirSync(dir).sort()) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) stdFiles(p, out);
        else if (n.endsWith(".ms") && n !== "prelude.ms" && !n.endsWith("_test.ms")) out.push(p);
    }
    return out;
}

for (const file of stdFiles(join(root, "std"))) {
    test(`std package ${relative(join(root, "std"), dirname(file))} loads cleanly`, () => {
        const fe = frontEnd(file);
        assert.deepEqual([...fe.diagnostics, ...fe.hirProblems.map((p) => ({ code: "HIR", message: p }))].map((d) => `${d.code}: ${d.message}`), []);
    });
}

for (const dir of ["std", "examples/prelude", "samples/calc", "samples/shop", "examples/projects/basic"]) {
    test(`ms test ${dir}`, async () => {
        const r = await ms("test", dir);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, / 0 failed\n/);
    });
}

test("ms test reports failures (examples/testing/failing)", async () => {
    const r = await ms("test", "examples/testing/failing");
    assert.equal(r.code, 1);
    assert.equal(r.out.replace(/\(\d+ ms\)/g, "(… ms)"), readFileSync(join(root, "examples/testing/failing/report.out"), "utf8"));
});

test("samples/calc runs", async () => {
    const r = await ms("run", "samples/calc");
    assert.equal(r.code, 0, r.out);
    assert.equal(r.out, readFileSync(join(root, "samples/calc/run.out"), "utf8"));
});

test("samples/shop runs to the end", async () => {
    const r = await ms("run", "samples/shop");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /takings KSh 1090\.00; 6 seen, 4 refused\n/);
    assert.match(r.out, /promo milk KSh 59\.00; catalog still says KSh 65\.00\n/);
});
