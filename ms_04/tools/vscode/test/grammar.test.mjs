// Tokenizes MinScript (v0.4) with the TextMate engine VS Code uses (vscode-textmate + Oniguruma)
// and checks the scopes of the cases from spec §1. Run: npm test (in tools/vscode).

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

function scopeOf(src, text, nth = 0) {
    const found = tokens(src).filter(([t]) => t === text)
    assert.ok(found[nth], `no token ${JSON.stringify(text)} in ${JSON.stringify(src)}: ${JSON.stringify(tokens(src))}`)
    return found[nth][1]
}

describe("MinScript v0.4 grammar", () => {
    test("keywords, and keywords used as members", () => {
        assert.match(scopeOf("let x = a or b", "let"), /keyword\.other\.declaration/)
        assert.match(scopeOf("let x = a or b", "or"), /keyword\.control/)
        assert.match(scopeOf("lock a, b { }", "lock"), /keyword\.control/)
        assert.match(scopeOf("let y = x.or(5)", "or"), /entity\.name\.function\.member/)
        assert.match(scopeOf("cfg.type", "type"), /variable\.other\.member/)
        assert.match(scopeOf("while x { }", "while"), /invalid\.deprecated\.reserved/)
        assert.match(scopeOf("fun f() {}", "fun"), /invalid\.deprecated\.removed/)
        assert.match(scopeOf("var mut x = 1", "mut"), /invalid\.deprecated\.removed/)
    })

    test("declarations", () => {
        assert.match(scopeOf("pub fn area(w: f32) -> f32 {", "area"), /entity\.name\.function\.minscript/)
        assert.match(scopeOf("pub fn area(w: f32) -> f32 {", "fn"), /storage\.type\.function/)
        assert.match(scopeOf("type User {", "User"), /entity\.name\.type/)
        assert.match(scopeOf("union Shape { Circle(f64)  Empty }", "Shape"), /entity\.name\.type/)
        assert.match(scopeOf("fn t[T](v: T) -> T {", "t"), /entity\.name\.function/)      // no sigil after `fn`
        assert.match(scopeOf("x: Vec[str]", "str"), /support\.type\.primitive/)
    })

    test("write modes, shared and once", () => {
        assert.match(scopeOf("fn bump(*this) { }", "*"), /storage\.modifier\.write/)
        assert.match(scopeOf("fn tag(u: *User, t: str) { }", "*"), /storage\.modifier\.write/)
        assert.match(scopeOf("fn at_mut(*this, i: int) -> *T { }", "*", 1), /storage\.modifier\.write/)
        assert.match(scopeOf("x := a * b", "*"), /keyword\.operator\.minscript/)
        assert.match(scopeOf("shared var hits = 0", "shared"), /storage\.modifier\.minscript/)
        assert.match(scopeOf("    once ty: Type", "once"), /storage\.modifier\.minscript/)
        assert.match(scopeOf("let shared = 1", "shared"), /variable\.other/)         // a contextual keyword
    })

    test("sigils, closures and attributes", () => {
        assert.match(scopeOf("let p = t(1, 2)", "t"), /storage\.modifier\.sigil/)
        assert.match(scopeOf("let r = r{ a: 1 }", "r", 1), /storage\.modifier\.sigil/)
        assert.match(scopeOf("let c = #{ it * 2 }", "#"), /keyword\.operator\.closure/)
        assert.match(scopeOf("let c = #{ it * 2 }", "it"), /variable\.language\.implicit/)
        assert.doesNotMatch(scopeOf("obj.t(1)", "t"), /sigil/)
        assert.match(scopeOf("    #[effects(keeps: [v])]", "effects"), /entity\.name\.function\.attribute/)
        assert.match(scopeOf("f.[str](x)", "."), /punctuation\.accessor\.generic/)
    })

    test("literals: numbers, bytes, chars", () => {
        assert.deepEqual(tokens("1..10").map(([t]) => t), ["1", "..", "10"])
        assert.match(scopeOf("x = 2.5e-3", "2.5e-3"), /constant\.numeric\.float/)
        assert.match(scopeOf("x = 0xFF", "0xFF"), /constant\.numeric\.hex/)
        assert.deepEqual(tokens("t.0.1").map(([t]) => t), ["t", ".", "0", ".", "1"])
        assert.match(scopeOf("if c == b'\\n' {", "'\\n'"), /constant\.character\.byte/)
        assert.match(scopeOf("c >= b'a'", "b"), /storage\.type\.byte/)
        assert.match(scopeOf("let c = 'x'", "'x'"), /constant\.character\.minscript/)
    })

    test("strings: escapes, interpolation with nested braces and strings, raw, multi-line", () => {
        const src = `let s = "a \\n \${ r{ x: "}" }.x } b"`
        assert.match(scopeOf(src, "\\n"), /constant\.character\.escape/)
        assert.match(scopeOf(src, "x", 1), /variable\.other\.member/)
        assert.match(scopeOf(src, " b"), /string\.quoted\.double/)
        assert.match(scopeOf('let p = r"C:\\dir"', 'C:\\dir'), /string\.quoted\.raw/)
        const multi = 'let m = """\n    one ${n}\n    """\nlet after = 1'
        assert.match(scopeOf(multi, "after"), /variable\.other/)
    })

    test("every .ms file of the repository tokenizes, and strings and comments close", () => {
        const root = join(here, "..", "..", "..")
        const files = []
        const walk = (d) => {
            for (const n of readdirSync(d)) {
                const p = join(d, n)
                if (n === "node_modules" || n.startsWith(".")) continue
                if (statSync(p).isDirectory()) walk(p)
                else if (n.endsWith(".ms") && !p.includes("/errors/")) files.push(p)
            }
        }
        for (const d of ["examples", "samples", "std"]) walk(join(root, d))
        assert.ok(files.length > 60, `${files.length} files`)
        for (const f of files) {
            const lines = readFileSync(f, "utf8").split("\n")
            let state = vsctm.INITIAL
            for (const line of lines) state = grammar.tokenizeLine(line, state).ruleStack
            // at the end of a valid file, no string, comment or interpolation is still open
            const scopes = grammar.tokenizeLine("", state).tokens[0].scopes.join(" ")
            assert.doesNotMatch(scopes, /string|comment|interpolation/, f)
        }
    })
})
