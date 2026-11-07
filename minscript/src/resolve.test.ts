import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { describe, test } from "node:test"
import type * as A from "./ast.ts"
import { parse } from "./parser.ts"
import { resolvePackage, type Resolution, type Sym } from "./resolve.ts"

function resolve(...sources: string[]): Resolution {
    const files = sources.map((src) => {
        const res = parse(src)
        assert.deepEqual(res.diagnostics.map((d) => `${d.code}@${d.span.line}: ${d.message}`), [], "must parse cleanly")
        return res.file
    })
    return resolvePackage(files)
}

function codes(...sources: string[]): string[] {
    return resolve(...sources).diagnostics.map((d) => `${d.code}@${d.span.line}`)
}

/** The symbol each Ident named `name` resolves to, in source order. */
function refsTo(res: Resolution, name: string): Sym[] {
    return [...res.refs].filter(([n]) => n.kind === "Ident" && n.name === name).sort(([a], [b]) => a.span.start - b.span.start).map(([, s]) => s)
}

describe("packages with several files", () => {
    test("items are shared across files; imports are per file", () => {
        const a = `package p\nimport "std.json"\nfun main() { helper(json.stringify(1)) }`
        const b = `package p\nfun helper(s: string) { log.println(s) }`
        assert.deepEqual(codes(a, b), [])
        const c = `package p\nfun other() { json.parse("") }`      // `json` is imported only in the first file
        assert.deepEqual(codes(a, b, c), ["E_UNDECLARED_NAME@2"])
    })

    test("duplicate items across files", () => {
        assert.deepEqual(codes("package p\nfun f() {}", "package p\ntype f = int"), ["E_DUPLICATE_DECLARATION@2"])
    })

    test("an import can't take the name of an item", () => {
        assert.deepEqual(codes(`package p\nimport "std.time"\nfun time() {}`), ["E_DUPLICATE_DECLARATION@2"])
        assert.deepEqual(codes(`package p\nimport "std.time" as clock\nfun time() {}`), [])
    })

    test("import forms", () => {
        const res = resolve(`package p\nimport "std.io.{print, println}"\nimport "std.io"\nimport "app.models" as m\nimport "./helpers"\nfun f() { print(1); println(2); io.flush(); m.User; helpers.x() }`)
        assert.deepEqual(res.diagnostics, [])
        assert.equal(refsTo(res, "print")[0]!.kind, "import")
        assert.equal(refsTo(res, "io")[0]!.kind, "package")
        assert.equal(refsTo(res, "m")[0]!.detail, "app.models")
        assert.equal(refsTo(res, "helpers")[0]!.kind, "package")
    })

    test("local items shadow the prelude", () => {
        const res = resolve("package p\ntype Box[T] = { v: T }\nfun f(b: Box[int]) -> Box[int] { b }")
        assert.deepEqual(res.diagnostics, [])
        const boxes = [...res.refs].filter(([n]) => n.kind === "TName" && n.path[0] === "Box").map(([, s]) => s.kind)
        assert.deepEqual(boxes, ["type", "type"])
    })
})

describe("scopes", () => {
    test("redeclaration is allowed in an inner scope only", () => {
        assert.deepEqual(codes("package p\nfun f() {\n let x = 1\n { let x = 2 }\n}"), [])
        assert.deepEqual(codes("package p\nfun f() {\n let x = 1\n let x = 2\n}"), ["E_DUPLICATE_BINDING@4"])
    })

    test("parameters and the body's top level share a scope; closures too", () => {
        assert.deepEqual(codes("package p\nfun f(x: int) {\n let x = 1\n}"), ["E_DUPLICATE_BINDING@3"])
        assert.deepEqual(codes("package p\nfun f() {\n g := #{ a => \n  let a = 1\n  a }\n}"), ["E_DUPLICATE_BINDING@4"])
        assert.deepEqual(codes("package p\nfun f(x: int) {\n if true { let x = 1 }\n}"), [])
    })

    test("a let's value sees the outer binding", () => {
        const res = resolve("package p\nfun f() {\n let a = 1\n { let a = a + 1\n a }\n}")
        const [outer, inner] = [...res.decls].filter(([n]) => n.kind === "PBind").map(([, s]) => s)
        assert.deepEqual(refsTo(res, "a"), [outer, inner])
    })

    test("`let … else` bindings are not visible in the else block", () => {
        assert.deepEqual(codes("package p\nfun f(o: int?) {\n let Some(v) = o else { log.println(v); return }\n}"), ["E_UNDECLARED_NAME@3"])
    })

    test("if-let and match bindings stay in their branch", () => {
        assert.deepEqual(codes("package p\nfun f(o: int?) {\n if let Some(v) = o { } else { log.println(v) }\n}"), ["E_UNDECLARED_NAME@3"])
        assert.deepEqual(codes("package p\nfun f(o: int?) {\n match o { Some(v) => 1, None => v }\n}"), ["E_UNDECLARED_NAME@3"])
    })
})

