import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { lex } from "./lexer.ts";
import { parse } from "./parser.ts";

function usage(): never { console.error("Usage: node --experimental-strip-types run.ts [file.ms] [--json|--ast]"); process.exit(2); }
async function main(): Promise<void> {
  const args = process.argv.slice(2), json = args.includes("--json"), ast = args.includes("--ast");
  const file = args.find((arg) => !arg.startsWith("--")) ?? "sample.ms";
  if (args.filter((arg) => !arg.startsWith("--")).length > 1) usage();
  let source: string;
  try { source = await readFile(resolve(process.cwd(), file), "utf8"); }
  catch (error) { console.error(`Could not read ${file}:`, error); process.exit(1); }
  const result = ast || json ? parse(source) : { lexed: lex(source), ast: null, diagnostics: [] };
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (ast) console.log(JSON.stringify(result.ast, null, 2));
  else {
    console.log(`\nMinScript lexer: ${file}\n`);
    for (let i = 0; i < result.lexed.tokens.length; i++) { const t = result.lexed.tokens[i]; console.log(`${String(i).padStart(4)}  ${t.span.line}:${t.span.column}`.padEnd(14) + `${t.kind.padEnd(24)} ${JSON.stringify(t.lexeme)}${t.value === undefined ? "" : ` value=${JSON.stringify(t.value)}`}${t.ws_before ? " ws" : ""}${t.nl_before ? " nl" : ""}${t.matching === null ? "" : ` match=${t.matching}`}`); }
  }
  const errors = [...result.lexed.errors, ...result.diagnostics];
  if (errors.length) { console.error(`\n${errors.length} diagnostic(s):`); for (const e of errors) console.error(`  ${e.span.line}:${e.span.column} ${e.code}: ${e.message}`); process.exitCode = 1; }
}
main();
