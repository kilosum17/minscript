// Whole programs (spec §8.1, §8.7, §13.5): every program in examples/ and samples/ is loaded,
// parsed, resolved and type-checked. A file's diagnostics must match its `//~ CODE` annotations exactly; most files have none.
//
// Entries: every folder with a mod.ms (a project), then every `main.ms`, then any file not yet
// loaded by an earlier entry (a single-file program, or a package nobody imports).

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LineMap, type Diagnostic } from "../src/diagnostic.ts";
import { checkProgram } from "../src/check.ts";
import { loadPrelude, loadProgram } from "../src/loader.ts";
import { frontEnd } from "../src/pipeline.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith(".ms")) out.push(p);
    }
    return out;
}

export function annotations(file: string): string[] {
    const out: string[] = [];
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const m = /\/\/~\s+(.*)$/.exec(line);
        if (m) for (const code of m[1]!.trim().split(/\s+/)) out.push(`${i + 1}: ${code}`);
    });
    return out;
}

const sort = (xs: string[]) => [...xs].sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b));

test("the prelude resolves and type-checks cleanly", () => {
    const { res, file } = loadPrelude();
    const checked = checkProgram({ packages: [], prelude: res, diagnostics: [] }, file);
    assert.deepEqual([...file.diagnostics, ...res.diagnostics, ...checked.prelude.diagnostics].map((d) => `${d.code}: ${d.message}`), []);
    for (const name of ["Identity", "Unique", "Symbol", "sym", "Weak", "PMap", "Some", "Ok", "log", "all"]) {
        assert.ok(res.exports.has(name), `prelude exports ${name}`);
    }
});

for (const dir of ["examples", "samples"]) {
    test(`${dir}/ programs load, resolve and type-check; diagnostics match their annotations`, () => {
        const files = walk(join(root, dir));
        const projects = [...new Set(files.filter((f) => f.endsWith("/mod.ms")).map(dirname))];
        // a `main.ms` marks a program folder: every `package main` file in it is one package
        const mains = files.filter((f) => f.endsWith("/main.ms")).map(dirname);
        const loaded = new Set<string>();
        const found = new Map<string, Diagnostic[]>();
        const entries = [...projects, ...mains, ...files];
        for (const entry of entries) {
            if (entry.endsWith(".ms") ? loaded.has(entry) : loaded.has(join(entry, "main.ms"))) continue;
            const program = loadProgram(entry, { tests: true });
            program.diagnostics.push(...checkProgram(program, loadPrelude().file).diagnostics);
            const fresh = new Set<string>();
            for (const p of program.packages) {
                for (const f of p.files) {
                    if (!loaded.has(f.path)) fresh.add(f.path);
                    loaded.add(f.path);
                }
            }
            for (const d of program.diagnostics) {
                if (d.file && !fresh.has(d.file) && loaded.has(d.file) && !d.file.endsWith("mod.ms")) continue;
                const list = found.get(d.file ?? entry) ?? [];
                if (!list.some((x) => x.start === d.start && x.code === d.code)) list.push(d);
                found.set(d.file ?? entry, list);
            }
            if (existsSync(join(entry, "mod.ms"))) {
                // mod.ms is a package of its own (package mod)
                loaded.add(join(entry, "mod.ms"));
                const m = loadProgram(join(entry, "mod.ms"), { tests: true });
                m.diagnostics.push(...checkProgram(m, loadPrelude().file).diagnostics);
                for (const d of m.diagnostics) found.set(d.file ?? entry, [...(found.get(d.file ?? entry) ?? []), d]);
            }
        }
        const problems: string[] = [];
        for (const f of files) {
            const lines = new LineMap(readFileSync(f));
            const actual = (found.get(f) ?? []).map((d) => `${lines.line(d.start)}: ${d.code}`);
            const expected = annotations(f);
            if (JSON.stringify(sort(actual)) !== JSON.stringify(sort(expected))) {
                const detail = (found.get(f) ?? []).map((d) => `    ${lines.line(d.start)}: ${d.code} ${d.message}`).join("\n");
                problems.push(`${relative(root, f)}: expected [${sort(expected).join(", ")}], got [${sort(actual).join(", ")}]\n${detail}`);
            }
        }
        assert.equal(problems.join("\n"), "");
    });
}

for (const dir of ["examples", "samples"]) {
    test(`${dir}/ programs lower to valid HIR`, () => {
        const files = walk(join(root, dir));
        const entries = [...new Set(files.filter((f) => f.endsWith("/mod.ms")).map(dirname)), ...files.filter((f) => f.endsWith("/main.ms")).map(dirname), ...files];
        const problems: string[] = [];
        for (const e of entries) problems.push(...frontEnd(e, { tests: true }).hirProblems.map((p) => `${relative(root, e)}: ${p}`));
        assert.deepEqual(problems, []);
    });
}
