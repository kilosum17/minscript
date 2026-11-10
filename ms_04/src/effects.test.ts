// Effect summaries over recursion (spec §15.1): a large recursive component converges without
// widening; past the safety cap, the growing paths widen and L_SUMMARY_WIDENED is reported.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeEffects, showSummary } from "./effects.ts";
import { frontEnd } from "./pipeline.ts";

function program(text: string): ReturnType<typeof frontEnd> & { dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "ms04-effects-"));
    writeFileSync(join(dir, "main.ms"), text);
    return { ...frontEnd(join(dir, "main.ms")), dir };
}

/** A ring of `n` functions, each calling the next; only the last one writes `s.field<n-1>`. */
function ring(n: number): string {
    const fields = Array.from({ length: n }, (_, i) => `    f${i}: int = 0`).join("\n");
    const funs = Array.from({ length: n }, (_, i) => {
        const next = (i + 1) % n;
        const write = i === n - 1 ? `s.f${i} += 1\n    ` : "";
        return `fn step${i}(s: *State, k: int) {\n    ${write}if k > 0 { step${next}(s, k - 1) }\n}`;
    }).join("\n\n");
    return `package main\n\ntype State {\n${fields}\n}\n\n${funs}\n\nfn main() {\n    var s = State {}\n    step0(s, 3)\n}\n`;
}

test("a ring of 60 recursive functions converges without widening", () => {
    const p = program(ring(60));
    try {
        assert.deepEqual(p.diagnostics.map((d) => d.code), []);
        const step0 = p.hir.funs.find((f) => f.name === "step0")!;
        assert.equal(showSummary(p.effects.summaries.get(step0)!), "reads [k, s.f59]  writes [s.f59]");
        assert.ok(p.effects.maxEvaluations <= 3, `max evaluations ${p.effects.maxEvaluations}`);
    } finally {
        rmSync(p.dir, { recursive: true });
    }
});

test("past the safety cap, growing paths widen to their first segment", () => {
    // each round adds one deeper path (s.a, s.a.a, …), so a cap of 1 round triggers widening
    const p = program(`package main

type Node {
    a: Node? = None
    n: int = 0
}

fn walk(s: *Node, k: int) {
    s.n += 1
    if k > 0 {
        if let Some(var child) = s.a { walk(child, k - 1) }
    }
}

fn main() {
    var root = Node {}
    walk(root, 3)
}
`);
    try {
        const r = computeEffects(p.hir, { cap: 1 });
        assert.ok(r.diagnostics.some((d) => d.code === "L_SUMMARY_WIDENED"));
        const walk = p.hir.funs.find((f) => f.name === "walk")!;
        assert.match(showSummary(r.summaries.get(walk)!), /writes \[s\.n\]/);
        assert.deepEqual(computeEffects(p.hir).diagnostics, []);
    } finally {
        rmSync(p.dir, { recursive: true });
    }
});
