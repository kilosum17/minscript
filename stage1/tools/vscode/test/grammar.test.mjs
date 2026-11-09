// Tokenizes MinScript with the real TextMate engine VS Code uses (vscode-textmate + Oniguruma) and
// checks the scopes of the tricky cases from spec §1. Run: npm test (in tools/vscode).

import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import vsctm from "vscode-textmate"
import oniguruma from "vscode-oniguruma"

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL(".", import.meta.url))
const wasm = readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer
await oniguruma.loadWASM(wasm)

const registry = new vsctm.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p) => new oniguruma.OnigScanner(p), createOnigString: (s) => new oniguruma.OnigString(s) }),
    loadGrammar: async () => vsctm.parseRawGrammar(readFileSync(join(here, "../syntaxes/minscript.tmLanguage.json"), "utf8"), "minscript.tmLanguage.json"),
})
const grammar = await registry.loadGrammar("source.minscript")

/** Tokens of a snippet as [text, innermost scope] pairs (whitespace dropped). */
function tokens(src) {
    let state = vsctm.INITIAL
    const out = []
    for (const line of src.split("\n")) {
        const r = grammar.tokenizeLine(line, state)
        for (const t of r.tokens) {
            const text = line.slice(t.startIndex, t.endIndex)
            if (text.trim() === "") continue
            out.push([text, t.scopes[t.scopes.length - 1]])
        }
        state = r.ruleStack
    }
    return out
}

/** The innermost scope of the first token equal to `text`. */
function scopeOf(src, text, nth = 0) {
    const found = tokens(src).filter(([t]) => t === text)
    assert.ok(found[nth], `no token ${JSON.stringify(text)} in ${JSON.stringify(src)}: ${JSON.stringify(tokens(src))}`)
    return found[nth][1]
}

describe("MinScript grammar", () => {
    test("keywords, and keywords used as members", () => {
        assert.match(scopeOf("let x = a or b", "let"), /keyword\.other\.declaration/)
        assert.match(scopeOf("let x = a or b", "or"), /keyword\.control/)
        assert.match(scopeOf("let y = x.or(5)", "or"), /entity\.name\.function\.member/)     // spec §1.4
        assert.match(scopeOf("cfg.type", "type"), /variable\.other\.member/)
        assert.match(scopeOf("while x { }", "while"), /invalid\.deprecated/)
    })

    test("declarations", () => {
        assert.match(scopeOf("pub fun area(w: f32) -> f32 {", "area"), /entity\.name\.function\.minscript/)
        assert.match(scopeOf("type User = {", "User"), /entity\.name\.type/)
        assert.match(scopeOf("fun t[T](v: T) -> T {", "t"), /entity\.name\.function/)   // no sigil after `fun`
        assert.match(scopeOf("x: Vec[int]", "int"), /support\.type\.primitive/)
    })

    test("sigils are glued letters only", () => {
        assert.match(scopeOf("let p = t(1, 2)", "t"), /storage\.modifier\.sigil/)
        assert.match(scopeOf("let r = r{ a: 1 }", "r", 1), /storage\.modifier\.sigil/)
        assert.match(scopeOf("let a = a[1, 2]", "a", 1), /storage\.modifier\.sigil/)
        assert.match(scopeOf("let c = #{ it * 2 }", "#"), /keyword\.operator\.closure/)
        assert.match(scopeOf("let c = #{ it * 2 }", "it"), /variable\.language\.implicit/)
        assert.doesNotMatch(scopeOf("obj.t(1)", "t"), /sigil/)
    })

    test("numbers: ranges and tuple indexing", () => {
        assert.deepEqual(tokens("1..10").map(([t]) => t), ["1", "..", "10"])
        assert.match(scopeOf("x = 2.5e-3", "2.5e-3"), /constant\.numeric\.float/)
        assert.match(scopeOf("x = 0xFF", "0xFF"), /constant\.numeric\.hex/)
        assert.deepEqual(tokens("t.0.1").map(([t]) => t), ["t", ".", "0", ".", "1"])
    })

    test("strings: escapes, interpolation with nested braces and strings, raw, multi-line", () => {
        const src = `let s = "a \\n \${ r{ x: "}" }.x } b"`
        assert.match(scopeOf(src, "\\n"), /constant\.character\.escape/)
        assert.match(scopeOf(src, "${"), /punctuation\.section\.interpolation\.begin/)
        assert.match(scopeOf(src, "x", 1), /variable/)                        // code inside the interpolation
        assert.match(scopeOf(src, " b"), /string\.quoted\.double/)              // back in the string after `}`
        assert.match(scopeOf(`p = r"C:\\x"`, "r"), /storage\.type\.string/)
        assert.match(scopeOf(`p = r"C:\\x"`, "C:\\x"), /string\.quoted\.raw/)
        const multi = tokens(`m = """\n  line \${n}\n  """\nlet after = 1`)
        assert.ok(multi.some(([t, s]) => t === "let" && /keyword/.test(s)), "code after a multi-line string")
        assert.match(scopeOf(`"unterminated\nlet x = 1`, "let"), /keyword/)  // a "…" string ends at the line end
    })

    test("comments nest", () => {
        const src = "/* a /* b */ still */ let x = 1"
        assert.match(scopeOf(src, "let"), /keyword/)
        assert.match(scopeOf("/// docs", "/// docs"), /comment\.line\.documentation/)
    })

    test("labels and chars", () => {
        assert.match(scopeOf("outer: for x in xs {", "outer"), /entity\.name\.label/)
        assert.match(scopeOf("c = '\\u{1F600}'", "'\\u{1F600}'"), /constant\.character/)
    })

    test("every corpus file tokenizes, and the grammar never gets stuck", () => {
        const root = join(here, "../../../test")
        const files = []
        const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith(".ms")) files.push(p) } }
        walk(root)
        files.push(join(here, "../../../std/prelude.ms"))
        for (const f of files) {
            const n = tokens(readFileSync(f, "utf8")).length
            assert.ok(n > 0, f)
        }
    })
})
