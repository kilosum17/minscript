import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { analyze } from "./analysis.ts"
import { completion, inlayHints, prepareRename, rename, signatureHelp } from "./features.ts"

const URI = "file:///work/app/main.ms"

const BASE = `package main

import "std.json"

type User = {
    name: string
    age: int
    tags: Vec[string]

    /// Whether the user is an adult.
    fun adult(&this) -> bool { this.age >= 18 }
    fun guest() -> User { User { name: "guest", age: 0, tags: [] } }
}

union Shape = { Circle(f64)  Square(f64) }

/// Adds two numbers.
fun add(a: int, b: int) -> int { a + b }

fun main() {
    let u = User { name: "ann", age: 30, tags: [] }
    total := add(1, 2)
    let names = [u].map(#{ x => x.name })
    for n, i in names { log.println(n, i) }
    /*HERE*/
}
`

/** `src` with `code` at the HERE marker, and the cursor after `code` (or at `|` inside it). */
function at(code: string, src = BASE) {
    const cursor = code.includes("|") ? code.indexOf("|") : code.length
    const text = src.replace("/*HERE*/", code.replace("|", ""))
    const index = text.indexOf("/*HERE*/") >= 0 ? -1 : src.indexOf("/*HERE*/") + cursor
    const before = text.slice(0, index)
    return { docs: [{ uri: URI, text }], pos: { line: before.split("\n").length - 1, character: index - before.lastIndexOf("\n") - 1 }, text }
}

const labels = (items: { label: string }[]) => items.map((i) => i.label)

describe("completion", () => {
    test("members after `.`, while the line doesn't parse: fields first, then methods", () => {
        const { docs, pos } = at("u.")
        assert.deepEqual(labels(completion(docs, URI, pos)).slice(0, 4), ["name", "age", "tags", "adult"])
        const adult = completion(docs, URI, pos).find((c) => c.label === "adult")!
        assert.equal(adult.detail, "fun adult(&this) -> bool")
        assert.match((adult.documentation as { value: string }).value, /adult/)
    })
    test("inside a call that isn't closed yet", () => {
        const { docs, pos } = at("log.println(u.")
        assert.deepEqual(labels(completion(docs, URI, pos)).slice(0, 3), ["name", "age", "tags"])
        const nested = at("add(total, [u].map(#{ x => x.")
        assert.ok(labels(completion(nested.docs, URI, nested.pos)).includes("adult"), "a closure parameter's members")
    })
    test("a partly typed member, and the members of a field's type", () => {
        const { docs, pos } = at("u.ta")
        assert.ok(labels(completion(docs, URI, pos)).includes("tags"))
        const s = at("u.name.")
        const names = labels(completion(s.docs, URI, s.pos))
        assert.ok(names.includes("trim") && names.includes("split") && !names.includes("is_space"), "string methods, not private prelude helpers")
    })
    test("statics and variants of a type; a package's pub items", () => {
        const t = at("User.")
        assert.deepEqual(labels(completion(t.docs, URI, t.pos)), ["guest"])
        const v = at("Shape.")
        assert.deepEqual(labels(completion(v.docs, URI, v.pos)), ["Circle", "Square"])
        const p = at("json.")
        assert.ok(["parse", "stringify", "Value", "Error"].every((x) => labels(completion(p.docs, URI, p.pos)).includes(x)))
    })
    test("bounded impl methods appear only when the items meet the bounds", () => {
        const ints = at("let xs = [1, 2]\n    xs.")
        assert.ok(labels(completion(ints.docs, URI, ints.pos)).includes("sum"))
        const flags = at("let fs = [true]\n    fs.")
        assert.ok(!labels(completion(flags.docs, URI, flags.pos)).includes("sum"), "bool isn't Plus")
        assert.ok(labels(completion(flags.docs, URI, flags.pos)).includes("join"), "bool is Stringer")
    })
    test("names in scope: locals declared before the cursor (with types), items, imports, prelude, keywords", () => {
        const { docs, pos } = at("to")
        const items = completion(docs, URI, pos)
        const local = (name: string) => items.find((c) => c.label === name)
        assert.equal(local("total")?.detail, "let total: int")
        assert.equal(local("names")?.detail, "let names: Vec[string]")
        assert.equal(local("n"), undefined, "the loop variable is out of scope after the loop")
        assert.ok(local("add") && local("User") && local("json") && local("Some") && local("for") && local("Vec"))
        assert.equal(local("while"), undefined, "reserved keywords aren't offered")
    })
    test("import paths: roots, then std folders", () => {
        const text = "package main\n\nimport \"std.n"
        const items = labels(completion([{ uri: URI, text }], URI, { line: 2, character: 13 }))
        assert.ok(items.includes("net") && items.includes("json"))
        const roots = labels(completion([{ uri: URI, text: "package main\n\nimport \"" }], URI, { line: 2, character: 8 }))
        assert.deepEqual(roots, ["std"])
    })
})

