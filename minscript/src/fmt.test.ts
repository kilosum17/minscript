import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { format } from "./fmt.ts"
import { fmtOptionsFrom } from "./fmt_cli.ts"

const SRC = "package p\n\nfun f(a: int) -> int {\n  let total = add(a, 22222222, 33333333, 44444444)\n  total\n}\n"

describe("formatter options", () => {
    test("indent, width and trailing commas", () => {
        assert.equal(format(SRC).text, "package p\n\nfun f(a: int) -> int {\n    let total = add(a, 22222222, 33333333, 44444444)\n    total\n}\n")
        const narrow = format(SRC, { indent: 2, maxWidth: 30 }).text!
        assert.match(narrow, /\n  let total = add\(\n    a,\n    22222222,\n    33333333,\n    44444444,\n  \)\n/)
        assert.match(format(SRC, { maxWidth: 30, trailingCommas: false }).text!, /44444444\n    \)/)
    })
    test("mod.ms's fmt section (ms.fmt Options) maps to options; missing keys keep the defaults", () => {
        assert.deepEqual(fmtOptionsFrom({ indent: 2, max_width: 80 }), { indent: 2, maxWidth: 80, trailingCommas: true })
        assert.deepEqual(fmtOptionsFrom(undefined), { indent: 4, maxWidth: 100, trailingCommas: true })
    })
    test("a file with a syntax error isn't formatted", () => {
        const r = format("package p\nfun f( {\n")
        assert.equal(r.text, null)
        assert.ok(r.diagnostics.length > 0)
    })
})

describe("ms fmt", () => {
    const MS = fileURLToPath(new URL("../bin/ms.js", import.meta.url))
    test("--check reports, then formatting writes, then --check passes", () => {
        const dir = mkdtempSync(join(tmpdir(), "ms-fmt-"))
        const file = join(dir, "main.ms")
        writeFileSync(file, "package main\n\nfun main() { log.println(1);  }\n")
        const run = (args: string[]) => spawnSync(process.execPath, [MS, "fmt", ...args], { cwd: dir, encoding: "utf8" })
        const check = run(["--check"])
        assert.equal(check.status, 1)
        assert.match(check.stdout, /main\.ms: not formatted/)
        assert.equal(run([]).status, 0)
        assert.equal(readFileSync(file, "utf8"), "package main\n\nfun main() { log.println(1); }\n")
        assert.equal(run(["--check"]).status, 0)
    })
})
