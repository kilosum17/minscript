// HIR → JavaScript (spec §16). The output is the body of a function taking the runtime (`$rt`) and
// returning `{ main }`; src/js/run.ts runs it. Every function of the program is emitted, the
// prelude's included; `_builtin()` bodies are bound to the runtime's implementation by name.
//
// - Expressions that need statements (`if`, `match`, blocks, loops, `recover`, `select`) are
//   hoisted into temporaries. When one argument of a call (or operand, or element) needs
//   statements, every argument is evaluated into a temporary in order, so evaluation order is
//   always left to right.
// - A write to a place first makes each prefix of its path unique (copy-on-write, §16.2); a value
//   read from a place and then bound, stored, passed or returned is marked shared.
// - `shared` bindings and fields, and `*T` parameters, are cells (`{ v }`). A `*` argument passes
//   the caller's cell when it is one (a `shared` place: an alias, §10.1), and otherwise a box that
//   is written back after the call returns.

import { LineMap } from "../diagnostic.ts";
import type * as H from "../hir.ts";
import type { MechanismResult } from "../mechanism.ts";
import type { Sym } from "../resolve.ts";
import * as T from "../types.ts";
import type { Ty } from "../types.ts";

export interface EmitOptions {
    /** the source of each file, for statement positions in panics */
    sources: Map<string, Uint8Array>;
    /** files whose functions don't record positions (the prelude, std) */
    isStd: (file: string) => boolean;
    /** how a file is named in panics */
    displayName: (file: string) => string;
    /** pass 8: which reads move or lend instead of sharing, which writes skip the uniqueness check */
    mechanisms?: MechanismResult | null;
    /** the HIR name of the function the module runs (default: the program's `main`) */
    entry?: string;
}

const ident = (s: string) => s.replace(/[^A-Za-z0-9_$]/g, (c) => (c === "." ? "$" : "_"));
const fnName = (name: string) => `F_${ident(name)}`;
const className = (name: string) => `C_${ident(name)}`;
const variantClass = (union: string, v: string) => `V_${ident(union)}$${ident(v)}`;
const globalName = (name: string) => `G_${ident(name)}`;

const OPTION = "prelude.Option";
const RESULT = "prelude.Result";

export function emitProgram(p: H.Program, opts: EmitOptions): string {
    return new Emitter(p, opts).run();
}

// ---- types -------------------------------------------------------------------------------------

