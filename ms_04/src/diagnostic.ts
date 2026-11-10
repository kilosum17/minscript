// Diagnostics (spec §18) and the line table that turns byte offsets into 1-based line / column.

export type Severity = "error" | "warning";

export interface Diagnostic {
    code: string;
    message: string;
    /** byte offsets into the source */
    start: number;
    end: number;
    severity: Severity;
    /** the file it is in, when the producer knows it (the loader and the resolver do) */
    file?: string;
    /** a short description of the fix, when there is an obvious one */
    fix?: string;
}

export function diag(code: string, message: string, start: number, end: number, fix?: string): Diagnostic {
    const d: Diagnostic = { code, message, start, end, severity: code.startsWith("L_") ? "warning" : "error" };
    if (fix !== undefined) d.fix = fix;
    return d;
}

/** Maps byte offsets to 1-based lines and columns (columns count code points, spec §1.1). */
export class LineMap {
    readonly src: Uint8Array;
    readonly lineStarts: number[];

    constructor(src: Uint8Array) {
        this.src = src;
        this.lineStarts = [0];
        for (let i = 0; i < src.length; i++) {
            if (src[i] === 0x0a) this.lineStarts.push(i + 1);
        }
    }

    line(offset: number): number {
        let lo = 0;
        let hi = this.lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.lineStarts[mid]! <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo + 1;
    }

    lineCol(offset: number): { line: number; col: number } {
        const line = this.line(offset);
        const start = this.lineStarts[line - 1]!;
        let col = 1;
        for (let i = start; i < offset && i < this.src.length; i++) {
            if ((this.src[i]! & 0xc0) !== 0x80) col++;
        }
        return { line, col };
    }
}

export function formatDiagnostic(d: Diagnostic, file: string, lines: LineMap): string {
    const { line, col } = lines.lineCol(d.start);
    const fix = d.fix ? ` (fix: ${d.fix})` : "";
    return `${file}:${line}:${col}: ${d.severity} ${d.code}: ${d.message}${fix}`;
}
