// The language server's analysis and features on small packages written to a temporary folder
// (the loader reads the imports from disk; the edited file comes from the "editor").

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { analyze, definition, documentSymbols, hover, packageName, PositionMap, references, type Analysis } from "./analysis.ts";
import { completion, inlayHints, prepareRename, rename, signatureHelp } from "./features.ts";

/** A folder with `files`; the first is the edited one. */
function setup(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "ms-lsp-"));
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
    const [first] = Object.keys(files);
    const uri = pathToFileURL(join(dir, first!)).href;
    const src = files[first!]!;
    const an = analyze([{ uri, text: src }], uri);
    const at = (needle: string, nth = 0, delta = 0) => {
        let idx = -1;
        for (let i = 0; i <= nth; i++) idx = src.indexOf(needle, idx + 1);
        assert.ok(idx >= 0, `no ${JSON.stringify(needle)}`);
        const before = src.slice(0, idx + delta);
        return { line: before.split("\n").length - 1, character: before.length - before.lastIndexOf("\n") - 1 };
    };
    return { an, at, uri, src, dir };
}

const hoverText = (an: Analysis, uri: string, pos: { line: number; character: number }) => {
    const h = hover(an, uri, pos);
    return h ? (h.contents as { value: string }).value : null;
};

const SHOP = `package main

/// A line of an order.
type Item {
    name: str
    qty: int

    /// Adds to the quantity.
    fn add(*this, n: int) { this.qty += n }
}

fn total(items: Vec[Item]) -> int {
    var sum = 0
    for line in items { sum += line.qty }
    sum
}

fn main() {
    var cart = [Item { name: "tea", qty: 1 }]
    cart[0].add(2)
    t := total(cart)
    log.println(t)
}
`;

describe("positions and names", () => {
    test("byte offsets ↔ LSP positions (UTF-16), with non-ASCII text", () => {
        const text = "let s = \"é😀\"\nlet x = 1";
        const map = new PositionMap(text);
        const xByte = new TextEncoder().encode(text.slice(0, text.indexOf("x"))).length;
        assert.deepEqual(map.position(xByte), { line: 1, character: 4 });
        assert.equal(map.offset({ line: 1, character: 4 }), xByte);
    });

    test("package names", () => {
        assert.equal(packageName("// header\npackage app.users\n"), "app.users");
        assert.equal(packageName("fn f() {}"), null);
    });
});

describe("diagnostics", () => {
    test("every pass reports, at the right place", () => {
        const { an, at, uri } = setup({ "main.ms": "package main\n\nfn main() {\n    let x: int = \"no\"\n}\n" });
        const d = an.diagnostics.get(uri)!;
        assert.deepEqual(d.map((x) => x.code), ["E_TYPE_MISMATCH"]);
        assert.deepEqual(d[0]!.range.start, at("\"no\""));
    });

    test("lints are warnings (on code without errors)", () => {
        const { an, uri } = setup({ "main.ms": "package main\n\nfn main() {\n    big := 3000000000\n    log.println(big)\n}\n" });
        const d = an.diagnostics.get(uri)!;
        assert.deepEqual(d.map((x) => `${x.code} ${x.severity}`), ["L_INT_NOT_PORTABLE 2"]);
    });

    test("while the syntax is broken, only syntax and name errors are shown", () => {
        const { an, uri } = setup({ "main.ms": "package main\n\nfn main() {\n    let x: int = \"no\"\n    let = 1\n}\n" });
        assert.deepEqual(an.diagnostics.get(uri)!.map((x) => x.code), ["E_INVALID_PATTERN"]);
    });

    test("a package of several files: each diagnostic goes to its file", () => {
        const { an, uri, dir } = setup({ "main.ms": "package main\n\nfn main() { log.println(helper()) }\n", "other.ms": "package main\n\nfn helper() -> int { \"x\" }\n" });
        assert.deepEqual(an.diagnostics.get(uri), []);
        const other = an.diagnostics.get(pathToFileURL(join(dir, "other.ms")).href)!;
        assert.deepEqual(other.map((x) => x.code), ["E_TYPE_MISMATCH"]);
    });
});