const INT_NAMES = new Set(["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "isize", "usize", "int"]);

function primName(t: Ty): string | null {
    const p = T.prune(t);
    if (p.k === "prim") return p.name;
    if (p.k === "lit") return typeof p.value === "bigint" ? "int" : typeof p.value === "string" ? "str" : "bool";
    return null;
}
const isBig = (t: Ty) => {
    const n = primName(t);
    return n === "i64" || n === "u64";
};
const isIntTy = (t: Ty) => INT_NAMES.has(primName(t) ?? "");
const isFloatTy = (t: Ty) => primName(t) === "f32" || primName(t) === "f64";
const isCopyTy = (t: Ty) => {
    const p = T.prune(t);
    return p.k === "prim" || p.k === "lit" || p.k === "never";
};

/** Where a type's floats are, for printing (null: no floats). See `show` in the runtime. */
function shapeOf(t: Ty, depth = 0): unknown {
    const p = T.prune(t);
    if (depth > 6) return null;
    if (isFloatTy(p)) return "f";
    if (p.k === "tuple") {
        const t2 = p.elems.map((e) => shapeOf(e, depth + 1));
        return t2.some((x) => x !== null) ? { t: t2 } : null;
    }
    if (p.k === "record") {
        const r: Record<string, unknown> = {};
        let any = false;
        for (const f of p.fields) {
            const s = shapeOf(f.ty, depth + 1);
            if (s !== null) (r[f.name] = s), (any = true);
        }
        return any ? { r } : null;
    }
    if (p.k !== "named" || p.sym.pkg !== "prelude") return null;
    const a = p.args.map((x) => shapeOf(x, depth + 1));
    switch (p.sym.name) {
        case "Vec": case "Array": case "Slice": case "Set": case "Option": case "PVec":
            return a[0] ? { e: a[0] } : null;
        case "Result":
            return a[0] || a[1] ? { ok: a[0], err: a[1] } : null;
        case "Map": case "PMap":
            return a[0] || a[1] ? { k: a[0], v: a[1] } : null;
        default:
            return null;
    }
}

/** Integer casts that keep every value and the JS representation (a number stays a number). */
const WIDENS: Record<string, string[]> = {
    u8: ["u16", "u32", "i16", "i32", "int", "isize", "usize", "f32", "f64"],
    i8: ["i16", "i32", "int", "isize", "f32", "f64"],
    u16: ["u32", "i32", "int", "isize", "usize", "f32", "f64"],
    i16: ["i32", "int", "isize", "f32", "f64"],
    i32: ["int", "isize", "f64"], int: ["i32", "isize", "f64"], isize: ["int", "i32", "f64"],
    u32: ["usize", "f64"], usize: ["u32", "f64"],
};
const widens = (from: string, to: string) => WIDENS[from]?.includes(to) ?? false;

const isInter = (t: Ty) => {
    const p = T.prune(t);
    return p.k === "named" && p.sym.kind === "inter";
};

// ---- the program -------------------------------------------------------------------------------

class Emitter {
    readonly p: H.Program;
    readonly opts: EmitOptions;
    readonly funs = new Map<string, H.Fun>();
    readonly out: string[] = [];
    readonly lineMaps = new Map<string, LineMap>();

    /** the runtime name of each struct and union, by its symbol (for type descriptors) */
    readonly typeNames = new Map<Sym, string>();

    constructor(p: H.Program, opts: EmitOptions) {
        this.p = p;
        this.opts = opts;
        for (const f of p.funs) this.funs.set(f.name, f);
        for (const t of p.types) if (t.kind !== "inter" && t.sym) this.typeNames.set(t.sym, t.name);
    }

    /**
     * A type descriptor, as JS code (§15.4 witness tables, read by `json`): `{"p":"int"}`,
     * `{"n":"Point","a":[…]}`, `{"t":[…]}`, `{"r":{…}}`. A generic parameter is `{"g":i}` inside a
     * type declaration (`gens`), its witness's descriptor inside a generic function, else null.
     */
    desc(t: Ty, gens: Sym[] | null, witnesses: Map<Sym, string> | null): string {
        const p = T.prune(t);
        const prim = primName(p);
        if (prim) return JSON.stringify({ p: prim });
        switch (p.k) {
            case "named": {
                const name = p.sym.pkg === "prelude" ? `prelude.${p.sym.name}` : this.typeNames.get(p.sym) ?? p.sym.name;
                return `{"n":${JSON.stringify(name)},"a":[${p.args.map((a) => this.desc(a, gens, witnesses)).join(",")}]}`;
            }
            case "tuple":
                return `{"t":[${p.elems.map((e) => this.desc(e, gens, witnesses)).join(",")}]}`;
            case "record":
                return `{"r":{${p.fields.map((f) => `${JSON.stringify(f.name)}:${this.desc(f.ty, gens, witnesses)}`).join(",")}}}`;
            case "param": {
                const i = gens?.indexOf(p.sym) ?? -1;
                if (i >= 0) return `{"g":${i}}`;
                const w = witnesses?.get(p.sym);
                return w ? `${w}.d` : "null";
            }
            default:
                return "null";
        }
    }

    run(): string {
        this.out.push('"use strict";');
        for (const t of this.p.types) this.typeDef(t);
        for (const g of this.p.globals) this.global(g);
        for (const f of this.p.funs) this.fun(f);
        this.methods();
        const entry = this.opts.entry;
        const main = entry
            ? this.funs.get(entry) ?? this.p.funs.find((f) => f.name.endsWith(`.${entry}`))
            : this.p.funs.find((f) => f.name === "main" && !this.opts.isStd(f.file));
        this.out.push(`return { main: ${main ? fnName(main.name) : "null"} };`);
        return this.out.join("\n");
    }

    line(file: string, offset: number): number {
        let m = this.lineMaps.get(file);
        if (!m) {
            const src = this.opts.sources.get(file);
            if (!src) return 0;
            m = new LineMap(src);
            this.lineMaps.set(file, m);
        }
        return m.line(offset);
    }

    typeDef(t: H.TypeDef): void {
        // printed as written outside its package: `Point` in main, `build.Opts`, `models.User`
        const short = t.name.replace(/^(std|app)\./, "");
        if (t.kind === "struct") {
            const fields = t.fields.map((f) => f.name);
            const shapes: Record<string, unknown> = {};
            for (const f of t.fields) {
                const s = shapeOf(f.ty);
                if (s !== null) shapes[f.name] = s;
            }
            const c = className(t.name);
            // positional parameters: a field may be named like a JS reserved word (`default`)
            this.out.push(`class ${c} { constructor(${fields.map((_, i) => `a${i}`).join(", ")}) { ${fields.map((f, i) => `this.${f} = a${i};`).join(" ")} } }`);
            this.out.push(`Object.assign(${c}.prototype, { $t: ${JSON.stringify(short)}, $f: ${JSON.stringify(fields)}, $sh: ${JSON.stringify(shapes)}${t.identity ? ", $id: true" : ""} });`);
            // what `json` needs: field types, defaults, and which fields are cells or once
            const ft = t.fields.map((f) => `${JSON.stringify(f.name)}: ${this.desc(f.ty, t.generics, null)}`).join(", ");
            const defs = t.fields.filter((f) => f.default).map((f) => `${JSON.stringify(f.name)}: ${this.thunk(f.default!)}`).join(", ");
            const cells = t.fields.filter((f) => f.mode === "shared").map((f) => f.name);
            const once = t.fields.filter((f) => f.mode === "once").map((f) => f.name);
            this.out.push(`Object.assign(${c}.prototype, { $ft: { ${ft} }, $def: { ${defs} }, $cells: ${JSON.stringify(cells)}, $once: ${JSON.stringify(once)} });`);
            this.out.push(`$rt.reg(${JSON.stringify(t.name)}, ${c});`);
            return;
        }
        if (t.kind === "union") {
            if (t.name === OPTION || t.name === RESULT) return;
            for (const v of t.variants) {
                const c = variantClass(t.name, v.name);
                const keys = v.positional ? v.fields.map((_, i) => `$${i}`) : v.fields;
                this.out.push(`class ${c} { constructor(${keys.map((_, i) => `a${i}`).join(", ")}) { ${keys.map((k, i) => `this.${k} = a${i};`).join(" ")} } }`);
                this.out.push(`Object.assign(${c}.prototype, { $u: ${JSON.stringify(short)}, $v: ${JSON.stringify(v.name)}, $f: ${JSON.stringify(keys)}, $pos: ${v.positional}, $sh: ${JSON.stringify(this.variantShapes(t, v.name, keys))} });`);
                this.out.push(`${c}.prototype.$ft = [${v.tys.map((ty) => this.desc(ty, t.generics, null)).join(", ")}];`);
                this.out.push(`$rt.reg(${JSON.stringify(`${t.name}.${v.name}`)}, ${c});`);
            }
        }
    }

    /** `() => value` for a field default. */
    thunk(e: H.Expr): string {
        const fe = new FnEmitter(this, null, "");
        const v = fe.value(e);
        return `() => { ${[...fe.lines, `return ${v};`].join(" ")} }`;
    }

    variantShapes(t: H.TypeDef & { kind: "union" }, variant: string, keys: string[]): Record<string, unknown> {
        const v = t.variants.find((x) => x.name === variant);
        const out: Record<string, unknown> = {};
        (v?.tys ?? []).forEach((ty, i) => {
            const s = shapeOf(ty);
            if (s !== null && keys[i]) out[keys[i]!] = s;
        });
        return out;
    }

    global(g: H.Global): void {
        const fe = new FnEmitter(this, null, "");
        const v = fe.value(g.value);
        const body = [...fe.lines, `return ${g.mutable ? `$rt.cell(${v})` : v};`].join(" ");
        this.out.push(`const ${globalName(g.name)} = $rt.lazy(() => { ${body} });`);
    }

    fun(f: H.Fun): void {
        const name = fnName(f.name);
        if (f.builtin || (!f.body && f.extern !== null)) {
            this.out.push(`const ${name} = $rt.builtin(${JSON.stringify(f.extern !== null ? `extern.${f.name}` : f.name)});`);
            return;
        }
        if (!f.body) return;
        const fe = new FnEmitter(this, f, f.file);
        const params = [...(f.self ? [fe.localName(f.self)] : []), ...f.params.map((l) => fe.localName(l)), ...f.witnesses.js.map((g) => `$w_${ident(g.name)}_${Math.abs(g.id)}`)];
        fe.body(f.body, f.retMode === "write");
        const body = fe.lines.join("\n");
        const isAsync = f.async || (f.name === "main" && containsAwait(f.body));
        if (isAsync) this.out.push(`function ${name}(${params.join(", ")}) { return $rt.spawn(async () => {\n${body}\n}); }`);
        else this.out.push(`function ${name}(${params.join(", ")}) {\n${body}\n}`);
    }

    /** Methods on prototypes, for dynamic dispatch; interface defaults; prelude methods of `str` / `int`. */
    methods(): void {
        const structs = new Set(this.p.types.filter((t) => t.kind === "struct").map((t) => t.name));
        const unions = new Map(this.p.types.filter((t): t is H.TypeDef & { kind: "union" } => t.kind === "union").map((t) => [t.name, t] as const));
        const inters = new Set(this.p.types.filter((t) => t.kind === "inter").map((t) => t.name));
        for (const f of this.p.funs) {
            if (!(f.body || f.builtin)) continue;
            const owner = f.name.slice(0, f.name.lastIndexOf("."));
            const method = f.name.slice(f.name.lastIndexOf(".") + 1);
            if (!f.self) {
                // statics of a type, for `T.default()` through a witness
                if (structs.has(owner) || unions.has(owner)) this.out.push(`$rt.defStatic(${JSON.stringify(owner)}, ${JSON.stringify(method)}, ${fnName(f.name)});`);
                continue;
            }
            const boxed = f.selfMode === "write" && !!f.body && !f.builtin;
            const install = (cls: string) => this.out.push(`${cls}.prototype[${JSON.stringify(method)}] = function (...a) { return ${fnName(f.name)}(${boxed ? "$rt.cell(this)" : "this"}, ...a); };`);
            if (structs.has(owner)) install(className(owner));
            else if (unions.has(owner) && owner !== OPTION && owner !== RESULT) for (const v of unions.get(owner)!.variants) install(variantClass(owner, v.name));
            else if (inters.has(owner) && f.body) this.out.push(`$rt.defaultMethod(${JSON.stringify(method)}, ${boxed ? `(self, ...a) => ${fnName(f.name)}($rt.cell(self), ...a)` : fnName(f.name)});`);
            else if (owner === "prelude.str" || owner.startsWith("prelude.") && INT_NAMES.has(owner.slice(8))) this.out.push(`$rt.prim(${JSON.stringify(f.name)}, ${fnName(f.name)});`);
        }
    }
}

function containsAwait(b: H.Block): boolean {
    let found = false;
    const visit = (e: H.Expr): void => {
        if (found) return;
        if (e.k === "await" || e.k === "select" || (e.k === "foreach" && e.of === "async")) {
            found = true;
            return;
        }
        if (e.k === "closure") return;
        children(e, visit);
    };
    for (const s of b.stmts) visit(s.k === "let" ? s.value : s.expr);
    if (b.value) visit(b.value);
    return found;
}

// ---- one function ------------------------------------------------------------------------------

type Dest = { k: "discard" } | { k: "var"; name: string; ty: Ty } | { k: "return" };

interface Loop {
    label: string | null;
    js: string;
    result: string | null;
}

class FnEmitter {
    readonly e: Emitter;
    readonly f: H.Fun | null;
    readonly file: string;
    lines: string[] = [];
    temps = 0;
    loops: Loop[] = [];
    readonly cells = new Set<Sym>();
    readonly writeViews = new Set<Sym>();
    readonly witnesses = new Map<Sym, string>();
    readonly std: boolean;

    constructor(e: Emitter, f: H.Fun | null, file: string) {
        this.e = e;
        this.f = f;
        this.file = file;
        this.std = f === null || e.opts.isStd(file);
        if (f) {
            f.params.forEach((l, i) => f.modes[i] === "write" && this.cells.add(l.sym));
            // a `*this` method with a body gets its receiver as a cell, like a `*T` parameter, so a
            // copy-on-write inside it reaches the caller (builtins write in place)
            if (f.self && f.selfMode === "write" && f.body && !f.builtin) this.cells.add(f.self.sym);
            for (const g of f.witnesses.js) this.witnesses.set(g, `$w_${ident(g.name)}_${Math.abs(g.id)}`);
        }
    }

    temp(): string {
        return `$t${this.temps++}`;
    }

    emit(s: string): void {
        this.lines.push(s);
    }

    localName(l: H.Local): string {
        if (l.shared) this.cells.add(l.sym);
        const base = l.name === "this" ? "self" : l.name.replace(/^\$/, "t_");
        return `${ident(base)}_${Math.abs(l.sym.id)}`;
    }

    symName(sym: Sym, name: string): string {
        const base = name === "this" ? "self" : name.replace(/^\$/, "t_");
        return `${ident(base)}_${Math.abs(sym.id)}`;
    }

    pos(span: H.Span): void {
        if (this.std || !this.file) return;
        this.emit(`$rt.pos(${JSON.stringify(this.e.opts.displayName(this.file))}, ${this.e.line(this.file, span.start)});`);
    }

    // ---- bodies and blocks --------------------------------------------------------------------

    body(b: H.Block, writeView: boolean): void {
        this.declareCells(b);
        for (const s of b.stmts) this.stmt(s);
        if (b.value) {
            this.pos(b.value.span);
            if (writeView && b.value.k === "read") this.emit(`return ${this.uniquePlace(b.value.place)};`);
            else this.into(b.value, { k: "return" });
        }
    }

    /** Records the locals that are cells (shared, write-mode closure parameters) and write views. */
    declareCells(b: H.Block): void {
        const visit = (e: H.Expr): void => {
            if (e.k === "closure") e.params.forEach((l, i) => e.modes[i] === "write" && this.cells.add(l.sym));
            children(e, visit);
        };
        const stmts = (bb: H.Block) => {
            for (const s of bb.stmts) {
                if (s.k === "let") {
                    if (s.pattern.k === "bind") {
                        if (s.pattern.local.shared) this.cells.add(s.pattern.local.sym);
                        if (s.value.k === "call" && s.value.callee.k === "fn" && this.e.funs.get(s.value.callee.name)?.retMode === "write") this.writeViews.add(s.pattern.local.sym);
                    }
                    visit(s.value);
                    if (s.else) stmts(s.else);
                } else visit(s.expr);
            }
            if (bb.value) visit(bb.value);
        };
        const inner = (e: H.Expr): void => {
            for (const blk of blocksOf(e)) stmts(blk);
            children(e, inner);
        };
        stmts(b);
        for (const s of b.stmts) inner(s.k === "let" ? s.value : s.expr);
        if (b.value) inner(b.value);
    }

    block(b: H.Block, dest: Dest): void {
        for (const s of b.stmts) this.stmt(s);
        if (b.value) {
            this.pos(b.value.span);
            this.into(b.value, dest);
        } else if (dest.k === "var") {
            this.emit(`${dest.name} = undefined;`);
        }
    }

    stmt(s: H.Stmt): void {
        if (s.k === "expr") {
            this.pos(s.expr.span);
            this.into(s.expr, { k: "discard" });
            return;
        }
        this.pos(s.value.span);
        const p = s.pattern;
        if (p.k === "bind" && !s.else) {
            const v = this.value(s.value, p.local.ty);
            const name = this.localName(p.local);
            this.emit(this.cells.has(p.local.sym) ? `let ${name} = $rt.cell(${v});` : `let ${name} = ${v};`);
            return;
        }
        const subj = this.temp();
        this.emit(`const ${subj} = ${this.value(s.value)};`);
        if (s.else) {
            this.emit(`if (!(${this.test(p, subj, s.value.ty)})) {`);
            this.block(s.else, { k: "discard" });
            this.emit("}");
        }
        this.binds(p, subj, "let");
    }

    // ---- expressions into destinations --------------------------------------------------------

    /** Emits `e`, putting its value into `dest`. */
    into(e: H.Expr, dest: Dest): void {
        switch (e.k) {
            case "if": {
                this.emit(`if (${this.expr(e.cond)}) {`);
                this.block(e.then, dest);
                if (e.else) {
                    this.emit("} else {");
                    this.block(e.else, dest);
                } else if (dest.k === "var") {
                    this.emit(`} else { ${dest.name} = undefined;`);
                }
                this.emit("}");
                return;
            }
            case "match":
                return this.match(e, dest);
            case "block":
                this.emit("{");
                this.block(e.block, dest);
                this.emit("}");
                return;
            case "loop": case "foreach":
                return this.loop(e, dest);
            case "break": {
                const loop = this.loopFor(e.label);
                if (e.value && loop?.result) this.emit(`${loop.result} = ${this.value(e.value)};`);
                else if (e.value) this.into(e.value, { k: "discard" });
                this.emit(`break ${loop?.js ?? ""};`);
                return;
            }
            case "continue":
                this.emit(`continue ${this.loopFor(e.label)?.js ?? ""};`);
                return;
            case "return": {
                if (!e.value) {
                    this.emit("return;");
                    return;
                }
                if (this.f?.retMode === "write" && e.value.k === "read") {
                    this.emit(`return ${this.uniquePlace(e.value.place)};`);
                    return;
                }
                this.emit(`return ${this.value(e.value, this.f?.ret)};`);
                return;
            }
            case "recover": {
                const r = this.temp();
                this.emit(`let ${r};`);
                this.emit("try {");
                this.block(e.body, { k: "var", name: r, ty: T.UNKNOWN });
                this.emit(`${r} = $rt.ok(${r});`);
                this.emit(`} catch ($e) { if ($e instanceof $rt.MsPanic || $e instanceof RangeError || $e instanceof Error) ${r} = $rt.err($rt.caught($e)); else throw $e; }`);
                this.put(r, dest, e.ty);
                return;
            }
            case "lock":
                for (const p of e.places) this.placeParts(p);
                this.emit("{");
                this.block(e.body, dest);
                this.emit("}");
                return;
            case "select":
                return this.select(e, dest);
            default: {
                if (dest.k === "discard") {
                    const v = this.expr(e);
                    if (v !== "" && v !== "undefined") this.emit(`${v};`);
                    return;
                }
                this.put(this.value(e, dest.k === "var" ? dest.ty : this.f?.ret), dest, e.ty);
            }
        }
    }

    put(v: string, dest: Dest, _ty: Ty): void {
        if (dest.k === "var") this.emit(`${dest.name} = ${v};`);
        else if (dest.k === "return") this.emit(`return ${v};`);
        else this.emit(`${v};`);
    }

    loopFor(label: string | null): Loop | undefined {
        if (label === null) return this.loops[this.loops.length - 1];
        for (let i = this.loops.length - 1; i >= 0; i--) if (this.loops[i]!.label === label) return this.loops[i];
        return undefined;
    }

    /** A value that will be bound, stored, passed or returned: a read of a place is shared. */
    value(e: H.Expr, to?: Ty): string {
        const v = this.expr(e);
        const tag = e.k === "read" ? this.e.opts.mechanisms?.tags.get(e) : undefined;
        const shared = e.k === "read" && !isCopyTy(e.ty) && tag !== "move" && tag !== "view" ? `$rt.s(${v})` : v;
        return to ? this.coerce(shared, e, to) : shared;
    }

    /** Conversions at a boundary: an int widened to i64, a value with floats passed as an interface. */
    coerce(v: string, e: H.Expr, to: Ty): string {
        const from = e.ty;
        if (isBig(to) && isIntTy(from) && !isBig(from)) return `BigInt(${v})`;
        if (isFloatTy(to) && isBig(from)) return `Number(${v})`;
        if (isInter(to)) {
            const s = shapeOf(from);
            if (s !== null) return `$rt.sh(${v}, ${JSON.stringify(s)})`;
        }
        return v;
    }

    /** Emits `e` and returns a JS expression for its value (statements go before it). */
    expr(e: H.Expr): string {
        if (STMT_KINDS.has(e.k)) {
            const t = this.temp();
            this.emit(`let ${t};`);
            this.into(e, { k: "var", name: t, ty: e.ty });
            return t;
        }
        return this.simple(e);
    }

    /** Several values left to right: if one needs statements, all go through temporaries. */
    exprs(xs: H.Expr[], f: (x: H.Expr, i: number) => string = (x) => this.expr(x)): string[] {
        if (!xs.some(needsStatements)) return xs.map(f);
        return xs.map((x, i) => {
            const v = f(x, i);
            if (/^\$t\d+$/.test(v) || /^[-0-9."]/.test(v)) return v;
            const t = this.temp();
            this.emit(`const ${t} = ${v};`);
            return t;
        });
    }

    simple(e: H.Expr): string {
        switch (e.k) {
            case "lit":
                return this.lit(e.value, e.ty);
            case "char":
                return JSON.stringify(e.value);
            case "read":
                return this.read(e.place);
            case "assign":
                this.assign(e);
                return "undefined";
            case "fnref":
                return this.fnref(e.name);
            case "call":
                return this.call(e);
            case "callvalue": {
                const fn = this.expr(e.fn);
                const args = this.args(e.args, null);
                // a `*T` parameter of the function type given a value (a write view: `f(v.at_mut(i))`):
                // the callee takes a cell, and writes through it land in the viewed value
                const ft = T.prune(e.fn.ty);
                const js = args.js.map((a, i) => (ft.k === "fn" && ft.params[i]?.star && e.args[i]?.mode === "read" ? `$rt.cell(${a})` : a));
                return this.withWritebacks(`${fn}(${js.join(", ")})`, args.after);
            }
            case "extern":
                return `$rt.builtin(${JSON.stringify(`ext.${e.path}`)})(${(e.args ?? []).map((a) => this.value(a)).join(", ")})`;
            case "struct": {
                const def = this.e.p.types.find((t) => t.kind === "struct" && t.name === e.type) as (H.TypeDef & { kind: "struct" }) | undefined;
                const vals = this.exprs(e.fields.map((f) => f.value), (x, i) => {
                    const fd = def?.fields.find((d) => d.name === e.fields[i]!.name);
                    if (fd?.mode === "once" && x.k === "variant" && x.variant === "None") return "undefined";
                    const v = this.value(x);
                    return fd?.mode === "shared" ? `$rt.cell(${v})` : v;
                });
                return `new ${className(e.type)}(${vals.join(", ")})`;
            }
            case "variant": {
                const vals = this.exprs(e.fields, (x) => this.value(x));
                if (e.union === OPTION) return e.variant === "Some" ? `$rt.some(${vals[0] ?? "undefined"})` : "$rt.None";
                if (e.union === RESULT) return e.variant === "Ok" ? `$rt.ok(${vals[0] ?? "undefined"})` : `$rt.err(${vals[0] ?? "undefined"})`;
                if (e.union === "?") return "undefined";
                return `new ${variantClass(e.union, e.variant)}(${vals.join(", ")})`;
            }
            case "record": {
                const vals = this.exprs(e.fields.map((f) => f.value), (x) => this.value(x));
                return `$rt.rec({ ${e.fields.map((f, i) => `${JSON.stringify(f.name)}: ${vals[i]}`).join(", ")} })`;
            }
            case "tuple":
                return `$rt.tup(${this.exprs(e.elems, (x) => this.value(x)).join(", ")})`;
            case "vec": case "array": case "set": {
                const elemTy = T.prune(e.ty).k === "named" ? (T.prune(e.ty) as { args: Ty[] }).args[0] : undefined;
                const items = e.elems.map((x) => (x.k === "spread" ? x.expr : x));
                const vals = this.exprs(items, (x, i) => (e.elems[i]!.k === "spread" ? `...$rt.spread(${this.expr(x)})` : this.value(x, elemTy)));
                return e.k === "set" ? `$rt.set(${vals.join(", ")})` : `$rt.vec(${vals.join(", ")})`;
            }
            case "map": {
                const parts: string[] = [];
                for (const en of e.entries) {
                    if ("k" in en) parts.push(`...$rt.spread(${this.expr(en.expr)}).map((x) => [x[0], x[1]])`);
                    else {
                        const [k, v] = this.exprs([en.key, en.value], (x) => this.value(x));
                        parts.push(`[${k}, ${v}]`);
                    }
                }
                return `$rt.map(${parts.join(", ")})`;
            }
            case "range": {
                const [a, b] = this.exprs([e.start, e.end].filter((x): x is H.Expr => x !== null));
                const start = e.start ? a! : "undefined";
                const end = e.end ? (e.start ? b! : a!) : "undefined";
                return `$rt.range(${start}, ${end}, ${e.inclusive})`;
            }
            case "unary":
                return this.unary(e);
            case "binary":
                return this.binary(e);
            case "and": case "or": {
                const l = this.expr(e.left);
                if (!needsStatements(e.right)) return `(${l} ${e.k === "and" ? "&&" : "||"} ${this.expr(e.right)})`;
                const t = this.temp();
                this.emit(`let ${t} = ${l};`);
                this.emit(e.k === "and" ? `if (${t}) {` : `if (!${t}) {`);
                this.into(e.right, { k: "var", name: t, ty: T.BOOL });
                this.emit("}");
                return t;
            }
            case "truthy":
                return `$rt.isOk(${this.expr(e.expr)})`;
            case "concat": {
                const parts = this.exprs(e.parts);
                return parts.length === 0 ? '""' : `(${parts.map((p, i) => (primName(e.parts[i]!.ty) === "str" || e.parts[i]!.k === "tostr" ? p : `$rt.show(${p})`)).join(" + ")})`;
            }
            case "tostr":
                return `$rt.show(${this.expr(e.expr)}, ${JSON.stringify(shapeOf(e.expr.ty))})`;
            case "cast": {
                const from = primName(e.expr.ty);
                const to = primName(e.to);
                const v = this.expr(e.expr);
                if (from && to && widens(from, to)) return v;
                return from && to && from !== to ? `$rt.cast(${v}, ${JSON.stringify(from)}, ${JSON.stringify(to)})` : v;
            }
            case "await":
                return `(await $rt.aw(${this.expr(e.expr)}))`;
            case "closure":
                return this.closure(e);
            case "unsupported":
                return `$rt.panic("User", ${JSON.stringify(`not supported on the JS back end yet: ${e.what}`)})`;
            default: {
                const t = this.temp();
                this.emit(`let ${t};`);
                this.into(e, { k: "var", name: t, ty: e.ty });
                return t;
            }
        }
    }

    lit(v: bigint | number | string | boolean | null, ty: Ty): string {
        if (v === null) return "undefined";
        if (typeof v === "bigint") return isBig(ty) ? `${v}n` : isFloatTy(ty) ? `${Number(v)}` : `${v}`;
        if (typeof v === "number") return isBig(ty) ? `${BigInt(Math.trunc(v))}n` : Object.is(v, -0) ? "-0" : `${v}`;
        if (typeof v === "string") return JSON.stringify(v);
        return String(v);
    }

    fnref(name: string): string {
        if (this.e.funs.has(name)) return fnName(name);
        // a variant constructor used as a function
        const dot = name.lastIndexOf(".");
        const union = name.slice(0, dot);
        const v = name.slice(dot + 1);
        if (union === OPTION) return v === "Some" ? "$rt.some" : "(() => $rt.None)";
        if (union === RESULT) return v === "Ok" ? "$rt.ok" : "$rt.err";
        return `((...a) => new ${variantClass(union, v)}(...a))`;
    }

    // ---- places -------------------------------------------------------------------------------

    rootExpr(r: H.Root): string {
        if (r.k === "local") {
            const n = this.symName(r.local, r.name);
            return this.cells.has(r.local) ? `${n}.v` : n;
        }
        if (r.k === "global") {
            const g = this.e.p.globals.find((x) => x.name === r.name);
            return g?.mutable ? `${globalName(r.name)}().v` : `${globalName(r.name)}()`;
        }
        return this.expr(r.expr);
    }

    placeParts(p: H.Place): void {
        if (p.root.k === "value") this.expr(p.root.expr);
    }

    /** Reads a place. */
    read(p: H.Place): string {
        let v = this.rootExpr(p.root);
        const n = p.segs.length;
        p.segs.forEach((s, i) => {
            if (s.k === "field") {
                v = `${v}.${s.name}`;
                if (s.mode === "shared") v += ".v";
                if (s.mode === "once" && i === n - 1) v = `$rt.opt(${v})`;
            } else if (s.k === "tuple") v = `${v}[${s.index}]`;
            else v = s.map ? `$rt.mget(${v}, ${this.expr(s.index)})` : `$rt.idx(${v}, ${this.expr(s.index)})`;
        });
        return v;
    }

    /**
     * Makes every prefix of a place unique (copy-on-write) and returns an lvalue-ish expression for
     * its last segment's container, with how to write and read the last segment.
     */
    prepare(p: H.Place): { write: (v: string) => string; readNow: () => string } {
        const segs = p.segs;
        if (segs.length === 0) {
            const root = this.rootExpr(p.root);
            return { write: (v) => `${root} = ${v}`, readNow: () => root };
        }
        let lv = this.rootExpr(p.root);
        const view = p.root.k === "local" && this.writeViews.has(p.root.local);
        const proven = p.root.k === "local" && !!this.e.opts.mechanisms?.unique.has(p.root.local);
        if (p.root.k !== "value" && !view && !proven) this.emit(`${lv} = $rt.u(${lv});`);
        else if (p.root.k === "value") {
            const t = this.temp();
            this.emit(`const ${t} = ${lv};`);
            lv = t;
        }
        for (let i = 0; i < segs.length - 1; i++) {
            const s = segs[i]!;
            if (s.k === "field") {
                lv = `${lv}.${s.name}${s.mode === "shared" ? ".v" : ""}`;
                if (s.mode !== "once") this.emit(`${lv} = $rt.u(${lv});`);
            } else if (s.k === "tuple") {
                lv = `${lv}[${s.index}]`;
                this.emit(`${lv} = $rt.u(${lv});`);
            } else {
                const k = this.temp();
                this.emit(`const ${k} = ${this.expr(s.index)};`);
                if (s.map) {
                    this.emit(`$rt.mset(${lv}, ${k}, $rt.u($rt.mget(${lv}, ${k})));`);
                    lv = `$rt.mget(${lv}, ${k})`;
                } else {
                    this.emit(`$rt.vset(${lv}, ${k}, $rt.u($rt.idx(${lv}, ${k})));`);
                    lv = `${lv}[${k}]`;
                }
            }
        }
        const last = segs[segs.length - 1]!;
        const obj = lv;
        if (last.k === "field") {
            if (last.mode === "shared") return { write: (v) => `${obj}.${last.name}.v = ${v}`, readNow: () => `${obj}.${last.name}.v` };
            if (last.mode === "once") return { write: (v) => `$rt.setOnce(${obj}, ${JSON.stringify(last.name)}, ${v})`, readNow: () => `$rt.opt(${obj}.${last.name})` };
            return { write: (v) => `${obj}.${last.name} = ${v}`, readNow: () => `${obj}.${last.name}` };
        }
        if (last.k === "tuple") return { write: (v) => `${obj}[${last.index}] = ${v}`, readNow: () => `${obj}[${last.index}]` };
        const k = this.temp();
        this.emit(`const ${k} = ${this.expr(last.index)};`);
        if (last.map) return { write: (v) => `$rt.mset(${obj}, ${k}, ${v})`, readNow: () => `$rt.mget(${obj}, ${k})` };
        return { write: (v) => `$rt.vset(${obj}, ${k}, ${v})`, readNow: () => `$rt.idx(${obj}, ${k})` };
    }

    /** The place made unique all the way down, stored back, and its value (write views, `*this`). */
    uniquePlace(p: H.Place): string {
        if (p.root.k === "local" && this.writeViews.has(p.root.local) && p.segs.length === 0) return this.rootExpr(p.root);
        if (p.root.k === "local" && p.segs.length === 0 && this.e.opts.mechanisms?.unique.has(p.root.local)) return this.rootExpr(p.root);
        const w = this.prepare(p);
        const t = this.temp();
        this.emit(`const ${t} = $rt.u(${w.readNow()});`);
        this.emit(`${w.write(t)};`);
        return t;
    }

    assign(e: H.Expr & { k: "assign" }): void {
        // a write view of a Copy value (`n := v.at_mut(i); n = 5`) isn't representable yet
        const valueTy = e.place.segs.length === 0 && e.place.root.k === "local" ? this.f?.params.find((x) => x.sym === (e.place.root as { local: Sym }).local)?.ty ?? e.value.ty : e.value.ty;
        const v = this.value(e.value, valueTy);
        const w = this.prepare(e.place);
        if (e.op === "=") {
            this.emit(`${w.write(v)};`);
            return;
        }
        if (e.op === "??=") {
            const cur = this.temp();
            this.emit(`const ${cur} = ${w.readNow()};`);
            this.emit(`if (!$rt.isOk(${cur})) ${w.write(v)};`);
            return;
        }
        const op = e.op.slice(0, -1);
        const cur = this.temp();
        this.emit(`const ${cur} = ${w.readNow()};`);
        this.emit(`${w.write(this.arith(op, cur, v, e.value.ty, e.value.ty, e.value.ty))};`);
    }

    // ---- operators ----------------------------------------------------------------------------

    unary(e: H.Expr & { k: "unary" }): string {
        const v = this.expr(e.expr);
        const t = primName(e.ty) ?? "int";
        if (e.op === "not") return `!${v}`;
        if (e.op === "bitnot") return `$rt.bitnot(${v}, ${JSON.stringify(t)})`;
        if (isIntTy(e.ty)) return `$rt.chk(-${v}, ${JSON.stringify(t)})`;
        return `(-${v})`;
    }

    binary(e: H.Expr & { k: "binary" }): string {
        const [l, r] = this.exprs([e.left, e.right]);
        const lt = e.left.ty;
        const prim = (t: Ty) => primName(t) !== null;
        switch (e.op) {
            case "==": case "!=": {
                const strict = prim(lt) && prim(e.right.ty) && isBig(lt) === isBig(e.right.ty);
                const eqs = strict ? `(${l} === ${r})` : `$rt.eq(${l}, ${r})`;
                return e.op === "==" ? eqs : `!${eqs}`;
            }
            case "<": case "<=": case ">": case ">=":
                return prim(lt) ? `(${l} ${e.op} ${r})` : `($rt.cmp(${l}, ${r}) ${e.op} 0)`;
            default:
                return this.arith(e.op, l!, r!, e.ty, e.left.ty, e.right.ty);
        }
    }

    arith(op: string, l: string, r: string, ty: Ty, lt: Ty, rt: Ty): string {
        if (primName(ty) === "str" || primName(lt) === "str") return `(${l} + ${r})`;
        if (isFloatTy(ty)) return `(${l} ${op} ${r})`;
        if (!isIntTy(ty)) return `(${l} ${op} ${r})`;
        const t = JSON.stringify(primName(ty) ?? "int");
        if (isBig(ty)) {
            if (!isBig(lt)) l = `BigInt(${l})`;
            if (!isBig(rt)) r = `BigInt(${r})`;
        }
        switch (op) {
            case "+": case "-": case "*": return `$rt.chk(${l} ${op} ${r}, ${t})`;
            case "/": return `$rt.div(${l}, ${r}, ${t})`;
            case "%": return `$rt.rem(${l}, ${r}, ${t})`;
            case "<<": return `$rt.shl(${l}, ${r}, ${t})`;
            case ">>": return `$rt.shr(${l}, ${r}, ${t})`;
            case "&": case "|": case "^": return isBig(ty) ? `(${l} ${op} ${r})` : `$rt.wrap(${l} ${op} ${r}, ${t})`;
            default: return `(${l} ${op} ${r})`;
        }
    }

    // ---- calls --------------------------------------------------------------------------------

    /** Arguments: read ones as values, `*` ones as cells; returns what to write back afterwards. */
    args(args: H.Arg[], callee: H.Fun | null, offset = 0): { js: string[]; after: string[] } {
        const after: string[] = [];
        const exprs = args.map((a) => (a.mode === "read" ? a.expr : null));
        const anyStmts = exprs.some((x) => x !== null && needsStatements(x)) || args.some((a) => a.mode === "write");
        const js = args.map((a, i) => {
            const param = callee?.params[i + offset];
            if (a.mode === "write") return this.writeArg(a, after);
            if (a.expr.k === "vec" && param && T.prune(param.ty).k === "named") {
                const elem = (T.prune(param.ty) as { args: Ty[] }).args[0];
                if (elem && isInter(elem)) {
                    const vals = this.exprs(a.expr.elems.map((x) => (x.k === "spread" ? x.expr : x)), (x) => this.coerce(this.value(x), x, elem));
                    return `$rt.vec(${vals.join(", ")})`;
                }
            }
            const v = this.value(a.expr, param?.ty);
            if (!anyStmts || /^\$t\d+$/.test(v)) return v;
            const t = this.temp();
            this.emit(`const ${t} = ${v};`);
            return t;
        });
        return { js, after };
    }

    /** A `*` argument: the caller's cell, or a box written back after the call. */
    writeArg(a: H.Arg & { mode: "write" }, after: string[]): string {
        const p = a.place;
        const last = p.segs[p.segs.length - 1];
        if (p.segs.length === 0 && p.root.k === "local" && this.cells.has(p.root.local)) return this.symName(p.root.local, p.root.name);
        if (p.segs.length === 0 && p.root.k === "global" && this.e.p.globals.find((g) => g.name === (p.root as { name: string }).name)?.mutable) return `${globalName(p.root.name)}()`;
        if (last?.k === "field" && last.mode === "shared") {
            // the shared cell itself: the callee aliases it (§10.1)
            const w = this.prepare({ root: p.root, segs: p.segs.slice(0, -1) });
            const obj = p.segs.length === 1 ? this.rootExpr(p.root) : w.readNow();
            return `${obj}.${last.name}`;
        }
        const w = this.prepare(p);
        const box = this.temp();
        this.emit(`const ${box} = $rt.cell($rt.u(${w.readNow()}));`);
        after.push(`${w.write(`${box}.v`)};`);
        return box;
    }

    withWritebacks(call: string, after: string[]): string {
        if (after.length === 0) return call;
        const r = this.temp();
        this.emit(`const ${r} = ${call};`);
        for (const a of after) this.emit(a);
        return r;
    }

    recv(a: H.Arg): string {
        if (a.mode === "write") return this.uniquePlace(a.place);
        return this.expr(a.expr);
    }

    call(e: H.Expr & { k: "call" }): string {
        const c = e.callee;
        if (c.k === "fn") {
            const callee = this.e.funs.get(c.name) ?? null;
            const boxed = !!callee && callee.selfMode === "write" && !!callee.body && !callee.builtin && e.recv?.mode === "write";
            const early: string[] = [];
            const recv = e.recv ? [boxed ? this.writeArg(e.recv as H.Arg & { mode: "write" }, early) : this.recv(e.recv)] : [];
            const { js, after } = this.args(e.args, callee);
            after.unshift(...early);
            const wit = (callee?.witnesses.js ?? []).map((g) => this.witnessFor(g, e.witnessArgs));
            return this.withWritebacks(`${fnName(c.name)}(${[...recv, ...js, ...wit].join(", ")})`, after);
        }
        if (c.k === "dyn") {
            const recv = e.recv ? this.recv(e.recv) : "undefined";
            const { js, after } = this.args(e.args, null);
            return this.withWritebacks(`$rt.dyn(${[recv, JSON.stringify(c.method), ...js].join(", ")})`, after);
        }
        if (c.k === "auto") {
            const recv = e.recv ? this.recv(e.recv) : "undefined";
            const recvTy = e.recv ? (e.recv.mode === "read" ? e.recv.expr.ty : e.recv.ty) : T.UNKNOWN;
            const { js } = this.args(e.args, null);
            switch (c.method) {
                case "to_str": return `$rt.show(${recv}, ${JSON.stringify(shapeOf(recvTy))})`;
                case "eq": case "same_fields": return `$rt.eq(${recv}, ${js[0]})`;
                case "hash": return `$rt.hash(${recv})`;
                case "clone": return `$rt.s(${recv})`;
                case "weak": return `$rt.weak(${recv})`;
                default: return `$rt.dyn(${recv}, ${JSON.stringify(c.method)})`;
            }
        }
        // a static of a generic parameter, through its witness (§15.4)
        const w = this.witnesses.get(c.param) ?? "null";
        const { js } = this.args(e.args, null);
        return `$rt.wstatic(${w}, ${JSON.stringify(c.method)}, [${js.join(", ")}])`;
    }

    /** The witness table passed for a callee's generic parameter `g` (§15.4). */
    witnessFor(g: Sym, args: [Sym, Ty][]): string {
        const t = T.prune(args.find(([s]) => s === g)?.[1] ?? T.UNKNOWN);
        if (t.k === "param" && this.witnesses.has(t.sym)) return this.witnesses.get(t.sym)!;
        return `$rt.wt(${this.e.desc(t, null, this.witnesses)})`;
    }

    closure(e: H.Expr & { k: "closure" }): string {
        const fe = new FnEmitter(this.e, this.f, this.file);
        for (const s of this.cells) fe.cells.add(s);
        for (const s of this.writeViews) fe.writeViews.add(s);
        for (const [k, v] of this.witnesses) fe.witnesses.set(k, v);
        e.params.forEach((l, i) => e.modes[i] === "write" && fe.cells.add(l.sym));
        fe.temps = this.temps + 1000;
        fe.declareCells(e.body);
        for (const s of e.body.stmts) fe.stmt(s);
        if (e.body.value) {
            fe.pos(e.body.value.span);
            fe.into(e.body.value, { k: "return" });
        }
        const params = e.params.map((l) => this.symName(l.sym, l.name));
        const isAsync = containsAwait(e.body);
        return `(${isAsync ? "async " : ""}(${params.join(", ")}) => {\n${fe.lines.join("\n")}\n})`;
    }

    // ---- control flow -------------------------------------------------------------------------

    match(e: H.Expr & { k: "match" }, dest: Dest): void {
        const subj = this.temp();
        this.emit(`const ${subj} = ${this.expr(e.subject)};`);
        const label = `$m${this.temps++}`;
        this.emit(`${label}: {`);
        for (const arm of e.arms) {
            this.emit(`if (${this.test(arm.pattern, subj, e.subject.ty)}) {`);
            this.binds(arm.pattern, subj, "let");
            if (arm.guard) this.emit(`if (${this.expr(arm.guard)}) {`);
            this.into(arm.body, dest);
            this.emit(`break ${label};`);
            if (arm.guard) this.emit("}");
            this.emit("}");
        }
        this.emit(`$rt.panic("User", "no arm of this match applies");`);
        this.emit("}");
    }

    select(e: H.Expr & { k: "select" }, dest: Dest): void {
        const waits = this.exprs(e.arms.map((a) => a.wait));
        const tests = e.arms.map((a) => `(v) => ${this.test(a.pattern, "v", T.UNKNOWN)}`);
        const r = this.temp();
        this.emit(`const ${r} = await $rt.aw($rt.select([${waits.join(", ")}], [${tests.join(", ")}], ${e.else !== null}));`);
        e.arms.forEach((a, i) => {
            this.emit(`${i === 0 ? "" : "else "}if (${r}[0] === ${i}) {`);
            this.binds(a.pattern, `${r}[1]`, "let");
            this.into(a.body, dest);
            this.emit("}");
        });
        if (e.else) {
            this.emit("else {");
            this.into(e.else, dest);
            this.emit("}");
        }
    }

    loop(e: H.Expr & ({ k: "loop" } | { k: "foreach" }), dest: Dest): void {
        const js = `$L${this.temps++}`;
        const result = e.k === "loop" && dest.k !== "discard" ? this.temp() : null;
        if (result) this.emit(`let ${result};`);
        const loop: Loop = { label: e.label, js, result };
        if (e.k === "loop") {
            this.loops.push(loop);
            this.emit(`${js}: for (;;) {`);
            this.block(e.body, { k: "discard" });
            this.emit("}");
            this.loops.pop();
            if (result) this.put(result, dest, e.ty);
            return;
        }
        const item = this.temp();
        const second = this.temp();
        const header = this.foreachHeader(e, item, second);
        this.loops.push(loop);
        this.emit(`${js}: ${header} {`);
        if (e.of === "async") {
            this.emit(`if (!(${item} instanceof $rt.Some)) break;`);
            this.binds(e.item, `${item}.v`, "let");
        } else {
            this.binds(e.item, item, "let");
            if (e.second) this.binds(e.second, second, "let");
        }
        this.block(e.body, { k: "discard" });
        this.emit("}");
        this.loops.pop();
        if (dest.k !== "discard") this.put("undefined", dest, e.ty);
    }

    foreachHeader(e: H.Expr & { k: "foreach" }, item: string, second: string): string {
        if (e.of === "range" && e.iterable.k === "range" && e.iterable.start && e.iterable.end) {
            const [a, b] = this.exprs([e.iterable.start, e.iterable.end]);
            const one = isBig(e.iterable.start.ty) ? "1n" : "1";
            const end = this.temp();
            this.emit(`const ${end} = ${b};`);
            return `for (let ${item} = ${a}, ${second} = 0; ${item} ${e.iterable.inclusive ? "<=" : "<"} ${end}; ${item} += ${one}, ${second}++)`;
        }
        const it = this.temp();
        if (e.of === "async") {
            const t = T.prune(e.iterable.ty);
            const src = this.expr(e.iterable);
            this.emit(`const ${it} = ${src};`);
            const next = t.k === "named" && t.sym.pkg === "prelude" && (t.sym.name === "Sub" || t.sym.name === "Watcher") ? `${fnName(`prelude.${t.sym.name}.next`)}(${it})` : `$rt.dyn(${it}, "next")`;
            return `for (let ${item}; (${item} = await $rt.aw(${next})), true; )`;
        }
        this.emit(`const ${it} = $rt.s(${this.expr(e.iterable)});`);
        if (e.of === "vec" && !(T.prune(e.iterable.ty).k === "named" && (T.prune(e.iterable.ty) as { sym: Sym }).sym.name === "Set")) {
            return `for (let ${second} = 0, ${item}; ${second} < ${it}.length && ((${item} = ${it}[${second}]), true); ${second}++)`;
        }
        if (e.of === "map") return `for (const [${item}, ${second}] of [...${it}.m.values()])`;
        return `for (const ${item} of $rt.iter(${it}))`;
    }

    // ---- patterns -----------------------------------------------------------------------------

    /** A JS condition: whether `subj` matches `p`. */
    test(p: H.Pattern, subj: string, ty: Ty): string {
        switch (p.k) {
            case "wild": case "bind":
                return "true";
            case "lit":
                if (p.value === null) return "true";
                if (typeof p.value === "string") return `${subj} === ${JSON.stringify(p.value)}`;
                if (typeof p.value === "boolean") return `${subj} === ${p.value}`;
                return `${subj} == ${typeof p.value === "bigint" ? `${p.value}` : p.value}`;
            case "range": {
                const v = (x: bigint | number | string) => (typeof x === "string" ? JSON.stringify(x) : String(x));
                return `(${subj} >= ${v(p.start)} && ${subj} ${p.inclusive ? "<=" : "<"} ${v(p.end)})`;
            }
            case "ok":
                return `($rt.isOk(${subj}) && ${this.test(p.value, `${subj}.v`, T.UNKNOWN)})`;
            case "fail":
                return `(!$rt.isOk(${subj}) && ${this.test(p.payload, `${subj}.e`, T.UNKNOWN)})`;
            case "variant": {
                const head = p.union === "?" ? `${subj}?.$v === ${JSON.stringify(p.variant)}` : `${subj} instanceof ${variantClass(p.union, p.variant)}`;
                const keys = this.variantKeys(p.union, p.variant);
                const sub = p.fields.map((f, i) => this.test(f, `${subj}.${keys[i] ?? `$${i}`}`, T.UNKNOWN)).filter((x) => x !== "true");
                return sub.length === 0 ? `(${head})` : `(${head} && ${sub.join(" && ")})`;
            }
            case "fields": {
                const sub = p.fields.map((f) => this.test(f.pattern, `${subj}.${f.name}`, T.UNKNOWN)).filter((x) => x !== "true");
                return sub.length === 0 ? "true" : sub.join(" && ");
            }
            case "tuple": {
                const sub = p.elems.map((x, i) => this.test(x, `${subj}[${i}]`, T.UNKNOWN)).filter((x) => x !== "true");
                return sub.length === 0 ? "true" : sub.join(" && ");
            }
            case "or":
                return `(${p.alts.map((a) => this.test(a, subj, ty)).join(" || ")})`;
        }
    }

    variantKeys(union: string, variant: string): string[] {
        const u = this.e.p.types.find((t) => t.kind === "union" && t.name === union) as (H.TypeDef & { kind: "union" }) | undefined;
        const v = u?.variants.find((x) => x.name === variant);
        if (!v) return [];
        return v.positional ? v.fields.map((_, i) => `$${i}`) : v.fields;
    }

    /** Declares (`let`) or assigns the pattern's bindings from `subj`. */
    binds(p: H.Pattern, subj: string, mode: "let" | "assign"): void {
        switch (p.k) {
            case "bind": {
                const n = this.localName(p.local);
                const v = isCopyTy(p.local.ty) ? subj : `$rt.s(${subj})`;
                const val = this.cells.has(p.local.sym) ? `$rt.cell(${v})` : v;
                this.emit(mode === "let" ? `let ${n} = ${val};` : `${n} = ${val};`);
                return;
            }
            case "ok":
                return this.binds(p.value, `${subj}.v`, mode);
            case "fail":
                return this.binds(p.payload, `${subj}.e`, mode);
            case "variant": {
                const keys = this.variantKeys(p.union, p.variant);
                p.fields.forEach((f, i) => this.binds(f, `${subj}.${keys[i] ?? `$${i}`}`, mode));
                return;
            }
            case "fields":
                for (const f of p.fields) this.binds(f.pattern, `${subj}.${f.name}`, mode);
                return;
            case "tuple":
                p.elems.forEach((x, i) => this.binds(x, `${subj}[${i}]`, mode));
                return;
            case "or": {
                const names = bindings(p.alts[0]!);
                if (names.length === 0) return;
                if (mode === "let") for (const l of names) this.emit(`let ${this.localName(l)};`);
                p.alts.forEach((a, i) => {
                    this.emit(`${i === 0 ? "" : "else "}if (${this.test(a, subj, T.UNKNOWN)}) {`);
                    this.binds(a, subj, "assign");
                    this.emit("}");
                });
                return;
            }
            default:
                return;
        }
    }
}

// ---- helpers -------------------------------------------------------------------------------------

function bindings(p: H.Pattern): H.Local[] {
    switch (p.k) {
        case "bind": return [p.local];
        case "ok": return bindings(p.value);
        case "fail": return bindings(p.payload);
        case "variant": return p.fields.flatMap(bindings);
        case "fields": return p.fields.flatMap((f) => bindings(f.pattern));
        case "tuple": return p.elems.flatMap(bindings);
        case "or": return p.alts[0] ? bindings(p.alts[0]) : [];
        default: return [];
    }
}

/** Expressions emitted as statements (`into`), their value through a temporary. */
const STMT_KINDS = new Set(["if", "match", "block", "loop", "foreach", "break", "continue", "return", "select", "recover", "lock"]);

/** Whether emitting `e` needs statements (control flow inside it, or a write with copy-on-write). */
function needsStatements(e: H.Expr): boolean {
    switch (e.k) {
        case "if": case "match": case "block": case "loop": case "foreach": case "break": case "continue":
        case "return": case "select": case "recover": case "lock": case "assign":
            return true;
        case "call":
            if ((e.recv?.mode === "write") || e.args.some((a) => a.mode === "write")) return true;
            break;
        case "callvalue":
            if (e.args.some((a) => a.mode === "write")) return true;
            break;
        case "closure":
            return false;
    }
    let found = false;
    children(e, (x) => {
        if (!found && needsStatements(x)) found = true;
    });
    return found;
}

/** The blocks directly inside an expression. */
function blocksOf(e: H.Expr): H.Block[] {
    switch (e.k) {
        case "if": return [e.then, ...(e.else ? [e.else] : [])];
        case "loop": case "foreach": return [e.body];
        case "block": return [e.block];
        case "recover": return [e.body];
        case "lock": return [e.body];
        default: return [];
    }
}

/** The direct sub-expressions (not inside closures' bodies, which `closure` handles). */
function children(e: H.Expr, f: (e: H.Expr) => void): void {
    const place = (p: H.Place) => {
        if (p.root.k === "value") f(p.root.expr);
        for (const s of p.segs) if (s.k === "elem") f(s.index);
    };
    const arg = (a: H.Arg) => (a.mode === "read" ? f(a.expr) : place(a.place));
    const sub = (x: H.Expr | H.Spread | null) => {
        if (x) f(x.k === "spread" ? x.expr : x);
    };
    const block = (b: H.Block) => {
        for (const s of b.stmts) f(s.k === "let" ? s.value : s.expr);
        if (b.value) f(b.value);
    };
    switch (e.k) {
        case "read": return place(e.place);
        case "assign": place(e.place); return f(e.value);
        case "call": if (e.recv) arg(e.recv); e.args.forEach(arg); return;
        case "callvalue": f(e.fn); e.args.forEach(arg); return;
        case "extern": e.args?.forEach(f); return;
        case "struct": case "record": e.fields.forEach((x) => f(x.value)); return;
        case "variant": e.fields.forEach(f); return;
        case "tuple": e.elems.forEach(f); return;
        case "vec": case "array": case "set": e.elems.forEach(sub); return;
        case "map": e.entries.forEach((en) => ("k" in en ? sub(en) : (f(en.key), f(en.value)))); return;
        case "range": sub(e.start); sub(e.end); return;
        case "unary": case "tostr": case "cast": case "await": case "truthy": return f(e.expr);
        case "binary": case "and": case "or": f(e.left); f(e.right); return;
        case "concat": e.parts.forEach(f); return;
        case "if": f(e.cond); block(e.then); if (e.else) block(e.else); return;
        case "match": f(e.subject); e.arms.forEach((a) => (sub(a.guard), f(a.body))); return;
        case "loop": return block(e.body);
        case "foreach": f(e.iterable); return block(e.body);
        case "break": case "return": return sub(e.value);
        case "block": return block(e.block);
        case "select": e.arms.forEach((a) => (f(a.wait), f(a.body))); return sub(e.else);
        case "recover": return block(e.body);
        case "lock": e.places.forEach(place); return block(e.body);
        default: return;
    }
}
