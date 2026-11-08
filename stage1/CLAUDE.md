# stage1: the self-hosted MinScript compiler

The MinScript compiler, written in MinScript. It replaces the TypeScript compiler in `../minscript/` (stage 0) one pass at a time; stage 0 compiles and runs it until stage 1 can compile itself.

## Rules

- **Port, don't redesign.** Each pass mirrors its stage-0 file (`src/lexer/lexer.ms` ← `../minscript/src/lexer.ts`): the same algorithm, the same diagnostics (codes and messages), the same dump formats. Improvements go into stage 0 first (with its tests and the spec), then are ported.
- **Differential testing is the definition of done.** `ms run difftest` (`tools/difftest.sh`) runs stage 0 and stage 1 over every `.ms` file of the repository and requires identical output. Each ported pass adds its dump to it (done: lexer `.tokens`, parser `.ast`, resolver `.refs`, with diagnostics; next: checker `.types`, …). Stage 0's `npm test` runs it too.
- **Unit tests in MinScript**, next to the code: `*_test.ms` with `test_` functions (`ms test`).
- **Gaps in MinScript go into stage 0.** If the port needs something MinScript lacks (a std function, a checker fix), add it to `../minscript/` with tests and spec, as for any feature (`std.utf8` came from the lexer port). Don't work around it here.
- Follow `../minscript/CLAUDE.md` for MinScript style (bindings, closures, `as`, ownership) and `../minscript/docs/spec.md` for the language.

## Layout

- `mod.ms`: the project (`main` is `./src`); scripts: `difftest`.
- `src/main.ms`: the CLI (`ms run . -- lex|parse <file.ms>…`): dumps on stdout, diagnostics on stderr, as stage 0's `ms lex` / `ms parse`.
- `src/lexer/` (← `token.ts`, `lexer.ts`, `dump.ts`): `token.ms` (tokens, keyword and punctuator tables), `lexer.ms`, `dump.ms` (the `.tokens` dump), `lexer_test.ms`.
- `src/ast/` (← `ast.ts`, `sexpr.ts`): `ast.ms` (the AST), `sexpr.ms` (the `.ast` dump).
- `src/parser/` (← `parser.ts`): `parser.ms` (helpers, recovery, items, types), `expr.ms` (statements, expressions), `control.ms` (closures, control flow, patterns), `parser_test.ms`.
- `src/resolve/` (← `resolve.ts`, `resolve_dump.ts`, `std_stub.ts`): `resolve.ms` (symbols, scopes, items, imports), `walk.ms` (types, statements, patterns, expressions, closures), `dump.ms` (the `.refs` dump), `resolve_test.ms`. Not ported yet: imports of loaded packages (stage 0's `LoadedImport`), which come with the loader.

## Representation choices (so far)

- Spans are records (`r{ start, end, line, col }`): Copy, passed by value.
- Token kinds are strings (a kind is its own text, as in stage 0).
- State shared between structures lives in an arena with indices (the lexer's string states: `strings: Vec[StringState]`, referenced from the mode stack by index), because MinScript values have one owner.
- Integer literal values are decimal strings (literals may exceed u64).
- **The AST** is unions with `Box` for single children and `Vec` for lists (spec §7.3), and every node has an `id` (unique in its file): later passes key their side tables by id, where stage 0 keys them by object identity.
- **Parser recovery** is `Result[T, Sync]` with `?`: `fail()` reports and returns `Err(Sync)`, and the recovery boundaries (`parse_file`, `parse_members`, `parse_stmts`, `match` / `select` arms) match on it and resynchronize, exactly where stage 0 catches its `Sync` exception. Stage 0's `try / finally` context restores become explicit `enter` / `leave` around the call, before the `?`.
- **The resolver's symbols and scopes are arenas** (`symbols: Vec[Sym]`, `scopes: Vec[Scope]`) referenced by index; its side tables are `Map[int, …]` keyed by node id, and each entry carries what the dump shows (span, label), since an id alone doesn't say. The prelude's symbols are copied into each resolution's arena; a union symbol carries its variants (a symbol can't point into another file's AST). Node ids are unique across a program's files: `parse_from(src, first_id)` continues after the previous file (the prelude).
- Stage 0's callback helpers (`elementList`, `parseMembers`) become specialised loops (`expr_list`, `map_entries`, `record_items`, `parse_members` with a `MemberKind`): closures that mutate `this` are awkward under the ownership rules.

## Pitfalls found while porting

- An unqualified name in a pattern resolves through the prelude before the scrutinee's type (spec §6): a variant named `Range`, `Index` or like another type in scope (`Item`) silently means that type. Variants here are named `RangeExpr`, `IndexExpr`, `EValue`… (spec §18 #12).
- Keywords can't be names: fields and parameters use `ty`, `is_mut`, `is_async`, `is_await`, `else_branch`, `allow_inter`; reserved words too (`where` → `loc`); and `it` / `it1`… are reserved.
- A bare variant needs an expected type: annotate the first use (`let kind: ExprKind = match …`, `[EValue(x)] as Vec[Elem]`); later `match` / `if` arms get the earlier arms' type.

## Commands (from `stage1/`)

```bash
ms check .                        # type-check and ownership-check stage 1
ms test                           # its unit tests
ms run difftest                   # stage 0 vs stage 1 on every file
ms run . -- lex file.ms           # the token dump of a file
ms run . -- parse file.ms         # the AST dump (diagnostics on stderr)
ms run . -- resolve --prelude ../minscript/std/prelude.ms file.ms   # the resolution dump
```
