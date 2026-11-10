// Editing features on top of the analysis: completion, signature help, inlay hints and rename. Like
// analysis.ts, nothing here is LSP plumbing (server.ts wraps it), so it works for any LSP client.
//
// Completion has to work while the code doesn't parse (`user.` with nothing after the dot). It
// analyses a copy of the document with a placeholder name at the cursor (`user.__ms_c`), and asks
// the checker what the expression before the dot can be followed by.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type * as L from "vscode-languageserver";
import type * as A from "../../src/ast.ts";
import type { MemberInfo } from "../../src/check.ts";
import { loadPrelude, STD_DIR } from "../../src/loader.ts";
import { projectOf } from "../../src/project.ts";
import type { Sym } from "../../src/resolve.ts";
import { KEYWORDS, RESERVED_KEYWORDS } from "../../src/token.ts";
import { ground, show as showRaw, type Ty } from "../../src/types.ts";

/** A type as an editor shows it: literal types defaulted (`{integer}` → `int`). */
const show = (t: Ty) => showRaw(ground(t));
import {
    analyze, callOf, docComment, location, nodeAt, paramText, references, signature, symType, target, typeOf, typeText,
    type Analysis, type Doc, type FileInfo, type Node,
} from "./analysis.ts";
import { fileURLToPath } from "node:url";

export const MARK = "__ms_c";

// LSP enum values (CompletionItemKind, InlayHintKind), inlined: this module only imports types
const K = { Method: 2, Function: 3, Field: 5, Variable: 6, Class: 7, Interface: 8, Module: 9, Keyword: 14, Folder: 19, EnumMember: 20, Constant: 21, Struct: 22, Enum: 13 } as const;
const TYPE_HINT = 1;

/** The string index of an LSP position (UTF-16 units, like JS strings). */
function indexOf(text: string, pos: L.Position): number {
    let i = 0;
    for (let line = 0; line < pos.line; line++) {
        const nl = text.indexOf("\n", i);
        if (nl < 0) return text.length;
        i = nl + 1;
    }
    return Math.min(i + pos.character, text.length);
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

// ---- completion ---------------------------------------------------------------------------------

export function completion(docs: Doc[], uri: string, pos: L.Position): L.CompletionItem[] {
    const doc = docs.find((d) => d.uri === uri);
    if (!doc) return [];
    const text = doc.text;
    const index = indexOf(text, pos);
    const lineStart = text.lastIndexOf("\n", index - 1) + 1;
    const before = text.slice(lineStart, index);

    const imp = /^\s*import\s+(?:pub\s+)?"([^"]*)$/.exec(before);
    if (imp) return importPaths(imp[1]!, uri);

    const word = /[A-Za-z_]\w*$/.exec(before)?.[0] ?? "";
    const start = index - word.length;
    const patched = text.slice(0, start) + MARK + openClosers(text.slice(0, start)) + text.slice(index);
    const an = analyze(docs.map((d) => (d.uri === uri ? { uri, text: patched } : d)), uri);
    const f = an.files.get(uri);
    if (!f) return [];
    const markAt = byteLength(patched.slice(0, start));
    if (text[start - 1] === ".") {
        const member = f.nodes.find((n) => n.kind === "Member" && n.name === MARK) as unknown as A.Member | undefined;
        return member ? memberItems(an, member.target) : [];
    }
    return scopeItems(an, f, markAt);
}

function memberItems(an: Analysis, object: A.Expr): L.CompletionItem[] {
    let ty = typeOf(an, object);
    if (ty === undefined) {
        const sym = an.res.refs.get(object);
        if (sym) ty = symType(an, sym);
    }
    if (ty === undefined) return [];
    return an.fe.checked.membersOf(ty).map((m) => memberItem(an, m));
}

