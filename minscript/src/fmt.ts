// The formatter (`ms fmt`, spec §17.8): prints a parsed file in the standard style.
//
// - Layout uses a small Wadler / Prettier document printer: a `group` goes on one line if it fits in
//   `maxWidth`, otherwise its `line`s become newlines. Breaks are only placed where spec §5.4 allows
//   them: inside `(…)` / `[…]`, after a binary operator, before `.`; inside `{…}` entries go one per
//   line (newlines separate them).
// - The author's choices are kept where the style has no opinion: a block, body, literal, `match` or
//   `select` written on several lines stays expanded; a broken method chain or a line break after a
//   binary operator stays broken. A one-liner stays one if it still fits.
// - Literals (strings, templates, numbers, chars) are copied from the source, so escapes, `1_000`
//   and `"""` strings never change.
// - Comments between the entries of a list (items, statements, members, fields, arms) stay on their
//   own line, blank lines between entries are kept (several collapse into one), and trailing `//`
//   comments are aligned within runs of consecutive lines (like gofmt). A comment anywhere else
//   (inside an expression) makes the formatter copy that whole statement verbatim: nothing is lost.
// - The output must parse to the same AST (the corpus test checks every file), and formatting twice
//   changes nothing.

import type * as A from "./ast.ts"
import { parse } from "./parser.ts"
import type { Span, Trivia } from "./token.ts"
import type { Diagnostic } from "./diagnostic.ts"

export type FmtOptions = { indent: number, maxWidth: number, trailingCommas: boolean }
export const DEFAULT_FMT: FmtOptions = { indent: 4, maxWidth: 100, trailingCommas: true }

export type FmtResult = { text: string | null, diagnostics: Diagnostic[] }

