// The front end as one call: load, resolve, type-check, lower to HIR, compute witnesses, validate.

import { checkProgram, type CheckResult } from "./check.ts";
import type { Diagnostic } from "./diagnostic.ts";
import type * as H from "./hir.ts";
import { checkHir } from "./hir_check.ts";
import { loadPrelude, loadProgram, type LoadOptions, type Program } from "./loader.ts";
import { lowerProgram, type LowerPackage } from "./lower.ts";
import { computeWitnesses } from "./witness.ts";
import { computeEffects, type EffectsResult } from "./effects.ts";

export interface FrontEnd {
    program: Program;
    checked: ReturnType<typeof checkProgram>;
    hir: H.Program;
    /** HIR invariants lowering broke: compiler bugs */
    hirProblems: string[];
    effects: EffectsResult;
    diagnostics: Diagnostic[];
}

export function frontEnd(entry: string, opts: LoadOptions = {}): FrontEnd {
    const program = loadProgram(entry, opts);
    const prelude = loadPrelude();
    const checked = checkProgram(program, prelude.file);
    const packages: LowerPackage[] = [
        { name: "prelude", files: [prelude.file], res: prelude.res, checked: checked.prelude, std: true },
        ...program.packages.map((p) => ({ name: p.name, files: p.files, res: p.res, checked: checked.packages.get(p) as CheckResult, std: p.dir.includes("/std/") })),
    ];
    const hir = lowerProgram(packages);
    computeWitnesses(hir);
    const effects = computeEffects(hir);
    return {
        program, checked, hir, hirProblems: checkHir(hir), effects,
        diagnostics: [...program.diagnostics, ...checked.prelude.diagnostics, ...checked.diagnostics, ...effects.diagnostics],
    };
}