describe("queries", () => {
    test("hover: types of bindings, signatures with doc comments, fields, the prelude", () => {
        const { an, at, uri } = setup({ "main.ms": SHOP });
        assert.match(hoverText(an, uri, at("t := total"))!, /let t: int/);
        const add = hoverText(an, uri, at("add(2)"))!;
        assert.match(add, /fn add\(\*this, n: int\)/);
        assert.match(add, /Adds to the quantity/);
        assert.match(hoverText(an, uri, at("qty }", 0, 0))!, /qty: int/);
        assert.match(hoverText(an, uri, at("println"))!, /fn println\(this, \.\.\.args: Stringer\)[\s\S]*prelude/);
    });

    test("definition and references", () => {
        const { an, at, uri } = setup({ "main.ms": SHOP });
        const def = definition(an, uri, at("total(cart)"));
        assert.deepEqual(def[0]!.range.start, at("total(items"));
        const refs = references(an, uri, at("sum = 0"), true);
        assert.equal(refs.length, 3);
    });

    test("outline", () => {
        const { an, uri } = setup({ "main.ms": SHOP });
        assert.deepEqual(documentSymbols(an, uri).map((s) => `${s.name}:${s.children?.map((c) => c.name).join(",")}`), ["Item:name,qty,add", "total:", "main:"]);
    });

    test("inlay hints on bindings without a type", () => {
        const { an, uri } = setup({ "main.ms": SHOP });
        const hints = inlayHints(an, uri, { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } }).map((h) => h.label);
        assert.deepEqual(hints, [": Item", ": Vec[Item]", ": int"]);
    });
});

describe("editing", () => {
    test("completion after `x.`: fields, then methods, then generated ones", () => {
        const { uri, src } = setup({ "main.ms": SHOP });
        const text = src.replace("log.println(t)", "cart[0].");
        const line = text.split("\n").findLastIndex((l) => l.includes("cart[0]."));
        const items = completion([{ uri, text }], uri, { line, character: text.split("\n")[line]!.length });
        const sorted = [...items].sort((a, b) => a.sortText!.localeCompare(b.sortText!)).map((i) => i.label);
        assert.deepEqual(sorted.slice(0, 3), ["name", "qty", "add"]);
        assert.ok(sorted.includes("to_str"));
    });

    test("completion of names in scope, and import paths", () => {
        const { uri, src } = setup({ "main.ms": SHOP });
        const text = src.replace("log.println(t)", "log.println(c)");
        const line = text.split("\n").findIndex((l) => l.includes("println(c)"));
        const labels = completion([{ uri, text }], uri, { line, character: text.split("\n")[line]!.indexOf("(c") + 2 }).map((i) => i.label);
        for (const name of ["cart", "t", "total", "Item", "Vec", "fn"]) assert.ok(labels.includes(name), name);
        const imp = completion([{ uri, text: "package main\nimport \"std." }], uri, { line: 1, character: 12 }).map((i) => i.label);
        assert.ok(imp.includes("json") && imp.includes("net"), imp.join(" "));
    });

    test("signature help: the active parameter", () => {
        const { uri } = setup({ "main.ms": SHOP });
        const text = SHOP.replace("t := total(cart)", "cart[0].add(");
        const line = text.split("\n").findLastIndex((l) => l.includes("add("));
        const help = signatureHelp([{ uri, text }], uri, { line, character: text.split("\n")[line]!.length })!;
        assert.equal(help.signatures[0]!.label, "fn add(n: int)");
        assert.equal(help.activeParameter, 0);
    });

    test("rename a local across its uses; not std names", () => {
        const { an, at, uri } = setup({ "main.ms": SHOP });
        assert.equal(prepareRename(an, uri, at("cart = "))!.placeholder, "cart");
        const edit = rename(an, uri, at("cart = "), "basket")!;
        assert.equal(edit.changes![uri]!.length, 3);
        assert.equal(prepareRename(an, uri, at("println")), null);
        assert.throws(() => rename(an, uri, at("cart = "), "match"));
    });
});
