// Loader cases the corpus can't hold (spec §8.1, §17.6).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProgram } from "./loader.ts";

function tree(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "ms04-"));
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(dir, path, ".."), { recursive: true });
        writeFileSync(join(dir, path), text);
    }
    return dir;
}

test("a program folder without a `package main` file is E_NO_MAIN", () => {
    const dir = tree({ "lib.ms": "package lib\n\npub fn f() {}\n" });
    try {
        assert.deepEqual(loadProgram(dir).diagnostics.map((d) => d.code), ["E_NO_MAIN"]);
    } finally {
        rmSync(dir, { recursive: true });
    }
});

test("a project's main defaults to ./src, and path: dependencies load by name", () => {
    const dir = tree({
        "app/mod.ms": 'package mod\n\nimport "build.*"\n\npub fn config() -> Config {\n    Config { name: "a", version: "1.0.0", deps: m{ "util": "path:../util" } }\n}\n',
        "app/src/main.ms": 'package main\n\nimport "util"\nimport "app.models.{User}"\n\nfn main() { log.println(util.twice(User { id: 1 }.id)) }\n',
        "app/src/models/user.ms": "package models\n\npub type User { pub id: int }\n",
        "util/util.ms": "package util\n\npub fn twice(n: int) -> int { n * 2 }\n",
    });
    try {
        const p = loadProgram(join(dir, "app"));
        assert.deepEqual(p.diagnostics.map((d) => `${d.code}: ${d.message}`), []);
        assert.deepEqual(p.packages.map((x) => x.name), ["util", "app.models", "main"]);
    } finally {
        rmSync(dir, { recursive: true });
    }
});

test("std packages that aren't written yet load as not loaded; unknown std paths are errors", () => {
    const dir = tree({
        "main.ms": 'package main\n\nimport "std.json"\nimport "std.io.println"\nimport "std.testing.*"\nimport "std.nope"\n\nfn main() { println(json.stringify(1)) }\n',
    });
    try {
        assert.deepEqual(loadProgram(join(dir, "main.ms")).diagnostics.map((d) => d.code), ["E_UNKNOWN_IMPORT"]);
    } finally {
        rmSync(dir, { recursive: true });
    }
});
