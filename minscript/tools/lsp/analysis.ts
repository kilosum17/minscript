// The language server's analysis: runs the compiler passes on a package (every `.ms` file in a folder
// with the same `package` name) and answers editor questions from their results. No LSP plumbing
// here, so it is tested directly (analysis.test.ts); server.ts wraps it.
//
// Positions: the compiler's spans are UTF-8 byte offsets; LSP positions are 0-based lines and UTF-16
// columns. `PositionMap` converts between them.

import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import type * as L from "vscode-languageserver"
import type * as A from "../../src/ast.ts"
import { checkPackage, type CheckResult } from "../../src/check.ts"
import type { Diagnostic } from "../../src/diagnostic.ts"
import { checkOwnership } from "../../src/ownership.ts"
import { parse, type ParseResult } from "../../src/parser.ts"
import { loadPrelude } from "../../src/prelude.ts"
import { resolvePackage, type Resolution, type Sym } from "../../src/resolve.ts"
import type { Span } from "../../src/token.ts"
import { show, type Ty } from "../../src/types.ts"

export type Doc = { uri: string, text: string }

// ---- positions --------------------------------------------------------------------------------

export class PositionMap {
    private readonly text: string
    private readonly byteToUnit: Uint32Array        // byte offset → UTF-16 index (at code point boundaries)
    private readonly unitToByte: Uint32Array        // UTF-16 index → byte offset
    private readonly lineStarts: number[] = [0]     // UTF-16 index of each line start

    constructor(text: string) {
        this.text = text
        const bytes = new TextEncoder().encode(text).length
        this.byteToUnit = new Uint32Array(bytes + 1)
        this.unitToByte = new Uint32Array(text.length + 1)
        let b = 0
        for (let u = 0; u < text.length; u++) {
            this.unitToByte[u] = b
            this.byteToUnit[b] = u
            const c = text.charCodeAt(u)
            if (c === 0x0a) this.lineStarts.push(u + 1)
            if (c < 0x80) b += 1
            else if (c < 0x800) b += 2
            else if (c >= 0xd800 && c <= 0xdbff) { b += 4; this.unitToByte[u + 1] = b; u++ }
            else b += 3
        }
        this.unitToByte[text.length] = b
        this.byteToUnit[b] = text.length
    }

    position(byteOffset: number): L.Position {
        const unit = this.byteToUnit[Math.min(byteOffset, this.byteToUnit.length - 1)] ?? this.text.length
        let lo = 0, hi = this.lineStarts.length - 1
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (this.lineStarts[mid]! <= unit) lo = mid
            else hi = mid - 1
        }
        return { line: lo, character: unit - this.lineStarts[lo]! }
    }

    range(span: { start: number, end: number }): L.Range {
        return { start: this.position(span.start), end: this.position(Math.max(span.end, span.start)) }
    }

    offset(pos: L.Position): number {
        const start = this.lineStarts[Math.min(pos.line, this.lineStarts.length - 1)] ?? 0
        const unit = Math.min(start + pos.character, this.text.length)
        return this.unitToByte[unit] ?? 0
    }
}

// ---- package analysis -------------------------------------------------------------------------

type FileInfo = {
    uri: string
    text: string
    parsed: ParseResult
    map: PositionMap
    nodes: A.Node[]                       // every AST node, for position lookups
    parent: Map<A.Node, A.Node>           // the node directly containing each node
    spanKeys: Set<string>                 // `${start}:${end}` of every node, to attribute diagnostics
}

export type Analysis = {
    files: Map<string, FileInfo>
    res: Resolution
    checked: CheckResult
    /** LSP diagnostics per file URI (every file of the package has an entry, possibly empty). */
    diagnostics: Map<string, L.Diagnostic[]>
    /** Which file each AST node (of the package and the prelude) belongs to. */
    nodeFile: Map<A.Node, string>
}

const PRELUDE_URI = pathToFileURL(fileURLToPath(new URL("../../std/prelude.ms", import.meta.url))).href
let preludeInfo: FileInfo | null = null

