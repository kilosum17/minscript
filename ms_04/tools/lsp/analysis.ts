// The language server's analysis: runs the whole front end (src/pipeline.ts) on the package of a
// file and answers editor questions from the passes' side tables. No LSP plumbing here, so it is
// tested directly (analysis.test.ts); server.ts wraps it.
//
// - The edited file's package is loaded with everything it imports (src/loader.ts); open editors
//   override the files on disk (the loader's `virtual` files). The package's `*_test.ms` files are
//   included. In a project, the evaluated mod.ms says where `main` is (src/project.ts).
// - Positions: the compiler's spans are UTF-8 byte offsets; LSP positions are 0-based lines and
//   UTF-16 columns. `PositionMap` converts between them.

import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as L from "vscode-languageserver";
import type * as A from "../../src/ast.ts";
import type { CheckResult, MemberTarget } from "../../src/check.ts";
import type { Diagnostic } from "../../src/diagnostic.ts";
import { lex } from "../../src/lexer.ts";
import { loadPrelude, STD_DIR, type LoadedPackage } from "../../src/loader.ts";
import { frontEnd, type FrontEnd } from "../../src/pipeline.ts";
import type { Resolution, Sym } from "../../src/resolve.ts";
import { ground, show as showRaw, type Ty } from "../../src/types.ts";

/** A type as an editor shows it: literal types defaulted (`{integer}` → `int`). */
const show = (t: Ty) => showRaw(ground(t));

export interface Doc {
    uri: string;
    text: string;
}

const decoder = new TextDecoder();
const byteLength = (s: string) => new TextEncoder().encode(s).length;

// ---- positions --------------------------------------------------------------------------------

export class PositionMap {
    private readonly text: string;
    /** byte offset → UTF-16 index (at code point boundaries) */
    private readonly byteToUnit: Uint32Array;
    /** UTF-16 index → byte offset */
    private readonly unitToByte: Uint32Array;
    /** UTF-16 index of each line start */
    private readonly lineStarts: number[] = [0];

    constructor(text: string) {
        this.text = text;
        const bytes = byteLength(text);
        this.byteToUnit = new Uint32Array(bytes + 1);
        this.unitToByte = new Uint32Array(text.length + 1);
        let b = 0;
        for (let u = 0; u < text.length; u++) {
            this.unitToByte[u] = b;
            this.byteToUnit[b] = u;
            const c = text.charCodeAt(u);
            if (c === 0x0a) this.lineStarts.push(u + 1);
            if (c < 0x80) b += 1;
            else if (c < 0x800) b += 2;
            else if (c >= 0xd800 && c <= 0xdbff) {
                b += 4;
                this.unitToByte[u + 1] = b;
                u++;
            } else b += 3;
        }
        this.unitToByte[text.length] = b;
        this.byteToUnit[b] = text.length;
    }

    position(byteOffset: number): L.Position {
        const unit = this.byteToUnit[Math.min(byteOffset, this.byteToUnit.length - 1)] ?? this.text.length;
        let lo = 0;
        let hi = this.lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.lineStarts[mid]! <= unit) lo = mid;
            else hi = mid - 1;
        }
        return { line: lo, character: unit - this.lineStarts[lo]! };
    }

    range(span: { start: number; end: number }): L.Range {
        return { start: this.position(span.start), end: this.position(Math.max(span.end, span.start)) };
    }

    offset(pos: L.Position): number {
        const start = this.lineStarts[Math.min(pos.line, this.lineStarts.length - 1)] ?? 0;
        const unit = Math.min(start + pos.character, this.text.length);
        return this.unitToByte[unit] ?? 0;
    }

    /** The 0-based line of a byte offset. */
    lineOf(byteOffset: number): number {
        return this.position(byteOffset).line;
    }
}

// ---- package analysis -------------------------------------------------------------------------

/** Any node with a span: AST nodes with a `kind`, and parameters, arms, elements without one. */
export type Node = { span: A.Span; kind?: string; [k: string]: unknown };

export interface FileInfo {
    uri: string;
    path: string;
    text: string;
    ast: A.File;
    map: PositionMap;
    /** every node, for position lookups */
    nodes: Node[];
    /** the node directly containing each node */
    parent: Map<object, Node>;
}

