import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "../parser.ts";

function check(source: string) { const result = parse(source); assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics)); assert.deepEqual(result.lexed.errors, []); return result.ast; }
test("parses square-bracket generic types and generic calls", () => {
  const ast = check("type Box[T] = { value: T }\nfun parse[T](s: string) -> Result[T, string] { json.parse[T](s) }");
  assert.equal(ast.items.length, 2);
});
test("parses compact collection sigils and ordinary indexing", () => {
  const ast = check('fun f() { let x = r{ id: 1 }\nlet m = m{"a": 2}\nlet s = s{1, 2}\nlet t = t(1, 2)\nlet a = a[1, 2]\nlet v = v[1, 2]\nlet y = v[0]\nlet z = _{name: "x"}\nlet q = \'1{ id: 1 } }');
  assert.equal(ast.items.length, 1);
});
test("parses Pratt precedence, postfixes and optional propagation", () => {
  const ast = check("fun f(a: i32) { let x = a + 2 * 3\nlet y = await load()?\nlet z = user?.name }");
  const fn: any = ast.items[0]; const body: any = fn.body; const awaited: any = body.statements[1].value;
  assert.equal(awaited.kind, "PropagateExpr"); assert.equal(awaited.expression.kind, "AwaitExpr");
});
test("parses closures and captures", () => {
  const ast = check("fun f() { let a = #{ it * 2 }\nlet b = #{ x, y => x + y }\nlet c = (x: i32) -> i32 => x * 2\nlet d = #[state](x) => state + x }");
  assert.equal(ast.items.length, 1);
});
test("parses declarations, patterns, loops and match arms from the stress sample", async () => {
  const source = await readFile(new URL("../sample1.ms", import.meta.url), "utf8");
  const ast = check(source); assert.ok(ast.items.length >= 10);
});
test("supports shorthand declarations and let conditions", () => {
  const ast = check("fun f() { count := 1\nother :== 2\nif let Some(x) = value { x }\nwhile let Some(x) = next() { x } }");
  assert.equal(ast.items.length, 1);
});
test("reports malformed syntax", () => {
  const result = parse("fun f( { let x = ; }");
  assert.ok(result.diagnostics.length > 0 || result.lexed.errors.length > 0);
});
