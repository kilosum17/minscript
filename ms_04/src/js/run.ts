// Compile a program to JS and run it (spec §16): the front end, then `emitProgram`, then the
// generated module evaluated against the runtime.

import { basename } from "node:path";
import type { Diagnostic } from "../diagnostic.ts";
import { frontEnd } from "../pipeline.ts";
import { emitProgram } from "./emit.ts";
import * as rt from "./runtime.ts";

export interface Compiled {
    js: string | null;
    diagnostics: Diagnostic[];
    hirProblems: string[];
}

export function compile(entry: string, opts: { mechanisms?: boolean } = {}): Compiled {
    const fe = frontEnd(entry);
    const errors = fe.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) return { js: null, diagnostics: fe.diagnostics, hirProblems: fe.hirProblems };
    const sources = new Map<string, Uint8Array>();
    for (const p of fe.program.packages) for (const f of p.files) sources.set(f.path, f.src);
    const stdDirs = new Set(fe.program.packages.filter((p) => p.dir.includes("/std/")).flatMap((p) => p.files.map((f) => f.path)));
    const js = emitProgram(fe.hir, {
        sources,
        isStd: (file) => !sources.has(file) || stdDirs.has(file),
        displayName: (file) => basename(file),
        mechanisms: opts.mechanisms === false ? null : fe.mechanisms,
    });
    return { js, diagnostics: fe.diagnostics, hirProblems: fe.hirProblems };
}

/** Evaluates compiled JS and runs its `main`; resolves to the exit code. */
export async function runJs(js: string, opts: { stats?: boolean } = {}): Promise<number> {
    const mod = new Function("$rt", js)(rt) as { main: (() => unknown) | null };
    if (!mod.main) {
        process.stderr.write("error: the program has no `main`\n");
        return 2;
    }
    rt.stats.copies = 0;
    const code = await rt.runMain(mod.main);
    if (opts.stats) process.stderr.write(`copies: ${rt.stats.copies}\n`);
    return code;
}
