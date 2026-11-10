// Projects (spec §17): each examples/projects/* with a mod.ms evaluates to its `config.json`, and
// its program prints `run.out`: the program's output, then each `task` script's, run as
// `ms run <name> -- --verbose` from the project folder, with its lines prefixed `[name] `. A folder
// without a mod.ms (`plain`) runs with the defaults. The samples and examples/programs/project
// evaluate cleanly; the projects of test/projects/ each fail with the code their comment names.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { configJson, openProject } from "../src/project.ts";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const cli = join(root, "src", "cli.ts");
const update = process.env.UPDATE_SNAPSHOTS === "1";
const exec = promisify(execFile);

async function ms(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
    const q = (x: string) => `'${x.replace(/'/g, "'\\''")}'`;
    try {
        const r = await exec("/bin/sh", ["-c", `${q(process.execPath)} ${q(cli)} ${args.map(q).join(" ")} 2>&1`], { cwd, timeout: 60_000 });
        return { code: 0, out: r.stdout };
    } catch (e) {
        const x = e as { code?: number; stdout?: string };
        return { code: x.code ?? 1, out: x.stdout ?? "" };
    }
}

function snapshot(file: string, text: string): void {
    if (update || !existsSync(file)) writeFileSync(file, text);
    assert.equal(text, readFileSync(file, "utf8"));
}

for (const name of ["basic", "plain"]) {
    const dir = join(root, "examples", "projects", name);
    test(`project ${name}`, async () => {
        const p = openProject(dir);
        assert.deepEqual(p.diagnostics.map((d) => `${d.code}: ${d.message}`), []);
        if (p.config) snapshot(join(dir, "config.json"), configJson(p.config) + "\n");
        const run = await ms(root, "run", dir);
        assert.equal(run.code, 0, run.out);
        let out = run.out;
        for (const [script, s] of p.config?.scripts ?? []) {
            if (s.kind !== "Task") continue;
            const r = await ms(dir, "run", script, "--", "--verbose");
            assert.equal(r.code, 0, r.out);
            out += r.out.split("\n").filter((l) => l !== "").map((l) => `[${script}] ${l}\n`).join("");
        }
        snapshot(join(dir, "run.out"), out);
    });
}

test("project basic: scripts run from the project folder (sh, pkg, the list)", async () => {
    const dir = join(root, "examples", "projects", "basic");
    assert.equal((await ms(dir, "run", "hello", "--", "a b")).out, "hello from a shell script a b\n");
    assert.equal((await ms(dir, "run", "gen", "--", "x", "y")).out, "gen ran with 2 args\n");
    assert.match((await ms(dir, "run")).out, /^hello +echo hello from a shell script\ngen +pkg \.\/tools\/gen\ncheck +task\n$/);
    const missing = await ms(dir, "run", "nope");
    assert.equal(missing.code, 2);
    assert.match(missing.out, /no script `nope`/);
});

test("project basic: mod.ms reads the environment", async () => {
    const dir = join(root, "examples", "projects", "basic");
    const before = openProject(dir).config!.deps.has("extra");
    process.env.BASIC_EXTRA = "1";
    try {
        assert.equal(openProject(dir).config!.deps.get("extra"), "path:../extra");
    } finally {
        delete process.env.BASIC_EXTRA;
    }
    assert.equal(before, false);
});

for (const dir of ["samples/calc", "samples/shop", "examples/programs/project", "test/lint/project"]) {
    test(`${dir}: mod.ms evaluates cleanly`, () => {
        const p = openProject(join(root, dir));
        assert.deepEqual(p.diagnostics.map((d) => `${d.code}: ${d.message}`), []);
        assert.ok(p.config);
    });
}

const failing: [string, string][] = [
    ["examples/projects/script_in_eval", "E_SCRIPT_IN_EVAL"],
    ["test/projects/bad_dep", "E_BAD_DEP_SPEC"],
    ["test/projects/section_conflict", "E_SECTION_CONFLICT"],
    ["test/projects/no_config", "E_CONFIG_FAILED"],
];
for (const [dir, code] of failing) {
    test(`${dir}: ${code}`, async () => {
        assert.deepEqual(openProject(join(root, dir)).diagnostics.map((d) => d.code), [code]);
        const r = await ms(root, "config", dir);
        assert.equal(r.code, 1);
        assert.match(r.out, new RegExp(`error ${code}:`));
    });
}
