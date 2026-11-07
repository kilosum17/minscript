import assert from "node:assert/strict"
import { describe, test } from "node:test"
import "./prelude.ts"
import { checkPackage, type CheckResult } from "./check.ts"
import { parse } from "./parser.ts"
import { resolvePackage, type Resolution } from "./resolve.ts"
import { show, widens } from "./types.ts"

function run(src: string): { res: Resolution, checked: CheckResult } {
    const parsed = parse(`package p\n${src}`)
    assert.deepEqual(parsed.diagnostics.map((d) => `${d.code}@${d.span.line - 1}: ${d.message}`), [], "must parse cleanly")
    const res = resolvePackage([parsed.file])
    assert.deepEqual(res.diagnostics.map((d) => `${d.code}@${d.span.line - 1}: ${d.message}`), [], "must resolve cleanly")
    return { res, checked: checkPackage([parsed.file], res) }
}

/** Checker diagnostics as `CODE@line` (lines counted from the first line of `src`). */
function codes(src: string): string[] {
    return run(src).checked.diagnostics.map((d) => `${d.code}@${d.span.line - 1}`)
}

/** The inferred type of the binding `name` (the first one declared with that name). */
function typeOf(src: string, name: string): string {
    const { res, checked } = run(src)
    assert.deepEqual(checked.diagnostics.map((d) => `${d.code}@${d.span.line - 1}: ${d.message}`), [])
    const sym = res.symbols.find((s) => s.name === name && (s.kind === "local" || s.kind === "param"))
    assert.ok(sym, `no binding ${name}`)
    return show(checked.symbols.get(sym) ?? { k: "unknown" })
}

describe("numbers (spec §9.5)", () => {
    test("lossless widening", () => {
        assert.ok(widens("i8", "i64"))
        assert.ok(widens("u8", "u32"))
        assert.ok(widens("u16", "i32"))
        assert.ok(widens("i32", "f64"))
        assert.ok(widens("int", "i64"))
        assert.ok(!widens("i64", "i32"))
        assert.ok(!widens("u32", "i32"))
        assert.ok(!widens("i32", "u64"))
        assert.ok(!widens("f64", "f32"))
        assert.ok(!widens("i64", "int"))
    })

    test("literals default to int / f64 and adopt the expected type", () => {
        assert.equal(typeOf("fun f() { let x = 1 }", "x"), "int")
        assert.equal(typeOf("fun f() { let x = 1.5 }", "x"), "f64")
        assert.equal(typeOf("fun f() { let x: u16 = 1 }", "x"), "u16")
        assert.equal(typeOf("fun f() { let x: f32 = 2 }", "x"), "f32")
        assert.equal(typeOf("fun f(a: i64) { let x = a + 1 }", "x"), "i64")
    })

    test("mixed widths widen, otherwise `as` is needed", () => {
        assert.equal(typeOf("fun f(a: i32, b: i64) { let x = a + b }", "x"), "i64")
        assert.deepEqual(codes("fun f(a: i64, b: u64) { let x = a + b }"), ["E_TYPE_MISMATCH@1"])
        assert.deepEqual(codes("fun f(a: i64, b: u64) { let x = a + b as i64 }"), [])
    })

    test("out-of-range literals", () => {
        assert.deepEqual(codes("fun f() { let x: i8 = -128 }"), [])
        assert.deepEqual(codes("fun f() { let x: i8 = -129 }"), ["E_INT_OUT_OF_RANGE@1"])
        assert.deepEqual(codes("fun f() { let x: u8 = -1 }"), ["E_INT_OUT_OF_RANGE@1"])
    })
})

describe("gradual typing: std packages without signatures", () => {
    test("members, calls and arguments of unknown packages are never reported", () => {
        assert.deepEqual(codes(`import "std.json"\nfun f(s: string) {\n v := json.parse(s, #{ x => x.whatever }, Text("x"), _{ a: 1 }, [])\n w := v.deep.chain()\n}`), [])
    })

    test("unknown flows into inference variables instead of failing them", () => {
        assert.equal(typeOf(`import "std.json"\nfun f() { var v = []\n v.push(json.x()) }`, "v"), "Vec[unknown]")
    })
})

describe("inference", () => {
    test("generic functions and explicit `.[T]`", () => {
        assert.equal(typeOf("fun id[T](v: T) -> T { v }\nfun f() { let x = id(\"s\") }", "x"), "string")
        assert.equal(typeOf("fun id[T](v: T) -> T { v }\nfun f() { let x = id.[u8](1) }", "x"), "u8")
        assert.deepEqual(codes("fun id[T](v: T) -> T { v }\nfun f() { let x = id.[u8, u8](1) }"), ["E_ARG_COUNT@2"])
    })

    test("empty collections are inferred from later use", () => {
        assert.equal(typeOf("fun f() { var v = []\n v.push(\"a\") }", "v"), "Vec[string]")
        assert.deepEqual(codes("fun f() { let v = m{} }"), ["E_CANNOT_INFER_TYPE@1"])
    })

    test("closures take their parameter types from the callee", () => {
        assert.equal(typeOf("fun f(v: Vec[string]) { let x = v.map(#{ it.len() }) }", "x"), "Vec[int]")
        assert.equal(typeOf("fun f(v: Vec[int]) { let x = v.fold(\"\", #{ acc, n => acc + \"${n}\" }) }", "x"), "string")
    })

    test("trailing void arguments may be left out", () => {
        assert.deepEqual(codes("fun f() -> Result[void, string] { Ok() }"), [])
        assert.deepEqual(codes("async fun f() { let t(p, r) = Promise.new.[void]()\n r.resolve()\n await p }"), [])
        assert.deepEqual(codes("fun f() -> Result[int, string] { Ok() }"), ["E_ARG_COUNT@1"])
    })

    test("Self in a method found through a generic bound is the type parameter", () => {
        assert.deepEqual(codes("fun f[T: Clone](v: Vec[T], d: T) -> T { v.get(0)?.clone() ?? d }"), [])
    })
})

