// Loads a program (spec §8.1, §17.6): the entry's package and, depth first, every package it
// imports, each parsed and resolved after its dependencies.
//
// - `"app.x"` is the folder `x/` under the program's root (a project's `main` folder, or the entry
//   file's folder); `"./x"` / `"../x"` are relative to the importing file; `"std.x"` is `std/x/`.
//   A path whose last segment isn't a folder names an item of the parent package.
// - A first segment that is a `path:` dependency of `mod.ms` is that folder. Until `mod.ms` is
//   evaluated (§17.5), the loader reads `path:` dependencies and `main:` from it statically.
// - std packages that the spec lists but that aren't written yet (§21 step 10) load as *not
//   loaded*: their members stay unknown. So do dependencies that aren't `path:` ones.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type * as A from "./ast.ts";
import { diag, type Diagnostic } from "./diagnostic.ts";
import { parse } from "./parser.ts";
import { resolvePackage, splitImportPath, type LoadedImport, type Resolution, type ResolveFile } from "./resolve.ts";

export const STD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "std");

/** std packages of spec §14.4; a `std.` path outside this list is E_UNKNOWN_IMPORT. */
const STD_PACKAGES: ReadonlySet<string> = new Set([
    "std.io", "std.log", "std.time", "std.json", "std.fs", "std.env", "std.math", "std.crypto", "std.runtime",
    "std.utf8", "std.unsafe", "std.net", "std.net.http", "std.net.ws", "std.testing", "build", "ms", "ms.fmt", "ms.test",
]);

export interface LoadedFile extends ResolveFile {
    diagnostics: Diagnostic[];
}

export interface LoadedPackage {
    name: string;
    dir: string;
    files: LoadedFile[];
    res: Resolution;
    isMain: boolean;
}

export interface Program {
    /** in dependency order; the entry's package is last */
    packages: LoadedPackage[];
    prelude: Resolution;
    /** parse, load and resolve diagnostics of every file, each with its `file` */
    diagnostics: Diagnostic[];
    /** the `lint.setup(…)` settings of the project's mod.ms (§18.4), read without evaluating it */
    lint: LintSettings;
}

/** Lint levels set in mod.ms: `lint.setup(_{ allow: […], warn: […], deny: […], strict: true })`. */
export interface LintSettings {
    allow: string[];
    warn: string[];
    deny: string[];
    /** every lint that warns is an error */
    strict: boolean;
}

const noLint = (): LintSettings => ({ allow: [], warn: [], deny: [], strict: false });

export interface LoadOptions {
    /** include `*_test.ms` files in their packages (`ms check`) */
    tests?: boolean;
    /** include the `*_test.ms` files of this folder only (`ms test`, §17.7) */
    testDir?: string;
    /** files that exist only in memory, by absolute path (`ms test`'s generated harness) */
    virtual?: Map<string, string>;
    /**
     * The project, from its evaluated mod.ms (src/project.ts); null: none. When it is left out the
     * loader reads mod.ms statically (`main:` and `path:` deps written as literals).
     */
    project?: Project | null;
}

// ---- the prelude ---------------------------------------------------------------------------------

let preludeCache: { res: Resolution; file: LoadedFile } | null = null;

export function loadPrelude(): { res: Resolution; file: LoadedFile } {
    if (preludeCache) return preludeCache;
    const path = join(STD_DIR, "prelude.ms");
    const file = parseFile(path);
    const res = resolvePackage([file], { name: "prelude", prelude: null, std: true });
    preludeCache = { res, file };
    return preludeCache;
}

let virtualFiles: Map<string, string> | undefined;

function parseFile(path: string): LoadedFile {
    const text = virtualFiles?.get(path);
    const r = parse(text !== undefined ? new TextEncoder().encode(text) : readFileSync(path));
    for (const d of r.diagnostics) d.file = path;
    return { path, ast: r.file, src: r.lexed.src, diagnostics: r.diagnostics };
}

// ---- projects ------------------------------------------------------------------------------------