export interface Analysis {
    /** the files of the edited package */
    files: Map<string, FileInfo>;
    res: Resolution;
    checked: CheckResult;
    fe: FrontEnd;
    /** LSP diagnostics per file URI (every file of the package has an entry, possibly empty) */
    diagnostics: Map<string, L.Diagnostic[]>;
    /** which file each node (of the package, the packages it imports, and the prelude) is in */
    nodeFile: Map<object, string>;
    /** the files of imported packages and the prelude, and the package each is in */
    others: Map<string, FileInfo>;
    packageOf: Map<string, string>;
}

export const PRELUDE_URI = pathToFileURL(`${STD_DIR}/prelude.ms`).href;

export function fileFor(an: Analysis, uri: string): FileInfo | undefined {
    return an.files.get(uri) ?? an.others.get(uri);
}

function fileInfo(path: string, text: string, ast: A.File): FileInfo {
    const parent = new Map<object, Node>();
    const nodes = collectNodes(ast as unknown as Node, parent);
    return { uri: pathToFileURL(path).href, path, text, ast, map: new PositionMap(text), nodes, parent };
}

/** The `package` name a file declares (a cheap scan, used to group a folder's files). */
export function packageName(text: string): string | null {
    const m = /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*package\s+([A-Za-z_][\w.]*)/.exec(text);
    return m ? m[1]! : null;
}

/**
 * Runs every pass on the package of `primary` and on everything it imports. `docs` are the open
 * editors: they override the files on disk. A `package main` file stands for its whole folder (every
 * `package main` file there is one package, §17.6).
 */
export function analyze(docs: Doc[], primary: string): Analysis {
    const virtual = new Map<string, string>();
    for (const d of docs) if (d.uri.startsWith("file:")) virtual.set(fileURLToPath(d.uri), d.text);
    const path = fileURLToPath(primary);
    const text = virtual.get(path) ?? "";
    const isMain = (packageName(text) ?? "main") === "main" && !path.endsWith("mod.ms");
    const fe = frontEnd(isMain ? dirname(path) : path, { testDir: dirname(path), virtual });
    const pkg = fe.program.packages.find((p) => p.files.some((f) => f.path === path)) ?? fe.program.packages[fe.program.packages.length - 1];

    const files = new Map<string, FileInfo>();
    const others = new Map<string, FileInfo>();
    const packageOf = new Map<string, string>();
    const textOf = (f: { path: string; src: Uint8Array }) => virtual.get(f.path) ?? decoder.decode(f.src);
    for (const p of fe.program.packages) {
        for (const f of p.files) {
            const info = fileInfo(f.path, textOf(f), f.ast);
            if (p === pkg) files.set(info.uri, info);
            else {
                others.set(info.uri, info);
                packageOf.set(info.uri, p.name);
            }
        }
    }
    const pre = loadPrelude();
    const preInfo = fileInfo(pre.file.path, decoder.decode(pre.file.src), pre.file.ast);
    others.set(preInfo.uri, preInfo);
    packageOf.set(preInfo.uri, "prelude");

    const diagnostics = new Map<string, L.Diagnostic[]>();
    for (const f of files.values()) diagnostics.set(f.uri, []);
    if (pkg) collectDiagnostics(fe, pkg, files, diagnostics);

    const nodeFile = new Map<object, string>();
    for (const f of [...others.values(), ...files.values()]) for (const n of f.nodes) nodeFile.set(n, f.uri);
    const checked = (pkg ? fe.checked.packages.get(pkg) : undefined) ?? fe.checked.prelude;
    return { files, res: pkg?.res ?? fe.program.prelude, checked, fe, diagnostics, nodeFile, others, packageOf };
}

/**
 * The package's diagnostics, with its lints. While a file has a syntax error, only syntax and name
 * errors are shown: type and access errors on half-parsed code are mostly noise.
 */
