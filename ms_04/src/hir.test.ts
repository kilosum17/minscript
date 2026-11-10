// Access paths (spec §9.5): at most 4 segments, literal indices kept, others `[*]`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PATH_DEPTH, pathOf, type Place } from "./hir.ts";
import type { Sym } from "./resolve.ts";
import * as T from "./types.ts";

const sym = { name: "u" } as Sym;
const lit = (v: bigint) => ({ k: "lit" as const, ty: T.INT, span: { start: 0, end: 0 }, value: v });

test("paths render fields, tuple indices and elements", () => {
    const p: Place = {
        root: { k: "local", local: sym, name: "u" },
        segs: [
            { k: "field", name: "tags", mode: null },
            { k: "elem", index: lit(0n), key: "0", map: false },
            { k: "tuple", index: 1 },
        ],
    };
    assert.equal(pathOf(p), "u.tags[0].1");
});

test(`paths are truncated to ${PATH_DEPTH} segments, which only widens them`, () => {
    const segs = ["a", "b", "c", "d", "e", "f"].map((name) => ({ k: "field" as const, name, mode: null }));
    const p: Place = { root: { k: "local", local: sym, name: "u" }, segs: [...segs, { k: "elem", index: lit(1n), key: null, map: false }] };
    assert.equal(pathOf(p), "u.a.b.c.d");
});
