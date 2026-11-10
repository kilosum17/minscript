// The `ms` command for v0.4. Only the front end exists so far:
//   node src/cli.ts lex     <file.ms>    tokens
//   node src/cli.ts parse   <file.ms>    AST (S-expressions); the file on its own
//   node src/cli.ts resolve <file.ms>    what each name binds to; the file's whole program is loaded
//   node src/cli.ts types   <file.ms>    the type of each binding and parameter (whole program checked)
//   node src/cli.ts hir     <file.ms>    the file's functions lowered to HIR, with access paths and witnesses
//   node src/cli.ts effects <file.ms>    the effect summary of each of the file's functions
//   node src/cli.ts check   <entry>...   parse + load + resolve + type-check each program (a file, a folder or a
//                                        project); diagnostics only, exit 1 on errors

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { LineMap, formatDiagnostic, type Diagnostic } from "./diagnostic.ts";
import { dumpTokens } from "./dump.ts";
import { lex } from "./lexer.ts";
import { checkProgram } from "./check.ts";
import { loadPrelude, loadProgram } from "./loader.ts";
import { dumpResolution } from "./resolve_dump.ts";
import { dumpTypes } from "./check_dump.ts";
import { dumpFun } from "./hir_dump.ts";
import { frontEnd } from "./pipeline.ts";
import { showSummary } from "./effects.ts";
import { parse } from "./parser.ts";
import { sexpr } from "./sexpr.ts";

function msFiles(path: string): string[] {
    if (!statSync(path).isDirectory()) return [path];
    const out: string[] = [];
    for (const name of readdirSync(path).sort()) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const p = join(path, name);
        if (statSync(p).isDirectory()) out.push(...msFiles(p));
        else if (p.endsWith(".ms")) out.push(p);
    }
    return out;
}

const lineMaps = new Map<string, LineMap>();

function printDiagnostics(ds: Diagnostic[]): number {
    for (const d of ds) {
        const file = d.file ?? "?";
        let lines = lineMaps.get(file);
        if (!lines) {
            lines = new LineMap(existsSync(file) && statSync(file).isFile() ? readFileSync(file) : new Uint8Array());
            lineMaps.set(file, lines);
        }
        console.log(formatDiagnostic(d, relative(process.cwd(), file), lines));
    }
    return ds.length;
}

function main(args: string[]): number {
    const [cmd, ...rest] = args;
    switch (cmd) {
        case "lex": {
            for (const f of rest) process.stdout.write(dumpTokens(lex(readFileSync(f))));
            return 0;
        }
        case "parse": {
            let errors = 0;
            for (const f of rest) {
                const r = parse(readFileSync(f));
                process.stdout.write(sexpr(r.file) + "\n");
                const lines = new LineMap(r.lexed.src);
                for (const d of r.diagnostics) console.error(formatDiagnostic(d, f, lines));
                errors += r.diagnostics.length;
            }
            return errors > 0 ? 1 : 0;
        }
        case "resolve": {
            let errors = 0;
            for (const f of rest) {
                const program = loadProgram(f, { tests: true });
                const full = resolvePath(f);
                const pkg = program.packages.find((p) => p.files.some((x) => x.path === full));
                const file = pkg?.files.find((x) => x.path === full);
                if (pkg && file) process.stdout.write(dumpResolution(pkg.res, full, file.src));
                errors += printDiagnostics(program.diagnostics);
            }
            return errors > 0 ? 1 : 0;
        }
        case "types": {
            let errors = 0;
            for (const f of rest) {
                const program = loadProgram(f, { tests: true });
                const checked = checkProgram(program, loadPrelude().file);
                const full = resolvePath(f);
                const pkg = program.packages.find((p) => p.files.some((x) => x.path === full));
                const file = pkg?.files.find((x) => x.path === full);
                const result = pkg ? checked.packages.get(pkg) : undefined;
                if (pkg && file && result) process.stdout.write(dumpTypes(pkg.res, result, full, file.src));
                errors += printDiagnostics([...program.diagnostics, ...checked.diagnostics]);
            }
            return errors > 0 ? 1 : 0;
        }
        case "hir": {
            let errors = 0;
            for (const f of rest) {
                const fe = frontEnd(f, { tests: true });
                const full = resolvePath(f);
                for (const fun of fe.hir.funs) if (fun.file === full) process.stdout.write(dumpFun(fun) + "\n\n");
                for (const p of fe.hirProblems) console.log(`internal: ${p}`);
                errors += printDiagnostics(fe.diagnostics) + fe.hirProblems.length;
            }
            return errors > 0 ? 1 : 0;
        }
        case "effects": {
            let errors = 0;
            for (const f of rest) {
                const fe = frontEnd(f, { tests: true });
                const full = resolvePath(f);
                const funs = fe.hir.funs.filter((x) => x.file === full);
                const width = Math.max(...funs.map((x) => x.name.length), 0);
                for (const fun of funs) console.log(`${fun.name.padEnd(width)}  ${showSummary(fe.effects.summaries.get(fun)!)}`);
                errors += printDiagnostics(fe.diagnostics);
            }
            return errors > 0 ? 1 : 0;
        }
        case "check": {
            let errors = 0;
            const seen = new Set<string>();
            for (const entry of rest) {
                const program = loadProgram(entry, { tests: true });
                const checked = checkProgram(program, loadPrelude().file);
                const all = [...program.diagnostics, ...checked.prelude.diagnostics, ...checked.diagnostics];
                const fresh = all.filter((d) => !seen.has(`${d.file}:${d.start}:${d.code}`));
                for (const d of fresh) seen.add(`${d.file}:${d.start}:${d.code}`);
                errors += printDiagnostics(fresh);
                const files = program.packages.reduce((n, p) => n + p.files.length, 0);
                console.log(`${entry}: ${program.packages.length} package(s), ${files} file(s)`);
            }
            console.log(`${errors} diagnostic(s)`);
            return errors > 0 ? 1 : 0;
        }
        default:
            console.log("usage: ms lex <file> | ms parse <file> | ms resolve <file> | ms types <file> | ms hir <file> | ms effects <file> | ms check <entry>...");
            return cmd === undefined || cmd === "help" ? 0 : 2;
    }
}

process.exitCode = main(process.argv.slice(2));
