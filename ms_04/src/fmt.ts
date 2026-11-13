// The formatter (`ms fmt`, spec §17.8): prints a parsed file in the standard style.
//
// - Layout uses a small Wadler / Prettier document printer: a `group` goes on one line if it fits in
//   `maxWidth`, otherwise its `line`s become newlines. Breaks are only placed where spec §5.4 allows
//   them: inside `(…)` / `[…]`, after a binary operator, before `.`; inside `{…}` entries go one per
//   line (newlines separate them).
// - The author's choices are kept where the style has no opinion: a block, body, literal, `match` or
//   `select` written on several lines stays expanded; a broken method chain or a line break after a
//   binary operator stays broken. A one-liner stays one if it still fits.
// - Literals (strings, templates, numbers, chars, bytes) are copied from the source, so escapes,
//   `1_000` and `"""` strings never change.
// - Comments between the entries of a list (items, statements, members, fields, arms) stay on their
//   own line, blank lines between entries are kept (several collapse into one), and trailing `//`
//   comments are aligned within runs of consecutive lines (like gofmt). A comment anywhere else
//   (inside an expression) makes the formatter copy that whole entry verbatim: nothing is lost.
// - The output must parse to the same AST (the corpus test checks every file), and formatting twice
//   changes nothing. The document printer is stage 0's; the AST printing is v0.4's.

import type * as A from "./ast.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { parse } from "./parser.ts";

type Span = A.Span;

export interface FmtOptions {
    indent: number;
    maxWidth: number;
    trailingCommas: boolean;
}
export const DEFAULT_FMT: FmtOptions = { indent: 4, maxWidth: 100, trailingCommas: true };

export interface FmtResult {
    /** null: the file has a syntax error and isn't formatted */
    text: string | null;
    diagnostics: Diagnostic[];
}

/** Formats a file. Files with syntax errors aren't formatted (`text: null`). */
export function format(source: string, opts: Partial<FmtOptions> = {}): FmtResult {
    const parsed = parse(source);
    if (parsed.diagnostics.length > 0) return { text: null, diagnostics: parsed.diagnostics };
    const f = new Formatter(parsed.lexed.src, parsed.lexed.trivia, { ...DEFAULT_FMT, ...opts });
    return { text: f.file(parsed.file), diagnostics: [] };
}

/** `{ indent, max_width, trailing_commas }` (the `ms.fmt` Options in mod.ms) → FmtOptions. */
export function fmtOptionsFrom(section: unknown): FmtOptions {
    const s = (section ?? {}) as Record<string, unknown>;
    return {
        indent: typeof s.indent === "number" ? s.indent : DEFAULT_FMT.indent,
        maxWidth: typeof s.max_width === "number" ? s.max_width : DEFAULT_FMT.maxWidth,
        trailingCommas: typeof s.trailing_commas === "boolean" ? s.trailing_commas : DEFAULT_FMT.trailingCommas,
    };
}

// ---- documents ------------------------------------------------------------------------------------

type Doc =
    | string
    | Doc[]
    | { t: "group", d: Doc, brk: boolean }
    | { t: "indent", d: Doc }
    | { t: "line" }                    // a space, or a newline when the group breaks
    | { t: "soft" }                    // nothing, or a newline when the group breaks
    | { t: "hard" }                    // always a newline (breaks the enclosing groups)
    | { t: "ifBreak", d: Doc, flat: Doc }
    | { t: "flat", d: Doc }            // never broken (header lines)
    | { t: "suffix", s: string, col: number }   // a trailing comment (and its column in the source): not measured

const line: Doc = { t: "line" }
const soft: Doc = { t: "soft" }
const hard: Doc = { t: "hard" }
const indent = (d: Doc): Doc => ({ t: "indent", d })
const ifBreak = (d: Doc, flat: Doc = ""): Doc => ({ t: "ifBreak", d, flat })
const flat = (d: Doc): Doc => ({ t: "flat", d })
const group = (d: Doc, brk = false): Doc => ({ t: "group", d, brk: brk || hasHard(d) })
const join = (sep: Doc, ds: Doc[]): Doc[] => ds.flatMap((d, i) => (i === 0 ? [d] : [sep, d]))

function hasHard(d: Doc): boolean {
    if (typeof d === "string") return d.includes("\n")
    if (Array.isArray(d)) return d.some(hasHard)
    switch (d.t) {
        case "hard": return true
        case "group": return d.brk
        case "indent": return hasHard(d.d)
        case "ifBreak": return hasHard(d.d)
        default: return false
    }
}

const SUFFIX = "\u0001"      // marks a trailing comment in the output, for the alignment pass

