// The `ms` command, run as a user would: bin/ms.js in a child process.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"

const MS = fileURLToPath(new URL("../bin/ms.js", import.meta.url))
const BASIC = fileURLToPath(new URL("../test/projects/basic/", import.meta.url))
const PLAIN = fileURLToPath(new URL("../test/projects/plain/", import.meta.url))

function ms(args: string[], cwd = BASIC) {
    const r = spawnSync(process.execPath, [MS, ...args], { cwd, encoding: "utf8" })
    return { code: r.status, out: r.stdout, err: r.stderr }
}

describe("the ms command", () => {
    test("help and version", () => {
        assert.match(ms([]).out, /usage: ms <command>/)
        assert.match(ms(["help"]).out, /run <script>/)
        assert.match(ms(["version"]).out, /^ms \d+\.\d+\.\d+ \(node /)
    })
    test("run: the project here, a folder, a file inside main", () => {
        assert.deepEqual(ms(["run", "."]), { code: 0, out: "[shared] hello, basic!\n2 items, $14.49\n", err: "" })
        assert.equal(ms(["run", PLAIN], BASIC).out, "42\n")
        assert.equal(ms(["run", "src/greet.ms"]).out, "[shared] hello, basic!\n2 items, $14.49\n")
    })
    test("scripts: listed, run by name, and the `ms <script>` shorthand", () => {
        assert.match(ms(["run"]).out, /hello +echo hello from a shell script/)
        assert.equal(ms(["run", "hello"]).out, "hello from a shell script\n")
        assert.equal(ms(["gen", "--", "a", "b"]).out, "gen ran with 2 args\n")
        assert.equal(ms(["run", "check", "--", "--verbose"]).out, "task args: 1, verbose: true\n")
    })
    test("check and config", () => {
        assert.deepEqual(ms(["check"]), { code: 0, out: ".: ok (3 packages, 4 files)\n", err: "" })
        assert.equal(JSON.parse(ms(["config"]).out).name, "basic")
    })
    test("errors: unknown command, failing evaluation", () => {
        const r = ms(["nope"])
        assert.equal(r.code, 2)
        assert.match(r.err, /unknown command `nope`/)
        const bad = ms(["config"], fileURLToPath(new URL("../test/projects/script_in_eval/", import.meta.url)))
        assert.equal(bad.code, 1)
        assert.match(bad.err, /E_SCRIPT_IN_EVAL/)
    })
})
