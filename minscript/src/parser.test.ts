import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type * as A from "./ast.ts"
import { parse } from "./parser.ts"
import { printFile, printStmtFlat } from "./sexpr.ts"

// ---- helpers ----------------------------------------------------------------------------------

/** Statements of `fun main() { <body> }` as one-line S-expressions; the source must parse cleanly. */
function body(src: string): string[] {
    const res = parse(`package p\nfun main() {\n${src}\n}\n`)
    assert.deepEqual(res.diagnostics.map((d) => `${d.code}@${d.span.line - 2}: ${d.message}`), [], `diagnostics for ${JSON.stringify(src)}`)
    const fn = res.file.items[0] as A.FunDecl
    return fn.body!.stmts.map(printStmtFlat)
}

/** One expression. */
function ex(src: string): string {
    const stmts = body(src)
    assert.equal(stmts.length, 1, `expected one statement in ${JSON.stringify(src)}, got ${JSON.stringify(stmts)}`)
    return stmts[0]!
}

/** Diagnostics (code@line, lines counted from the first line of `src`) for a whole file. */
function diags(src: string): string[] {
    return parse(src).diagnostics.map((d) => `${d.code}@${d.span.line}`)
}

/** Diagnostic codes for statements inside a function. */
function bodyDiags(src: string): string[] {
    return parse(`package p\nfun main() {\n${src}\n}\n`).diagnostics.map((d) => d.code)
}

// ---- tests ------------------------------------------------------------------------------------

describe("precedence (spec §3)", () => {
    const cases: [string, string][] = [
        ["1 + 2 * 3", "(+ 1 (* 2 3))"],
        ["10 - 4 - 3", "(- (- 10 4) 3)"],
        ["-x * y", "(* (- x) y)"],
        ["-x.abs()", "(- (call (. x abs)))"],
        ["!a && b || c", "(|| (&& (! a) b) c)"],
        ["a & b == c", "(== (& a b) c)"],
        ["a | b ^ c & d", "(| a (^ b (& c d)))"],
        ["x << 2 + 1", "(<< x (+ 2 1))"],
        ["n as i64 * 2", "(* (as n i64) 2)"],
        ["-n as u8", "(as (- n) u8)"],
        ["v as i32?", "(as v (Option i32))"],
        ["big as i32 as f64", "(as (as big i32) f64)"],
        ["flags as u8 & MASK", "(& (as flags u8) MASK)"],
        ["0..n + 1", "(.. 0 (+ n 1))"],
        ["..10", "(.. _ 10)"],
        ["a ?? b ?? c", "(?? a (?? b c))"],
        ["x ?? y + 1", "(?? x (+ y 1))"],
        ["a ?? b or return", "(or (?? a b) (return))"],
        ["f() or e => g(e)", "(or (call f) e => (call g e))"],
        ["await f()?", "(? (await (call f)))"],
        ["await g()?.name", "(?. (await (call g)) name)"],
        ["!await check()", "(! (await (call check)))"],
        ["x.y.z(1)[2].w", "(. (index (call (. (. x y) z) 1) 2) w)"],
        ["(user?).name", "(. (paren (? user)) name)"],
        ["z = a + b * c", "(= z (+ a (* b c)))"],
        ["a = b = c", "(= a (= b c))"],
        ["z += x ?? 1", "(+= z (?? x 1))"],
        ["t.0.1", "(. (. t 0) 1)"],
        ["&this.value", "(& (. this value))"],
    ]
    for (const [src, want] of cases) test(src, () => assert.equal(ex(src), want))
})

