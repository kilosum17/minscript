// Resolution dump (the `.refs` format): every use, in source order, with what it binds to, then
// each closure's captures and the names left for the checker.

import type * as A from "./ast.ts";
import { LineMap } from "./diagnostic.ts";
import type { Resolution, Sym } from "./resolve.ts";

export function dumpResolution(res: Resolution, file: string, src: Uint8Array): string {
    const lines = new LineMap(src);
    const at = (offset: number) => {
        const { line, col } = lines.lineCol(offset);
        return `${line}:${col}`;
    };
    const where = (s: Sym) => {
        if (s.file === null) return s.kind === "builtin-type" || s.kind === "package" ? "builtin" : "opaque";
        if (s.file !== file) return s.pkg;
        return at(s.start);
    };
    const out: string[] = [];
    const uses = [...res.refs].filter(([node]) => "span" in (node as object) && (node as { kind?: string }).kind !== "Import");
    uses.sort((a, b) => (a[0] as { span: A.Span }).span.start - (b[0] as { span: A.Span }).span.start);
    for (const [node, s] of uses) {
        const n = node as { span: A.Span };
        out.push(`${at(n.span.start)} ${s.name} -> ${s.kind} ${where(s)}`);
    }
    const caps = [...res.captures].filter(([, syms]) => syms.length > 0);
    for (const [c, syms] of caps) out.push(`closure ${at(c.span.start)} captures ${syms.map((s) => s.name).join(", ")}`);
    const deferred = res.deferred as { span: A.Span }[];
    if (deferred.length) out.push(`deferred ${deferred.map((d) => at(d.span.start)).join(" ")}`);
    return out.join("\n") + "\n";
}
