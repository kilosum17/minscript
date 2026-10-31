import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { lex } from "./lexer.ts";

function usage(): never {
  console.error("Usage: node run.ts [file.ms] [--json]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const file = args.find((arg) => !arg.startsWith("--")) ?? "sample.ms";
  if (args.filter((arg) => !arg.startsWith("--")).length > 1) usage();
  const path = resolve(process.cwd(), file);
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) { console.error(`Could not read ${path}:`, error); process.exit(1); }

  const result = lex(source);
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`\nMinScript lexer: ${file}\n`);
    for (let i = 0; i < result.tokens.length; i++) {
      const token = result.tokens[i];
      const flags = `${token.ws_before ? " ws" : ""}${token.nl_before ? " nl" : ""}`;
      const match = token.matching === null ? "" : ` match=${token.matching}`;
      const value = token.value === undefined ? "" : ` value=${JSON.stringify(token.value)}`;
      console.log(`${String(i).padStart(4)}  ${token.span.line}:${token.span.column}`.padEnd(14) + `${token.kind.padEnd(24)} ${JSON.stringify(token.lexeme)}${value}${flags}${match}`);
    }
    if (result.trivia.length) console.log(`\nTrivia: ${result.trivia.length} comment(s)`);
  }
  if (result.errors.length) {
    console.error(`\n${result.errors.length} lexer error(s):`);
    for (const error of result.errors) console.error(`  ${error.span.line}:${error.span.column} ${error.code}: ${error.message}`);
    process.exitCode = 1;
  } else if (!json) console.log("\nNo lexer errors.");
}

await main();
