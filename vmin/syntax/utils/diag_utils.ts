import type { Diagnostic } from "./diagnostics";

export function printDiag(d: Diagnostic) {
    return `[${d.span.start},${d.span.end}]${d.code}, ${d.info}`
}