function memberItem(an: Analysis, m: MemberInfo): L.CompletionItem {
    const kind = m.kind === "field" ? K.Field : m.kind === "variant" ? K.EnumMember : m.kind === "item" ? itemKind(m.sym) : m.kind === "static" ? K.Function : K.Method;
    const item: L.CompletionItem = { label: m.name, kind };
    const decl = m.decl;
    if (decl?.kind === "Fn") item.detail = signature(decl);
    else if (decl?.kind === "Field") item.detail = `${decl.name}: ${typeText(decl.type)}`;
    else if (m.kind === "auto") item.detail = "generated (spec §13.2)";
    else if (m.kind === "item" && m.sym) item.detail = detailOf(m.sym);
    const about = decl ? docComment(an, decl) : m.sym?.decl ? docComment(an, m.sym.decl) : "";
    if (about) item.documentation = { kind: "markdown", value: about };
    // fields and variants first, then methods, then the generated ones (sortText compares as text)
    item.sortText = `${m.kind === "field" || m.kind === "variant" ? "0" : m.kind === "auto" ? "2" : "1"}${m.name}`;
    return item;
}

function itemKind(sym: Sym | undefined): L.CompletionItemKind {
    switch (sym?.kind) {
        case "fn": case "extern-fn": return K.Function;
        case "type": return K.Struct;
        case "union": return K.Enum;
        case "inter": return K.Interface;
        case "global": return K.Constant;
        case "package": case "import": return K.Module;
        case "variant": return K.EnumMember;
        default: return K.Variable;
    }
}

const SCOPES: ReadonlySet<string> = new Set(["Block", "Fn", "Closure", "For", "If", "Match"]);

/**
 * Names visible at `offset`: locals of an enclosing scope declared before it, the package's items,
 * the file's imports, the prelude, and keywords.
 */
function scopeItems(an: Analysis, f: FileInfo, offset: number): L.CompletionItem[] {
    const items = new Map<string, L.CompletionItem>();
    const add = (label: string, kind: L.CompletionItemKind, detail?: string, sort = "1") => {
        if (label === MARK || label.startsWith("$") || items.has(label)) return;
        const item: L.CompletionItem = { label, kind, sortText: `${sort}${label}` };
        if (detail) item.detail = detail;
        items.set(label, item);
    };
    for (const sym of an.res.symbols) {
        if (!["local", "param", "closure-param", "this"].includes(sym.kind) || !sym.decl) continue;
        if (an.nodeFile.get(sym.decl) !== f.uri || sym.start >= offset) continue;
        let scope: Node | undefined = f.parent.get(sym.decl);
        while (scope && !SCOPES.has(scope.kind ?? "")) scope = f.parent.get(scope);
        if (scope && (offset < scope.span.start || offset > scope.span.end)) continue;
        const ty = symType(an, sym);
        add(sym.name, K.Variable, ty ? `${sym.mutable ? "var" : "let"} ${sym.name}: ${show(ty)}` : undefined, "0");
    }
    for (const [name, sym] of an.res.items) add(name, itemKind(sym), detailOf(sym));
    for (const sym of an.res.symbols) {
        if ((sym.kind === "package" || sym.kind === "import") && sym.file === f.path) add(sym.name, itemKind(sym), undefined);
    }
    for (const [name, sym] of loadPrelude().res.exports) if (!name.startsWith("_")) add(name, itemKind(sym), detailOf(sym), "2");
    for (const v of ["Some", "None", "Ok", "Err"]) add(v, K.EnumMember, "prelude variant", "2");
    for (const kw of KEYWORDS) if (!RESERVED_KEYWORDS.has(kw) && kw !== "fun" && kw !== "mut") add(kw, K.Keyword, undefined, "3");
    return [...items.values()];
}

function detailOf(sym: Sym): string | undefined {
    const d = sym.decl as Node | null;
    switch (d?.kind) {
        case "Fn": return signature(d as unknown as A.FnDecl);
        case "TypeDecl": return `type ${d.name}`;
        case "UnionDecl": return `union ${d.name}`;
        case "InterDecl": return `inter ${d.name}`;
        default: return undefined;
    }
}