describe("implicit parameters", () => {
    test("`it` and `it1` are the same symbol", () => {
        const res = resolve("package p\nfun f() { g := #{ it + it1 + it2 } }")
        const it = refsTo(res, "it")[0]!
        assert.equal(refsTo(res, "it1")[0], it)
        assert.notEqual(refsTo(res, "it2")[0], it)
    })

    test("the innermost provider wins: header-less closure or unnamed `or`", () => {
        const res = resolve("package p\nfun h(x: int) {}\nfun f() {\n g := #{ h(it) or Err(it) }\n}")
        const [closureIt, orIt] = refsTo(res, "it")
        assert.notEqual(closureIt, orIt)
        assert.deepEqual(res.diagnostics, [])
    })

    test("a named `or` doesn't provide `it`", () => {
        assert.deepEqual(codes("package p\nfun g() {}\nfun f() {\n x := g() or e => it\n}"), ["E_IT_OUTSIDE_CLOSURE@4"])
    })
})

describe("captures", () => {
    const closures = (res: Resolution) =>
        [...res.captures].sort(([a], [b]) => a.span.start - b.span.start).map(([, syms]) => syms.map((s) => s.name))

    test("implicit, explicit, and through nested closures", () => {
        const res = resolve("package p\nfun f(n: int) {\n var total = 0\n k := 2\n a := #[&mut total]{ total += it * k }\n b := #{ x => #{ y => x + y + n } }\n c := #{ it }\n}")
        assert.deepEqual(closures(res), [["total", "k"], ["n"], ["x", "n"], []])
    })

    test("`this` is captured by closures in methods", () => {
        const res = resolve("package p\ntype T = {\n v: int\n fun f(&this) -> int { g := #{ this.v }\n g() }\n}")
        assert.deepEqual(closures(res), [["this"]])
    })

    test("globals and functions are not captures", () => {
        const res = resolve("package p\nlet G = 1\nfun h() {}\nfun f() { g := #{ h(); G } }")
        assert.deepEqual(closures(res), [[]])
    })
})

describe("deferred names", () => {
    test("bare uppercase names and member names are left for the type checker", () => {
        const res = resolve("package p\nfun f(m: int) {\n send(Text(\"x\"))\n match m { Cash => 1, _ => 2 }\n m.anything\n}\nfun send(x: int) {}")
        assert.deepEqual(res.diagnostics, [])
        const names = res.deferred.map((n) => (n.kind === "Ident" ? n.name : n.kind === "PPath" ? n.path.join(".") : n.kind))
        assert.deepEqual(names, ["Text", "Cash"])
    })

    test("a glob import defers unknown names in that file only", () => {
        const a = `package p\nimport "std.collections.*"\nfun f() { deque_new() }`
        const b = `package p\nfun g() { deque_new() }`
        assert.deepEqual(codes(a, b), ["E_UNDECLARED_NAME@2"])
    })
})

describe("robustness", () => {
    test("every prefix of every program resolves without throwing", () => {
        const dir = new URL("../test/programs/", import.meta.url)
        for (const name of readdirSync(dir).filter((f) => f.endsWith(".ms"))) {
            const src = readFileSync(new URL(name, dir), "utf8")
            const step = Math.max(1, Math.floor(src.length / 60))
            for (let i = 0; i <= src.length; i += step) {
                const file: A.File = parse(src.slice(0, i)).file
                resolvePackage([file])
            }
        }
    })
})
