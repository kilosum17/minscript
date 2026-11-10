// Compile a program to JS and run it (spec §16): the front end, then `emitProgram`, then the
// generated module evaluated against the runtime.

import { basename } from "node:path";
import type { Diagnostic } from "../diagnostic.ts";
import { frontEnd, type FrontEndOptions } from "../pipeline.ts";
import { emitProgram } from "./emit.ts";
import * as rt from "./runtime.ts";
import { closeResources, setArgs } from "./stdlib.ts";

export interface Compiled {
    js: string | null;
    diagnostics: Diagnostic[];
    hirProblems: string[];
}

export function compile(entry: string, opts: { mechanisms?: boolean; load?: FrontEndOptions; entryFn?: string } = {}): Compiled {
    const fe = frontEnd(entry, opts.load);
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
        entry: opts.entryFn,
    });
    return { js, diagnostics: fe.diagnostics, hirProblems: fe.hirProblems };
}

/** Evaluates compiled JS and runs its `main`; resolves to the exit code. */
export async function runJs(js: string, opts: { stats?: boolean; args?: string[]; entry?: string } = {}): Promise<{ code: number; value: unknown }> {
    const mod = new Function("$rt", js)(rt) as Record<string, (() => unknown) | null>;
    const main = mod[opts.entry ?? "main"];
    if (!main) {
        process.stderr.write(`error: the program has no \`${opts.entry ?? "main"}\`\n`);
        return { code: 2, value: undefined };
    }
    setArgs(opts.args ?? []);
    rt.stats.copies = 0;
    try {
        const r = await rt.runMain(main);
        if (opts.stats) process.stderr.write(`copies: ${rt.stats.copies}\n`);
        return r;
    } finally {
        closeResources();
    }
}
