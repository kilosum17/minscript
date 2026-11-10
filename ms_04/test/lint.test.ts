// Lints (spec §18.4): each test/lint/*.ms (and the project in test/lint/project/) goes through the
// whole front end and pass 9; its findings must match its `//~ L_CODE` annotations exactly, and it
// must have no other diagnostics. Each file holds firing and quiet cases for one lint, and every
// lint of `LINTS` must fire somewhere. A `//! effects-cap: N` first line lowers pass 6's cap.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LineMap } from "../src/diagnostic.ts";
import { frontEnd } from "../src/pipeline.ts";
import { LINTS } from "../src/lint.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "test", "lint");
const sort = (xs: string[]) => [...xs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const fired = new Set<string>();

/** `//~ CODE` annotations as `line: CODE` (as in programs.test.ts). */
function annotations(file: string): string[] {
    const out: string[] = [];
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const m = /\/\/~\s+(.*)$/.exec(line);
        if (m) for (const code of m[1]!.trim().split(/\s+/)) out.push(`${i + 1}: ${code}`);
    });
    return out;
}

function check(entry: string, files: string[]) {
    const header = /^\/\/! effects-cap: (\d+)/.exec(readFileSync(files[0]!, "utf8"));
    const fe = frontEnd(entry, { tests: true, effectsCap: header ? Number(header[1]) : undefined });
    const expected = files.flatMap((f) => annotations(f).map((a) => `${relative(dir, f)}:${a}`));
    const got = [...fe.diagnostics, ...fe.lints].map((d) => {
        const lines = new LineMap(readFileSync(d.file!));
        return `${relative(dir, d.file!)}:${lines.line(d.start)}: ${d.code}`;
    });
    for (const d of fe.lints) fired.add(d.code);
    assert.deepEqual(sort(got), sort(expected));
    return fe;
}

for (const name of readdirSync(dir).filter((n) => n.endsWith(".ms")).sort()) {
    test(`lint ${name}`, () => {
        check(join(dir, name), [join(dir, name)]);
    });
}

test("lint levels from mod.ms: allow silences, deny makes an error", () => {
    const main = join(dir, "project", "src", "main.ms");
    const fe = check(join(dir, "project"), [main]);
    assert.deepEqual(fe.lints.map((d) => `${d.code} ${d.severity}`), ["L_INT_NOT_PORTABLE error"]);
});

test("lint levels on the command line come after mod.ms", () => {
    const fe = frontEnd(join(dir, "project"), { lint: { allow: ["L_INT_NOT_PORTABLE"], warn: ["L_NESTED_LOCK"], deny: [], strict: false } });
    assert.deepEqual(fe.lints.map((d) => `${d.code} ${d.severity}`), ["L_NESTED_LOCK warning"]);
});

test("every lint has a test that fires it", () => {
    assert.deepEqual([...Object.keys(LINTS)].filter((c) => !fired.has(c)), []);
});
