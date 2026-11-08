import assert from "node:assert/strict"
import { describe, test } from "node:test"
import "./prelude.ts"
import { checkPackage } from "./check.ts"
import { checkOwnership } from "./ownership.ts"
import { parse } from "./parser.ts"
import { resolvePackage } from "./resolve.ts"

const DECLS = `
type User = { name: string }
fun take(u: User) {}
fun look(u: &User) {}
fun take_vec(v: Vec[int]) {}
fun grow(v: &mut Vec[int]) {}
`

/** Ownership diagnostics as `CODE@line`, lines counted from the first line of `body`. */
function codes(body: string): string[] {
    const src = `package p\n${DECLS}\n${body}`
    const offset = 2 + DECLS.split("\n").length - 1
    const parsed = parse(src)
    assert.deepEqual(parsed.diagnostics.map((d) => `${d.code}: ${d.message}`), [], "must parse cleanly")
    const res = resolvePackage([parsed.file])
    assert.deepEqual(res.diagnostics.map((d) => `${d.code}: ${d.message}`), [], "must resolve cleanly")
    const checked = checkPackage([parsed.file], res)
    assert.deepEqual(checked.diagnostics.map((d) => `${d.code}@${d.span.line - offset}: ${d.message}`), [], "must type-check cleanly")
    return checkOwnership([parsed.file], res, checked).diagnostics.map((d) => `${d.code}@${d.span.line - offset}`)
}

describe("moves", () => {
    test("a move on one branch: maybe moved afterwards; on both: moved", () => {
        assert.deepEqual(codes("fun f(c: bool) {\n let u = User { name: \"a\" }\n if c { take(u) }\n look(u)\n}"), ["E_USE_AFTER_MOVE@4"])
        assert.deepEqual(codes("fun f(c: bool) {\n let u = User { name: \"a\" }\n if c { take(u) } else { take(u) }\n}"), [])
    })

    test("a branch that returns doesn't count", () => {
        assert.deepEqual(codes("fun f(c: bool) {\n let u = User { name: \"a\" }\n if c { take(u)\n return }\n look(u)\n}"), [])
    })

    test("match arms are separate paths", () => {
        assert.deepEqual(codes("fun f(n: int) {\n let v = [1]\n match n { 0 => take_vec(v), _ => take_vec(v) }\n}"), [])
        assert.deepEqual(codes("fun f(n: int) {\n let v = [1]\n match n { 0 => take_vec(v), _ => {} }\n take_vec(v)\n}"), ["E_USE_AFTER_MOVE@4"])
    })

    test("loops: a move in one iteration is a use in the next, unless the loop exits", () => {
        assert.deepEqual(codes("fun f() {\n let v = [1]\n for {\n  take_vec(v)\n }\n}"), ["E_USE_AFTER_MOVE@4"])
        assert.deepEqual(codes("fun f() {\n let v = [1]\n for {\n  take_vec(v)\n  break\n }\n}"), [])
    })

    test("assignment re-initializes", () => {
        assert.deepEqual(codes("fun f() {\n var v = [1]\n take_vec(v)\n v = [2]\n take_vec(v)\n}"), [])
    })

    test("`??`, `&&` and `||` evaluate their right side conditionally", () => {
        assert.deepEqual(codes("fun f(o: Vec[int]?) {\n let v = [1]\n let w = o ?? v\n take_vec(v)\n}"), ["E_USE_AFTER_MOVE@4"])
    })

    test("Copy values, strings and handles never move", () => {
        assert.deepEqual(codes("fun f() {\n let n = 1\n let a = n\n let b = n\n let s = \"x\"\n let c = s\n let d = s\n let r = Ref(0)\n let e = r\n let g = r\n}"), [])
    })

    test("types declared Copy don't move", () => {
        assert.deepEqual(codes("type P: Copy = { x: int }\nfun use_p(p: P) {}\nfun f() {\n let p = P { x: 1 }\n use_p(p)\n use_p(p)\n}"), [])
    })

    test("consuming methods (`this`) move the receiver", () => {
        assert.deepEqual(codes("type S = { v: Vec[int]\n fun done(this) {}\n}\nfun f() {\n let s = S { v: [] }\n s.done()\n s.done()\n}"), ["E_USE_AFTER_MOVE@7"])
    })
})