describe("operator errors", () => {
    test("comparisons and ranges don't chain", () => {
        assert.deepEqual(bodyDiags("x := a < b < c"), ["E_NON_ASSOCIATIVE_OPERATOR"])
        assert.deepEqual(bodyDiags("x := a == b == c"), ["E_NON_ASSOCIATIVE_OPERATOR"])
        assert.deepEqual(bodyDiags("x := 1..2..3"), ["E_NON_ASSOCIATIVE_OPERATOR"])
        assert.deepEqual(bodyDiags("x := (a < b) == c"), [])
    })
    test("?? doesn't mix with && / || without parentheses", () => {
        assert.deepEqual(bodyDiags("x := a ?? b || c"), ["E_MIXED_NULLISH"])
        assert.deepEqual(bodyDiags("x := a && b ?? c"), ["E_MIXED_NULLISH"])
        assert.deepEqual(bodyDiags("x := (a || b) ?? c"), [])
    })
    test("assignment targets", () => {
        assert.deepEqual(bodyDiags("1 = x"), ["E_INVALID_ASSIGNMENT_TARGET"])
        assert.deepEqual(bodyDiags("f() = x"), ["E_INVALID_ASSIGNMENT_TARGET"])
        assert.deepEqual(bodyDiags("a.b[0].c = x\n*p = 1"), [])
    })
    test("reserved operators", () => {
        assert.deepEqual(bodyDiags("i++"), ["E_RESERVED_OPERATOR"])
        assert.deepEqual(bodyDiags("--i"), ["E_RESERVED_OPERATOR"])
        assert.deepEqual(bodyDiags("x := ~m"), ["E_RESERVED_OPERATOR"])
    })
})

describe("newlines (spec §5.4)", () => {
    test("an operator at the end of a line continues", () => {
        assert.deepEqual(body("x := a +\n  b"), ["(:= x (+ a b))"])
    })
    test("continuation tokens at the start of a line", () => {
        assert.deepEqual(body("x := a\n  .b\n  ?.c\n  ?? d"), ["(:= x (?? (?. (. a b) c) d))"])
        assert.deepEqual(body("x := a\n  && b\n  || c"), ["(:= x (|| (&& a b) c))"])
        assert.deepEqual(body("x := f()\n  or g()"), ["(:= x (or (call f) (call g)))"])
        assert.deepEqual(body("x := n\n  as i64"), ["(:= x (as n i64))"])
    })
    test("( [ - ! at the start of a line begin a new statement", () => {
        assert.deepEqual(body("foo\n(bar)"), ["foo", "(paren bar)"])
        assert.deepEqual(body("foo\n[1]"), ["foo", "(vec 1)"])
        assert.deepEqual(body("a\n-b"), ["a", "(- b)"])
        assert.deepEqual(body("a\n!b"), ["a", "(! b)"])
    })
    test("other binary operators at the start of a line also end the statement", () => {
        // `/ b` then has no left operand (`* b` would be a valid deref statement)
        assert.deepEqual(bodyDiags("x := a\n  / b"), ["E_UNEXPECTED_TOKEN"])
        assert.deepEqual(bodyDiags("x := a\n  == b"), ["E_UNEXPECTED_TOKEN"])
    })
    test("newlines are ignored inside ( ) and [ ]", () => {
        assert.deepEqual(body("f(a\n  + b,\n  c)"), ["(call f (+ a b) c)"])
        assert.deepEqual(body("x := [\n  1\n  2,\n  3\n]"), ["(:= x (vec 1 2 3))"])
    })
    test("but they matter again inside a nested { }", () => {
        assert.deepEqual(body("f(#{\n  a\n  -b\n})"), ["(call f (closure a (- b)))"])
    })
    test("postfix ( and [ don't cross a newline; . and ?. do", () => {
        assert.deepEqual(body("a\n(b)"), ["a", "(paren b)"])
        assert.deepEqual(body("a\n.b()"), ["(call (. a b))"])
    })
    test("return / break without a value end at the newline", () => {
        assert.deepEqual(body("for {\n  break\n  x\n}"), ["(for (block (break) x))"])
        assert.deepEqual(body("return\n42"), ["(return)", "42"])
    })
    test("else on the next line continues an if", () => {
        assert.deepEqual(body("if a {\n  1\n}\nelse {\n  2\n}"), ["(if a (block 1) (block 2))"])
    })
    test("statements on one line need `;`", () => {
        assert.deepEqual(bodyDiags("a b"), ["E_UNEXPECTED_TOKEN"])
        assert.deepEqual(body("a; b"), ["(; a)", "b"])
    })
})