/** What the loader needs of a project (§17.6): its root, `main` folder, `path:` deps and lint levels. */
export interface Project {
    root: string;
    /** the folder holding `package main` */
    main: string;
    deps: Map<string, string>;
    lint: LintSettings;
}

/** The nearest folder at or above `start` (a file or a folder) with a mod.ms. */
export function findProjectRoot(start: string): string | null {
    let dir = resolvePath(start);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) dir = dirname(dir);
    for (;;) {
        if (existsSync(join(dir, "mod.ms"))) return dir;
        if (dirname(dir) === dir) return null;
        dir = dirname(dir);
    }
}

/** §17.6: `Config.main`, else `./src` if it exists, else the root. */
export function defaultMainDir(root: string, main = ""): string {
    if (main !== "") return resolvePath(root, main);
    return existsSync(join(root, "src")) && statSync(join(root, "src")).isDirectory() ? join(root, "src") : root;
}

/** The `lint.setup(…)` levels of a mod.ms, read statically. */
export function staticLint(mod: string): LintSettings {
    return readProject(dirname(mod), mod).lint;
}

function findProject(start: string): Project | null {
    for (let dir = start; ; dir = dirname(dir)) {
        const mod = join(dir, "mod.ms");
        if (existsSync(mod)) return readProject(dir, mod);
        if (dirname(dir) === dir) return null;
    }
}

/** Reads `main:` and `path:` dependencies from mod.ms without evaluating it. */
function readProject(root: string, mod: string): Project {
    const deps = new Map<string, string>();
    let main = "";
    const lint = noLint();
    const ast = parse(readFileSync(mod)).file;
    const visit = (v: unknown): void => {
        if (!v || typeof v !== "object") return;
        if (Array.isArray(v)) return v.forEach(visit);
        const o = v as Record<string, unknown>;
        if (o.kind === "Entry") {
            const k = o.key as A.Expr;
            const val = o.value as A.Expr;
            if (k.kind === "Str" && val.kind === "Str" && val.value.startsWith("path:")) {
                deps.set(k.value, resolvePath(root, val.value.slice(5)));
            }
        }
        if (o.kind === "Call") readLintSetup(o as unknown as A.Call, lint);
        if (o.kind === "Field" && o.name === "main" && (o.value as A.Expr | null)?.kind === "Str") {
            main = (o.value as A.StrLit).value;
        }
        for (const [key, child] of Object.entries(o)) if (key !== "span") visit(child);
    };
    visit(ast);
    const mainDir = main !== "" ? resolvePath(root, main) : existsSync(join(root, "src")) ? join(root, "src") : root;
    return { root, main: mainDir, deps, lint };
}

/** `lint.setup(_{ deny: ["L_IMPLICIT_COPY"], strict: true })`: string lists and a bool, read statically. */
function readLintSetup(call: A.Call, out: LintSettings): void {
    const c = call.callee;
    if (c.kind !== "Member" || c.name !== "setup" || c.target.kind !== "Ident" || c.target.name !== "lint") return;
    const arg = call.args[0]?.value;
    if (!arg || (arg.kind !== "Inferred" && arg.kind !== "Struct")) return;
    for (const item of arg.items) {
        if (item.kind !== "Field" || !item.value) continue;
        const v = item.value;
        if (item.name === "strict" && v.kind === "Bool") out.strict = v.value;
        if ((item.name === "allow" || item.name === "warn" || item.name === "deny") && v.kind === "Vec") {
            for (const el of v.elems) if (el.value.kind === "Str") out[item.name].push(el.value.value);
        }
    }
}

// ---- loading -------------------------------------------------------------------------------------

/** Loads the program whose entry is a file or a folder (§17.6). */
export function loadProgram(entry: string, opts: LoadOptions = {}): Program {
    return new Loader(opts).load(resolvePath(entry));
}

class Loader {
    readonly opts: LoadOptions;
    readonly prelude = loadPrelude();
    /** by key (folder, or folder + file for a single-file main): the package, or null while loading */
    readonly packages = new Map<string, LoadedPackage | null>();
    readonly order: LoadedPackage[] = [];
    readonly diagnostics: Diagnostic[] = [];
    project: Project | null = null;
    root = "";

