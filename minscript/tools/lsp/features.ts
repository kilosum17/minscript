// Editing features on top of the analysis: completion, signature help, inlay hints and rename.
// Like analysis.ts, nothing here is LSP plumbing (server.ts wraps it), so it works for any LSP client.
//
// Completion has to work while the code doesn't parse (`user.` with nothing after the dot). It
// analyses a copy of the document with a placeholder name at the cursor (`user.__ms_c`), and asks
// the checker what the expression before the dot can be followed by.

import type * as L from "vscode-languageserver"
import type * as A from "../../src/ast.ts"
import { KEYWORDS, RESERVED_KEYWORDS } from "../../src/token.ts"
import { loadPrelude } from "../../src/prelude.ts"
import type { Sym } from "../../src/resolve.ts"
import { show, type Ty } from "../../src/types.ts"
import { STD_DIR } from "../../src/loader.ts"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import {
    analyze, docComment, location, nodeAt, references, signature, target, typeText,
    type Analysis, type Doc, type FileInfo, type ProjectInfo,
} from "./analysis.ts"

export const MARK = "__ms_c"

// LSP enum values (CompletionItemKind, InlayHintKind), inlined: this module only imports types
const K = { Method: 2, Function: 3, Field: 5, Variable: 6, Class: 7, Interface: 8, Module: 9, Keyword: 14, Folder: 19, EnumMember: 20, Constant: 21, Struct: 22, TypeParameter: 25, Enum: 13 } as const
const TYPE_HINT = 1

/** The string index of an LSP position (UTF-16 units, like JS strings). */
function indexOf(text: string, pos: L.Position): number {
    let i = 0
    for (let line = 0; line < pos.line; line++) {
        const nl = text.indexOf("\n", i)
        if (nl < 0) return text.length
        i = nl + 1
    }
    return Math.min(i + pos.character, text.length)
}

const byteLength = (s: string) => new TextEncoder().encode(s).length

// ---- completion ---------------------------------------------------------------------------------

export function completion(docs: Doc[], uri: string, pos: L.Position, project: ProjectInfo | null = null): L.CompletionItem[] {
    const doc = docs.find((d) => d.uri === uri)
    if (!doc) return []
    const text = doc.text
    const index = indexOf(text, pos)
    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const before = text.slice(lineStart, index)

    const imp = /^\s*import\s+(?:pub\s+)?"([^"]*)$/.exec(before)
    if (imp) return importPaths(imp[1]!, project)

    const word = /[A-Za-z_][\w]*$/.exec(before)?.[0] ?? ""
    const start = index - word.length
    const patched = text.slice(0, start) + MARK + openClosers(text.slice(0, start)) + text.slice(index)
    const an = analyze(docs.map((d) => (d.uri === uri ? { uri, text: patched } : d)), uri, project)
    const f = an.files.get(uri)
    if (!f) return []
    const markAt = byteLength(patched.slice(0, start))
    const mark = f.nodes.find((n) => n.span.start === markAt && (n.kind === "Member" || n.kind === "OptMember" || n.kind === "Ident"))
        ?? f.nodes.find((n) => (n.kind === "Member" || n.kind === "OptMember") && n.name === MARK)

    if (text[start - 1] === "." && mark && (mark.kind === "Member" || mark.kind === "OptMember")) {
        return memberItems(an, mark.object)
    }
    if (text[start - 1] === ".") {
        const member = f.nodes.find((n): n is A.Node & { kind: "Member", object: A.Expr } => n.kind === "Member" && n.name === MARK)
        return member ? memberItems(an, member.object) : []
    }
    return scopeItems(an, f, markAt)
}

function memberItems(an: Analysis, object: A.Expr): L.CompletionItem[] {
    let ty = an.checked.types.get(object)
    if (ty === undefined) {
        const sym = an.res.refs.get(object)
        if (sym) ty = an.checked.symbols.get(sym)
    }
    if (ty === undefined) return []
    return an.checked.membersOf(ty).map((m) => {
        const decl = m.decl
        const item: L.CompletionItem = { label: m.name, kind: m.kind === "field" ? K.Field : m.kind === "variant" ? K.EnumMember : m.kind === "item" ? itemKind(m.sym) : m.kind === "static" ? K.Function : K.Method }
        if (decl?.kind === "FunDecl") item.detail = signature(decl)
        else if (decl?.kind === "Field") item.detail = `${decl.name}: ${typeText(decl.type)}`
        else if (decl === null && m.kind === "method") item.detail = "auto-generated (spec §9.7)"
        const docs = decl ? docComment(an, decl) : ""
        if (docs) item.documentation = { kind: "markdown", value: docs }
        // methods last, so fields come first (sortText is compared as text)
        item.sortText = `${m.kind === "field" || m.kind === "variant" ? "0" : decl === null ? "2" : "1"}${m.name}`
        return item
    })
}