/** Formats a file. Files with syntax errors aren't formatted (`text: null`). */
export function format(source: string, opts: Partial<FmtOptions> = {}): FmtResult {
    const parsed = parse(source)
    if (parsed.diagnostics.length > 0) return { text: null, diagnostics: parsed.diagnostics }
    const o = { ...DEFAULT_FMT, ...opts }
    const f = new Formatter(source, parsed.lex.trivia, o)
    return { text: f.file(parsed.file), diagnostics: [] }
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

class Formatter {
    private readonly bytes: Uint8Array
    private readonly comments: Trivia[]
    private readonly used = new Set<number>()
    private readonly o: FmtOptions
    private readonly lineStarts: number[] = [0]

    constructor(source: string, trivia: Trivia[], o: FmtOptions) {
        this.bytes = new TextEncoder().encode(source)
        this.comments = [...trivia].sort((a, b) => a.span.start - b.span.start)
        this.o = o
        for (let i = 0; i < this.bytes.length; i++) if (this.bytes[i] === 10) this.lineStarts.push(i + 1)
    }

    // ---- source access ----

    private text(start: number, end: number): string {
        return new TextDecoder().decode(this.bytes.subarray(start, end))
    }
    private src(span: Span): string { return this.text(span.start, span.end) }
    private lineOf(offset: number): number {
        let lo = 0, hi = this.lineStarts.length - 1
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (this.lineStarts[mid]! <= offset) lo = mid
            else hi = mid - 1
        }
        return lo
    }
    /** Was the node written over several lines? */
    private multiline(span: Span): boolean { return this.lineOf(span.start) !== this.lineOf(Math.max(span.start, span.end - 1)) }
    /** Is there a newline in the source between two offsets? */
    private brokenBetween(a: number, b: number): boolean { return this.lineOf(a) !== this.lineOf(b) }
    /** Does the source have a newline right after this offset (before the next token)? */
    private newlineAfter(offset: number, end: number): boolean {
        for (let i = offset; i < end; i++) {
            const c = this.bytes[i]!
            if (c === 10) return true
            if (c !== 32 && c !== 9 && c !== 13) return false
        }
        return false
    }

    // ---- comments ----

    private commentsIn(start: number, end: number): number[] {
        const out: number[] = []
        this.comments.forEach((c, i) => { if (!this.used.has(i) && c.span.start >= start && c.span.end <= end) out.push(i) })
        return out
    }

    /** Prints a list of entries (items, statements, members, arms) one per line: their leading
     *  comments, blank lines between them, trailing comments, and comments before `end`. */
    private entries<T extends { span: Span }>(nodes: T[], print: (n: T) => Doc, start: number, end: number): Doc[] {
        const out: Doc[] = []
        let prevEnd = start
        let first = true
        const emitComments = (upTo: number) => {
            for (const i of this.commentsIn(prevEnd, upTo)) {
                const c = this.comments[i]!
                this.used.add(i)
                if (!first) {
                    out.push(hard)
                    if (this.blankBetween(prevEnd, c.span.start)) out.push(hard)
                }
                out.push(c.text.replace(/\s+$/, ""))
                first = false
                prevEnd = c.span.end
            }
        }
        for (const n of nodes) {
            emitComments(n.span.start)
            if (!first) {
                out.push(hard)
                if (this.blankBetween(prevEnd, n.span.start)) out.push(hard)
            }
            out.push(this.guarded(n, print))
            first = false
            prevEnd = n.span.end
            // a trailing comment on the entry's last line
            const trailing = this.commentsIn(n.span.end, end).find((i) => this.lineOf(this.comments[i]!.span.start) === this.lineOf(n.span.end - 1))
            if (trailing !== undefined && this.comments[trailing]!.kind !== "doc") {
                this.used.add(trailing)
                out.push(this.suffix(trailing))
                prevEnd = this.comments[trailing]!.span.end
            }
        }
        emitComments(end)
        return out
    }

    private suffix(i: number): Doc {
        const c = this.comments[i]!
        this.used.add(i)
        const col = this.text(this.lineStarts[this.lineOf(c.span.start)]!, c.span.start).length
        return { t: "suffix", s: c.text.replace(/\s+$/, ""), col }
    }

    /** A comment right after an opening `{` (or a closure's `=>`), on the same line: it stays there. */
    private openComment(open: number, end: number): Doc | null {
        const i = this.commentsIn(open, end).find((k) => this.lineOf(this.comments[k]!.span.start) === this.lineOf(open))
        return i === undefined || this.comments[i]!.kind === "doc" ? null : this.suffix(i)
    }

    private blankBetween(a: number, b: number): boolean {
        return /\n[ \t\r]*\n/.test(this.text(a, b))
    }

    /** Prints a node; if it contains a comment the printer didn't place, copies it verbatim instead. */
    private guarded<T extends { span: Span }>(n: T, print: (n: T) => Doc): Doc {
        const before = new Set(this.used)
        const d = print(n)
        const stray = this.commentsIn(n.span.start, n.span.end)
        if (stray.length === 0) return d
        // undo what the attempt claimed inside, then take the source as it is
        for (const i of [...this.used]) if (!before.has(i)) this.used.delete(i)
        for (const i of this.commentsIn(n.span.start, n.span.end)) this.used.add(i)
        return this.src(n.span)
    }

    /** Statements / members between braces: `{ … }` flat if allowed and it fits, else one per line. */
    private braced<T extends { span: Span }>(nodes: T[], print: (n: T) => Doc, span: Span, opts: { flatSep?: string, allowFlat?: boolean, empty?: string, bare?: boolean } = {}): Doc {
        const head = this.openComment(span.start + 1, nodes.length > 0 ? nodes[0]!.span.start : span.end - 1)
        const inner = this.entries(nodes, print, span.start + 1, span.end - 1)
        if (inner.length === 0 && head === null) return opts.empty ?? "{}"
        const canFlat = head === null && (opts.allowFlat ?? true) && !this.multiline(span) && nodes.length > 0 && !inner.some(isSuffix)
        if (canFlat) {
            const flatDocs = nodes.length === inner.filter((d) => d !== hard).length ? join(breakableSep(opts.flatSep ?? "; "), inner.filter((d) => d !== hard)) : null
            // bare: the caller groups it (the blocks of an `if` chain break together)
            if (flatDocs) return opts.bare ? ["{", indent([line, ...flatDocs]), line, "}"] : group(["{", indent([line, ...flatDocs]), line, "}"])
        }
        return ["{", head ?? "", indent([hard, ...inner]), hard, "}"]
    }

    // ---- file and items ----

    file(f: A.File): string {
        const parts: Doc[] = []
        const head: { span: Span, doc: () => Doc }[] = []
        if (f.package.length > 0) {
            const at = this.findPackageSpan()
            head.push({ span: at, doc: () => `package ${f.package.join(".")}` })
        }
        for (const imp of f.imports) head.push({ span: imp.span, doc: () => this.importDecl(imp) })
        const all: { span: Span, doc: () => Doc }[] = [...head, ...f.items.map((it) => ({ span: it.span, doc: () => this.item(it) }))]
        parts.push(this.entries(all, (x) => x.doc(), 0, this.bytes.length))
        const doc: Doc = [parts, hard]
        return alignComments(render(doc, this.o.maxWidth, " ".repeat(this.o.indent))).replace(/\n+$/, "\n")
    }

    private findPackageSpan(): Span {
        const text = this.text(0, this.bytes.length)
        const m = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(package\s+[\w.]+)/.exec(text)
        const start = m ? new TextEncoder().encode(text.slice(0, m.index + m[0].length - m[1]!.length)).length : 0
        const end = m ? start + new TextEncoder().encode(m[1]!).length : 0
        return { start, end, line: this.lineOf(start) + 1, col: 1 } as Span
    }

    private importDecl(i: A.Import): Doc {
        return `import ${i.pub ? "pub " : ""}${JSON.stringify(i.path)}${i.alias ? ` as ${i.alias}` : ""}`
    }

    private item(it: A.Item): Doc {
        switch (it.kind) {
            case "FunDecl": return this.fun(it)
            case "TypeDecl": {
                const head = flat(`${it.pub ? "pub " : ""}type ${it.name}${this.generics(it.generics)}${it.impls.length ? `: ${it.impls.map((t) => this.type(t)).join(", ")}` : ""} = `)
                return [head, it.body.kind === "StructBody" ? this.structBody(it.body) : this.type(it.body)]
            }
            case "UnionDecl": {
                const head = flat(`${it.pub ? "pub " : ""}union ${it.name}${this.generics(it.generics)}${it.impls.length ? `: ${it.impls.map((t) => this.type(t)).join(", ")}` : ""} = `)
                const members: { span: Span, doc: () => Doc, method: boolean }[] = [
                    ...it.variants.map((v) => ({ span: v.span, doc: () => this.variant(v), method: false })),
                    ...it.methods.map((m) => ({ span: m.span, doc: () => this.fun(m), method: true })),
                ].sort((a, b) => a.span.start - b.span.start)
                const bodySpan = this.bodySpan(it.span)
                return [head, this.braced(members, (m) => m.doc(), bodySpan, { flatSep: "  ", allowFlat: it.methods.length === 0 })]
            }
            case "InterDecl": {
                const head = `${it.pub ? "pub " : ""}inter ${it.name}${this.generics(it.generics)}${it.supers.length ? `: ${it.supers.map((t) => this.type(t)).join(", ")}` : ""} = `
                if (it.composition) return flat([head, this.type(it.composition)])
                return [flat(head), this.braced(it.methods ?? [], (m) => this.fun(m), this.bodySpan(it.span))]
            }
            case "ImplDecl": {
                const ifaces = it.interfaces.length ? `${it.interfaces.map((t) => this.type(t)).join(", ")} for ` : ""
                return [flat(`impl${this.generics(it.generics)} ${ifaces}${this.type(it.target)} `), this.braced(it.methods, (m) => this.fun(m), this.bodySpan(it.span), { allowFlat: false })]
            }
            case "LetDecl":
                return [`${it.pub ? "pub " : ""}let ${it.name}${it.type ? `: ${this.type(it.type)}` : ""} = `, this.expr(it.value)]
            case "ExternDecl":
                return [`extern ${JSON.stringify(it.abi)} `, this.braced(it.funs, (m) => this.fun(m), this.bodySpan(it.span), { allowFlat: false })]
        }
    }

    /** The `{ … }` at the end of an item: from its last top-level `{` (the item ends with `}`). */
    private bodySpan(span: Span): Span {
        const text = this.text(span.start, span.end)
        // scan for the `{` matching the final `}`, skipping strings and comments
        let depth = 0
        const open: number[] = []
        for (let i = 0; i < text.length; i++) {
            const c = text[i]!
            if (c === "\"") { for (i++; i < text.length && text[i] !== "\""; i++) if (text[i] === "\\") i++; continue }
            if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue }
            if (c === "{") { open.push(i); depth++ } else if (c === "}") { depth--; const o = open.pop()!; if (depth === 0 && i === text.length - 1) {
                const startByte = span.start + new TextEncoder().encode(text.slice(0, o)).length
                return { start: startByte, end: span.end, line: this.lineOf(startByte) + 1, col: 1 } as Span
            } }
        }
        return span
    }

    private generics(gs: A.GenericParam[]): string {
        if (gs.length === 0) return ""
        return `[${gs.map((g) => `${g.name}${g.bounds.length ? `: ${g.bounds.map((b) => this.type(b)).join(" & ")}` : ""}`).join(", ")}]`
    }

    private fun(f: A.FunDecl): Doc {
        const params: Doc[] = []
        if (f.receiver) params.push(f.receiver)
        for (const p of f.params) params.push(`${p.mut ? "mut " : ""}${p.variadic ? "..." : ""}${p.name}: ${this.type(p.type)}`)
        const sig: Doc = flat([
            `${f.pub ? "pub " : ""}${f.async ? "async " : ""}fun ${f.name}${this.generics(f.generics)}(`, join(", ", params), ")",
            f.ret ? ` -> ${this.type(f.ret)}` : "",
        ])
        if (f.body === null) return sig
        return [sig, " ", this.block(f.body)]
    }

    private structBody(b: A.StructBody): Doc {
        const members: { span: Span, doc: () => Doc }[] = [
            ...b.fields.map((x) => ({ span: x.span, doc: () => this.field(x) })),
            ...b.methods.map((m) => ({ span: m.span, doc: () => this.fun(m) })),
        ].sort((a, c) => a.span.start - c.span.start)
        return this.braced(members, (m) => m.doc(), b.span, { flatSep: ", ", allowFlat: b.methods.length === 0 })
    }

    private field(x: A.Field): Doc {
        return [`${x.pub ? "pub " : ""}${x.name}: ${this.type(x.type)}`, x.default ? [" = ", this.expr(x.default)] : ""]
    }

    private variant(v: A.Variant): Doc {
        if (v.tuple) return `${v.name}(${v.tuple.map((t) => this.type(t)).join(", ")})`
        if (v.fields) return `${v.name} { ${v.fields.map((f) => `${f.pub ? "pub " : ""}${f.name}: ${this.type(f.type)}`).join(", ")} }`
        return v.name
    }

    // ---- types ----

    private type(t: A.Type): string {
        switch (t.kind) {
            case "TName": return t.path.join(".") + (t.args.length ? `[${t.args.map((a) => this.type(a)).join(", ")}]` : "")
            case "TOption": return `${this.type(t.inner)}?`
            case "TRef": return `&${t.mut ? "mut " : ""}${this.type(t.inner)}`
            case "TPtr": return `*${t.mut ? "mut " : ""}${this.type(t.inner)}`
            case "TTuple": return `t(${t.elems.map((e) => this.type(e)).join(", ")})`
            case "TRecord": return `r{ ${t.fields.map((f) => `${f.name}: ${this.type(f.type)}`).join(", ")} }`
            case "TFn": return `(${t.params.map((p) => this.type(p)).join(", ")}) -> ${this.type(t.ret)}`
            case "TTypeOf": return `TypeOf(${t.path.join(".")})`
            case "TLiteral": return this.src(t.span)
            case "TUnion": return t.members.map((m) => this.type(m)).join(" | ")
            case "TIntersection": return t.members.map((m) => this.type(m)).join(" & ")
            case "TError": return this.src(t.span)
        }
    }

    // ---- statements ----

    private block(b: A.Block | (A.Expr & { kind: "Block" }), allowFlat = true): Doc {
        const stmts = b.stmts
        return this.braced(stmts, (s) => this.stmt(s, s === stmts[stmts.length - 1]), b.span, { flatSep: "; ", allowFlat })
    }

    private stmt(s: A.Stmt, last: boolean): Doc {
        if (s.kind === "ExprStmt") return [this.expr(s.expr), s.semi && last ? ";" : ""]
        const value = this.expr(s.value)
        if (s.short) return [this.pattern(s.pattern), s.mutable ? " :== " : " := ", value]
        return [
            `${s.mutable ? "var" : "let"} `, this.pattern(s.pattern), s.type ? `: ${this.type(s.type)}` : "", " = ", value,
            s.else ? [" else ", this.block(s.else)] : "",
        ]
    }

    // ---- expressions ----

    private expr(e: A.Expr): Doc {
        switch (e.kind) {
            case "Ident": return e.name
            case "This": return "this"
            case "Int": case "Float": case "Str": case "Template": case "Char": return this.src(e.span)
            case "Bool": return e.value ? "true" : "false"
            case "Nil": return "nil"
            case "Paren": return ["(", this.expr(e.expr), ")"]
            case "Vec": return this.seq("[", e.elems, "]", e.span)
            case "Array": return this.seq("a[", e.elems, "]", e.span)
            case "Tuple": return this.seq("t(", e.elems, ")", e.span)
            case "Set": return this.bracedSeq("s{", e.elems.map((x) => ({ span: x.span, doc: () => this.elem(x) })), e.span)
            case "Map": return this.bracedSeq("m{", e.entries.map((x) => ({ span: x.span, doc: () => (x.kind === "Spread" ? this.elem(x) : [this.expr(x.key), ": ", this.expr(x.value)]) })), e.span)
            case "Record": return this.bracedSeq("r{", this.recordFields(e.fields), e.span)
            case "Inferred": return this.bracedSeq("_{", this.recordFields(e.fields), e.span)
            case "StructLit": return [this.expr(e.type), " ", this.bracedSeq("{", this.recordFields(e.fields), { ...e.span, start: e.type.span.end } as Span)]
            case "Closure": return this.closure(e)
            case "Unary": return [e.op === "&mut" ? "&mut " : e.op, this.expr(e.expr)]
            case "Await": return ["await ", this.expr(e.expr)]
            case "Binary": {
                const broken = this.brokenBetween(e.left.span.end, e.right.span.start)
                const sep = broken ? indent([hard]) : " "
                return [this.expr(e.left), ` ${e.op}`, sep, this.expr(e.right)]
            }
            case "Assign": return [this.expr(e.target), ` ${e.op} `, this.expr(e.value)]
            case "Range": return [e.start ? this.expr(e.start) : "", e.op, e.end ? this.expr(e.end) : ""]
            case "As": return [this.expr(e.expr), " as ", this.type(e.type)]
            case "Or": {
                const broken = this.brokenBetween(e.expr.span.end, e.rhs.span.start) && !this.newlineAfterOr(e)
                const rhs: Doc = [e.name ? `${e.name} => ` : "", this.expr(e.rhs)]
                return broken ? [this.expr(e.expr), indent([hard, "or ", rhs])] : [this.expr(e.expr), " or ", rhs]
            }
            case "Member": case "OptMember": {
                const dot = e.kind === "Member" ? "." : "?."
                const name = String(e.name)
                if (this.chainBroken(e)) return [this.expr(e.object), indent([hard, dot, name])]
                return [this.expr(e.object), dot, name]
            }
            // `t (1)` calls `t` and `a [0]` indexes `a`: glued, they would be the sigils `t(` / `a[` (spec §1.6)
            case "Call": return [this.expr(e.callee), sigilLetter(e.callee, "t") ? " " : "", this.args(e.args, e.span)]
            case "Index": return [this.expr(e.object), sigilLetter(e.object, "a") ? " [" : "[", this.expr(e.index), "]"]
            case "GenericApply": return [this.expr(e.target), `.[${e.args.map((a) => this.type(a)).join(", ")}]`]
            case "Try": return [this.expr(e.expr), "?"]
            case "If": return this.ifExpr(e)
            case "Match": return this.matchExpr(e)
            case "Select": return this.selectExpr(e)
            case "For": return this.forExpr(e)
            case "Block": return this.block(e)
            case "Unsafe": return ["unsafe ", this.block(e.body)]
            case "Recover": return ["recover ", this.block(e.body)]
            case "Return": return e.value ? ["return ", this.expr(e.value)] : "return"
            case "Break": return ["break", e.label ? ` ${e.label}` : "", e.value ? [" ", this.expr(e.value)] : ""]
            case "Continue": return `continue${e.label ? ` ${e.label}` : ""}`
            case "Error": return this.src(e.span)
        }
    }

    /** `x or\n  y` (newline after `or`) is rare; keep `or` where the author put it only when it starts the line. */
    private newlineAfterOr(e: A.Expr & { kind: "Or" }): boolean {
        const between = this.text(e.expr.span.end, e.rhs.span.start)
        return !/\n\s*or\b/.test(between)
    }

    /** `a\n    .b()`: the author broke the chain before this `.` (not after a closing bracket's own line). */
    private chainBroken(e: A.Expr & { kind: "Member" | "OptMember" }): boolean {
        const between = this.text(e.object.span.end, e.span.end)
        return /^\s*\n\s*\??\./.test(between)
    }

    private elem(x: A.Expr | A.Spread): Doc {
        return x.kind === "Spread" ? ["...", this.expr(x.expr)] : this.expr(x)
    }

    /** `(a, b)`, `[a, b]`: a group that breaks with one element per line (and a trailing comma). */
    private seq(open: string, elems: (A.Expr | A.Spread)[], close: string, span: Span): Doc {
        if (elems.length === 0) return `${open}${close}`
        const expanded = this.newlineAfter(span.start + byteLen(open), span.end) && elems.length > 1
        const items = elems.map((x) => this.elem(x))
        return group([open, indent([soft, join([",", line], items)]), this.o.trailingCommas ? ifBreak(",") : "", soft, close], expanded)
    }

    private args(args: (A.Expr | A.Spread)[], span: Span): Doc {
        const open = this.findOpenParen(span, args)
        // `xs.map(#{ x =>` … `})`: a multi-line closure or literal as the last argument stays hugged
        const last = args[args.length - 1]
        if (last && HUGGABLE.has(last.kind) && this.multiline(last.span) && !this.newlineAfter(open + 1, last.span.start)) {
            const before = args.slice(0, -1)
            if (before.every((a) => !this.multiline(a.span))) {
                return ["(", join(", ", [...before.map((a) => this.elem(a)), this.elem(last)]), ")"]
            }
        }
        return this.seq("(", args, ")", { ...span, start: open } as Span)
    }

    /** The offset of a call's `(`: just before its first argument, or before the final `)`. */
    private findOpenParen(span: Span, args: (A.Expr | A.Spread)[]): number {
        const limit = args.length > 0 ? args[0]!.span.start : span.end
        const text = this.text(span.start, limit)
        const i = text.lastIndexOf("(")
        return span.start + byteLen(text.slice(0, Math.max(0, i)))
    }

    /** `m{ k: v }`, `r{ a }`, `User { … }`: flat with commas if it fits (and was flat), else one per line. */
    private bracedSeq(open: string, items: { span: Span, doc: () => Doc }[], span: Span): Doc {
        if (items.length === 0) return `${open}}`
        const braceAt = this.findBrace(span, items[0]!.span.start)
        const body: Span = { ...span, start: braceAt }
        const head = this.openComment(braceAt + 1, items[0]!.span.start)
        const inner = this.entries(items, (x) => x.doc(), braceAt + 1, span.end - 1)
        if (head === null && !this.multiline(body) && !inner.some(isSuffix)) {
            const flatDocs = inner.filter((d) => d !== hard)
            if (flatDocs.length === items.length) return group([open, indent([line, join([",", line], flatDocs)]), line, "}"])
        }
        return [open, head ?? "", indent([hard, ...inner]), hard, "}"]
    }

    private findBrace(span: Span, firstItem: number): number {
        const text = this.text(span.start, firstItem)
        const i = text.lastIndexOf("{")
        return span.start + byteLen(text.slice(0, Math.max(0, i)))
    }

    private recordFields(fields: (A.RecordField | A.Spread)[]): { span: Span, doc: () => Doc }[] {
        return fields.map((f) => ({
            span: f.span,
            doc: () => (f.kind === "Spread" ? this.elem(f) : f.value === null ? key(f.key) : [key(f.key), ": ", this.expr(f.value)]),
        }))
    }

    private closure(e: A.Expr & { kind: "Closure" }): Doc {
        const caps = e.captures ? `[${e.captures.map((c) => `${c.mode === "ref" ? "&" : c.mode === "mut" ? "&mut " : ""}${c.name}`).join(", ")}]` : ""
        const header = e.params === null ? "" : `${e.params.map((p) => `${p.mut ? "mut " : ""}${p.name}${p.type ? `: ${this.type(p.type)}` : ""}`).join(", ")}${e.ret ? ` -> ${this.type(e.ret)}` : ""} =>`
        const open = `#${caps}{`
        const stmts = e.body.stmts
        const print = (s: A.Stmt) => this.stmt(s, s === stmts[stmts.length - 1])
        const bodyStart = this.closureBodyStart(e)
        const head = this.openComment(bodyStart, stmts.length > 0 ? stmts[0]!.span.start : e.span.end - 1)
        const inner = this.entries(stmts, print, bodyStart, e.span.end - 1)
        if (inner.length === 0 && head === null) return `${open} ${header}${header ? " " : ""}}`
        const flatDocs = inner.filter((d) => d !== hard)
        if (head === null && !this.multiline(e.span) && !inner.some(isSuffix) && flatDocs.length === stmts.length) {
            return group([open, " ", header, header ? " " : "", join("; ", flatDocs), " }"])
        }
        // a header-less closure starts its body on the next line (an empty first line: no header)
        return [open, header ? ` ${header}` : "", head ?? "", indent([hard, ...inner]), hard, "}"]
    }

    /** Where a closure's statements may start: after `=>` (or the `{`). */
    private closureBodyStart(e: A.Expr & { kind: "Closure" }): number {
        const first = e.body.stmts[0]
        const text = this.text(e.span.start, first ? first.span.start : e.span.end)
        const arrow = e.params !== null ? text.indexOf("=>") : -1
        const at = arrow >= 0 ? arrow + 2 : text.indexOf("{") + 1
        return e.span.start + byteLen(text.slice(0, at))
    }

    /** An `if` / `else if` / `else` chain is one group: its blocks are all flat, or all broken. */
    private ifExpr(e: A.Expr & { kind: "If" }): Doc {
        return group(this.ifParts(e))
    }

    private ifParts(e: A.Expr & { kind: "If" }): Doc[] {
        const cond: Doc = e.cond.kind === "LetCond" ? ["let ", this.pattern(e.cond.pattern), " = ", this.expr(e.cond.value)] : this.expr(e.cond)
        const out: Doc[] = ["if ", flat(cond), " ", this.bareBlock(e.then)]
        if (e.else?.kind === "If") out.push(" else ", ...this.ifParts(e.else))
        else if (e.else) out.push(" else ", this.bareBlock(e.else as A.Block))
        return out
    }

    private bareBlock(b: A.Block): Doc {
        const stmts = b.stmts
        return this.braced(stmts, (s) => this.stmt(s, s === stmts[stmts.length - 1]), b.span, { flatSep: "; ", bare: true })
    }

    private matchExpr(e: A.Expr & { kind: "Match" }): Doc {
        const head = e.subject ? ["match ", flat(this.expr(e.subject)), " "] : ["match "]
        const arm = (a: A.MatchArm): Doc => [
            a.pattern ? this.pattern(a.pattern) : a.test ? this.expr(a.test) : "_",
            a.guard ? [" if ", this.expr(a.guard)] : "",
            " => ", this.expr(a.body),
        ]
        const body = this.bodySpan(e.span)
        return [head, this.braced(e.arms, arm, body, { flatSep: ", " })]
    }

    private selectExpr(e: A.Expr & { kind: "Select" }): Doc {
        const arms: { span: Span, doc: () => Doc }[] = e.arms.map((a) => ({
            span: a.span,
            doc: () => [a.pattern ? [this.pattern(a.pattern), " = "] : "", this.expr(a.expr), " => ", this.expr(a.body)],
        }))
        if (e.else) {
            const els = e.else
            arms.push({ span: { ...els.span, start: this.elseStart(e, els) } as Span, doc: () => ["else => ", this.expr(els)] })
        }
        return ["select ", this.braced(arms, (a) => a.doc(), this.bodySpan(e.span), { allowFlat: false })]
    }

    private elseStart(e: A.Expr & { kind: "Select" }, els: A.Expr): number {
        const from = e.arms.length > 0 ? e.arms[e.arms.length - 1]!.span.end : e.span.start
        const text = this.text(from, els.span.start)
        const i = text.lastIndexOf("else")
        return i >= 0 ? from + byteLen(text.slice(0, i)) : els.span.start
    }

    private forExpr(e: A.Expr & { kind: "For" }): Doc {
        const label = e.label ? `${e.label}: ` : ""
        let header: Doc = ""
        switch (e.form) {
            case "infinite": header = ""; break
            case "cond": header = [this.expr(e.expr!), " "]; break
            case "let": header = ["let ", this.pattern(e.pattern!), " = ", this.expr(e.expr!), " "]; break
            case "in": header = [e.await ? "await " : "", this.pattern(e.pattern!), e.pattern2 ? [", ", this.pattern(e.pattern2)] : "", " in ", this.expr(e.expr!), " "]; break
        }
        return [label, "for ", flat(header), this.block(e.body, false)]
    }

    // ---- patterns ----

    private pattern(p: A.Pattern): string {
        switch (p.kind) {
            case "PWild": return "_"
            case "PBind": return `${p.mut ? "mut " : ""}${p.name}`
            case "PLit": return this.src(p.span)
            case "PRange": return `${p.start ? this.src(p.start.span) : ""}${p.op}${p.end ? this.src(p.end.span) : ""}`
            case "PPath": return p.path.join(".")
            case "PCall": return `${p.path.join(".")}(${[...p.args.map((a) => this.pattern(a)), ...(p.rest ? [".."] : [])].join(", ")})`
            case "PStruct": {
                const fields = [...p.fields.map((f) => (f.pattern ? `${f.name}: ${this.pattern(f.pattern)}` : f.name)), ...(p.rest ? [".."] : [])]
                return `${p.path ? `${p.path.join(".")} ` : "r"}{ ${fields.join(", ")} }`
            }
            case "PTuple": return `t(${[...p.elems.map((a) => this.pattern(a)), ...(p.rest ? [".."] : [])].join(", ")})`
            case "POr": return p.alts.map((a) => this.pattern(a)).join(" | ")
            case "PError": return this.src(p.span)
        }
    }
}

function byteLen(s: string): number { return new TextEncoder().encode(s).length }

const HUGGABLE: ReadonlySet<string> = new Set(["Closure", "StructLit", "Record", "Inferred", "Map", "Set"])

function isSuffix(d: Doc): boolean {
    return typeof d === "object" && !Array.isArray(d) && d.t === "suffix"
}

function sigilLetter(e: A.Expr, letter: string): boolean {
    return e.kind === "Ident" && e.name === letter
}

/** A flat separator that becomes a newline when its group breaks: `"; "` → `;` + line. */
function breakableSep(sep: string): Doc {
    const visible = sep.trim()
    return [ifBreak("", visible === "" ? " " : visible), line]
}

/** A record key: as written if it is an identifier, quoted otherwise. */
function key(k: string): string {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k)
}

