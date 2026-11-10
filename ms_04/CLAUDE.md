# MinScript v0.4

The v0.4 restart: value semantics with inferred sharing (`T` / `*T` parameters, effect summaries, `shared`, `Identity`). Everything for v0.4 lives in this folder. `../minscript/` (stage 0, v0.2) and `../stage1/` are reference only.

## Layout

- `docs/spec.md`: **the source of truth**, self-contained. Change it before or alongside any syntax or semantics change, and keep §18 (diagnostics), §19 (grammar), §20 (corpus) and §22 (open questions) in sync. `docs/spec_04_ai.md` is the design note with the reasoning (superseded, its section numbers differ); `docs/porting_notes.md` records the v0.2 → v0.4 port.
- `src/`: the compiler in TypeScript, run directly by Node ≥ 23.6 (type stripping), no runtime dependencies. Erasable TS only (no `enum`, `namespace`, parameter properties); import with `.ts`.
  - `token.ts`, `diagnostic.ts` (`Diagnostic`, `LineMap`), `lexer.ts`, `ast.ts`, `parser.ts`, `sexpr.ts` (`.ast` format), `dump.ts` (`.tokens` format), `resolve.ts` (name resolution: side tables keyed by AST node), `resolve_dump.ts` (`.refs` format), `loader.ts` (finds a program's packages, resolves them in dependency order), `types.ts` + `check.ts` (the type checker: bidirectional, gradual `unknown`), `check_dump.ts` (`.types` format), `hir.ts` (the HIR: places, resolved calls, sugar removed), `lower.ts` (AST → HIR), `witness.ts` (which type parameters each generic function needs at run time, spec §15.4), `hir_check.ts` (HIR invariants: findings are compiler bugs), `hir_dump.ts` (`.hir` format), `effects.ts` (effect summaries, bottom-up by SCC, spec §9.5 / §15.1), `pipeline.ts` (the whole front end as one call), `cli.ts`.
  - Done: spec §21 steps 1 (lexer + parser), 2 (resolver + loader), 3 (type checker), 4 (HIR + witnesses) and 5 (effect summaries). Next: step 6, the access check.
  - Lowering reads the checker's recorded decisions (`types`, `calls`, `members`, `variants`, `ops`, `rets` in `CheckResult`); it never re-derives a type rule. If lowering needs a fact, record it in the checker.
  - The checker reports a mismatch only between two types it fully knows; anything it can't know is `unknown`. Don't add special cases for std packages that aren't written yet.
  - Passes don't modify the AST; they return side tables keyed by node.
- `std/`: std in MinScript. Only `std/prelude.ms` exists so far; it must parse and resolve cleanly. std packages listed in spec §14.4 but not written yet load as *not loaded* (members `unknown`), so don't add workarounds for them in the passes.
- `test/`: `errors/` (parser and lexer cases: one per function, `//~ CODE` on the line of each expected diagnostic, matched exactly), `resolve/` (each file resolved as one package: `//~` annotations, or a `.refs` snapshot when it has none), `check/` (the same, type-checked: `//~`, or a `.types` snapshot), `hir/` (lowered: a `.hir` snapshot), `effects/` (summaries: an `.effects` snapshot), `parser/` (`.ast` snapshots), `lexer/` (`.tokens` snapshots), `corpus.test.ts`, `programs.test.ts`. Unit tests sit next to the code as `src/*.test.ts`.
- `examples/` (the v0.2 corpus ported to v0.4) and `samples/` (`calc`, `shop`): every program loads and resolves with exactly the diagnostics its `//~` annotations name (most have none; `examples/packages/errors/` holds the loader cases).

## Commands

`npm test`, `npm run test:update` (rewrites snapshots: review the diff), `npm run typecheck`, `npm run lex -- f.ms`, `npm run parse -- f.ms`, `npm run resolve -- f.ms`, `npm run types -- f.ms`, `npm run hir -- f.ms`, `npm run effects -- f.ms`, `npm run check -- entry...` (a file, a folder or a project).

## Rules

- Parser errors: `report()` when the intended form is clear (keep parsing), `fail()` otherwise (reports and syncs to the next statement, item, member, arm or list element). Each mistake gives exactly one diagnostic. The lexer inserts synthetic closers so the parser never sees unbalanced delimiters.
- A new lexer diagnostic code goes in `LEXER_CODES` too. Every code in spec §18.1–§18.2 must have an `errors/` test, every resolver / loader code in §18.3 a `test/resolve/` case, an `examples/packages/errors/` case or a `src/loader.test.ts` test, and every checker code a `test/check/` case.
- MinScript code (samples, tests, spec examples) follows the spec, mixes `let` / `var` with `:=` / `:==`, and uses `x := [] as Vec[T]` as freely as `let x: Vec[T] = []`.
