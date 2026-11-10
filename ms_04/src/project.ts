// Projects (spec §17): a folder with a `mod.ms`. Its `config()` is compiled and run on the JS back
// end; the result says where `package main` lives, which `path:` dependencies exist, the scripts
// `ms run <name>` can run, and every tool's section (`ms config` prints it).
//
// - Evaluation is separate from execution (§17.3): while `config()` runs, `build.run` is
//   E_SCRIPT_IN_EVAL. The sandbox of §17.5 (no network, no file writes) isn't enforced beyond that.
// - The result is cached by the text of mod.ms and the environment (§17.5), so the passes that load
//   the same project many times (`ms test`, the LSP) evaluate it once.
// - A folder without a mod.ms is a project with the defaults: `main` is `./src` if it exists, and
//   the folder itself otherwise (§17.6).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { diag, type Diagnostic } from "./diagnostic.ts";
import { defaultMainDir, findProjectRoot, staticLint, type LintSettings, type Project } from "./loader.ts";
// a cycle (the pipeline imports this file, and the compiler is built on the pipeline): used only at
// call time, never while the modules load
import { compile, runJs } from "./js/run.ts";
import * as rt from "./js/runtime.ts";
import * as stdlib from "./js/stdlib.ts";

export const MOD_FILE = "mod.ms";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A script from `Config.scripts` (§17.3). `fn` is the compiled closure of a `task`. */
export type Script = { kind: "Shell"; cmd: string } | { kind: "Package"; path: string } | { kind: "Task"; fn: (args: Any) => Any };

export interface ProjectConfig {
    name: string;
    version: string;
    main: string;
    deps: Map<string, string>;
    devDeps: Map<string, string>;
    scripts: Map<string, Script>;
    /** tool sections, as JSON */
    sections: Record<string, unknown>;
}

export interface OpenProject {
    root: string;
    /** null: no mod.ms (the defaults apply) */
    modFile: string | null;
    config: ProjectConfig | null;
    /** what the loader uses */
    project: Project;
    /** compiling or evaluating mod.ms went wrong (E_CONFIG_FAILED, E_SCRIPT_IN_EVAL, …) */
    diagnostics: Diagnostic[];
}

const noLint = (): LintSettings => ({ allow: [], warn: [], deny: [], strict: false });
const cache = new Map<string, OpenProject>();

/** The project a file or folder belongs to: the nearest mod.ms at or above it (evaluated), or null. */
export function projectOf(entry: string): OpenProject | null {
    const root = findProjectRoot(entry);
    return root === null ? null : openProject(root);
}

/** Opens the project at `root`: evaluates its mod.ms, if it has one. */
export function openProject(root: string): OpenProject {
    root = resolve(root);
    const modFile = join(root, MOD_FILE);
    if (!existsSync(modFile)) {
        return { root, modFile: null, config: null, project: { root, main: defaultMainDir(root), deps: new Map(), lint: noLint() }, diagnostics: [] };
    }
    const text = readFileSync(modFile, "utf8");
    const key = createHash("sha256").update(modFile).update("\0").update(text).update("\0").update(JSON.stringify(process.env)).digest("hex");
    const hit = cache.get(key);
    if (hit) return hit;
    const out = evaluate(root, modFile);
    cache.set(key, out);
    return out;
}

function evaluate(root: string, modFile: string): OpenProject {
    // the defaults, and what a static read finds, until the evaluation succeeds
    const base: OpenProject = { root, modFile, config: null, project: { root, main: defaultMainDir(root), deps: new Map(), lint: staticLint(modFile) }, diagnostics: [] };
    const fail = (code: string, message: string): OpenProject => ({ ...base, diagnostics: [...base.diagnostics, { ...diag(code, message, 0, 0), file: modFile }] });

    const c = compile(modFile, { load: { project: null }, entryFn: "config" });
    if (c.js === null) return { ...base, diagnostics: c.diagnostics.filter((d) => d.severity === "error") };
    if (!c.entryFound) return fail("E_CONFIG_FAILED", `${modFile} has no \`pub fn config() -> Config\` in \`package mod\``);

    let value: Any;
    stdlib.setEvaluating(true);
    try {
        const mod = new Function("$rt", c.js)(rt) as { main: () => Any };
        value = mod.main();
    } catch (e) {
        const message = e instanceof rt.ExitRequest ? `config() called runtime.exit(${e.code})` : rt.caught(e).message;
        const code = /^(E_[A-Z_]+):/.exec(message)?.[1] ?? "E_CONFIG_FAILED";
        return fail(code, `evaluating mod.ms: ${message.replace(/^E_[A-Z_]+: /, "")}`);
    } finally {
        stdlib.setEvaluating(false);
    }
    if (value instanceof rt.MsPromise) return fail("E_CONFIG_FAILED", "`config()` must not be async: evaluating mod.ms is synchronous");

    const config = fromConfigValue(value, stdlib.toJson);
    const diagnostics: Diagnostic[] = [];
    for (const [name, spec] of [...config.deps, ...config.devDeps]) {
        if (!validDep(spec)) diagnostics.push({ ...diag("E_BAD_DEP_SPEC", `dependency \`${name}\`: \`${spec}\` is neither a semver range nor \`path:\` / \`git:\``, 0, 0), file: modFile });
    }
    const deps = new Map<string, string>();
    for (const [name, spec] of config.deps) if (spec.startsWith("path:")) deps.set(name, resolve(root, spec.slice(5)));
    return {
        root, modFile, config, diagnostics,
        project: { root, main: defaultMainDir(root, config.main), deps, lint: lintOf(config.sections.lint) ?? base.project.lint },
    };
}