function itemKind(sym: Sym | undefined): L.CompletionItemKind {
    switch (sym?.kind) {
        case "fun": case "extern-fun": return K.Function
        case "type": return K.Struct
        case "union": return K.Enum
        case "inter": return K.Interface
        case "global": return K.Constant
        case "package": return K.Module
        default: return K.Variable
    }
}

const SCOPE_NODES: ReadonlySet<string> = new Set(["Block", "FunDecl", "Closure", "For", "MatchArm", "If", "SelectArm"])

/** Names visible at `offset`: locals in an enclosing scope declared before it, the package's items,
 *  the file's imports, the prelude, and keywords. */
function scopeItems(an: Analysis, f: FileInfo, offset: number): L.CompletionItem[] {
    const items = new Map<string, L.CompletionItem>()
    const add = (label: string, kind: L.CompletionItemKind, detail?: string, sort = "1") => {
        if (label === MARK || label.startsWith("$") || items.has(label)) return
        items.set(label, { label, kind, ...(detail ? { detail } : {}), sortText: `${sort}${label}` })
    }
    for (const sym of an.res.symbols) {
        if (!["local", "param", "closure-param", "this"].includes(sym.kind) || !sym.decl || !sym.span) continue
        if (an.nodeFile.get(sym.decl) !== f.uri || sym.span.start >= offset) continue
        let scope: A.Node | undefined = f.parent.get(sym.decl)
        while (scope && !SCOPE_NODES.has(scope.kind)) scope = f.parent.get(scope)
        if (scope && (offset < scope.span.start || offset > scope.span.end)) continue
        const ty = an.checked.symbols.get(sym)
        add(sym.name, K.Variable, ty ? `${sym.mutable ? "var" : "let"} ${sym.name}: ${show(ty)}` : undefined, "0")
    }
    for (const [name, sym] of an.res.pkgScope.names) add(name, itemKind(sym), detailOf(sym))
    for (const sym of an.res.symbols) if ((sym.kind === "package" || sym.kind === "import") && sym.decl && an.nodeFile.get(sym.decl) === f.uri) add(sym.name, sym.kind === "package" ? K.Module : K.Variable, sym.detail)
    for (const [name, sym] of loadPrelude().res.pkgScope.names) if (sym.pub && !name.startsWith("_")) add(name, itemKind(sym), detailOf(sym), "2")
    for (const v of ["Some", "None", "Ok", "Err"]) add(v, K.EnumMember, "prelude variant", "2")
    for (const kw of KEYWORDS) if (!RESERVED_KEYWORDS.has(kw)) add(kw, K.Keyword, undefined, "3")
    return [...items.values()]
}

function detailOf(sym: Sym): string | undefined {
    const d = sym.decl
    if (d?.kind === "FunDecl") return signature(d)
    if (d?.kind === "TypeDecl") return `type ${d.name}`
    if (d?.kind === "UnionDecl") return `union ${d.name}`
    if (d?.kind === "InterDecl") return `inter ${d.name}`
    return undefined
}

/** `import "std.` → std packages; `"app.` → folders under main; `path:` dependencies. */
function importPaths(typed: string, project: ProjectInfo | null): L.CompletionItem[] {
    const dot = typed.lastIndexOf(".")
    const parent = dot < 0 ? "" : typed.slice(0, dot)
    const segs = parent === "" ? [] : parent.split(".")
    const roots = new Map<string, string>([["std", STD_DIR]])
    if (project) {
        roots.set("app", project.mainDir)
        for (const [name, dir] of project.deps) roots.set(name, dir)
    }
    if (segs.length === 0) return [...roots.keys()].map((label) => ({ label, kind: K.Module }))
    const root = roots.get(segs[0]!)
    if (root === undefined) return []
    const dir = join(root, ...segs.slice(1))
    const out: L.CompletionItem[] = []
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return [] }
    for (const e of entries.sort()) {
        try {
            if (statSync(join(dir, e)).isDirectory() && !e.startsWith(".") && e !== "node_modules") out.push({ label: e, kind: K.Folder })
        } catch { /* gone */ }
    }
    return out
}

// ---- signature help -----------------------------------------------------------------------------