describe("bindings", () => {
    test("let / var / := / :==", () => {
        assert.deepEqual(body("let a = 1\nvar b = 2\nc := 3\nd :== 4"), ["(let a 1)", "(var b 2)", "(:= c 3)", "(:== d 4)"])
    })
    test("annotations and patterns", () => {
        assert.deepEqual(body("let e: i64 = 1"), ["(let e i64 1)"])
        assert.deepEqual(body("let t(w, h) = dims()"), ["(let (t w h) (call dims))"])
        assert.deepEqual(body("let Some(x) = f() else { return }"), ["(let (Some x) (call f) (else (block (return))))"])
    })
    test("short declarations take a plain name", () => {
        assert.deepEqual(bodyDiags("t(a, b) := p"), ["E_SHORT_DECL_TARGET"])
        assert.deepEqual(bodyDiags("u.name := p"), ["E_SHORT_DECL_TARGET"])
        assert.deepEqual(bodyDiags("let x := 5"), ["E_SHORT_DECL_TARGET"])
    })
    test("keywords as names are reported and accepted", () => {
        assert.deepEqual(bodyDiags("let match = 1"), ["E_KEYWORD_AS_IDENT"])
    })
})

describe("literals", () => {
    test("collections", () => {
        assert.deepEqual(body("x := [1, ...v]\ny := a[1, 2]\nz := t()\nw := s{ 1 }"), [
            "(:= x (vec 1 (... v)))", "(:= y (array 1 2))", "(:= z (tuple))", "(:= w (set 1))",
        ])
    })
    test("records, maps, inferred and struct literals", () => {
        assert.deepEqual(body(`x := r{ a: 1, b, ...c, "k-1": 2 }`), [`(:= x (record (a 1) (b) (... c) ("k-1" 2)))`])
        assert.deepEqual(body(`x := m{ k(): 1, "a": 2 }`), [`(:= x (map ((call k) 1) ("a" 2)))`])
        assert.deepEqual(body("x := _{ host, port: 80 }"), ["(:= x (_ (host) (port 80)))"])
        assert.deepEqual(body("x := User { id: 1, ...d }"), ["(:= x (struct User (id 1) (... d)))"])
        assert.deepEqual(body("x := models.User { id }"), ["(:= x (struct (. models User) (id)))"])
        assert.deepEqual(body("x := Box.[i32]{ value: 1 }"), ["(:= x (struct (generic Box i32) (value 1)))"])
    })
    test("a lowercase path is not a struct literal", () => {
        assert.deepEqual(body("x := y\n{ z }"), ["(:= x y)", "(block z)"])
    })
    test("string interpolation", () => {
        assert.deepEqual(body(`x := "a\${b + 1}c\${d}"`), [`(:= x (template "a" (+ b 1) "c" d ""))`])
    })
    test("bare tuples and brace literals are reported", () => {
        assert.deepEqual(bodyDiags("x := (1, 2)"), ["E_BARE_TUPLE"])
        assert.deepEqual(bodyDiags("x := ()"), ["E_BARE_TUPLE"])
        assert.deepEqual(bodyDiags(`x := { "a": 1 }`), ["E_BARE_BRACE_LITERAL"])
        assert.deepEqual(bodyDiags("x := r{ 1: 2 }"), ["E_INVALID_RECORD_KEY"])
    })
    test("keyword record keys", () => {
        assert.deepEqual(body("x := r{ type: 1 }"), ["(:= x (record (type 1)))"])
    })
})