/** Lays a document out in `width` columns. */
function render(doc: Doc, width: number, unit: string): string {
    type Cmd = [string, "flat" | "break", Doc]
    const out: string[] = []
    let col = 0
    const stack: Cmd[] = [["", "break", doc]]
    const fits = (rest: Cmd[], w: number): boolean => {
        const work: Cmd[] = [...rest]
        while (w >= 0 && work.length > 0) {
            const [ind, mode, d] = work.pop()!
            if (typeof d === "string") {
                const nl = d.indexOf("\n")
                if (nl >= 0) return w - nl >= 0
                w -= d.length
            } else if (Array.isArray(d)) {
                for (let i = d.length - 1; i >= 0; i--) work.push([ind, mode, d[i]!])
            } else switch (d.t) {
                case "group": work.push([ind, d.brk ? "break" : "flat", d.d]); break
                case "indent": work.push([ind + unit, mode, d.d]); break
                case "line": if (mode === "break") return true; w -= 1; break
                case "soft": if (mode === "break") return true; break
                case "hard": return true
                case "ifBreak": work.push([ind, mode, mode === "break" ? d.d : d.flat]); break
                case "flat": work.push([ind, "flat", d.d]); break
                case "suffix": break
            }
        }
        return w >= 0
    }
    const newline = (ind: string) => {
        while (out.length > 0 && / +$/.test(out[out.length - 1]!)) out[out.length - 1] = out[out.length - 1]!.replace(/ +$/, "")
        out.push("\n" + ind)
        col = ind.length
    }
    while (stack.length > 0) {
        const [ind, mode, d] = stack.pop()!
        if (typeof d === "string") {
            out.push(d)
            const nl = d.lastIndexOf("\n")
            col = nl >= 0 ? d.length - nl - 1 : col + d.length
        } else if (Array.isArray(d)) {
            for (let i = d.length - 1; i >= 0; i--) stack.push([ind, mode, d[i]!])
        } else switch (d.t) {
            case "group": {
                if (mode === "flat" && !d.brk) { stack.push([ind, "flat", d.d]); break }
                const m = !d.brk && fits([[ind, "flat", d.d]], width - col) ? "flat" : "break"
                stack.push([ind, m, d.d])
                break
            }
            case "indent": stack.push([ind + unit, mode, d.d]); break
            case "line": if (mode === "flat") { out.push(" "); col++ } else newline(ind); break
            case "soft": if (mode === "break") newline(ind); break
            case "hard": newline(ind); break
            case "ifBreak": stack.push([ind, mode, mode === "break" ? d.d : d.flat]); break
            case "flat": stack.push([ind, "flat", d.d]); break
            case "suffix": out.push(`${SUFFIX}${d.col}${SUFFIX}${d.s}`); break
        }
    }
    return out.join("")
}

/** Places trailing comments: in their source column if the code still ends before it (so aligned
 *  comments stay aligned); otherwise the run of consecutive commented lines is aligned two spaces
 *  after its longest line (like gofmt). Removes the markers. */
function alignComments(text: string): string {
    const lines = text.split("\n")
    let i = 0
    while (i < lines.length) {
        if (!lines[i]!.includes(SUFFIX)) { i++; continue }
        let j = i
        while (j < lines.length && lines[j]!.includes(SUFFIX)) j++
        const run = lines.slice(i, j).map((l) => {
            const [code, col, comment] = l.split(SUFFIX) as [string, string, string]
            return { code: code.replace(/ +$/, ""), col: Number(col), comment }
        })
        const keep = run.every((r) => r.col >= r.code.length + 2)
        const aligned = Math.max(...run.map((r) => r.code.length)) + 2
        run.forEach((r, k) => {
            const col = r.code.trim() === "" ? r.code.length : keep ? r.col : aligned
            lines[i + k] = `${r.code}${" ".repeat(Math.max(r.code.trim() === "" ? 0 : 2, col - r.code.length))}${r.comment}`
        })
        i = j
    }
    return lines.join("\n")
}

// ---- the formatter --------------------------------------------------------------------------------

interface Comment {
    kind: "line" | "doc" | "block";
    start: number;
    end: number;
    text: string;
}

/** Something printed as an entry of a list: its span (attributes included) and how to print it. */
interface Entry {
    span: Span;
    doc: () => Doc;
}

class Formatter {
    private readonly bytes: Uint8Array;
    private readonly comments: Comment[];
    private readonly used = new Set<number>();
    private readonly o: FmtOptions;
    private readonly lineStarts: number[] = [0];