function collectDiagnostics(fe: FrontEnd, pkg: LoadedPackage, files: Map<string, FileInfo>, out: Map<string, L.Diagnostic[]>): void {
    const paths = new Set(pkg.files.map((f) => f.path));
    const syntax = pkg.files.flatMap((f) => f.diagnostics.map((d) => ({ ...d, file: f.path })));
    const names = pkg.res.diagnostics;
    const broken = syntax.some((d) => d.severity === "error");
    const all: Diagnostic[] = broken ? [...syntax, ...names] : [...fe.diagnostics, ...fe.lints];
    const seen = new Set<string>();
    for (const d of all) {
        if (!d.file || !paths.has(d.file)) continue;
        const key = `${d.file}:${d.start}:${d.end}:${d.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const f = files.get(pathToFileURL(d.file).href);
        if (f) out.get(f.uri)!.push(toLsp(d, f.map));
    }
}

function toLsp(d: Diagnostic, map: PositionMap): L.Diagnostic {
    const out: L.Diagnostic = {
        range: map.range(d),
        severity: d.severity === "error" ? 1 : 2,
        code: d.code,
        source: "minscript",
        message: d.fix ? `${d.message} (fix: ${d.fix})` : d.message,
    };
    return out;
}

// ---- nodes ------------------------------------------------------------------------------------

function isNode(x: unknown): x is Node {
    if (typeof x !== "object" || x === null || !("span" in x)) return false;
    const s = (x as { span: unknown }).span;
    return typeof s === "object" && s !== null && "start" in s;
}

function collectNodes(root: Node, parent: Map<object, Node>): Node[] {
    const out: Node[] = [];
    const seen = new Set<object>();
    const visit = (x: unknown, owner: Node | null): void => {
        if (typeof x !== "object" || x === null || seen.has(x)) return;
        seen.add(x);
        if (Array.isArray(x)) {
            for (const y of x) visit(y, owner);
            return;
        }
        let next = owner;
        if (isNode(x)) {
            out.push(x);
            if (owner) parent.set(x, owner);
            next = x;
        }
        for (const [k, v] of Object.entries(x)) if (k !== "span") visit(v, next);
    };
    visit(root, null);
    return out;
}

const NAMES: ReadonlySet<string> = new Set(["Ident", "This", "TName", "Member", "PBind", "PCtor"]);

/** The smallest node containing the offset; among equal ones, the one the resolver or checker knows. */
export function nodeAt(an: Analysis, f: FileInfo, offset: number): Node | null {
    let best: Node | null = null;
    for (const n of f.nodes) {
        if (n.kind === "File") continue;
        if (offset < n.span.start || offset > n.span.end) continue;
        if (offset === n.span.end && n.span.end > n.span.start && !NAMES.has(n.kind ?? "")) continue;
        const size = n.span.end - n.span.start;
        const bestSize = best ? best.span.end - best.span.start : Infinity;
        if (size < bestSize || (size === bestSize && (an.res.refs.has(n) || an.res.decls.has(n)))) best = n;
    }
    return best;
}

// ---- what a node names ------------------------------------------------------------------------

export interface Target {
    sym?: Sym;
    decl?: object;
    name: string;
}

/** What a node names: a symbol (through the resolver), or a member's declaration (through the checker). */
export function target(an: Analysis, n: Node): Target | null {
    const ref = refOf(an, n);
    if (ref) return { sym: ref, decl: ref.decl ?? undefined, name: ref.name };
    const decl = declOf(an, n);
    if (decl) return { sym: decl, decl: decl.decl ?? n, name: decl.name };
    if (n.kind === "Member") {
        const m = memberOf(an, n as unknown as A.Member);
        const name = String(n.name);
        if (m?.kind === "method" && m.decl) return { decl: m.decl, name };
        if (m?.kind === "static") return { decl: m.decl, name };
        if (m?.kind === "item") return { sym: m.sym, decl: m.sym.decl ?? undefined, name };
        if (m?.kind === "variant") {
            const d = m.ref.union.decl as A.UnionDecl | null;
            const v = d?.members.find((x): x is A.Variant => x.kind === "Variant" && x.name === m.ref.variant);
            return { decl: v ?? d ?? undefined, name };
        }
        if (m?.kind === "field") {
            const field = fieldDecl(an, typeOf(an, (n as unknown as A.Member).target), name);
            if (field) return { decl: field, name };
        }
        // `x.method(…)`: the checker records the target on the call
        const call = parentCall(an, n);
        const t = call ? callOf(an, call)?.target : undefined;
        if (t && (t.kind === "method" || t.kind === "static" || t.kind === "fn") && t.decl) return { decl: t.decl, name: t.decl.name };
    }
    return null;
}

/** The resolver tables of every loaded package and the prelude (a node may be anywhere). */
function refOf(an: Analysis, n: object): Sym | undefined {
    return an.res.refs.get(n) ?? lookupAll(an, (r) => r.refs.get(n));
}
function declOf(an: Analysis, n: object): Sym | undefined {
    return an.res.decls.get(n) ?? lookupAll(an, (r) => r.decls.get(n));
}
function lookupAll(an: Analysis, f: (r: Resolution) => Sym | undefined): Sym | undefined {
    for (const p of an.fe.program.packages) {
        const s = f(p.res);
        if (s) return s;
    }
    return f(an.fe.program.prelude);
}

function results(an: Analysis): CheckResult[] {
    return [an.checked, ...an.fe.checked.packages.values(), an.fe.checked.prelude];
}
function memberOf(an: Analysis, m: A.Member): MemberTarget | undefined {
    for (const r of results(an)) {
        const t = r.members.get(m);
        if (t) return t;
    }
    return undefined;
}
export function callOf(an: Analysis, c: A.Call) {
    for (const r of results(an)) {
        const t = r.calls.get(c);
        if (t) return t;
    }
    return undefined;
}
export function typeOf(an: Analysis, e: object): Ty | undefined {
    for (const r of results(an)) {
        const t = r.types.get(e as A.Expr);
        if (t) return t;
    }
    return undefined;
}
export function symType(an: Analysis, s: Sym): Ty | undefined {
    return an.checked.symTypes.get(s);
}

function parentCall(an: Analysis, n: Node): A.Call | null {
    const uri = an.nodeFile.get(n);
    const f = uri ? fileFor(an, uri) : undefined;
    let p = f?.parent.get(n);
    if (p?.kind === "GenericApply" && p.target === n) p = f?.parent.get(p);
    if (p?.kind === "Call") {
        const c = p as unknown as A.Call;
        if (c.callee === (n as unknown) || (c.callee.kind === "GenericApply" && c.callee.target === (n as unknown))) return c;
    }
    return null;
}

function fieldDecl(an: Analysis, objTy: Ty | undefined, name: string): A.Field | null {
    if (!objTy) return null;
    let t = objTy;
    while (t.k === "var" && t.ref) t = t.ref;
    if (t.k !== "named") return null;
    const d = t.sym.decl as A.TypeDecl | A.UnionDecl | null;
    if (d?.kind === "TypeDecl") return (d.members ?? []).find((m): m is A.Field => m.kind === "Field" && m.name === name) ?? null;
    void an;
    return null;
}

export function location(an: Analysis, node: object): L.Location | null {
    const uri = an.nodeFile.get(node);
    if (uri === undefined) return null;
    const f = fileFor(an, uri);
    if (!f) return null;
    const n = node as Node;
    return { uri, range: f.map.range(nameSpan(n, f.text) ?? n.span) };
}

/** For a declaration, the span of its name (so "go to definition" lands on it, not on `pub fn`). */
export function nameSpan(node: Node, text: string): A.Span | null {
    const name = typeof node.name === "string" ? node.name : null;
    if (name === null || node.kind === "Ident" || node.kind === "PBind" || node.kind === "Member") return null;
    const bytes = new TextEncoder().encode(text);
    const slice = decoder.decode(bytes.subarray(node.span.start, node.span.end));
    const m = new RegExp(`\\b${name.replace(/[^\w]/g, "")}\\b`).exec(slice);
    if (!m) return null;
    const start = node.span.start + byteLength(slice.slice(0, m.index));
    return { start, end: start + byteLength(name) };
}

// ---- queries ----------------------------------------------------------------------------------

export function hover(an: Analysis, uri: string, pos: L.Position): L.Hover | null {
    const f = an.files.get(uri);
    if (!f) return null;
    const n = nodeAt(an, f, f.map.offset(pos));
    if (n === null) return null;
    const t = target(an, n);
    const ty = typeOf(an, n) ?? (t?.sym ? symType(an, t.sym) : undefined);
    const decl = t?.decl as Node | undefined;
    let code: string | null = null;
    switch (decl?.kind) {
        case "Fn": code = signature(decl as unknown as A.FnDecl); break;
        case "TypeDecl": code = `type ${decl.name}`; break;
        case "UnionDecl": code = `union ${decl.name}`; break;
        case "InterDecl": code = `inter ${decl.name}`; break;
        case "Field": code = fieldText(decl as unknown as A.Field); break;
        case "Variant": code = `variant ${decl.name}`; break;
    }
    if (code === null && t?.sym) {
        const s = t.sym;
        const word = s.kind === "local" ? (s.mutable ? "var" : "let") : s.kind === "global" ? (s.mutable ? "var" : "let") : s.kind === "this" ? "this" : s.kind.replace("-", " ");
        code = `${word} ${s.name}${ty ? `: ${show(ty)}` : ""}`;
    } else if (code === null && ty && ty.k !== "unknown") {
        code = show(ty);
    }
    if (code === null) return null;
    const declUri = decl ? an.nodeFile.get(decl) : undefined;
    const where = declUri && an.packageOf.has(declUri) ? `\n\n*${an.packageOf.get(declUri) === "prelude" ? "prelude" : `package ${an.packageOf.get(declUri)}`}*` : "";
    const docs = decl ? docComment(an, decl) : "";
    return {
        contents: { kind: "markdown", value: "```minscript\n" + code + "\n```" + (docs ? `\n\n${docs}` : "") + where },
        range: f.map.range(n.span),
    };
}

/** `///` lines directly above a declaration. */
export function docComment(an: Analysis, decl: object): string {
    const uri = an.nodeFile.get(decl);
    const f = uri ? fileFor(an, uri) : undefined;
    if (!f) return "";
    const trivia = docTrivia(f);
    const lines: string[] = [];
    let line = f.map.lineOf((decl as Node).span.start) - 1;
    for (let i = trivia.length - 1; i >= 0; i--) {
        const t = trivia[i]!;
        if (t.line > line) continue;
        if (t.line < line) break;
        lines.unshift(t.text.replace(/^\/\/\/\s?/, ""));
        line--;
    }
    return lines.join("\n");
}

const docCache = new WeakMap<FileInfo, { line: number; text: string }[]>();
function docTrivia(f: FileInfo): { line: number; text: string }[] {
    let d = docCache.get(f);
    if (!d) {
        const src = new TextEncoder().encode(f.text);
        d = lex(src).trivia.filter((t) => t.kind === "doc").map((t) => ({ line: f.map.lineOf(t.start), text: decoder.decode(src.subarray(t.start, t.end)) }));
        docCache.set(f, d);
    }
    return d;
}

export function definition(an: Analysis, uri: string, pos: L.Position): L.Location[] {
    const f = an.files.get(uri);
    if (!f) return [];
    const n = nodeAt(an, f, f.map.offset(pos));
    const t = n ? target(an, n) : null;
    if (!t?.decl) return [];
    const loc = location(an, t.decl);
    return loc ? [loc] : [];
}

export function references(an: Analysis, uri: string, pos: L.Position, includeDeclaration: boolean): L.Location[] {
    const f = an.files.get(uri);
    if (!f) return [];
    const n = nodeAt(an, f, f.map.offset(pos));
    const t = n ? target(an, n) : null;
    if (!t?.sym) return [];
    const out: L.Location[] = [];
    if (includeDeclaration && t.sym.decl) {
        const loc = location(an, t.sym.decl);
        if (loc) out.push(loc);
    }
    for (const p of [...an.fe.program.packages.map((x) => x.res)]) {
        for (const [node, sym] of p.refs) {
            if (sym !== t.sym) continue;
            const loc = location(an, node);
            if (loc) out.push(loc);
        }
    }
    return out;
}

// LSP SymbolKind values
const SK = { Namespace: 3, Method: 6, Field: 8, Enum: 10, Interface: 11, Function: 12, Variable: 13, Constant: 14, EnumMember: 22, Struct: 23, TypeParameter: 26 } as const;

export function documentSymbols(an: Analysis, uri: string): L.DocumentSymbol[] {
    const f = an.files.get(uri);
    if (!f) return [];
    const sym = (name: string, kind: L.SymbolKind, node: Node, children: L.DocumentSymbol[] = [], detail?: string): L.DocumentSymbol => {
        const s: L.DocumentSymbol = { name, kind, range: f.map.range(node.span), selectionRange: f.map.range(nameSpan(node, f.text) ?? node.span), children };
        if (detail) s.detail = detail;
        return s;
    };
    const fn = (m: A.FnDecl, kind: L.SymbolKind) => sym(m.name, kind, m as unknown as Node, [], signature(m).replace(/^.*?fn \S+?(?=[[(])/, ""));
    const out: L.DocumentSymbol[] = [];
    for (const item of f.ast.items) {
        const node = item as unknown as Node;
        switch (item.kind) {
            case "Fn": out.push(fn(item, SK.Function)); break;
            case "TypeDecl": {
                const children = (item.members ?? []).map((m) => (m.kind === "Field" ? sym(m.name, SK.Field, m as unknown as Node, [], typeText(m.type)) : fn(m, SK.Method)));
                out.push(sym(item.name, item.members ? SK.Struct : SK.TypeParameter, node, children));
                break;
            }
            case "UnionDecl":
                out.push(sym(item.name, SK.Enum, node, item.members.map((m) => (m.kind === "Variant" ? sym(m.name, SK.EnumMember, m as unknown as Node) : fn(m, SK.Method)))));
                break;
            case "InterDecl": out.push(sym(item.name, SK.Interface, node, (item.methods ?? []).map((m) => fn(m, SK.Method)))); break;
            case "ImplDecl": {
                const name = `impl ${item.inters.length ? `${item.inters.map(typeText).join(", ")} for ` : ""}${typeText(item.target)}`;
                out.push(sym(name, SK.Namespace, node, item.methods.map((m) => fn(m, SK.Method))));
                break;
            }
            case "LetDecl": out.push(sym(item.name, SK.Constant, node)); break;
            case "VarDecl": out.push(sym(item.name, SK.Variable, node)); break;
            case "ExternDecl": out.push(sym(`extern ${JSON.stringify(item.abi)}`, SK.Namespace, node, item.fns.map((m) => fn(m, SK.Function)))); break;
        }
    }
    return out;
}

// ---- printing declarations --------------------------------------------------------------------

export function signature(f: A.FnDecl): string {
    const generics = f.generics.length ? `[${f.generics.map((g) => (g.bounds.length ? `${g.name}: ${g.bounds.map(typeText).join(" & ")}` : g.name)).join(", ")}]` : "";
    const params = [...(f.receiver ? [f.receiver] : []), ...f.params.map(paramText)];
    const ret = f.ret ? ` -> ${f.retStar ? "*" : ""}${typeText(f.ret)}` : "";
    return `${f.isPub ? "pub " : ""}${f.isAsync ? "async " : ""}fn ${f.name}${generics}(${params.join(", ")})${ret}`;
}

export function paramText(p: A.Param): string {
    return `${p.variadic ? "..." : ""}${p.name}: ${p.star ? "*" : ""}${typeText(p.type)}`;
}

function fieldText(f: A.Field): string {
    return `${f.mode ? `${f.mode} ` : ""}${f.name}: ${typeText(f.type)}`;
}

export function typeText(t: A.Type): string {
    switch (t.kind) {
        case "TName": return t.path.join(".") + (t.args.length ? `[${t.args.map(typeText).join(", ")}]` : "");
        case "TOptional": return `${typeText(t.inner)}?`;
        case "TTuple": return `t(${t.elems.map(typeText).join(", ")})`;
        case "TRecord": return `r{ ${t.fields.map((f) => `${f.name}: ${typeText(f.type)}`).join(", ")} }`;
        case "TFn": return `(${t.params.map((p) => `${p.star ? "*" : ""}${typeText(p.type)}`).join(", ")}) -> ${typeText(t.ret)}`;
        case "TUnion": return t.alts.map(typeText).join(" | ");
        case "TInter": return t.parts.map(typeText).join(" & ");
        case "TTypeOf": return `TypeOf(${t.path.join(".")})`;
        case "TLit": return typeof t.value === "string" ? JSON.stringify(t.value) : String(t.value);
        case "TError": return "?";
    }
}
