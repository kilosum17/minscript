// Token dump (the `.tokens` snapshot format): one token per line, `line:col kind [value] [flags]`.

import { LineMap } from "./diagnostic.ts";
import type { LexResult } from "./lexer.ts";

export function dumpTokens(r: LexResult): string {
    const lines = new LineMap(r.src);
    const out: string[] = [];
    for (const t of r.tokens) {
        const { line, col } = lines.lineCol(t.start);
        let s = `${line}:${col} ${t.kind}`;
        if (t.value !== undefined && t.kind !== t.value) {
            s += " " + (typeof t.value === "bigint" ? t.value.toString() : JSON.stringify(t.value));
        }
        const flags: string[] = [];
        if (t.nlBefore) flags.push("nl");
        else if (t.wsBefore) flags.push("ws");
        if (t.match !== undefined) flags.push(`match=${t.match}`);
        if (t.multiline) flags.push("multiline");
        if (t.synthetic) flags.push("synthetic");
        if (flags.length > 0) s += " [" + flags.join(" ") + "]";
        out.push(s);
    }
    return out.join("\n") + "\n";
}