/** `^2.1.0`, `~1.2`, `>=1.0.0`, `1.2.3`, `*`, or a `path:` / `git:` source. */
function validDep(spec: string): boolean {
    if (spec.startsWith("path:") || spec.startsWith("git:")) return spec.length > spec.indexOf(":") + 1;
    return /^(\*|(\^|~|>=|<=|>|<|=)?\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?)$/.test(spec);
}

/** The `lint` section written by `ms.lint`'s `setup`. */
function lintOf(section: unknown): LintSettings | null {
    if (!section || typeof section !== "object") return null;
    const s = section as Record<string, unknown>;
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
    return { allow: list(s.allow), warn: list(s.warn), deny: list(s.deny), strict: s.strict === true };
}

/** The runtime value of a `build.Config` → TS. */
function fromConfigValue(v: Any, toJson: (v: Any) => Any): ProjectConfig {
    const entries = (m: Any): [Any, Any][] => [...m.m.values()];
    const strings = (m: Any) => new Map<string, string>(entries(m).map(([k, x]) => [String(k), String(x)]));
    const scripts = new Map<string, Script>();
    for (const [k, s] of entries(v.scripts)) {
        const kind = Object.getPrototypeOf(s)?.$v;
        if (kind === "Shell") scripts.set(k, { kind: "Shell", cmd: s.$0 });
        else if (kind === "Package") scripts.set(k, { kind: "Package", path: s.$0 });
        else scripts.set(k, { kind: "Task", fn: s.$0 });
    }
    return {
        name: v.name, version: v.version, main: v.main,
        deps: strings(v.deps), devDeps: strings(v.dev_deps), scripts,
        sections: toJson(v.sections) ?? {},
    };
}

/** What `ms config` prints. */
export function configJson(c: ProjectConfig): string {
    const scripts = Object.fromEntries([...c.scripts].map(([k, s]) => [k, s.kind === "Shell" ? { sh: s.cmd } : s.kind === "Package" ? { pkg: s.path } : { task: "<MinScript>" }]));
    return JSON.stringify({ name: c.name, version: c.version, main: c.main, deps: Object.fromEntries(c.deps), dev_deps: Object.fromEntries(c.devDeps), scripts, sections: c.sections }, null, 2);
}

// ---- running scripts (§17.3) -------------------------------------------------------------------------

/** Whether `ms run <x>` means a program (a path) rather than a script of the project. */
export function looksLikePath(x: string): boolean {
    return x.includes("/") || x.endsWith(".ms") || x === "." || x === ".." || existsSync(x);
}

/**
 * Runs the script `name` of the project at `root` with `args`; resolves to the exit code. A `Shell`
 * script runs in the project root with the arguments appended (quoted); a `Package` script runs that
 * folder's main with them in `env.args()`; a `Task` gets them as `Args`, and an `Err` fails it.
 */
export async function runScript(p: OpenProject, name: string, args: string[]): Promise<number> {
    const s = p.config?.scripts.get(name);
    if (!s) {
        process.stderr.write(`error: no script \`${name}\` in ${p.modFile ?? join(p.root, MOD_FILE)}${p.config ? `; scripts: ${[...p.config.scripts.keys()].join(", ") || "none"}` : ""}\n`);
        return 2;
    }
    if (s.kind === "Shell") {
        const { spawnSync } = await import("node:child_process");
        const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
        return spawnSync(`${s.cmd}${quoted ? ` ${quoted}` : ""}`, { shell: true, stdio: "inherit", cwd: p.root }).status ?? 1;
    }
    if (s.kind === "Package") {
        const c = compile(resolve(p.root, s.path));
        if (c.js === null) {
            for (const d of c.diagnostics.filter((x) => x.severity === "error")) process.stderr.write(`${d.file ?? "?"}: ${d.code}: ${d.message}\n`);
            return 1;
        }
        return (await runJs(c.js, { args })).code;
    }
    try {
        let r = s.fn(rt.make("build.Args", { list: rt.vec(...args) }));
        if (r instanceof rt.MsPromise) r = await r.p;
        if (r instanceof rt.Err) {
            process.stderr.write(`error: script \`${name}\` failed: ${rt.show(r.e)}\n`);
            return 1;
        }
        return 0;
    } catch (e) {
        if (e instanceof rt.ExitRequest) return e.code;
        process.stderr.write(`panic: ${rt.caught(e).message}\n`);
        return 101;
    }
}