describe("closures (spec §4.4)", () => {
    test("headers", () => {
        assert.equal(ex("#{ it * 2 }"), "(closure (* it 2))")
        assert.equal(ex("#{ a, b => a + b }"), "(closure (params a b) (+ a b))")
        assert.equal(ex("#{ x: i32 -> i32 => x }"), "(closure (params (x i32)) (-> i32) x)")
        assert.equal(ex("#{ f() or e => g(e) }"), "(closure (or (call f) e => (call g e)))")
        assert.equal(ex("#{ v: Vec[i32] => v }"), "(closure (params (v (Vec i32))) v)")
    })
    test("captures", () => {
        assert.equal(ex("#[a, &b, &mut c]{ a }"), "(closure (captures a &b &mut c) a)")
    })
    test("header errors", () => {
        assert.deepEqual(bodyDiags("f := #{\n  n => n\n}"), ["E_CLOSURE_HEADER_LINE"])
        assert.deepEqual(bodyDiags("f := #{ a => it }"), ["E_IT_IN_NAMED_CLOSURE"])
        assert.deepEqual(bodyDiags("f := #{ a => #{ it } }"), [])
        assert.deepEqual(bodyDiags("f := #[x] { x }"), ["E_CAPTURE_NOT_GLUED"])
        assert.deepEqual(bodyDiags("f := #[x.y]{ 1 }"), ["E_INVALID_CAPTURE"])
    })
    test("arrow functions are rejected but understood", () => {
        assert.deepEqual(bodyDiags("f := (a) => a"), ["E_ARROW_CLOSURE"])
        assert.deepEqual(bodyDiags("f := (a: int) -> int => a"), ["E_ARROW_CLOSURE"])
        assert.deepEqual(bodyDiags("f := xs.map(fun(x) { x })"), ["E_ARROW_CLOSURE"])
    })
})

describe("control flow", () => {
    test("struct literals are not allowed in headers", () => {
        assert.deepEqual(body("if x == P { y }"), ["(if (== x P) (block y))"])
        assert.deepEqual(body("if x == (P { a: 1 }) { }"), ["(if (== x (paren (struct P (a 1)))) (block))"])
        assert.deepEqual(bodyDiags("if x == P { a: 1 } { }"), ["E_STRUCT_LITERAL_IN_HEADER"])
    })
    test("for forms", () => {
        assert.deepEqual(body("for { }\nfor a < b { }\nfor let Some(x) = it.next() { }\nfor x, i in xs { }\nfor await m in sub { }\nfor await ready() { }"), [
            "(for (block))", "(for (< a b) (block))", "(for-let (Some x) (call (. it next)) (block))",
            "(for-in x i xs (block))", "(for-await m sub (block))", "(for (await (call ready)) (block))",
        ])
    })
    test("`break x` is a label only when an enclosing loop declares it", () => {
        assert.deepEqual(body("outer: for { break outer }"), ["(for outer: (block (break outer)))"])
        assert.deepEqual(body("x := for { break n }"), ["(:= x (for (block (break n))))"])
    })
    test("reserved loop keywords are reported and parsed as `for`", () => {
        assert.deepEqual(bodyDiags("while a { }"), ["E_RESERVED_KEYWORD"])
        assert.deepEqual(bodyDiags("loop { }"), ["E_RESERVED_KEYWORD"])
    })
    test("match", () => {
        assert.equal(ex("match n { 0 | 1 => a, x if x > 2 => b\n _ => c }"), "(match n (=> (| 0 1) a) (=> x (if (> x 2)) b) (=> _ c))")
        assert.equal(ex("match { a > 1 => 1, _ => 0 }"), "(match (=> (> a 1) 1) (=> _ 0))")
    })
    test("select", () => {
        assert.equal(ex("select { Some(j) = q.next() => run(j), time.after(10) => idle(), else => skip() }"),
            "(select (=> (Some j) = (call (. q next)) (call run j)) (=> (call (. time after) 10) (call idle)) (else (call skip)))")
        assert.deepEqual(bodyDiags("select { }"), ["E_SELECT_EMPTY"])
        assert.deepEqual(bodyDiags("select {\n else => a\n b => c\n}"), ["E_SELECT_ELSE_NOT_LAST"])
    })
    test("the `{` of a header goes on the header line", () => {
        assert.deepEqual(diags("package p\nfun main() {\n  if a\n  { }\n}"), ["E_OPEN_BRACE_NEWLINE@3"])
        assert.deepEqual(diags("package p\nfun f()\n{\n}"), ["E_OPEN_BRACE_NEWLINE@2"])
    })
})

