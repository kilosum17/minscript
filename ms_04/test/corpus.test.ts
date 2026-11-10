// The corpus (spec §20):
// - every file in examples/ and samples/ parses with zero diagnostics;
// - test/errors/*.ms produce exactly the diagnostics their `//~ CODE` annotations name;
// - test/parser/*.ms parse cleanly and match their `.ast` snapshot;
// - test/lexer/*.ms lex cleanly and match their `.tokens` snapshot;
// - test/resolve/*.ms, each resolved as a package of its own with the prelude: a file with `//~`
//   annotations must produce exactly those diagnostics; one without must resolve cleanly and match
//   its `.refs` snapshot;
// - test/check/*.ms, resolved and type-checked the same way: annotations, or a `.types` snapshot;
// - test/hir/*.ms, lowered with the whole front end: valid HIR and a `.hir` snapshot;
// - test/effects/*.ms: every function's effect summary, an `.effects` snapshot (spec §9.5).
// UPDATE_SNAPSHOTS=1 rewrites the snapshots (`npm run test:update`): review the diff.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LineMap, formatDiagnostic, type Diagnostic } from "../src/diagnostic.ts";
import { dumpTokens } from "../src/dump.ts";
import { lex } from "../src/lexer.ts";
import { loadPrelude } from "../src/loader.ts";
import { parse } from "../src/parser.ts";
import { checkPackage } from "../src/check.ts";
import { dumpTypes } from "../src/check_dump.ts";
import { dumpFun } from "../src/hir_dump.ts";
import { frontEnd } from "../src/pipeline.ts";
import { showSummary } from "../src/effects.ts";
import { resolvePackage } from "../src/resolve.ts";
import { dumpResolution } from "../src/resolve_dump.ts";
import { sexpr } from "../src/sexpr.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const update = process.env.UPDATE_SNAPSHOTS === "1";

function msFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...msFiles(p));
        else if (p.endsWith(".ms")) out.push(p);
    }
    return out;
}

function show(ds: Diagnostic[], file: string, src: Uint8Array): string {
    const lines = new LineMap(src);
    return ds.map((d) => formatDiagnostic(d, relative(root, file), lines)).join("\n");
}

function snapshot(file: string, actual: string): void {
    if (update || !existsSync(file)) {
        writeFileSync(file, actual);
        return;
    }
    assert.equal(actual, readFileSync(file, "utf8"), `snapshot ${relative(root, file)} differs (npm run test:update)`);
}

for (const dir of ["examples", "samples"]) {
    test(`${dir}/ parses with zero diagnostics`, () => {
        const files = msFiles(join(root, dir));
        assert.ok(files.length > 0);
        const failures: string[] = [];
        for (const f of files) {
            const r = parse(readFileSync(f));
            if (r.diagnostics.length > 0) failures.push(show(r.diagnostics, f, r.lexed.src));
        }
        assert.equal(failures.join("\n"), "");
    });
}

function expectedCodes(text: string): string[] {
    const expected: string[] = [];
    text.split("\n").forEach((line, i) => {
        const m = /\/\/~\s+(.*)$/.exec(line);
        if (m) for (const code of m[1]!.trim().split(/\s+/)) expected.push(`${i + 1}: ${code}`);
    });
    return expected;
}

const sortCodes = (xs: string[]) => [...xs].sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b));

for (const f of msFiles(join(root, "test/errors"))) {
    test(`errors/${relative(join(root, "test/errors"), f)}`, () => {
        const text = readFileSync(f, "utf8");
        const r = parse(text);
        const lines = new LineMap(r.lexed.src);
        const actual = r.diagnostics.map((d) => `${lines.line(d.start)}: ${d.code}`);
        assert.deepEqual(sortCodes(actual), sortCodes(expectedCodes(text)), show(r.diagnostics, f, r.lexed.src));
    });
}

for (const f of msFiles(join(root, "test/resolve"))) {
    test(`resolve/${relative(join(root, "test/resolve"), f)}`, () => {
        const text = readFileSync(f, "utf8");
        const r = parse(text);
        const res = resolvePackage([{ path: f, ast: r.file, src: r.lexed.src }], { name: "test", prelude: loadPrelude().res });
        const all = [...r.diagnostics, ...res.diagnostics];
        const lines = new LineMap(r.lexed.src);
        const expected = expectedCodes(text);
        if (expected.length > 0) {
            const actual = all.map((d) => `${lines.line(d.start)}: ${d.code}`);
            assert.deepEqual(sortCodes(actual), sortCodes(expected), show(all, f, r.lexed.src));
        } else {
            assert.equal(show(all, f, r.lexed.src), "");
            snapshot(f.replace(/\.ms$/, ".refs"), dumpResolution(res, f, r.lexed.src));
        }
    });
}

for (const f of msFiles(join(root, "test/parser"))) {
    test(`parser/${relative(join(root, "test/parser"), f)}`, () => {
        const r = parse(readFileSync(f));
        assert.equal(show(r.diagnostics, f, r.lexed.src), "");
        snapshot(f.replace(/\.ms$/, ".ast"), sexpr(r.file) + "\n");
    });
}

for (const f of msFiles(join(root, "test/lexer"))) {
    test(`lexer/${relative(join(root, "test/lexer"), f)}`, () => {
        const r = lex(readFileSync(f));
        assert.equal(show(r.diagnostics, f, r.src), "");
        snapshot(f.replace(/\.ms$/, ".tokens"), dumpTokens(r));
    });
}

for (const f of msFiles(join(root, "test/check"))) {
    test(`check/${relative(join(root, "test/check"), f)}`, () => {
        const text = readFileSync(f, "utf8");
        const r = parse(text);
        const file = { path: f, ast: r.file, src: r.lexed.src };
        const prelude = loadPrelude();
        const res = resolvePackage([file], { name: "test", prelude: prelude.res });
        const checked = checkPackage([file], res, prelude);
        const all = [...r.diagnostics, ...res.diagnostics, ...checked.diagnostics];
        const lines = new LineMap(r.lexed.src);
        const expected = expectedCodes(text);
        if (expected.length > 0) {
            const actual = all.map((d) => `${lines.line(d.start)}: ${d.code}`);
            assert.deepEqual(sortCodes(actual), sortCodes(expected), show(all, f, r.lexed.src));
        } else {
            assert.equal(show(all, f, r.lexed.src), "");
            snapshot(f.replace(/\.ms$/, ".types"), dumpTypes(res, checked, f, r.lexed.src));
        }
    });
}

for (const f of msFiles(join(root, "test/hir"))) {
    test(`hir/${relative(join(root, "test/hir"), f)}`, () => {
        const fe = frontEnd(f);
        const src = readFileSync(f);
        assert.equal(show(fe.diagnostics, f, src), "");
        assert.deepEqual(fe.hirProblems, []);
        snapshot(f.replace(/\.ms$/, ".hir"), fe.hir.funs.filter((x) => x.file === f).map(dumpFun).join("\n\n") + "\n");
    });
}

for (const f of msFiles(join(root, "test/effects"))) {
    test(`effects/${relative(join(root, "test/effects"), f)}`, () => {
        const fe = frontEnd(f);
        const src = readFileSync(f);
        assert.equal(show(fe.diagnostics, f, src), "");
        const funs = fe.hir.funs.filter((x) => x.file === f);
        const width = Math.max(...funs.map((x) => x.name.length));
        snapshot(f.replace(/\.ms$/, ".effects"), funs.map((x) => `${x.name.padEnd(width)}  ${showSummary(fe.effects.summaries.get(x)!)}`).join("\n") + "\n");
    });
}
