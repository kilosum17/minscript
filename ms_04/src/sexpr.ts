// AST dump as S-expressions (the `.ast` snapshot format). Generic over node shapes: each object
// prints as `(Kind field=value …)`, leaving out spans, nulls, `false` and empty lists so the
// snapshots stay readable. Objects without a `kind` (parameters, arms, elements) print as `(…)`.

const INDENT = "  ";
const WIDTH = 100;

export function sexpr(node: unknown): string {
    return print(node, 0);
}

function print(v: unknown, depth: number): string {
    if (v === null || v === undefined) return "_";
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") return Number.isInteger(v) && !Object.is(v, -0) ? v.toString() : String(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (Array.isArray(v)) {
        const items = v.map((x) => print(x, depth + 1));
        return wrap("[", "]", items, depth);
    }
    const obj = v as Record<string, unknown>;
    const head = typeof obj.kind === "string" ? obj.kind : "";
    const fields: string[] = [];
    for (const [k, val] of Object.entries(obj)) {
        if (k === "kind" || k === "span") continue;
        if (val === null || val === undefined || val === false) continue;
        if (Array.isArray(val) && val.length === 0) continue;
        fields.push(`${k}=${print(val, depth + 1)}`);
    }
    return wrap(head ? `(${head}` : "(", ")", fields, depth, head !== "");
}

function wrap(open: string, close: string, items: string[], depth: number, spaced = false): string {
    if (items.length === 0) return open + close;
    const sep = spaced ? " " : "";
    const flat = open + sep + items.join(" ") + close;
    if (flat.length + depth * INDENT.length <= WIDTH && !flat.includes("\n")) return flat;
    const pad = INDENT.repeat(depth + 1);
    return open + "\n" + items.map((i) => pad + i).join("\n") + "\n" + INDENT.repeat(depth) + close;
}