describe("conversions (spec §7.4)", () => {
    const decls = "type P = { x: int, y: int, label: string = \"\", note: string? }\n"
    test("record → struct: missing fields need a default or `T?`; no extra fields", () => {
        assert.deepEqual(codes(`${decls}fun f() { let p: P = r{ x: 1, y: 2 } }`), [])
        assert.deepEqual(codes(`${decls}fun f() { let p: P = r{ x: 1 } }`), ["E_TYPE_MISMATCH@2"])
        assert.deepEqual(codes(`${decls}fun f() { let p: P = r{ x: 1, y: 2, z: 3 } }`), ["E_TYPE_MISMATCH@2"])
    })

    test("a struct is never implicitly another struct of the same shape", () => {
        assert.deepEqual(codes("type A = { v: int }\ntype B = { v: int }\nfun f(a: A) { let b: B = a }"), ["E_TYPE_MISMATCH@3"])
        assert.deepEqual(codes("type A = { v: int }\ntype B = { v: int }\nfun f(a: A) { let b: B = _{ ...a } }"), ["E_TYPE_MISMATCH@3"])
    })

    test("&str and string convert both ways (spec §7.2)", () => {
        assert.deepEqual(codes("fun take(s: string) {}\nfun f(v: &str) { take(v) }"), [])
    })
})

describe("interfaces", () => {
    const decls = "inter Shape = { fun area(&this) -> f64 }\ntype Sq = { s: f64 }\nimpl Shape for Sq { fun area(&this) -> f64 { this.s * this.s } }\ntype Other = { v: int }\n"
    test("a value of an implementing type is accepted as the interface (dynamic dispatch)", () => {
        assert.deepEqual(codes(`${decls}fun total(xs: Vec[Shape]) -> f64 { 0.0 }\nfun f() { let s: Shape = Sq { s: 1.0 }\n let all: Vec[Shape] = [Sq { s: 2.0 }] }`), [])
        assert.deepEqual(codes(`${decls}fun f() { let s: Shape = Other { v: 1 } }`), ["E_TYPE_MISMATCH@5"])
    })

    test("methods are found on interface values and through bounds", () => {
        assert.equal(typeOf(`${decls}fun f(s: &Shape) { let a = s.area() }`, "a"), "f64")
        assert.equal(typeOf(`${decls}fun f[T: Shape](s: T) { let a = s.area() }`, "a"), "f64")
    })

    test("auto-generated interfaces are implemented by every type (spec §9.7)", () => {
        assert.deepEqual(codes("type P = { v: int }\nfun show(x: &Stringer) {}\nfun f(p: P) { show(p)\n let s = p.to_str()\n let c = p.clone() }"), [])
    })
})

describe("control flow", () => {
    test("main may await without `async`", () => {
        assert.deepEqual(codes("async fun g() -> int { 1 }\nfun main() { let x = await g() }"), [])
    })

    test("a refutable payload doesn't make a variant exhaustive", () => {
        assert.deepEqual(codes("fun f(o: int?) -> int { match o { Some(1) => 1, None => 0 } }"), ["E_NON_EXHAUSTIVE_MATCH@1"])
        assert.deepEqual(codes("fun f(o: int?) -> int { match o { Some(1) => 1, Some(_) => 2, None => 0 } }"), [])
    })

    test("a match without subject needs `_`", () => {
        assert.deepEqual(codes("fun f(a: int) -> int { match { a > 1 => 1, a < 0 => 2 } }"), ["E_NON_EXHAUSTIVE_MATCH@1"])
    })

    test("`it` after `or` is the error of a Result", () => {
        assert.equal(typeOf("fun g() -> Result[int, string] { Ok(1) }\nfun f() -> Result[int, string] { let v = g() or Err(it)\n Ok(v) }", "v"), "int")
        assert.deepEqual(codes("fun g() -> Result[int, string] { Ok(1) }\nfun f() -> Result[int, int] { let v = g() or Err(it)\n Ok(v) }"), ["E_TYPE_MISMATCH@2"])
    })

    test("break values give `for { }` its type", () => {
        assert.equal(typeOf("fun f(n: int) { let x = for { if n > 1 { break \"done\" } } }", "x"), "string")
    })
})