describe("signature help", () => {
    test("the parameters, the active one, and the doc comment", () => {
        const first = at("add(|")
        const h = signatureHelp(first.docs, URI, first.pos)!
        assert.equal(h.signatures[0]!.label, "fun add(a: int, b: int) -> int")
        assert.equal(h.activeParameter, 0)
        assert.match((h.signatures[0]!.documentation as { value: string }).value, /Adds two numbers/)
        const second = at("add(1, |")
        assert.equal(signatureHelp(second.docs, URI, second.pos)!.activeParameter, 1)
        const nested = at("add(add(1, 2), |")
        assert.equal(signatureHelp(nested.docs, URI, nested.pos)!.activeParameter, 1, "commas inside a nested call don't count")
    })
    test("methods (without the receiver)", () => {
        const m = at("u.adult(|")
        assert.equal(signatureHelp(m.docs, URI, m.pos)!.signatures[0]!.label, "fun adult() -> bool")
    })
    test("nothing outside a call", () => {
        const { docs, pos } = at("let z = 1")
        assert.equal(signatureHelp(docs, URI, pos), null)
    })
})

describe("inlay hints", () => {
    test("inferred types of lets, closure parameters and loop bindings; not where the value says it", () => {
        const { text } = at("")
        const an = analyze([{ uri: URI, text }], URI)
        const hints = inlayHints(an, URI, { start: { line: 0, character: 0 }, end: { line: 100, character: 0 } })
        const lines = text.split("\n")
        const shown = hints.map((h) => `${lines[h.position.line]!.slice(0, h.position.character).trim().split(/\s+/).pop()}${h.label}`)
        assert.deepEqual(shown, ["total: int", "names: Vec[string]", "x: &User", "n: string", "i: int"])
    })
})

describe("rename", () => {
    const { text } = at("log.println(u.name)")
    const an = analyze([{ uri: URI, text }], URI)
    const pos = (needle: string, nth = 0) => {
        let i = -1
        for (let k = 0; k <= nth; k++) i = text.indexOf(needle, i + 1)
        const b = text.slice(0, i)
        return { line: b.split("\n").length - 1, character: i - b.lastIndexOf("\n") - 1 }
    }
    test("a local: its declaration and every use", () => {
        const edit = rename(an, URI, pos("u = User"), "user")!
        const edits = edit.changes![URI]!
        assert.equal(edits.length, 3)
        assert.ok(edits.every((e) => e.newText === "user"))
    })
    test("a function, from a use", () => {
        const edits = rename(an, URI, pos("add(1"), "plus")!.changes![URI]!
        assert.equal(edits.length, 2)
    })
    test("prepare: refuses std names, `it`, and invalid new names", () => {
        assert.equal(prepareRename(an, URI, pos("log.")), null)
        assert.equal(prepareRename(an, URI, pos("println")), null)
        assert.equal(prepareRename(an, URI, pos("total"))?.placeholder, "total")
        assert.throws(() => rename(an, URI, pos("total"), "for"), /isn't a valid name/)
        assert.throws(() => rename(an, URI, pos("total"), "2x"), /isn't a valid name/)
    })
    test("a local used through the record shorthand keeps the field name", () => {
        const src = "package main\n\ntype P = { name: string }\n\nfun main() {\n    let name = \"a\"\n    let p = P { name }\n    log.println(p.name)\n}\n"
        const a2 = analyze([{ uri: URI, text: src }], URI)
        const edits = rename(a2, URI, { line: 5, character: 8 }, "label")!.changes![URI]!
        assert.deepEqual(edits.map((e) => e.newText).sort(), ["label", "name: label"])
    })
})
