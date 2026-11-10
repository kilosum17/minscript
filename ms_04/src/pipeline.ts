// The front end as one call: load, resolve, type-check, lower to HIR, compute witnesses, validate,
// effect summaries, the access check and mechanism selection.

import { checkProgram, type CheckResult } from "./check.ts";
import type { Diagnostic } from "./diagnostic.ts";
import type * as H from "./hir.ts";
import { checkHir } from "./hir_check.ts";
import { loadPrelude, loadProgram, type LoadOptions, type Program } from "./loader.ts";
import { lowerProgram, type LowerPackage } from "./lower.ts";
import { computeWitnesses } from "./witness.ts";
import { computeEffects, type EffectsResult } from "./effects.ts";
import { checkAccess } from "./access.ts";
import { selectMechanisms, type MechanismResult } from "./mechanism.ts";
import { lint, lintLevels } from "./lint.ts";
import type { LintSettings } from "./loader.ts";
import { projectOf } from "./project.ts";

export interface FrontEnd {
    program: Program;
    checked: ReturnType<typeof checkProgram>;
    hir: H.Program;
    /** HIR invariants lowering broke: compiler bugs */
    hirProblems: string[];
    effects: EffectsResult;
    /** pass 8; null when there are errors */
    mechanisms: MechanismResult | null;
    /** errors and front-end warnings */
    diagnostics: Diagnostic[];
    /** pass 9: the lints at their levels (mod.ms, then `opts.lint`); a denied lint is an error. Empty when there are errors */
    lints: Diagnostic[];
}

export interface FrontEndOptions extends LoadOptions {
    /** lint levels set on the command line, after mod.ms */
    lint?: LintSettings;
    /** pass 6's safety cap (§15.1), for tests */
    effectsCap?: number;
}

export function frontEnd(entry: string, opts: FrontEndOptions = {}): FrontEnd {
    // the project (§17): its evaluated mod.ms says where `main` is and which `path:` deps exist
    let projectDiagnostics: Diagnostic[] = [];
    if (opts.project === undefined && !entry.endsWith("mod.ms")) {
        const op = projectOf(entry);
        projectDiagnostics = op?.diagnostics ?? [];
        opts = { ...opts, project: op?.project ?? null };
    }
    const program = loadProgram(entry, opts);
    const prelude = loadPrelude();
    const checked = checkProgram(program, prelude.file);
    const packages: LowerPackage[] = [
        { name: "prelude", files: [prelude.file], res: prelude.res, checked: checked.prelude, std: true },
        ...program.packages.map((p) => ({ name: p.name, files: p.files, res: p.res, checked: checked.packages.get(p) as CheckResult, std: p.dir.includes("/std/") })),
    ];
    const hir = lowerProgram(packages);
    computeWitnesses(hir);
    const effects = computeEffects(hir, { cap: opts.effectsCap });
    const frontDiagnostics = [...projectDiagnostics, ...program.diagnostics, ...checked.prelude.diagnostics, ...checked.diagnostics];
    // the access check needs well-typed code: after type errors its findings would be noise
    const ok = !frontDiagnostics.some((d) => d.severity === "error");
    const access = ok ? checkAccess(hir, effects.summaries) : [];
    const mechanisms = ok && !access.some((d) => d.severity === "error") ? selectMechanisms(hir, effects.summaries) : null;
    const userFiles = new Set(packages.filter((p) => !p.std).flatMap((p) => p.files.map((f) => f.path)));
    const earlier = [...effects.diagnostics.filter((d) => d.code.startsWith("L_")), ...[...checked.packages.values()].flatMap((c) => c.lints)];
    const lints = mechanisms
        ? lint({ hir, summaries: effects.summaries, mechanisms, earlier, isUser: (f) => userFiles.has(f), target: "js" }, lintLevels(program.lint, ...(opts.lint ? [opts.lint] : [])))
        : [];
    return {
        program, checked, hir, hirProblems: checkHir(hir), effects, mechanisms,
        diagnostics: [...frontDiagnostics, ...effects.diagnostics.filter((d) => !d.code.startsWith("L_")), ...access],
        lints,
    };
}