export function signatureHelp(docs: Doc[], uri: string, pos: L.Position, project: ProjectInfo | null = null): L.SignatureHelp | null {
    const doc = docs.find((d) => d.uri === uri)
    if (!doc) return null
    const index = indexOf(doc.text, pos)
    // a placeholder argument, and the closers of what is still open, keep `f(a, ` parseable
    const patched = doc.text.slice(0, index) + MARK + openClosers(doc.text.slice(0, index)) + doc.text.slice(index)
    const an = analyze(docs.map((d) => (d.uri === uri ? { uri, text: patched } : d)), uri, project)
    const f = an.files.get(uri)
    if (!f) return null
    const offset = byteLength(patched.slice(0, index))
    let call: (A.Node & { kind: "Call" }) | null = null
    for (const n of f.nodes) {
        if (n.kind !== "Call" || offset <= n.callee.span.end || offset > n.span.end) continue
        if (call === null || n.span.end - n.span.start < call.span.end - call.span.start) call = n
    }
    if (call === null) return null
    const callee = call.callee.kind === "GenericApply" ? call.callee.target : call.callee
    const t = an.checked.calls.get(call)?.target
    const decl = t && (t.kind === "fun" || t.kind === "method" || t.kind === "static") ? t.decl : target(an, callee)?.decl
    if (!decl || decl.kind !== "FunDecl") return null

    const params = decl.params.map((p) => `${p.variadic ? "..." : ""}${p.name}: ${typeText(p.type)}`)
    const head = `${decl.async ? "async " : ""}fun ${decl.name}(`
    let label = head
    const ranges: [number, number][] = []
    params.forEach((p, i) => {
        if (i > 0) label += ", "
        ranges.push([label.length, label.length + p.length])
        label += p
    })
    label += `)${decl.ret ? ` -> ${typeText(decl.ret)}` : ""}`
    const between = patched.slice(indexOfByte(patched, call.callee.span.end), index)
    let active = topLevelCommas(between)
    const variadic = decl.params.findIndex((p) => p.variadic)
    if (variadic >= 0 && active > variadic) active = variadic
    const about = docComment(an, decl)
    return {
        signatures: [{
            label,
            parameters: ranges.map((r) => ({ label: r })),
            ...(about ? { documentation: { kind: "markdown", value: about } } : {}),
        }],
        activeSignature: 0,
        activeParameter: Math.min(active, Math.max(0, params.length - 1)),
    }
}

/** What would close the brackets still open at the end of `before`, back to the innermost open
 *  block. A block's `{` ends its header line (E_OPEN_BRACE_NEWLINE), so a `{` with more on its line
 *  is inline (a closure `#{`, a literal) and is closed too. Strings and comments are skipped. */
function openClosers(before: string): string {
    const stack: string[] = []          // "(", "[", "{" (inline) or "B" (a block)
    for (let i = 0; i < before.length; i++) {
        const c = before[i]
        if (c === "/" && before[i + 1] === "/") { const nl = before.indexOf("\n", i); if (nl < 0) break; i = nl; continue }
        if (c === "\"") {
            for (i++; i < before.length && before[i] !== "\"" && before[i] !== "\n"; i++) if (before[i] === "\\") i++
            continue
        }
        if (c === "(" || c === "[") stack.push(c)
        else if (c === "{") {
            const nl = before.indexOf("\n", i + 1)
            const rest = before.slice(i + 1, nl < 0 ? before.length : nl)
            stack.push(nl >= 0 && rest.trim() === "" ? "B" : "{")
        } else if ((c === ")" || c === "]" || c === "}") && stack.length > 0) stack.pop()
    }
    let out = ""
    for (let i = stack.length - 1; i >= 0 && stack[i] !== "B"; i--) out += stack[i] === "(" ? ")" : stack[i] === "[" ? "]" : " }"
    return out
}

/** The string index of a UTF-8 byte offset. */
function indexOfByte(text: string, byte: number): number {
    let bytes = 0
    for (let i = 0; i < text.length; i++) {
        if (bytes >= byte) return i
        const c = text.codePointAt(i)!
        bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
        if (c >= 0x10000) i++
    }
    return text.length
}

/** Commas between `(` and the cursor that separate arguments of this call (not of nested ones). */
function topLevelCommas(s: string): number {
    let depth = 0, n = 0, inString = false
    for (let i = 0; i < s.length; i++) {
        const c = s[i]
        if (inString) { if (c === "\\") i++; else if (c === "\"") inString = false; continue }
        if (c === "\"") inString = true
        else if (c === "(" || c === "[" || c === "{") depth++
        else if (c === ")" || c === "]" || c === "}") depth--
        else if (c === "," && depth === 1) n++
    }
    return n
}