/** `import "std.` → std packages; `"app.` → folders under main; `path:` dependencies. */
function importPaths(typed: string, uri: string): L.CompletionItem[] {
    const dot = typed.lastIndexOf(".");
    const parent = dot < 0 ? "" : typed.slice(0, dot);
    const segs = parent === "" ? [] : parent.split(".");
    const roots = new Map<string, string>([["std", STD_DIR]]);
    const project = uri.startsWith("file:") ? projectOf(fileURLToPath(uri)) : null;
    if (project) {
        roots.set("app", project.project.main);
        for (const [name, dir] of project.project.deps) roots.set(name, dir);
    }
    if (segs.length === 0) return [...roots.keys()].map((label) => ({ label, kind: K.Module }));
    const root = roots.get(segs[0]!);
    if (root === undefined) return [];
    const dir = join(root, ...segs.slice(1));
    let entries: string[] = [];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }
    const out: L.CompletionItem[] = [];
    for (const e of entries.sort()) {
        try {
            if (statSync(join(dir, e)).isDirectory() && !e.startsWith(".") && e !== "node_modules") out.push({ label: e, kind: K.Folder });
        } catch {
            // gone
        }
    }
    return out;
}

// ---- signature help -----------------------------------------------------------------------------

export function signatureHelp(docs: Doc[], uri: string, pos: L.Position): L.SignatureHelp | null {
    const doc = docs.find((d) => d.uri === uri);
    if (!doc) return null;
    const index = indexOf(doc.text, pos);
    // a placeholder argument, and the closers of what is still open, keep `f(a, ` parseable; where an
    // argument is already written (`f(|x)`), the text is left alone
    const next = /^\s*(.?)/.exec(doc.text.slice(index))![1]!;
    const missing = next === "" || next === ")" || next === "," || next === "\n";
    const patched = missing ? doc.text.slice(0, index) + MARK + openClosers(doc.text.slice(0, index)) + doc.text.slice(index) : doc.text;
    const an = analyze(docs.map((d) => (d.uri === uri ? { uri, text: patched } : d)), uri);
    const f = an.files.get(uri);
    if (!f) return null;
    const offset = byteLength(patched.slice(0, index));
    let call: A.Call | null = null;
    for (const n of f.nodes) {
        if (n.kind !== "Call") continue;
        const c = n as unknown as A.Call;
        if (offset <= c.callee.span.end || offset > c.span.end) continue;
        if (call === null || c.span.end - c.span.start < call.span.end - call.span.start) call = c;
    }
    if (call === null) return null;
    const callee = call.callee.kind === "GenericApply" ? call.callee.target : call.callee;
    const t = callOf(an, call)?.target;
    const decl = (t && (t.kind === "fn" || t.kind === "method" || t.kind === "static") ? t.decl : target(an, callee as unknown as Node)?.decl) as A.FnDecl | null | undefined;
    if (!decl || decl.kind !== "Fn") return null;

    const params = decl.params.map(paramText);
    let label = `${decl.isAsync ? "async " : ""}fn ${decl.name}(`;
    const ranges: [number, number][] = [];
    params.forEach((p, i) => {
        if (i > 0) label += ", ";
        ranges.push([label.length, label.length + p.length]);
        label += p;
    });
    label += `)${decl.ret ? ` -> ${decl.retStar ? "*" : ""}${typeText(decl.ret)}` : ""}`;
    const between = patched.slice(indexOfByte(patched, call.callee.span.end), index);
    let active = topLevelCommas(between);
    const variadic = decl.params.findIndex((p) => p.variadic);
    if (variadic >= 0 && active > variadic) active = variadic;
    const about = docComment(an, decl);
    const sig: L.SignatureInformation = { label, parameters: ranges.map((r) => ({ label: r })) };
    if (about) sig.documentation = { kind: "markdown", value: about };
    return { signatures: [sig], activeSignature: 0, activeParameter: Math.min(active, Math.max(0, params.length - 1)) };
}