    constructor(opts: LoadOptions) {
        this.opts = opts;
    }

    load(entry: string): Program {
        virtualFiles = this.opts.virtual;
        try {
            return this.loadEntry(entry);
        } finally {
            virtualFiles = undefined;
        }
    }

    loadEntry(entry: string): Program {
        if (entry === join(STD_DIR, "prelude.ms")) {
            // the prelude is loaded once, as itself
            return { packages: [], prelude: this.prelude.res, diagnostics: [...this.prelude.file.diagnostics, ...this.prelude.res.diagnostics], lint: noLint() };
        }
        const isDir = !this.opts.virtual?.has(entry) && statSync(entry).isDirectory();
        this.project = this.opts.project !== undefined ? this.opts.project : findProject(isDir ? entry : dirname(entry));
        if (isDir) {
            const main = this.project && (this.project.root === entry || entry.startsWith(this.project.main))
                ? this.project.main
                : existsSync(join(entry, "src")) && !existsSync(join(entry, "mod.ms")) ? join(entry, "src") : entry;
            this.root = main;
            this.loadMainFolder(main);
        } else {
            const file = parseFile(entry);
            const dir = dirname(entry);
            const isMain = file.ast.package.join(".") === "main";
            if (this.project && dir.startsWith(this.project.main) && isMain) {
                this.root = this.project.main;
                this.loadMainFolder(this.project.main);
            } else if (isMain || entry.endsWith("mod.ms")) {
                // a single `package main` file outside a project is a package of its own
                this.root = dir;
                this.loadPackage(entry, [file], isMain ? "main" : file.ast.package.join("."), dir, isMain);
            } else {
                this.root = this.project?.main ?? dir;
                // a package given as the entry is named by its declaration (`package failing`)
                const q = this.qualifiedName(dir);
                this.loadFolder(dir, q === "main" ? file.ast.package.join(".") : q);
            }
        }
        return {
            packages: this.order,
            prelude: this.prelude.res,
            diagnostics: [...this.diagnostics, ...this.order.flatMap((p) => [...p.files.flatMap((f) => f.diagnostics), ...p.res.diagnostics])],
            lint: this.project?.lint ?? noLint(),
        };
    }

    loadMainFolder(dir: string): LoadedPackage | null {
        const files = this.msFiles(dir).map(parseFile).filter((f) => f.ast.package.join(".") === "main");
        if (files.length === 0) {
            this.diagnostics.push({ ...diag("E_NO_MAIN", `no \`package main\` file in ${dir}`, 0, 0), file: dir });
            return null;
        }
        return this.loadPackage(dir, files, "main", dir, true);
    }

    msFiles(dir: string): string[] {
        const tests = (d: string) => this.opts.tests || this.opts.testDir === d;
        const real = readdirSync(dir)
            .filter((n) => n.endsWith(".ms") && n !== "mod.ms" && (tests(dir) || !n.endsWith("_test.ms")))
            .map((n) => join(dir, n))
            .filter((p) => statSync(p).isFile());
        const extra = [...(this.opts.virtual?.keys() ?? [])].filter((p) => dirname(p) === dir && !real.includes(p));
        return [...real, ...extra].sort();
    }

    qualifiedName(dir: string): string {
        if (dir.startsWith(STD_DIR + "/")) return relative(STD_DIR, dir).split("/").join(".").replace(/^(?!build$|build\.|ms$|ms\.)/, "std.");
        for (const [name, d] of this.project?.deps ?? []) {
            if (dir === d) return name;
            if (dir.startsWith(d + "/")) return name + "." + relative(d, dir).split("/").join(".");
        }
        const rel = relative(this.root, dir);
        return rel === "" ? "main" : "app." + rel.split("/").join(".");
    }

    /** Loads a non-main folder package (its files that don't declare `package main`). */
    loadFolder(dir: string, name: string): LoadedPackage | null {
        if (this.packages.has(dir)) return this.packages.get(dir) ?? null;
        const files = this.msFiles(dir).map(parseFile);
        return this.loadPackage(dir, files, name, dir, false);
    }