    constructor(bytes: Uint8Array, trivia: { kind: "line" | "doc" | "block"; start: number; end: number }[], o: FmtOptions) {
        this.bytes = bytes;
        this.o = o;
        for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) this.lineStarts.push(i + 1);
        this.comments = [...trivia].sort((a, b) => a.start - b.start).map((t) => ({ ...t, text: this.text(t.start, t.end) }));
    }

    // ---- source access ----

    private text(start: number, end: number): string {
        return new TextDecoder().decode(this.bytes.subarray(start, end));
    }
    private src(span: Span): string {
        return this.text(span.start, span.end);
    }
    private lineOf(offset: number): number {
        let lo = 0;
        let hi = this.lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.lineStarts[mid]! <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }
    /** Was the node written over several lines? */
    private multiline(span: Span): boolean {
        return this.lineOf(span.start) !== this.lineOf(Math.max(span.start, span.end - 1));
    }
    /** Is there a newline in the source between two offsets? */
    private brokenBetween(a: number, b: number): boolean {
        return this.lineOf(a) !== this.lineOf(b);
    }
    /** Does the source have a newline right after this offset (before the next token)? */
    private newlineAfter(offset: number, end: number): boolean {
        for (let i = offset; i < end; i++) {
            const c = this.bytes[i]!;
            if (c === 10) return true;
            if (c !== 32 && c !== 9 && c !== 13) return false;
        }
        return false;
    }

    // ---- comments ----

    private commentsIn(start: number, end: number): number[] {
        const out: number[] = [];
        this.comments.forEach((c, i) => {
            if (!this.used.has(i) && c.start >= start && c.end <= end) out.push(i);
        });
        return out;
    }

    /**
     * Prints a list of entries (items, statements, members, arms) one per line: their leading
     * comments, blank lines between them, trailing comments, and comments before `end`.
     */
    private entries<T extends { span: Span }>(nodes: T[], print: (n: T) => Doc, start: number, end: number): Doc[] {
        const out: Doc[] = [];
        let prevEnd = start;
        let first = true;
        const emitComments = (upTo: number) => {
            for (const i of this.commentsIn(prevEnd, upTo)) {
                const c = this.comments[i]!;
                this.used.add(i);
                if (!first) {
                    out.push(hard);
                    if (this.blankBetween(prevEnd, c.start)) out.push(hard);
                }
                out.push(c.text.replace(/\s+$/, ""));
                first = false;
                prevEnd = c.end;
            }
        };
        for (const n of nodes) {
            emitComments(n.span.start);
            if (!first) {
                out.push(hard);
                if (this.blankBetween(prevEnd, n.span.start)) out.push(hard);
            }
            out.push(this.guarded(n, print));
            first = false;
            prevEnd = n.span.end;
            // a trailing comment on the entry's last line
            const trailing = this.commentsIn(n.span.end, end).find((i) => this.lineOf(this.comments[i]!.start) === this.lineOf(n.span.end - 1));
            if (trailing !== undefined && this.comments[trailing]!.kind !== "doc") {
                this.used.add(trailing);
                out.push(this.suffix(trailing));
                prevEnd = this.comments[trailing]!.end;
            }
        }
        emitComments(end);
        return out;
    }

    private suffix(i: number): Doc {
        const c = this.comments[i]!;
        this.used.add(i);
        const col = this.text(this.lineStarts[this.lineOf(c.start)]!, c.start).length;
        return { t: "suffix", s: c.text.replace(/\s+$/, ""), col };
    }

    /** A comment right after an opening `{` (or a closure's `=>`), on the same line: it stays there. */
    private openComment(open: number, end: number): Doc | null {
        const i = this.commentsIn(open, end).find((k) => this.lineOf(this.comments[k]!.start) === this.lineOf(open));
        return i === undefined || this.comments[i]!.kind === "doc" ? null : this.suffix(i);
    }

    private blankBetween(a: number, b: number): boolean {
        return /\n[ \t\r]*\n/.test(this.text(a, b));
    }

    /** Prints a node; if it contains a comment the printer didn't place, copies it verbatim instead. */
    private guarded<T extends { span: Span }>(n: T, print: (n: T) => Doc): Doc {
        const before = new Set(this.used);
        const d = print(n);
        const stray = this.commentsIn(n.span.start, n.span.end);
        if (stray.length === 0) return d;
        // undo what the attempt claimed inside, then take the source as it is
        for (const i of [...this.used]) if (!before.has(i)) this.used.delete(i);
        for (const i of this.commentsIn(n.span.start, n.span.end)) this.used.add(i);
        return this.src(n.span);
    }

    /** Statements / members between braces: `{ … }` flat if allowed and it fits, else one per line. */
    private braced<T extends { span: Span }>(nodes: T[], print: (n: T) => Doc, span: Span, opts: { flatSep?: string; allowFlat?: boolean; empty?: string; bare?: boolean } = {}): Doc {
        const head = this.openComment(span.start + 1, nodes.length > 0 ? nodes[0]!.span.start : span.end - 1);
        const inner = this.entries(nodes, print, span.start + 1, span.end - 1);
        if (inner.length === 0 && head === null) return opts.empty ?? "{}";
        const canFlat = head === null && (opts.allowFlat ?? true) && !this.multiline(span) && nodes.length > 0 && !inner.some(isSuffix);
        if (canFlat) {
            const flatDocs = nodes.length === inner.filter((d) => d !== hard).length ? join(breakableSep(opts.flatSep ?? "; "), inner.filter((d) => d !== hard)) : null;
            // bare: the caller groups it (the blocks of an `if` chain break together)
            if (flatDocs) return opts.bare ? ["{", indent([line, ...flatDocs]), line, "}"] : group(["{", indent([line, ...flatDocs]), line, "}"]);
        }
        return ["{", head ?? "", indent([hard, ...inner]), hard, "}"];
    }

    // ---- file and items ----

    file(f: A.File): string {
        const head: Entry[] = [];
        if (f.package.length > 0) {
            const at = this.findPackageSpan();
            head.push({ span: at, doc: () => `package ${f.package.join(".")}` });
        }
        for (const imp of f.imports) head.push({ span: imp.span, doc: () => this.importDecl(imp) });
        const all: Entry[] = [...head, ...f.items.map((it) => this.withAttrs(it.attrs, it.span, () => this.item(it)))];
        const doc: Doc = [this.entries(all, (x) => x.doc(), 0, this.bytes.length), hard];
        return alignComments(render(doc, this.o.maxWidth, " ".repeat(this.o.indent))).replace(/\n+$/, "\n");
    }

    /** An entry with its attributes (`#[effects(keeps: [v])]`), each on its own line before it. */
    private withAttrs(attrs: A.Attribute[], span: Span, doc: () => Doc): Entry {
        if (attrs.length === 0) return { span, doc };
        return {
            span: { start: attrs[0]!.span.start, end: span.end },
            doc: () => [...attrs.flatMap((a) => [this.attribute(a), hard]), doc()],
        };
    }

    private attribute(a: A.Attribute): string {
        const args = a.args.map((g) => `${g.name}: [${g.paths.join(", ")}]`);
        return `#[${a.name}${args.length ? `(${args.join(", ")})` : ""}]`;
    }

    private findPackageSpan(): Span {
        const text = this.text(0, this.bytes.length);
        const m = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(package\s+[\w.]+)/.exec(text);
        const start = m ? byteLen(text.slice(0, m.index + m[0].length - m[1]!.length)) : 0;
        const end = m ? start + byteLen(m[1]!) : 0;
        return { start, end };
    }

    private importDecl(i: A.Import): Doc {
        return `import ${i.isPub ? "pub " : ""}${JSON.stringify(i.path)}${i.alias ? ` as ${i.alias}` : ""}`;
    }

    private item(it: A.Item): Doc {
        const pub = (p: boolean) => (p ? "pub " : "");
        switch (it.kind) {
            case "Fn": return this.fn(it);
            case "TypeDecl": {
                const impls = it.impls.length ? `: ${it.impls.map((t) => this.type(t)).join(", ")}` : "";
                const head = `${pub(it.isPub)}type ${it.name}${this.generics(it.generics)}${impls}`;
                if (it.alias) return flat(`${head} = ${this.type(it.alias)}`);
                const members = it.members ?? [];
                const entries = members.map((m) => this.withAttrs(m.attrs, m.span, () => (m.kind === "Field" ? this.field(m) : this.fn(m))));
                const hasMethods = members.some((m) => m.kind === "Fn");
                return [flat(`${head} `), this.braced(entries, (m) => m.doc(), this.bodySpan(it.span), { flatSep: ", ", allowFlat: !hasMethods })];
            }
            case "UnionDecl": {
                const impls = it.impls.length ? `: ${it.impls.map((t) => this.type(t)).join(", ")}` : "";
                const head = flat(`${pub(it.isPub)}union ${it.name}${this.generics(it.generics)}${impls} `);
                const entries = it.members.map((m) => (m.kind === "Variant" ? { span: m.span, doc: () => this.variant(m) } : this.withAttrs(m.attrs, m.span, () => this.fn(m))));
                const hasMethods = it.members.some((m) => m.kind === "Fn");
                return [head, this.braced(entries, (m) => m.doc(), this.bodySpan(it.span), { flatSep: "  ", allowFlat: !hasMethods })];
            }
            case "InterDecl": {
                const supers = it.supers.length ? `: ${it.supers.map((t) => this.type(t)).join(" & ")}` : "";
                const head = `${pub(it.isPub)}inter ${it.name}${this.generics(it.generics)}${supers}`;
                if (it.alias) return flat(`${head} = ${this.type(it.alias)}`);
                const methods = (it.methods ?? []).map((m) => this.withAttrs(m.attrs, m.span, () => this.fn(m)));
                return [flat(`${head} `), this.braced(methods, (m) => m.doc(), this.bodySpan(it.span))];
            }
            case "ImplDecl": {
                const inters = it.inters.length ? `${it.inters.map((t) => this.type(t)).join(", ")} for ` : "";
                const methods = it.methods.map((m) => this.withAttrs(m.attrs, m.span, () => this.fn(m)));
                return [flat(`impl${this.generics(it.generics)} ${inters}${this.type(it.target)} `), this.braced(methods, (m) => m.doc(), this.bodySpan(it.span), { allowFlat: false })];
            }
            case "LetDecl":
                return [`${pub(it.isPub)}let ${it.name}${it.type ? `: ${this.type(it.type)}` : ""} = `, this.expr(it.value)];
            case "VarDecl":
                return [`${pub(it.isPub)}${it.shared ? "shared " : ""}var ${it.name}${it.type ? `: ${this.type(it.type)}` : ""} = `, this.expr(it.value)];
            case "ExternDecl": {
                const fns = it.fns.map((m) => this.withAttrs(m.attrs, m.span, () => this.fn(m)));
                return [`extern ${JSON.stringify(it.abi)} `, this.braced(fns, (m) => m.doc(), this.bodySpan(it.span), { allowFlat: false })];
            }
        }
    }

    /** The `{ … }` at the end of an item: from the `{` matching its final `}`. */
    private bodySpan(span: Span): Span {
        const text = this.text(span.start, span.end);
        let depth = 0;
        const open: number[] = [];
        for (let i = 0; i < text.length; i++) {
            const c = text[i]!;
            if (c === "\"") {
                for (i++; i < text.length && text[i] !== "\""; i++) if (text[i] === "\\") i++;
                continue;
            }
            if (c === "'" ) {
                // a char or byte literal: `'{'`
                const close = text.indexOf("'", i + 1);
                if (close > i && close - i <= 8) i = close;
                continue;
            }
            if (c === "/" && text[i + 1] === "/") {
                while (i < text.length && text[i] !== "\n") i++;
                continue;
            }
            if (c === "{") {
                open.push(i);
                depth++;
            } else if (c === "}") {
                depth--;
                const o = open.pop()!;
                if (depth === 0 && i === text.length - 1) return { start: span.start + byteLen(text.slice(0, o)), end: span.end };
            }
        }
        return span;
    }

    private generics(gs: A.GenericParam[]): string {
        if (gs.length === 0) return "";
        return `[${gs.map((g) => `${g.name}${g.bounds.length ? `: ${g.bounds.map((b) => this.type(b)).join(" & ")}` : ""}`).join(", ")}]`;
    }

    private fn(f: A.FnDecl): Doc {
        const params: string[] = [];
        if (f.receiver) params.push(f.receiver);
        for (const p of f.params) params.push(`${p.variadic ? "..." : ""}${p.name}: ${p.star ? "*" : ""}${this.type(p.type)}`);
        const ret = f.ret ? ` -> ${f.retStar ? "*" : ""}${this.type(f.ret)}` : "";
        const sig: Doc = flat([`${f.isPub ? "pub " : ""}${f.isAsync ? "async " : ""}fn ${f.name}${this.generics(f.generics)}(`, join(", ", params), ")", ret]);
        if (f.body === null) return sig;
        return [sig, " ", this.block(f.body)];
    }

    private field(x: A.Field): Doc {
        return [`${x.isPub ? "pub " : ""}${x.mode ? `${x.mode} ` : ""}${x.name}: ${this.type(x.type)}`, x.default ? [" = ", this.expr(x.default)] : ""];
    }

    private variant(v: A.Variant): Doc {
        if (v.tuple) return `${v.name}(${v.tuple.map((t) => this.type(t)).join(", ")})`;
        if (v.fields) return [`${v.name} { `, join(", ", v.fields.map((f) => this.field(f))), " }"];
        return v.name;
    }

    // ---- types ----

    private type(t: A.Type): string {
        switch (t.kind) {
            case "TName": return t.path.join(".") + (t.args.length ? `[${t.args.map((a) => this.type(a)).join(", ")}]` : "");
            case "TOptional": return `${this.type(t.inner)}?`;
            case "TTuple": return `t(${t.elems.map((e) => this.type(e)).join(", ")})`;
            case "TRecord": return `r{ ${t.fields.map((f) => `${f.name}: ${this.type(f.type)}`).join(", ")} }`;
            case "TFn": return `(${t.params.map((p) => `${p.star ? "*" : ""}${this.type(p.type)}`).join(", ")}) -> ${this.type(t.ret)}`;
            case "TTypeOf": return `TypeOf(${t.path.join(".")})`;
            case "TLit": return this.src(t.span);
            case "TUnion": return t.alts.map((m) => this.type(m)).join(" | ");
            case "TInter": return t.parts.map((m) => this.type(m)).join(" & ");
            case "TError": return this.src(t.span);
        }
    }

    // ---- statements ----

    private block(b: A.Block, allowFlat = true): Doc {
        const stmts = b.stmts;
        return this.braced(stmts, (s) => this.stmt(s, s === stmts[stmts.length - 1]), b.span, { flatSep: "; ", allowFlat });
    }

    private stmt(s: A.Stmt, last: boolean): Doc {
        switch (s.kind) {
            case "ExprStmt": return [this.expr(s.expr), s.semi && last ? ";" : ""];
            case "ShortDecl": return [s.name, s.mutable ? " :== " : " := ", this.expr(s.value)];
            case "VarStmt": return [`${s.shared ? "shared " : ""}var ${s.name}${s.type ? `: ${this.type(s.type)}` : ""} = `, this.expr(s.value)];
            case "LetStmt":
                return ["let ", this.pattern(s.pattern), s.type ? `: ${this.type(s.type)}` : "", " = ", this.expr(s.value), s.else ? [" else ", this.block(s.else)] : ""];
        }
    }

    // ---- expressions ----

    private expr(e: A.Expr): Doc {
        switch (e.kind) {
            case "Ident": return e.name;
            case "This": return "this";
            case "SelfExpr": return "Self";
            case "Int": case "Float": case "Str": case "Template": case "Char": case "Byte": return this.src(e.span);
            case "Bool": return e.value ? "true" : "false";
            case "Nil": return "nil";
            case "Paren": return ["(", this.expr(e.expr), ")"];
            case "Vec": return this.seq("[", e.elems, "]", e.span);
            case "Array": return this.seq("a[", e.elems, "]", e.span);
            case "Tuple": return this.seq("t(", e.elems, ")", e.span);
            case "Set": return this.bracedSeq("s{", e.elems.map((x) => ({ span: x.span, doc: () => this.elem(x) })), e.span);
            case "Map":
                return this.bracedSeq("m{", e.entries.map((x) => ({ span: x.span, doc: () => (x.kind === "Spread" ? ["...", this.expr(x.value)] : [this.expr(x.key), ": ", this.expr(x.value)]) })), e.span);
            case "Record": return this.bracedSeq("r{", this.recItems(e.items), e.span);
            case "Inferred": return this.bracedSeq("_{", this.recItems(e.items), e.span);
            case "Struct": return [this.expr(e.type), " ", this.bracedSeq("{", this.recItems(e.items), { start: e.type.span.end, end: e.span.end })];
            case "Closure": return this.closure(e);
            case "Unary": return [e.op, this.expr(e.operand)];
            case "Await": return ["await ", this.expr(e.operand)];
            case "Binary": {
                const broken = this.brokenBetween(e.left.span.end, e.right.span.start);
                return [this.expr(e.left), ` ${e.op}`, broken ? indent([hard]) : " ", this.expr(e.right)];
            }
            case "Assign": return [this.expr(e.target), ` ${e.op} `, this.expr(e.value)];
            case "Range": return [e.start ? this.expr(e.start) : "", e.inclusive ? "..=" : "..", e.end ? this.expr(e.end) : ""];
            case "As": return [this.expr(e.expr), " as ", this.type(e.type)];
            case "Or": {
                const broken = this.brokenBetween(e.expr.span.end, e.rhs.span.start) && /\n\s*or\b/.test(this.text(e.expr.span.end, e.rhs.span.start));
                const rhs: Doc = [e.name ? `${e.name} => ` : "", this.expr(e.rhs)];
                return broken ? [this.expr(e.expr), indent([hard, "or ", rhs])] : [this.expr(e.expr), " or ", rhs];
            }
            case "Member": {
                const dot = e.optional ? "?." : ".";
                if (this.chainBroken(e)) return [this.expr(e.target), indent([hard, dot, e.name])];
                return [this.expr(e.target), dot, e.name];
            }
            // `t (1)` calls `t` and `a [0]` indexes `a`: glued, they would be the sigils `t(` / `a[` (§1.7)
            case "Call": return [this.expr(e.callee), sigilLetter(e.callee, "t") ? " " : "", this.args(e.args, e.span)];
            case "Index": return [this.expr(e.target), sigilLetter(e.target, "a") ? " [" : "[", this.expr(e.index), "]"];
            case "GenericApply": return [this.expr(e.target), `.[${e.args.map((a) => this.type(a)).join(", ")}]`];
            case "Try": return [this.expr(e.expr), "?"];
            case "If": return group(this.ifParts(e));
            case "Match": return this.matchExpr(e);
            case "Select": return this.selectExpr(e);
            case "Lock": return ["lock ", flat(join(", ", e.places.map((p) => this.expr(p)))), " ", this.block(e.body, false)];
            case "For": return this.forExpr(e);
            case "Block": return this.block(e);
            case "Unsafe": return ["unsafe ", this.block(e.body)];
            case "Recover": return ["recover ", this.block(e.body)];
            case "Return": return e.value ? ["return ", this.expr(e.value)] : "return";
            case "Break": return ["break", e.label ? ` ${e.label}` : "", e.value ? [" ", this.expr(e.value)] : ""];
            case "Continue": return `continue${e.label ? ` ${e.label}` : ""}`;
            case "Error": return this.src(e.span);
        }
    }

    /** `a\n    .b()`: the author broke the chain before this `.`. */
    private chainBroken(e: A.Member): boolean {
        return /^\s*\n\s*\??\./.test(this.text(e.target.span.end, e.span.end));
    }

    private elem(x: A.Elem): Doc {
        return x.spread ? ["...", this.expr(x.value)] : this.expr(x.value);
    }

    /** `(a, b)`, `[a, b]`: a group that breaks with one element per line (and a trailing comma). */
    private seq(open: string, elems: A.Elem[], close: string, span: Span): Doc {
        if (elems.length === 0) return `${open}${close}`;
        const expanded = this.newlineAfter(span.start + byteLen(open), span.end) && elems.length > 1;
        const items = elems.map((x) => this.elem(x));
        return group([open, indent([soft, join([",", line], items)]), this.o.trailingCommas ? ifBreak(",") : "", soft, close], expanded);
    }

    private args(args: A.Elem[], span: Span): Doc {
        const open = this.findOpenParen(span, args);
        // `xs.map(#{ x =>` … `})`: a multi-line closure or literal as the last argument stays hugged
        const last = args[args.length - 1];
        if (last && !last.spread && HUGGABLE.has(last.value.kind) && this.multiline(last.span) && !this.newlineAfter(open + 1, last.span.start)) {
            const before = args.slice(0, -1);
            if (before.every((a) => !this.multiline(a.span))) return ["(", join(", ", args.map((a) => this.elem(a))), ")"];
        }
        return this.seq("(", args, ")", { start: open, end: span.end });
    }

    /** The offset of a call's `(`: just before its first argument, or before the final `)`. */
    private findOpenParen(span: Span, args: A.Elem[]): number {
        const limit = args.length > 0 ? args[0]!.span.start : span.end;
        const text = this.text(span.start, limit);
        return span.start + byteLen(text.slice(0, Math.max(0, text.lastIndexOf("("))));
    }

    /** `m{ k: v }`, `r{ a }`, `User { … }`: flat with commas if it fits (and was flat), else one per line. */
    private bracedSeq(open: string, items: Entry[], span: Span): Doc {
        if (items.length === 0) return `${open}}`;
        const text = this.text(span.start, items[0]!.span.start);
        const braceAt = span.start + byteLen(text.slice(0, Math.max(0, text.lastIndexOf("{"))));
        const body: Span = { start: braceAt, end: span.end };
        const head = this.openComment(braceAt + 1, items[0]!.span.start);
        const inner = this.entries(items, (x) => x.doc(), braceAt + 1, span.end - 1);
        if (head === null && !this.multiline(body) && !inner.some(isSuffix)) {
            const flatDocs = inner.filter((d) => d !== hard);
            // broken, the entries of a `{…}` literal go one per line without commas (§17.8)
            if (flatDocs.length === items.length) return group([open, indent([line, join(breakableSep(", "), flatDocs)]), line, "}"]);
        }
        return [open, head ?? "", indent([hard, ...inner]), hard, "}"];
    }

    private recItems(items: A.RecItem[]): Entry[] {
        return items.map((f) => ({
            span: f.span,
            doc: () => (f.kind === "Spread" ? ["...", this.expr(f.value)] : f.value === null ? key(f.name, f.quoted) : [key(f.name, f.quoted), ": ", this.expr(f.value)]),
        }));
    }

    private closure(e: A.Closure): Doc {
        const params = e.params === null ? null : e.params.map((p) => `${p.isVar ? "var " : ""}${p.name}${p.type ? `: ${p.star ? "*" : ""}${this.type(p.type)}` : ""}`);
        const header = params === null ? "" : `${params.join(", ")}${e.ret ? ` -> ${this.type(e.ret)}` : ""} =>`;
        const stmts = e.body;
        const print = (s: A.Stmt) => this.stmt(s, s === stmts[stmts.length - 1]);
        const bodyStart = this.closureBodyStart(e);
        const head = this.openComment(bodyStart, stmts.length > 0 ? stmts[0]!.span.start : e.span.end - 1);
        const inner = this.entries(stmts, print, bodyStart, e.span.end - 1);
        if (inner.length === 0 && head === null) return `#{ ${header}${header ? " " : ""}}`;
        const flatDocs = inner.filter((d) => d !== hard);
        if (head === null && !this.multiline(e.span) && !inner.some(isSuffix) && flatDocs.length === stmts.length) {
            // one line if it fits, else the same layout as a closure written over several lines
            return group(["#{", header ? ` ${header}` : "", indent([line, join(breakableSep("; "), flatDocs)]), line, "}"]);
        }
        // a header-less closure starts its body on the next line (an empty first line: no header)
        return ["#{", header ? ` ${header}` : "", head ?? "", indent([hard, ...inner]), hard, "}"];
    }

    /** Where a closure's statements may start: after `=>` (or the `{`). */
    private closureBodyStart(e: A.Closure): number {
        const first = e.body[0];
        const text = this.text(e.span.start, first ? first.span.start : e.span.end);
        const arrow = e.params !== null ? text.indexOf("=>") : -1;
        const at = arrow >= 0 ? arrow + 2 : text.indexOf("{") + 1;
        return e.span.start + byteLen(text.slice(0, at));
    }

    /** An `if` / `else if` / `else` chain is one group: its blocks are all flat, or all broken. */
    private ifParts(e: A.If): Doc[] {
        const cond: Doc = e.pattern ? ["let ", this.pattern(e.pattern), " = ", this.expr(e.cond)] : this.expr(e.cond);
        const out: Doc[] = ["if ", flat(cond), " ", this.bareBlock(e.then)];
        if (e.else?.kind === "If") out.push(" else ", ...this.ifParts(e.else));
        else if (e.else) out.push(" else ", this.bareBlock(e.else));
        return out;
    }

    private bareBlock(b: A.Block): Doc {
        const stmts = b.stmts;
        return this.braced(stmts, (s) => this.stmt(s, s === stmts[stmts.length - 1]), b.span, { flatSep: "; ", bare: true });
    }

    private matchExpr(e: A.Match): Doc {
        const head: Doc = e.subject ? ["match ", flat(this.expr(e.subject)), " "] : "match ";
        const arm = (a: A.Arm): Doc => [
            a.pattern ? this.pattern(a.pattern) : a.cond ? this.expr(a.cond) : "_",
            a.guard ? [" if ", this.expr(a.guard)] : "",
            " => ",
            this.expr(a.body),
        ];
        return [head, this.braced(e.arms, arm, this.bodySpan(e.span), { flatSep: ", " })];
    }

    private selectExpr(e: A.Select): Doc {
        const arms: Entry[] = e.arms.map((a) => ({
            span: a.span,
            doc: () => [a.pattern ? [this.pattern(a.pattern), " = "] : "", this.expr(a.expr), " => ", this.expr(a.body)],
        }));
        if (e.else) {
            const els = e.else;
            arms.push({ span: { start: this.elseStart(e, els), end: els.span.end }, doc: () => ["else => ", this.expr(els)] });
        }
        return ["select ", this.braced(arms, (a) => a.doc(), this.bodySpan(e.span), { allowFlat: false })];
    }

    private elseStart(e: A.Select, els: A.Expr): number {
        const from = e.arms.length > 0 ? e.arms[e.arms.length - 1]!.span.end : e.span.start;
        const text = this.text(from, els.span.start);
        const i = text.lastIndexOf("else");
        return i >= 0 ? from + byteLen(text.slice(0, i)) : els.span.start;
    }

    private forExpr(e: A.For): Doc {
        const label = e.label ? `${e.label}: ` : "";
        let header: Doc = "";
        switch (e.form) {
            case "infinite": header = ""; break;
            case "cond": header = [this.expr(e.expr!), " "]; break;
            case "let": header = ["let ", this.pattern(e.pattern!), " = ", this.expr(e.expr!), " "]; break;
            case "in": header = [e.isAwait ? "await " : "", this.pattern(e.pattern!), e.pattern2 ? [", ", this.pattern(e.pattern2)] : "", " in ", this.expr(e.expr!), " "]; break;
        }
        return [label, "for ", flat(header), this.block(e.body, false)];
    }

    // ---- patterns ----

    private pattern(p: A.Pattern): string {
        switch (p.kind) {
            case "PWild": return "_";
            case "PBind": return `${p.isVar ? "var " : ""}${p.name}`;
            case "PLit": return this.src(p.value.span);
            case "PRange": return `${this.src(p.start.span)}${p.inclusive ? "..=" : ".."}${this.src(p.end.span)}`;
            case "PCtor": {
                const path = p.path.join(".");
                if (p.args) return `${path}(${[...p.args.map((a) => this.pattern(a)), ...(p.rest ? [".."] : [])].join(", ")})`;
                if (p.fields) return `${path} ${this.fieldPats(p.fields, p.rest)}`;
                return path;
            }
            case "PTuple": return `t(${[...p.elems.map((a) => this.pattern(a)), ...(p.rest ? [".."] : [])].join(", ")})`;
            case "PRecord": return `r${this.fieldPats(p.fields, p.rest)}`;
            case "POr": return p.alts.map((a) => this.pattern(a)).join(" | ");
            case "PError": return this.src(p.span);
        }
    }

    private fieldPats(fields: A.FieldPat[], rest: boolean): string {
        const parts = [...fields.map((f) => `${f.isVar ? "var " : ""}${f.name}${f.pattern ? `: ${this.pattern(f.pattern)}` : ""}`), ...(rest ? [".."] : [])];
        return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
    }
}

function byteLen(s: string): number {
    return new TextEncoder().encode(s).length;
}

const HUGGABLE: ReadonlySet<string> = new Set(["Closure", "Struct", "Record", "Inferred", "Map", "Set"]);

function isSuffix(d: Doc): boolean {
    return typeof d === "object" && !Array.isArray(d) && d.t === "suffix";
}

function sigilLetter(e: A.Expr, letter: string): boolean {
    return e.kind === "Ident" && e.name === letter;
}

/** A flat separator that becomes a newline when its group breaks: `"; "` → `;` + line. */
function breakableSep(sep: string): Doc {
    const visible = sep.trim();
    return [ifBreak("", visible === "" ? " " : visible), line];
}

/** A record key: as written (a quoted key stays quoted). */
function key(k: string, quoted: boolean): string {
    return quoted ? JSON.stringify(k) : k;
}