// ---- inlay hints --------------------------------------------------------------------------------

/** Inferred types where the code doesn't write one: `let` / `:=` without a type, closure
 *  parameters, `for` bindings. */
export function inlayHints(an: Analysis, uri: string, range: L.Range): L.InlayHint[] {
    const f = an.files.get(uri)
    if (!f) return []
    const from = f.map.offset(range.start), to = f.map.offset(range.end)
    const out: L.InlayHint[] = []
    const hint = (node: A.Node, name: string) => {
        const sym = an.res.decls.get(node)
        const ty = sym ? an.checked.symbols.get(sym) : undefined
        if (!ty || !worthShowing(ty)) return
        const end = node.span.start + byteLength(name)
        if (end < from || end > to) return
        out.push({ position: f.map.position(end), label: `: ${show(ty)}`, kind: TYPE_HINT, paddingLeft: false })
    }
    for (const n of f.nodes) {
        // not where the value already says the type: `User { … }`, literals, `as T`
        if (n.kind === "Let" && n.type === null && n.pattern.kind === "PBind" && !OBVIOUS.has(n.value.kind)) hint(n.pattern, n.pattern.name)
        else if (n.kind === "ClosureParam" && n.type === null) hint(n, n.name)
        else if (n.kind === "For" && n.form === "in") {
            if (n.pattern?.kind === "PBind") hint(n.pattern, n.pattern.name)
            if (n.pattern2?.kind === "PBind") hint(n.pattern2, n.pattern2.name)
        }
    }
    return out.sort((a, b) => a.position.line - b.position.line || a.position.character - b.position.character)
}

const OBVIOUS: ReadonlySet<string> = new Set(["StructLit", "Str", "Int", "Float", "Bool", "Char", "As", "Template"])

function worthShowing(t: Ty): boolean {
    const s = show(t)
    return !s.includes("unknown") && !/\b_\b/.test(s) && !s.includes("{integer}") && !s.includes("{float}")
}

// ---- rename -------------------------------------------------------------------------------------

const RENAMABLE: ReadonlySet<string> = new Set(["local", "param", "closure-param", "fun", "global", "type", "union", "inter"])
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The name under the cursor, if it can be renamed: declared in this package, not `this` / `it`. */
export function prepareRename(an: Analysis, uri: string, pos: L.Position): { range: L.Range, placeholder: string } | null {
    const r = renameTarget(an, uri, pos)
    if (r === null) return null
    return { range: r.range, placeholder: r.sym.name }
}

function renameTarget(an: Analysis, uri: string, pos: L.Position): { sym: Sym, range: L.Range } | null {
    const f = an.files.get(uri)
    if (!f) return null
    const n = nodeAt(an, f, f.map.offset(pos))
    const t = n ? target(an, n) : null
    const sym = t?.sym
    if (!n || !sym || !RENAMABLE.has(sym.kind) || sym.std || /^it\d*$/.test(sym.name)) return null
    if (!sym.decl || !an.files.has(an.nodeFile.get(sym.decl) ?? "")) return null      // declared outside this package
    const loc = location(an, n)
    return loc ? { sym, range: loc.range } : null
}

export function rename(an: Analysis, uri: string, pos: L.Position, newName: string): L.WorkspaceEdit | null {
    const r = renameTarget(an, uri, pos)
    if (r === null) return null
    if (!IDENT.test(newName) || (KEYWORDS as readonly string[]).includes(newName)) {
        throw new Error(`\`${newName}\` isn't a valid name`)
    }
    const changes: Record<string, L.TextEdit[]> = {}
    const edit = (loc: L.Location, text: string) => { (changes[loc.uri] ??= []).push({ range: loc.range, newText: text }) }
    for (const loc of references(an, uri, pos, true)) edit(loc, newName)
    // `User { name }` uses a local through the field shorthand: keep the field, rename the local
    for (const [node, sym] of an.res.refs) {
        if (sym !== r.sym || node.kind !== "RecordField" || node.value !== null) continue
        const loc = location(an, node)
        if (!loc) continue
        const list = changes[loc.uri] ?? []
        const i = list.findIndex((e) => e.range.start.line === loc.range.start.line && e.range.start.character === loc.range.start.character)
        if (i >= 0) list[i] = { range: list[i]!.range, newText: `${node.key}: ${newName}` }
    }
    return { changes }
}

