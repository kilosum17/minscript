// Checker dump (the `.types` format): every binding and parameter, in source order, with its type.

import type * as A from "./ast.ts";
import type { CheckResult } from "./check.ts";
import { LineMap } from "./diagnostic.ts";
import type { Resolution } from "./resolve.ts";
import * as T from "./types.ts";

export function dumpTypes(res: Resolution, checked: CheckResult, file: string, src: Uint8Array): string {
    const lines = new LineMap(src);
    const rows: { at: number; text: string }[] = [];
    for (const s of res.symbols) {
        if (s.file !== file || !["local", "param", "closure-param", "global"].includes(s.kind)) continue;
        const t = checked.symTypes.get(s);
        if (!t) continue;
        const { line, col } = lines.lineCol(s.start);
        rows.push({ at: s.start, text: `${line}:${col} ${s.name}: ${T.show(T.zonk(t))}` });
    }
    rows.sort((a, b) => a.at - b.at);
    void (null as unknown as A.File);
    return rows.map((r) => r.text).join("\n") + "\n";
}