    loadPackage(key: string, files: LoadedFile[], name: string, dir: string, isMain: boolean): LoadedPackage | null {
        this.packages.set(key, null);
        const imports = new Map<A.Import, LoadedImport>();
        for (const f of files) {
            for (const imp of f.ast.imports) imports.set(imp, this.loadImport(imp, f));
        }
        const res = resolvePackage(files, { name, prelude: this.prelude.res, imports, std: dir.startsWith(STD_DIR) });
        const pkg: LoadedPackage = { name, dir, files, res, isMain };
        this.packages.set(key, pkg);
        this.order.push(pkg);
        return pkg;
    }

    error(code: string, message: string, imp: A.Import, file: LoadedFile): void {
        const d = diag(code, message, imp.span.start, imp.span.end);
        d.file = file.path;
        this.diagnostics.push(d);
    }

    /** Finds an import's package on disk and loads it (§8.1). */
    loadImport(imp: A.Import, file: LoadedFile): LoadedImport {
        const { base, items, glob } = splitImportPath(imp.path);
        const notLoaded: LoadedImport = { pkg: null, item: null, items, glob };
        const segs = base.split(".");
        let dir: string | null = null;
        let qualified = base;
        if (base.startsWith("./") || base.startsWith("../")) {
            dir = resolvePath(dirname(file.path), base);
            qualified = this.qualifiedName(dir);
        } else if (segs[0] === "app") {
            dir = join(this.root, ...segs.slice(1));
        } else if (segs[0] === "std" || segs[0] === "build" || segs[0] === "ms") {
            dir = join(STD_DIR, ...(segs[0] === "std" ? segs.slice(1) : segs));
        } else if (this.project?.deps.has(segs[0]!)) {
            dir = join(this.project.deps.get(segs[0]!)!, ...segs.slice(1));
        } else {
            return notLoaded; // an external dependency: not fetched yet
        }

        const std = segs[0] === "std" || segs[0] === "build" || segs[0] === "ms";
        const last = segs[segs.length - 1]!;
        const parentBase = segs.slice(0, -1).join(".");
        const plain = !glob && !items;
        let item: string | null = null;
        if (!isPackageDir(dir)) {
            if (std) {
                // std packages the spec lists but that aren't written yet load as not loaded
                if (STD_PACKAGES.has(base)) return notLoaded;
                if (plain && STD_PACKAGES.has(parentBase) && !isPackageDir(dirname(dir))) return { pkg: null, item: last, items: null, glob: false };
            }
            // `"app.catalog.Money"`: an item of the parent package (never of the root `main` folder)
            const minSegs = segs[0] === "app" ? 3 : 2;
            if (plain && segs.length >= minSegs && dirname(dir) !== this.root && dirname(dir) !== STD_DIR && isPackageDir(dirname(dir))) {
                item = last;
                dir = dirname(dir);
                qualified = parentBase;
            } else {
                this.error("E_UNKNOWN_IMPORT", `\`${imp.path}\` names no package`, imp, file);
                return notLoaded;
            }
        }
        const key = dir;
        if (this.packages.has(key) && this.packages.get(key) === null) {
            this.error("E_IMPORT_CYCLE", `importing \`${imp.path}\` closes a cycle: packages must not import each other`, imp, file);
            return notLoaded;
        }
        const firstFile = this.msFiles(dir)[0];
        if (firstFile && !this.packages.has(key)) {
            const peek = parse(readFileSync(firstFile)).file;
            if (peek.package.join(".") === "main") {
                this.error("E_IMPORT_MAIN", `\`${imp.path}\` is a folder of \`package main\` files, which can't be imported`, imp, file);
                return notLoaded;
            }
        }
        const pkg = this.loadFolder(dir, qualified);
        return { pkg: pkg?.res ?? null, item, items, glob };
    }
}

function isPackageDir(dir: string): boolean {
    return existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).some((n) => n.endsWith(".ms"));
}

const isUpper = (s: string) => s.length > 0 && s[0]! >= "A" && s[0]! <= "Z";