function fileInfo(uri: string, text: string, parsed: ParseResult): FileInfo {
    const parent = new Map<A.Node, A.Node>()
    const nodes = collectNodes(parsed.file, parent)
    return { uri, text, parsed, map: new PositionMap(text), nodes, parent, spanKeys: new Set(nodes.map((n) => `${n.span.start}:${n.span.end}`)) }
}

function prelude(): FileInfo {
    if (preludeInfo === null) {
        const p = loadPrelude()
        preludeInfo = fileInfo(PRELUDE_URI, readFileSync(new URL("../../std/prelude.ms", import.meta.url), "utf8"), { file: p.file, diagnostics: [], lex: { tokens: [], trivia: [], diagnostics: [] } })
    }
    return preludeInfo
}

/** The `package` name a file declares (cheap scan, used to group a folder's files). */
export function packageName(text: string): string | null {
    const m = /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*package\s+([A-Za-z_][\w.]*)/.exec(text)
    return m ? m[1]! : null
}

/** Runs every pass on one package. `primary` is the file being edited (it wins ambiguous diagnostics). */
export function analyze(docs: Doc[], primary: string): Analysis {
    const files = new Map<string, FileInfo>()
    for (const d of docs) files.set(d.uri, fileInfo(d.uri, d.text, parse(d.text)))
    const asts = [...files.values()].map((f) => f.parsed.file)
    const res = resolvePackage(asts)
    const checked = checkPackage(asts, res)
    const parseErrors = [...files.values()].some((f) => f.parsed.diagnostics.length > 0)
    const semantic: Diagnostic[] = [...res.diagnostics]
    // type and ownership errors on half-parsed code are mostly noise: show them once the syntax is valid
    if (!parseErrors) semantic.push(...checked.diagnostics, ...checkOwnership(asts, res, checked).diagnostics)

    const diagnostics = new Map<string, L.Diagnostic[]>()
    for (const f of files.values()) diagnostics.set(f.uri, f.parsed.diagnostics.map((d) => toLsp(d, f.map)))
    for (const d of semantic) {
        const f = attribute(d.span, files, primary)
        diagnostics.get(f.uri)!.push(toLsp(d, f.map))
    }

    const nodeFile = new Map<A.Node, string>()
    for (const f of [prelude(), ...files.values()]) for (const n of f.nodes) nodeFile.set(n, f.uri)
    return { files, res, checked, diagnostics, nodeFile }
}

/** Which file a resolver / checker diagnostic belongs to: the one with a node at exactly that span. */
function attribute(span: Span, files: Map<string, FileInfo>, primary: string): FileInfo {
    const key = `${span.start}:${span.end}`
    const p = files.get(primary)
    if (p && p.spanKeys.has(key)) return p
    for (const f of files.values()) if (f.spanKeys.has(key)) return f
    return p ?? files.values().next().value!
}

function toLsp(d: Diagnostic, map: PositionMap): L.Diagnostic {
    return { range: map.range(d.span), severity: d.severity === "error" ? 1 : 2, code: d.code, source: "minscript", message: d.message }
}

// ---- nodes ------------------------------------------------------------------------------------

function isNode(x: unknown): x is A.Node {
    return typeof x === "object" && x !== null && "kind" in x && "span" in x
}

function collectNodes(root: A.Node, parent: Map<A.Node, A.Node>): A.Node[] {
    const out: A.Node[] = []
    const seen = new Set<object>()
    const visit = (x: unknown, owner: A.Node | null): void => {
        if (typeof x !== "object" || x === null || seen.has(x)) return
        seen.add(x)
        if (Array.isArray(x)) { for (const y of x) visit(y, owner); return }
        let next = owner
        if (isNode(x)) {
            out.push(x)
            if (owner) parent.set(x, owner)
            next = x
        }
        for (const [k, v] of Object.entries(x)) if (k !== "span") visit(v, next)
    }
    visit(root, null)
    return out
}

