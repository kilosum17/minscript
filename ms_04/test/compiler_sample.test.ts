// samples/compiler (the MinScript front end written in MinScript, spec §21 step 11): its lexer and
// parser must reproduce the TypeScript compiler's output exactly on every `.ms` file of the repo:
// the token dump (`ms lex`), the AST dump (`ms parse`), and every diagnostic with its span.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dumpTokens } from "../src/dump.ts";
import { lex } from "../src/lexer.ts";
import { parse } from "../src/parser.ts";
import { sexpr } from "../src/sexpr.ts";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const cli = join(root, "src", "cli.ts");
const exec = promisify(execFile);

function msFiles(dir: string, out: string[] = []): string[] {
    for (const n of readdirSync(dir).sort()) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) msFiles(p, out);
        else if (n.endsWith(".ms")) out.push(p);
    }
    return out;
}

const files = ["examples", "samples", "std", "test"].flatMap((d) => msFiles(join(root, d))).map((f) => relative(root, f)).sort();

async function sample(cmd: string): Promise<string> {
    const r = await exec(process.execPath, [cli, "run", "samples/compiler", "--", cmd, ...files], { cwd: root, maxBuffer: 1 << 28, timeout: 120_000 });
    return r.stdout;
}

/** The first differing line, with the file it is in, for a readable failure. */
function firstDifference(want: string, got: string): string {
    const a = want.split("\n");
    const b = got.split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
            const file = [...a.slice(0, i + 1)].reverse().find((l) => l.startsWith("== ")) ?? "?";
            return `${file}, line ${i + 1}:\n  want: ${a[i]}\n  got:  ${b[i]}`;
        }
    }
    return "";
}

test("samples/compiler lexes the corpus exactly as the TypeScript lexer", async () => {
    let want = "";
    for (const f of files) {
        const r = lex(readFileSync(join(root, f)));
        want += `== ${f}\n` + dumpTokens(r);
        for (const d of r.diagnostics) want += `! ${d.start} ${d.end} ${d.code} ${d.message}\n`;
    }
    const got = await sample("lex");
    assert.ok(got === want, firstDifference(want, got));
});

test("samples/compiler parses the corpus exactly as the TypeScript parser", async () => {
    let want = "";
    for (const f of files) {
        const r = parse(readFileSync(join(root, f)));
        want += `== ${f}\n` + sexpr(r.file) + "\n";
        for (const d of r.diagnostics) want += `! ${d.start} ${d.end} ${d.code} ${d.message}\n`;
    }
    const got = await sample("parse");
    assert.ok(got === want, firstDifference(want, got));
});