describe("mutability", () => {
    test("let / := can't be assigned; var / :== / mut can", () => {
        assert.deepEqual(codes("fun f(mut a: int) {\n let b = 1\n c := 2\n var d = 3\n e :== 4\n a = 1\n b = 1\n c = 1\n d = 1\n e = 1\n}"), ["E_ASSIGN_IMMUTABLE@7", "E_ASSIGN_IMMUTABLE@8"])
    })

    test("writing through `&mut` is fine; through `&` is not", () => {
        assert.deepEqual(codes("type P = { x: int }\nfun a(p: &mut P) { p.x = 1 }\nfun b(p: &P) { p.x = 1 }"), ["E_ASSIGN_IMMUTABLE@3"])
    })

    test("`&mut` arguments and receivers need a mutable binding; temporaries are fine", () => {
        assert.deepEqual(codes("fun f() {\n var a = [1]\n let b = [2]\n grow(a)\n grow(b)\n [3].push(4)\n}"), ["E_MUT_BORROW_IMMUTABLE@5"])
    })

    test("receivers: `&this` can't change fields, `&mut this` / `mut this` can", () => {
        assert.deepEqual(codes("type C = {\n n: int\n fun a(&this) { this.n = 1 }\n fun b(&mut this) { this.n = 1 }\n fun c(mut this) { this.n = 1 }\n}"), ["E_ASSIGN_IMMUTABLE@3"])
    })
})

describe("closures (spec §9.4)", () => {
    test("implicit captures are read-only; `#[&mut x]` needs a var", () => {
        assert.deepEqual(codes("fun f(xs: Vec[int]) {\n var t = 0\n xs.for_each(#{ t += it })\n xs.for_each(#[&mut t]{ t += it })\n}"), ["E_ASSIGN_IMMUTABLE@3"])
    })

    test("a by-value capture moves; the closure may then return it", () => {
        assert.deepEqual(codes("fun f() -> () -> int {\n let v = [1]\n let g = #[v]{ v.len() }\n take_vec(v)\n g\n}"), ["E_USE_AFTER_MOVE@4"])
    })

    test("closures holding borrows can't escape", () => {
        assert.deepEqual(codes("type H = { f: (int) -> int }\nfun f(n: int) -> H {\n H { f: #{ it + n } }\n}"), ["E_CLOSURE_ESCAPES_BORROW@3"])
        assert.deepEqual(codes("type H = { f: (int) -> int }\nfun f(n: int) -> H {\n H { f: #[n]{ it + n } }\n}"), [])
    })
})

describe("scoped values (spec §9.3)", () => {
    test("an owner can't change while a borrow of it is used later", () => {
        assert.deepEqual(codes("fun f() {\n var s = \" a \"\n let t = s.trim()\n s = \"b\"\n log.println(t)\n}"), ["E_BORROW_CONFLICT@4"])
        assert.deepEqual(codes("fun f() {\n var s = \" a \"\n let t = s.trim()\n log.println(t)\n s = \"b\"\n}"), [])
    })

    test("a borrow used in a loop stays live for the whole loop", () => {
        assert.deepEqual(codes("fun f(n: int) {\n var s = \" a \"\n let t = s.trim()\n for i in 0..n {\n  log.println(t)\n  s = \"b\"\n }\n}"), ["E_BORROW_CONFLICT@6"])
    })

    test("a mutable borrow excludes every other use", () => {
        assert.deepEqual(codes("fun f(xs: Vec[int]) {\n var t = 0\n let add = #[&mut t]{ t += it }\n log.println(t)\n xs.for_each(add)\n}"), ["E_BORROW_CONFLICT@4"])
    })

    test("returned borrows come from borrowed parameters or the receiver", () => {
        assert.deepEqual(codes("fun a(s: &str) -> &str { s.trim() }\nfun b(v: &Vec[string]) -> &str { v[0].trim() }"), [])
        assert.deepEqual(codes("type W = {\n s: string\n fun get(&this) -> &str { this.s.trim() }\n}"), [])
    })
})

describe("async (spec §9.6)", () => {
    const ASYNC = "async fun up(d: &Vec[int]) -> int { 0 }\nasync fun own(d: Vec[int]) -> int { 0 }\n"
    test("borrowing calls must be awaited at once; owned arguments and handles are fine", () => {
        assert.deepEqual(codes(`${ASYNC}async fun f() {\n let d = [1]\n let p = up(d)\n let q = own(d)\n}`), ["E_BORROW_ACROSS_SPAWN@5"])
        assert.deepEqual(codes(`${ASYNC}async fun f() {\n let d = [1]\n let a = await up(d)\n}`), [])
        assert.deepEqual(codes("async fun f(jobs: Queue[int]) {\n let p = jobs.publish(1)\n await p\n}"), [])
    })
})