/** The smallest node containing the offset; prefers nodes the resolver or checker knows about. */
function nodeAt(an: Analysis, f: FileInfo, offset: number): A.Node | null {
    let best: A.Node | null = null
    for (const n of f.nodes) {
        if (n.kind === "File") continue
        if (offset < n.span.start || offset > n.span.end) continue
        if (offset === n.span.end && n.span.end > n.span.start && !isName(n)) continue
        if (best === null || n.span.end - n.span.start < best.span.end - best.span.start ||
            (n.span.end - n.span.start === best.span.end - best.span.start && (an.res.refs.has(n) || an.res.decls.has(n)))) best = n
    }
    return best
}

function isName(n: A.Node): boolean {
    return n.kind === "Ident" || n.kind === "This" || n.kind === "TName" || n.kind === "Member" || n.kind === "OptMember"
}

// ---- symbols ----------------------------------------------------------------------------------

/** What a node names: a symbol (through the resolver), or a member's declaration (through the checker). */
function target(an: Analysis, n: A.Node): { sym?: Sym, decl?: A.Node, name: string } | null {
    const found = targetOf(an, n)
    if (found !== null) return found
    // `x.method` / `T.method` as the callee of a call: the checker records the target on the call
    const uri = an.nodeFile.get(n)
    const f = uri ? an.files.get(uri) : undefined
    let p = f?.parent.get(n)
    if (p?.kind === "GenericApply" && p.target === n) p = f?.parent.get(p)
    if (p?.kind === "Call" && (p.callee === n || (p.callee.kind === "GenericApply" && p.callee.target === n))) {
        const t = an.checked.calls.get(p)?.target
        if (t && (t.kind === "method" || t.kind === "static" || t.kind === "fun") && t.decl) return { decl: t.decl, name: t.decl.name }
    }
    return null
}

function targetOf(an: Analysis, n: A.Node): { sym?: Sym, decl?: A.Node, name: string } | null {
    const ref = an.res.refs.get(n)
    if (ref) return { sym: ref, decl: ref.decl ?? undefined, name: ref.name }
    const decl = an.res.decls.get(n)
    if (decl) return { sym: decl, decl: decl.decl ?? n, name: decl.name }
    if (n.kind === "Member" || n.kind === "OptMember") {
        const m = an.checked.members.get(n)
        const name = String(n.name)
        if (m?.kind === "method" && m.decl) return { decl: m.decl, name }
        if (m?.kind === "static") return { decl: m.decl, name }
        if (m?.kind === "variant") {
            const d = m.union.decl
            const v = d?.kind === "UnionDecl" ? d.variants.find((x) => x.name === m.variant) : undefined
            return { decl: v ?? d ?? undefined, name }
        }
        if (m?.kind === "field") {
            const field = fieldDecl(an.checked.types.get(n.object), name)
            if (field) return { decl: field, name }
        }
    }
    if (n.kind === "Call") {
        const info = an.checked.calls.get(n)
        const t = info?.target
        if (t && (t.kind === "method" || t.kind === "static" || t.kind === "fun") && t.decl) return { decl: t.decl, name: t.decl.name }
    }
    return null
}

function fieldDecl(objTy: Ty | undefined, name: string): A.Field | null {
    let t = objTy
    while (t && (t.k === "var" && t.ref)) t = t.ref
    while (t && t.k === "ref") t = t.inner
    if (!t || t.k !== "named") return null
    const d = t.sym.decl
    if (d?.kind === "TypeDecl" && d.body.kind === "StructBody") return d.body.fields.find((f) => f.name === name) ?? null
    return null
}

function location(an: Analysis, node: A.Node): L.Location | null {
    const uri = an.nodeFile.get(node)
    if (uri === undefined) return null
    const f = uri === PRELUDE_URI ? prelude() : an.files.get(uri)
    if (!f) return null
    return { uri, range: f.map.range(nameSpan(node, f.text) ?? node.span) }
}

