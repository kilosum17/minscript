import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"
import { analyze, definition, documentSymbols, hover, packageName, PositionMap, references, type Analysis } from "./analysis.ts"

const A = "file:///work/app/a.ms"
const B = "file:///work/app/b.ms"

/** Analyzes `src` (as file a.ms) and returns the analysis plus a position finder: `at("needle")`. */
function setup(src: string, others: { uri: string, text: string }[] = []) {
    const an = analyze([{ uri: A, text: src }, ...others], A)
    const at = (needle: string, nth = 0, delta = 0) => {
        let idx = -1
        for (let i = 0; i <= nth; i++) idx = src.indexOf(needle, idx + 1)
        assert.ok(idx >= 0, `no ${JSON.stringify(needle)}`)
        const before = src.slice(0, idx + delta)
        const line = before.split("\n").length - 1
        return { line, character: before.length - before.lastIndexOf("\n") - 1 }
    }
    return { an, at }
}

const hoverText = (an: Analysis, uri: string, pos: { line: number, character: number }) => {
    const h = hover(an, uri, pos)
    return h ? (h.contents as { value: string }).value : null
}

describe("positions", () => {
    test("byte offsets ↔ LSP positions (UTF-16), with non-ASCII text", () => {
        const text = "let s = \"é😀\"\nlet x = 1"
        const map = new PositionMap(text)
        const xByte = new TextEncoder().encode(text.slice(0, text.indexOf("x"))).length
        assert.deepEqual(map.position(xByte), { line: 1, character: 4 })
        assert.equal(map.offset({ line: 1, character: 4 }), xByte)
        const quote = new TextEncoder().encode(text.slice(0, text.lastIndexOf("\""))).length
        assert.deepEqual(map.position(quote), { line: 0, character: 12 })    // é = 1 unit, 😀 = 2 units
    })

    test("package names", () => {
        assert.equal(packageName("// header\npackage app.users\n"), "app.users")
        assert.equal(packageName("fun f() {}"), null)
    })
})

describe("diagnostics", () => {
    test("every pass reports, at the right place", () => {
        const { an, at } = setup("package p\nfun main() {\n    let x: int = \"no\"\n    y = 1\n}\n")
        const d = an.diagnostics.get(A)!
        assert.deepEqual(d.map((x) => x.code).sort(), ["E_TYPE_MISMATCH", "E_UNDECLARED_ASSIGNMENT"])
        const mismatch = d.find((x) => x.code === "E_TYPE_MISMATCH")!
        assert.deepEqual(mismatch.range.start, at("\"no\""))
        assert.equal(mismatch.source, "minscript")
    })

    test("while the syntax is broken, only syntax and name errors are shown", () => {
        const { an } = setup("package p\nfun main() {\n    let x: int = \"no\"\n    let = 1\n}\n")
        assert.deepEqual(an.diagnostics.get(A)!.map((x) => x.code), ["E_INVALID_PATTERN"])
    })

    test("in a package of several files, each diagnostic goes to its file", () => {
        const other = { uri: B, text: "package p\n\nfun helper() -> int { \"x\" }\n" }
        const { an } = setup("package p\nfun main() { helper() }\n", [other])
        assert.deepEqual(an.diagnostics.get(A), [])
        assert.deepEqual(an.diagnostics.get(B)!.map((x) => [x.code, x.range.start.line]), [["E_TYPE_MISMATCH", 2]])
    })
})

describe("hover", () => {
    const src = `package p

type Point = { x: int, y: int }

/// Adds two numbers.
/// Second line.
fun add(a: int, b: int) -> int { a + b }

fun main() {
    let p = Point { x: 1, y: 2 }
    total := add(p.x, 2)
    let names = ["a"].map(#{ it.len() })
}
`
    const { an, at } = setup(src)
    test("locals show their inferred type", () => {
        assert.match(hoverText(an, A, at("total"))!, /let total: int/)
        assert.match(hoverText(an, A, at("names"))!, /let names: Vec\[int\]/)
        assert.match(hoverText(an, A, at("it.len", 0, 0))!, /it: string/)
    })
    test("functions show their signature and doc comment", () => {
        const h = hoverText(an, A, at("add(p.x"))!
        assert.match(h, /fun add\(a: int, b: int\) -> int/)
        assert.match(h, /Adds two numbers\.\nSecond line\./)
    })
    test("fields and prelude methods", () => {
        assert.match(hoverText(an, A, at("x, 2", 0, 0))!, /x: int/)
        assert.match(hoverText(an, A, at("map("))!, /fun map\[U\]\(&this, f: &\(T, int\) -> U\) -> Vec\[U\][\s\S]*prelude/)
    })
})