/**
 * What would close the brackets still open at the end of `before`, back to the innermost open
 * block. A block's `{` ends its header line (E_OPEN_BRACE_NEWLINE), so a `{` with more on its line
 * is inline (a closure `#{`, a literal) and is closed too. Strings and comments are skipped.
 */
function openClosers(before: string): string {
    const stack: string[] = []; // "(", "[", "{" (inline) or "B" (a block)
    for (let i = 0; i < before.length; i++) {
        const c = before[i];
        if (c === "/" && before[i + 1] === "/") {
            const nl = before.indexOf("\n", i);
            if (nl < 0) break;
            i = nl;
            continue;
        }
        if (c === "\"") {
            for (i++; i < before.length && before[i] !== "\"" && before[i] !== "\n"; i++) if (before[i] === "\\") i++;
            continue;
        }
        if (c === "(" || c === "[") stack.push(c);
        else if (c === "{") {
            const nl = before.indexOf("\n", i + 1);
            const rest = before.slice(i + 1, nl < 0 ? before.length : nl);
            stack.push(nl >= 0 && rest.trim() === "" ? "B" : "{");
        } else if ((c === ")" || c === "]" || c === "}") && stack.length > 0) stack.pop();
    }
    let out = "";
    for (let i = stack.length - 1; i >= 0 && stack[i] !== "B"; i--) out += stack[i] === "(" ? ")" : stack[i] === "[" ? "]" : " }";
    return out;
}

/** The string index of a UTF-8 byte offset. */
function indexOfByte(text: string, byte: number): number {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        if (bytes >= byte) return i;
        const c = text.codePointAt(i)!;
        bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        if (c >= 0x10000) i++;
    }
    return text.length;
}

/** Commas between `(` and the cursor that separate this call's arguments (not nested calls'). */
function topLevelCommas(s: string): number {
    let depth = 0;
    let n = 0;
    let inString = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inString) {
            if (c === "\\") i++;
            else if (c === "\"") inString = false;
            continue;
        }
        if (c === "\"") inString = true;
        else if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (c === "," && depth === 1) n++;
    }
    return n;
}

// ---- inlay hints --------------------------------------------------------------------------------

/** Inferred types where the code doesn't write one: `let` / `var` / `:=` without a type, closure parameters, `for` bindings. */
export function inlayHints(an: Analysis, uri: string, range: L.Range): L.InlayHint[] {
    const f = an.files.get(uri);
    if (!f) return [];
    const from = f.map.offset(range.start);
    const to = f.map.offset(range.end);
    const out: L.InlayHint[] = [];
    const hint = (node: object, nameStart: number, name: string) => {
        const sym = an.res.decls.get(node);
        const ty = sym ? symType(an, sym) : undefined;
        if (!ty || !worthShowing(ty)) return;
        const end = nameStart + byteLength(name);
        if (end < from || end > to) return;
        out.push({ position: f.map.position(end), label: `: ${show(ty)}`, kind: TYPE_HINT, paddingLeft: false });
    };
    for (const n of f.nodes) {
        const k = n.k as { kind?: string } | undefined;
        void k;
        switch (n.kind) {
            case "LetStmt": {
                const s = n as unknown as A.LetStmt;
                if (s.type === null && s.pattern.kind === "PBind" && !OBVIOUS.has(s.value.kind)) hint(s.pattern, s.pattern.span.start, s.pattern.name);
                break;
            }
            case "VarStmt": {
                const s = n as unknown as A.VarStmt;
                if (s.type === null && !OBVIOUS.has(s.value.kind)) hint(s, nameStartIn(f, s.span.start, s.name), s.name);
                break;
            }
            case "ShortDecl": {
                const s = n as unknown as A.ShortDecl;
                if (!OBVIOUS.has(s.value.kind)) hint(s, s.span.start, s.name);
                break;
            }
            case "Closure": {
                const c = n as unknown as A.Closure;
                for (const p of c.params ?? []) if (p.type === null && p.name !== "_") hint(p, nameStartIn(f, p.span.start, p.name), p.name);
                break;
            }
            case "For": {
                const fr = n as unknown as A.For;
                if (fr.form !== "in") break;
                if (fr.pattern?.kind === "PBind") hint(fr.pattern, nameStartIn(f, fr.pattern.span.start, fr.pattern.name), fr.pattern.name);
                if (fr.pattern2?.kind === "PBind") hint(fr.pattern2, nameStartIn(f, fr.pattern2.span.start, fr.pattern2.name), fr.pattern2.name);
                break;
            }
        }
    }
    return out.sort((a, b) => a.position.line - b.position.line || a.position.character - b.position.character);
}