describe("patterns", () => {
    test("forms", () => {
        assert.equal(ex("match v { -1 => a\n 'a'..='z' => b\n 10.. => c\n Card { number, .. } => d\n r{ k: 1 } => e\n t(x, ..) => f\n Shape.Line(a, b) => g\n mut x => h }"),
            "(match v (=> (- 1) a) (=> (..= 'a' 'z') b) (=> (.. 10 _) c) (=> (Card (number) ..) d) (=> (r (k 1)) e) (=> (t x ..) f) (=> (Shape.Line a b) g) (=> (mut x) h))")
    })
    test("invalid", () => {
        assert.deepEqual(bodyDiags("for await in xs { }"), ["E_INVALID_PATTERN"])
        assert.deepEqual(bodyDiags("let (a, b) = p"), ["E_BARE_TUPLE"])
    })
})

describe("generics", () => {
    test("expression position uses .[ ]", () => {
        assert.equal(ex("json.parse.[User](s)"), "(call (generic (. json parse) User) s)")
        assert.equal(ex("json.parse[User](s)"), "(call (index (. json parse) User) s)")
    })
    test("angle brackets are reported once and understood", () => {
        assert.deepEqual(bodyDiags("let v: Map<string, Vec<int>> = m{}"), ["E_ANGLE_GENERICS"])
        assert.deepEqual(bodyDiags("u := json.parse<User>(s)"), ["E_ANGLE_GENERICS"])
        assert.deepEqual(bodyDiags("u := parse::<User>(s)"), ["E_ANGLE_GENERICS"])
        assert.deepEqual(bodyDiags("c := a<b"), [])
        assert.deepEqual(diags("package p\nfun f<T>(x: T) {}\ntype B<T> = { v: T }"), ["E_ANGLE_GENERICS@2", "E_ANGLE_GENERICS@3"])
    })
    test(".[ on a new line, and empty arguments", () => {
        assert.deepEqual(bodyDiags("v := Vec.new\n  .[u8]()"), ["E_GENERIC_ARGS_NEWLINE"])
        assert.deepEqual(bodyDiags("v := Vec.new.[]()"), ["E_EXPECTED_TYPE_ARGUMENTS"])
    })
})

describe("declarations", () => {
    const one = (src: string) => printFile(parse(`package p\n${src}`).file).replace(/\s+/g, " ").trim()

    test("functions", () => {
        assert.equal(one("pub async fun f[T: A & B](&mut this, mut x: int, ...r: &S) -> T? { x }"),
            "(file p (fun f pub async (generics (T A B)) (params &mut this (mut x int) (...r (& S))) (-> (Option T)) (block x)))")
    })
    test("types, unions, interfaces and impls", () => {
        assert.equal(one(`type Role = "A" | "B"`), `(file p (type Role (| "A" "B")))`)
        assert.equal(one("type U: S = { pub id: u64  tags: Vec[string] = []  fun f(&this) {} }"),
            "(file p (type U (impls S) (fields (pub id u64) (tags (Vec string) (= (vec)))) (fun f (params &this) (block))))")
        assert.equal(one("union P = { Cash  Card { n: string }  M(int) }"), "(file p (union P (variants Cash (Card (fields (n string))) (M int))))")
        assert.equal(one("inter RW = R & W"), "(file p (inter RW (and R W)))")
        assert.equal(one("impl[T] A[T], B for C[T] { fun f() {} }"), "(file p (impl (generics T) (for (A T) B) (C T) (fun f (params) (block))))")
    })
    test("function types", () => {
        assert.equal(one("fun f(a: (i32) -> (i32) -> i32, b: &(int) -> int, c: (Vec[int])?) {}"),
            "(file p (fun f (params (a (fn (params i32) (fn (params i32) i32))) (b (& (fn (params int) int))) (c (Option (Vec int)))) (block)))")
    })
    test("declaration errors", () => {
        assert.deepEqual(diags("package p\nvar x = 1"), ["E_GLOBAL_VAR@2"])
        assert.deepEqual(diags("package p\nfoo()\nfun f() {}"), ["E_TOP_LEVEL_STATEMENT@2"])
        assert.deepEqual(diags("package p\nfun f() {}\nimport \"x\""), ["E_IMPORT_AFTER_ITEM@3"])
        assert.deepEqual(diags("package p\n@inline\nfun f() {}"), ["E_ATTRIBUTES_RESERVED@2"])
        assert.deepEqual(diags("package p\nfun f(): int { 1 }"), ["E_UNEXPECTED_TOKEN@2"])
        assert.deepEqual(diags("package p\ntype X =\n  | A\n  | B"), ["E_LEADING_PIPE_UNION@3"])
        assert.deepEqual(diags("package p\nfun f(&x: int) {}"), ["E_INVALID_PARAM@2"])
        assert.deepEqual(diags("package p\nfun f(&mut self) {}"), ["E_UNKNOWN_RECEIVER@2"])
        assert.deepEqual(diags("package p\nfun f(...a: int, b: int) {}"), ["E_VARIADIC_NOT_LAST@2"])
        assert.deepEqual(diags("package p\ntype T = { a int }"), ["E_EXPECTED_COLON@2"])
        assert.deepEqual(diags("fun f() {}"), ["E_UNEXPECTED_TOKEN@1"])
    })
})