describe("navigation", () => {
    const src = `package p

type Point = { x: int, y: int
    fun len(&this) -> int { this.x + this.y }
}

fun main() {
    let p = Point { x: 1, y: 2 }
    let a = p.len()
    let b = p.x + p.len()
    let v: Vec[int] = []
}
`
    const { an, at } = setup(src)
    test("definition: locals, types, fields, methods", () => {
        assert.deepEqual(definition(an, A, at("p.len()"))[0]!.range.start, at("p = Point", 0))
        assert.deepEqual(definition(an, A, at("Point {", 0))[0]!.range.start, at("Point = {", 0))
        assert.deepEqual(definition(an, A, at("x + p.len", 0))[0]!.range.start, at("x: int", 0))
        assert.deepEqual(definition(an, A, at("len()", 0))[0]!.range.start, at("len(&this)", 0))
    })
    test("definition into the prelude", () => {
        const d = definition(an, A, at("Vec[int]"))
        assert.match(d[0]!.uri, /std\/prelude\.ms$/)
    })
    test("definition across files of the package", () => {
        const other = { uri: B, text: "package p\n\npub fun helper() -> int { 1 }\n" }
        const s = setup("package p\nfun main() { let h = helper() }\n", [other])
        const d = definition(s.an, A, s.at("helper"))
        assert.equal(d[0]!.uri, B)
        assert.deepEqual(d[0]!.range.start, { line: 2, character: 8 })
    })
    test("references", () => {
        const refs = references(an, A, at("p = Point"), true)
        assert.equal(refs.length, 1 + 3)          // the declaration and three uses
    })
    test("document symbols", () => {
        const syms = documentSymbols(an, A)
        assert.deepEqual(syms.map((s) => s.name), ["Point", "main"])
        assert.deepEqual(syms[0]!.children!.map((c) => c.name), ["x", "y", "len"])
    })
})

describe("imported packages (test/packages/app)", async () => {
    const { readFileSync } = await import("node:fs")
    const { pathToFileURL } = await import("node:url")
    const main = new URL("../../test/packages/app/main.ms", import.meta.url)
    const uri = pathToFileURL(main.pathname).href
    const src = readFileSync(main, "utf8")
    const an = analyze([{ uri, text: src }], uri)
    const at = (needle: string) => {
        const before = src.slice(0, src.indexOf(needle))
        return { line: before.split("\n").length - 1, character: before.length - before.lastIndexOf("\n") - 1 }
    }
    test("the program checks cleanly against its packages and real std signatures", () => {
        assert.deepEqual(an.diagnostics.get(uri), [])
    })
    test("hover and definition reach into other packages", () => {
        const h = hoverText(an, uri, at("describe(u)"))!
        assert.match(h, /fun describe\(u: &User\) -> string/)
        assert.match(h, /One line about a user/)
        assert.match(h, /package app\.models/)
        const d = definition(an, uri, at("describe(u)"))
        assert.match(d[0]!.uri, /test\/packages\/app\/models\/user\.ms$/)
        assert.match(hoverText(an, uri, at("stringify"))!, /fun stringify\[T\]\(value: &T\) -> string[\s\S]*package std\.json/)
    })
    test("an unsaved edit to an imported file is used", () => {
        const util = pathToFileURL(new URL("../../test/packages/app/util/util.ms", import.meta.url).pathname).href
        const edited = analyze([{ uri, text: src }, { uri: util, text: "package util\n\npub fun sum(xs: Vec[int]) -> string { \"\" }\npub fun shout(s: &str) -> string { s.to_upper() }\n" }], uri)
        assert.deepEqual(edited.diagnostics.get(uri), [])        // sum() now returns a string: still fine in a template
        assert.match(hoverText(edited, uri, at("sum("))!, /-> string/)
    })
})

describe("projects (test/projects/basic)", async () => {
    const { pathToFileURL } = await import("node:url")
    const { openProject } = await import("../../src/project.ts")
    const root = new URL("../../test/projects/basic/", import.meta.url).pathname
    const p = await openProject(root)
    const greet = pathToFileURL(`${root}src/greet.ms`).href
    test("every package main file of `main` is one package, with the path: deps", () => {
        const an = analyze([], greet, { mainDir: p.mainDir, deps: p.deps })
        assert.deepEqual(an.diagnostics.get(greet), [])
        assert.ok(an.files.has(pathToFileURL(`${root}src/main.ms`).href))
        const src = readFileSync(`${root}src/greet.ms`, "utf8")
        const before = src.slice(0, src.indexOf("banner()"))
        const pos = { line: before.split("\n").length - 1, character: before.length - before.lastIndexOf("\n") - 1 }
        assert.match(hoverText(an, greet, pos)!, /package shared/)
    })
    test("without the project, `shared` is an external dependency: opaque, not an error", () => {
        const an = analyze([], greet, null)
        assert.deepEqual(an.diagnostics.get(greet), [])
        assert.equal(an.files.size, 1)          // greet.ms alone: a main file is its own package
    })
})

describe("robustness", () => {
    test("queries anywhere in the corpus (and in half-typed prefixes) never throw", async () => {
        const { readFileSync, readdirSync } = await import("node:fs")
        const dir = new URL("../../test/programs/", import.meta.url)
        for (const name of readdirSync(dir).filter((f) => f.endsWith(".ms"))) {
            const full = readFileSync(new URL(name, dir), "utf8")
            for (const cut of [full.length, Math.floor(full.length / 2), Math.floor(full.length / 3)]) {
                const text = full.slice(0, cut)
                const an = analyze([{ uri: A, text }], A)
                const lines = text.split("\n")
                for (let line = 0; line < lines.length; line += 2) {
                    for (let character = 0; character <= lines[line]!.length; character += 3) {
                        hover(an, A, { line, character })
                        definition(an, A, { line, character })
                        references(an, A, { line, character }, true)
                    }
                }
                documentSymbols(an, A)
            }
        }
    })
})