/** The byte offset of `name` at or after `start` (past `var ` and the like). */
function nameStartIn(f: FileInfo, start: number, name: string): number {
    const bytes = new TextEncoder().encode(f.text);
    const tail = new TextDecoder().decode(bytes.subarray(start, Math.min(bytes.length, start + 200)));
    const m = new RegExp(`\\b${name}\\b`).exec(tail);
    return m ? start + byteLength(tail.slice(0, m.index)) : start;
}

/** Not where the value already says the type: `User { … }`, literals, `as T`. */
const OBVIOUS: ReadonlySet<string> = new Set(["Struct", "Str", "Int", "Float", "Bool", "Char", "Byte", "As", "Template"]);

function worthShowing(t: Ty): boolean {
    const s = show(t);
    return !s.includes("unknown") && !/\b_\b/.test(s) && !s.includes("{integer}") && !s.includes("{float}");
}

// ---- rename -------------------------------------------------------------------------------------

const RENAMABLE: ReadonlySet<string> = new Set(["local", "param", "closure-param", "fn", "global", "type", "union", "inter"]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The name under the cursor, if it can be renamed: declared in this package, not `this` / `it`. */
export function prepareRename(an: Analysis, uri: string, pos: L.Position): { range: L.Range; placeholder: string } | null {
    const r = renameTarget(an, uri, pos);
    return r === null ? null : { range: r.range, placeholder: r.sym.name };
}

function renameTarget(an: Analysis, uri: string, pos: L.Position): { sym: Sym; range: L.Range } | null {
    const f = an.files.get(uri);
    if (!f) return null;
    const n = nodeAt(an, f, f.map.offset(pos));
    const sym = n ? target(an, n)?.sym : undefined;
    if (!n || !sym || !RENAMABLE.has(sym.kind) || /^it\d*$/.test(sym.name)) return null;
    if (!sym.decl || !an.files.has(an.nodeFile.get(sym.decl) ?? "")) return null; // declared outside this package
    const loc = location(an, n);
    return loc ? { sym, range: loc.range } : null;
}

export function rename(an: Analysis, uri: string, pos: L.Position, newName: string): L.WorkspaceEdit | null {
    const r = renameTarget(an, uri, pos);
    if (r === null) return null;
    if (!IDENT.test(newName) || KEYWORDS.has(newName)) throw new Error(`\`${newName}\` isn't a valid name`);
    const changes: Record<string, L.TextEdit[]> = {};
    for (const loc of references(an, uri, pos, true)) (changes[loc.uri] ??= []).push({ range: loc.range, newText: newName });
    // `User { name }` uses a local through the field shorthand: keep the field, rename the local
    for (const [node, sym] of an.res.refs) {
        const item = node as { kind?: string; value?: unknown; name?: string; quoted?: boolean };
        if (sym !== r.sym || item.kind !== "Field" || item.value !== null || item.quoted === undefined) continue;
        const loc = location(an, node);
        if (!loc) continue;
        const list = changes[loc.uri] ?? [];
        const i = list.findIndex((e) => e.range.start.line === loc.range.start.line && e.range.start.character === loc.range.start.character);
        if (i >= 0) list[i] = { range: list[i]!.range, newText: `${item.name}: ${newName}` };
    }
    return { changes };
}