describe("recovery", () => {
    test("one diagnostic per broken statement, and parsing continues", () => {
        const res = parse("package p\nfun f() {\n  a b\n  let = 1\n  ok()\n}\nfun g() { c d }\nfun h() {}")
        assert.deepEqual(res.diagnostics.map((d) => `${d.code}@${d.span.line}`), [
            "E_UNEXPECTED_TOKEN@3", "E_INVALID_PATTERN@4", "E_UNEXPECTED_TOKEN@7",
        ])
        assert.deepEqual(res.file.items.map((i) => (i as A.FunDecl).name), ["f", "g", "h"])
        const f = res.file.items[0] as A.FunDecl
        assert.equal(f.body!.stmts.length, 2)       // `a` and `ok()` survive
    })

    test("a broken match arm doesn't take the rest of the match with it", () => {
        const res = parse("package p\nfun f() {\n  match x {\n    1 => a b\n    2 => c\n  }\n}")
        assert.deepEqual(res.diagnostics.map((d) => d.code), ["E_UNEXPECTED_TOKEN"])
        const stmt = (res.file.items[0] as A.FunDecl).body!.stmts[0] as Extract<A.Stmt, { kind: "ExprStmt" }>
        assert.equal((stmt.expr as Extract<A.Expr, { kind: "Match" }>).arms.length, 2)
    })

    test("every prefix of a program parses without throwing", () => {
        const src = `package p\nimport "std.x"\npub type U: S = { id: u64, fun f(&this) -> int { this.id } }\nasync fun main() {\n  x := [1, 2] as Vec[int]\n  for i in 0..x.len() { if i > 1 { break } }\n  select { Some(m) = s.next() => log(m), else => {} }\n  y := match x { t(a, ..) => a, _ => #[&mut z]{ it + z }(1) }\n}\n`
        for (let i = 0; i <= src.length; i++) {
            const res = parse(src.slice(0, i))
            assert.equal(res.file.kind, "File")
        }
    })
})

describe("spans", () => {
    test("nodes span their first to last token", () => {
        const src = "package p\nfun main() {\n  x := foo(1, 2)\n}"
        const res = parse(src)
        const stmt = (res.file.items[0] as A.FunDecl).body!.stmts[0]!
        assert.equal(src.slice(stmt.span.start, stmt.span.end), "x := foo(1, 2)")
        assert.equal(stmt.span.line, 3)
        assert.equal(stmt.span.col, 3)
    })
})