/** For a declaration, the span of its name (so "go to definition" lands on it, not on `pub fun`). */
function nameSpan(node: A.Node, text: string): { start: number, end: number } | null {
    const name = "name" in node && typeof node.name === "string" ? node.name : null
    if (name === null || node.kind === "Ident" || node.kind === "PBind") return null
    const bytes = new TextEncoder().encode(text)
    const slice = new TextDecoder().decode(bytes.subarray(node.span.start, node.span.end))
    const m = new RegExp(`\\b${name.replace(/[^\w]/g, "")}\\b`).exec(slice)
    if (!m) return null
    const start = node.span.start + new TextEncoder().encode(slice.slice(0, m.index)).length
    return { start, end: start + new TextEncoder().encode(name).length }
}

// ---- queries ----------------------------------------------------------------------------------

export function hover(an: Analysis, uri: string, pos: L.Position): L.Hover | null {
    const f = an.files.get(uri)
    if (!f) return null
    const n = nodeAt(an, f, f.map.offset(pos))
    if (n === null) return null
    const t = target(an, n)
    const ty = an.checked.types.get(n) ?? (t?.sym ? an.checked.symbols.get(t.sym) : undefined)
    let code: string | null = null
    let note = ""
    const decl = t?.decl
    if (decl?.kind === "FunDecl") code = signature(decl)
    else if (decl?.kind === "TypeDecl" || decl?.kind === "UnionDecl" || decl?.kind === "InterDecl") code = `${decl.kind === "TypeDecl" ? "type" : decl.kind === "UnionDecl" ? "union" : "inter"} ${decl.name}`
    else if (decl?.kind === "Field") code = `${decl.name}: ${typeText(decl.type)}`
    else if (decl?.kind === "Variant") code = `variant ${decl.name}`
    else if (t?.sym) {
        const word = t.sym.kind === "local" ? (t.sym.mutable ? "var" : "let") : t.sym.kind === "this" ? "this" : t.sym.kind.replace("-", " ")
        code = `${word} ${t.sym.name === "it1" ? "it" : t.sym.name}${ty ? `: ${show(ty)}` : ""}`
    } else if (ty && ty.k !== "unknown") {
        code = show(ty)
    }
    if (code === null) return null
    if (t?.sym?.std || (decl && an.nodeFile.get(decl) === PRELUDE_URI)) note = "\n\n*prelude*"
    const docs = decl ? docComment(an, decl) : ""
    return {
        contents: { kind: "markdown", value: "```minscript\n" + code + "\n```" + (docs ? `\n\n${docs}` : "") + note },
        range: f.map.range(n.span),
    }
}

/** `///` lines directly above a declaration. */
function docComment(an: Analysis, decl: A.Node): string {
    const uri = an.nodeFile.get(decl)
    const f = uri ? an.files.get(uri) : undefined
    if (!f) return ""
    const lines: string[] = []
    let line = decl.span.line - 1
    const trivia = [...f.parsed.lex.trivia].filter((t) => t.kind === "doc").sort((a, b) => b.span.line - a.span.line)
    for (const t of trivia) {
        if (t.span.line !== line) continue
        lines.unshift(t.text.replace(/^\/\/\/\s?/, ""))
        line--
    }
    return lines.join("\n")
}

export function definition(an: Analysis, uri: string, pos: L.Position): L.Location[] {
    const f = an.files.get(uri)
    if (!f) return []
    const n = nodeAt(an, f, f.map.offset(pos))
    if (n === null) return []
    const t = target(an, n)
    if (!t?.decl) return []
    const loc = location(an, t.decl)
    return loc ? [loc] : []
}

export function references(an: Analysis, uri: string, pos: L.Position, includeDeclaration: boolean): L.Location[] {
    const f = an.files.get(uri)
    if (!f) return []
    const n = nodeAt(an, f, f.map.offset(pos))
    const t = n ? target(an, n) : null
    if (!t?.sym) return []
    const out: L.Location[] = []
    if (includeDeclaration && t.sym.decl) {
        const loc = location(an, t.sym.decl)
        if (loc) out.push(loc)
    }
    for (const [node, sym] of an.res.refs) {
        if (sym !== t.sym) continue
        const loc = location(an, node)
        if (loc) out.push(loc)
    }
    return out
}

export function documentSymbols(an: Analysis, uri: string): L.DocumentSymbol[] {
    const f = an.files.get(uri)
    if (!f) return []
    const sym = (name: string, kind: L.SymbolKind, node: A.Node, children: L.DocumentSymbol[] = [], detail?: string): L.DocumentSymbol => ({
        name, kind, detail, range: f.map.range(node.span), selectionRange: f.map.range(nameSpan(node, f.text) ?? node.span), children,
    })
    const fun = (m: A.FunDecl, kind: L.SymbolKind) => sym(m.name, kind, m, [], signature(m).replace(/^.*?fun \S+?(?=[[(])/, ""))
    const out: L.DocumentSymbol[] = []
    for (const item of f.parsed.file.items) {
        switch (item.kind) {
            case "FunDecl": out.push(fun(item, 12)); break                                  // Function
            case "TypeDecl": {
                const children = item.body.kind === "StructBody"
                    ? [...item.body.fields.map((x) => sym(x.name, 8, x, [], typeText(x.type))), ...item.body.methods.map((m) => fun(m, 6))]   // Field, Method
                    : []
                out.push(sym(item.name, item.body.kind === "StructBody" ? 23 : 26, item, children))   // Struct / TypeParameter
                break
            }
            case "UnionDecl":
                out.push(sym(item.name, 10, item, [...item.variants.map((v) => sym(v.name, 22, v)), ...item.methods.map((m) => fun(m, 6))]))   // Enum, EnumMember
                break
            case "InterDecl": out.push(sym(item.name, 11, item, (item.methods ?? []).map((m) => fun(m, 6)))); break   // Interface
            case "ImplDecl": out.push(sym(`impl ${[...item.interfaces.map(typeText), ""].join(", ").replace(/, $/, item.interfaces.length ? " for " : "")}${typeText(item.target)}`, 3, item, item.methods.map((m) => fun(m, 6)))); break  // Namespace
            case "LetDecl": out.push(sym(item.name, 14, item)); break                       // Constant
            case "ExternDecl": out.push(sym(`extern ${JSON.stringify(item.abi)}`, 3, item, item.funs.map((m) => fun(m, 12)))); break
        }
    }
    return out
}

// ---- printing declarations --------------------------------------------------------------------

export function signature(f: A.FunDecl): string {
    const generics = f.generics.length ? `[${f.generics.map((g) => (g.bounds.length ? `${g.name}: ${g.bounds.map(typeText).join(" & ")}` : g.name)).join(", ")}]` : ""
    const params = [...(f.receiver ? [f.receiver] : []), ...f.params.map((p) => `${p.variadic ? "..." : ""}${p.mut ? "mut " : ""}${p.name}: ${typeText(p.type)}`)]
    return `${f.pub ? "pub " : ""}${f.async ? "async " : ""}fun ${f.name}${generics}(${params.join(", ")})${f.ret ? ` -> ${typeText(f.ret)}` : ""}`
}

export function typeText(t: A.Type): string {
    switch (t.kind) {
        case "TName": return t.path.join(".") + (t.args.length ? `[${t.args.map(typeText).join(", ")}]` : "")
        case "TOption": return `${typeText(t.inner)}?`
        case "TRef": return `&${t.mut ? "mut " : ""}${typeText(t.inner)}`
        case "TPtr": return `*${t.mut ? "mut " : ""}${typeText(t.inner)}`
        case "TTuple": return `t(${t.elems.map(typeText).join(", ")})`
        case "TRecord": return `r{ ${t.fields.map((f) => `${f.name}: ${typeText(f.type)}`).join(", ")} }`
        case "TFn": return `(${t.params.map(typeText).join(", ")}) -> ${typeText(t.ret)}`
        case "TTypeOf": return `TypeOf(${t.path.join(".")})`
        case "TLiteral": return typeof t.value === "string" ? JSON.stringify(t.value) : String(t.value)
        case "TUnion": return t.members.map(typeText).join(" | ")
        case "TIntersection": return t.members.map(typeText).join(" & ")
        case "TError": return "?"
    }
}
