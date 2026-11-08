# stage1: the self-hosted MinScript compiler

The MinScript compiler, written in MinScript. It replaces the TypeScript compiler in `../minscript/` (stage 0) one pass at a time; stage 0 compiles and runs it until stage 1 can compile itself.

## Rules

- **Port, don't redesign.** Each pass mirrors its stage-0 file (`src/lexer/lexer.ms` ← `../minscript/src/lexer.ts`): the same algorithm, the same diagnostics (codes and messages), the same dump formats. Improvements go into stage 0 first (with its tests and the spec), then are ported.
- **Differential testing is the definition of done.** `ms run difftest` (`tools/difftest.sh`) runs stage 0 and stage 1 over every `.ms` file of the repository and requires identical output. Each ported pass adds its dump to it (done: lexer `.tokens`, parser `.ast`, resolver `.refs`, checker `.types`, ownership diagnostics; next: lowering to HIR, …). Stage 0's `npm test` runs it too.
- **Unit tests in MinScript**, next to the code: `*_test.ms` with `test_` functions (`ms test`).
- **Gaps in MinScript go into stage 0.** If the port needs something MinScript lacks (a std function, a checker fix), add it to `../minscript/` with tests and spec, as for any feature (`std.utf8` came from the lexer port). Don't work around it here.
- Follow `../minscript/CLAUDE.md` for MinScript style (bindings, closures, `as`, ownership) and `../minscript/docs/spec.md` for the language.

## Layout

- `mod.ms`: the project (`main` is `./src`); scripts: `difftest`.
- `src/main.ms`: the CLI (`ms run . -- lex|parse <file.ms>…`, `resolve|types|ownership --prelude <prelude.ms> <file.ms>…`): dumps on stdout, diagnostics on stderr, as stage 0's `ms lex` / `ms parse` / `ms resolve` / `ms types` / `ms ownership`.
- `src/lexer/` (← `token.ts`, `lexer.ts`, `dump.ts`): `token.ms` (tokens, keyword and punctuator tables), `lexer.ms`, `dump.ms` (the `.tokens` dump), `lexer_test.ms`.
- `src/ast/` (← `ast.ts`, `sexpr.ts`): `ast.ms` (the AST), `sexpr.ms` (the `.ast` dump).
- `src/parser/` (← `parser.ts`): `parser.ms` (helpers, recovery, items, types), `expr.ms` (statements, expressions), `control.ms` (closures, control flow, patterns), `parser_test.ms`.
- `src/resolve/` (← `resolve.ts`, `resolve_dump.ts`, `std_stub.ts`): `resolve.ms` (symbols, scopes, items, imports), `walk.ms` (types, statements, patterns, expressions, closures), `dump.ms` (the `.refs` dump), `resolve_test.ms`. Not ported yet: imports of loaded packages (stage 0's `LoadedImport`), which come with the loader.
- `src/check/` (← `check.ts`, `types.ts`, `check_dump.ts`): `types.ms` (`Ty`, and prune / show / subst / occurs over the variable arena), `check.ms` (state, the declaration index, assignability, interfaces, type information, `Type` → `Ty`, signatures and methods, items, statements), `expr.ms` (expressions, operators, members, calls, literals with fields, closures), `control.ms` (if / match / select / for, patterns, exhaustiveness), `dump.ms` (the `.types` dump), `check_test.ms`. Not ported yet: imported packages' items (`pkgItem`, which needs the loader) and `membersOf` (editor completion).
- `src/ownership/` (← `ownership.ts`): `ownership.ms` (moves, mutability, scoped values, closures, spawns; `dump_ownership`: one line per diagnostic, as stage 0's `ms ownership`), `ownership_test.ms`.

## Representation choices (so far)

- Spans are records (`r{ start, end, line, col }`): Copy, passed by value.
- Token kinds are strings (a kind is its own text, as in stage 0).
- State shared between structures lives in an arena with indices (the lexer's string states: `strings: Vec[StringState]`, referenced from the mode stack by index), because MinScript values have one owner.
- Integer literal values are decimal strings (literals may exceed u64).
- **The AST** is unions with `Box` for single children and `Vec` for lists (spec §7.3), and every node has an `id` (unique in its file): later passes key their side tables by id, where stage 0 keys them by object identity.
- **Parser recovery** is `Result[T, Sync]` with `?`: `fail()` reports and returns `Err(Sync)`, and the recovery boundaries (`parse_file`, `parse_members`, `parse_stmts`, `match` / `select` arms) match on it and resynchronize, exactly where stage 0 catches its `Sync` exception. Stage 0's `try / finally` context restores become explicit `enter` / `leave` around the call, before the `?`.
- **The resolver's symbols and scopes are arenas** (`symbols: Vec[Sym]`, `scopes: Vec[Scope]`) referenced by index; its side tables are `Map[int, …]` keyed by node id, and each entry carries what the dump shows (span, label), since an id alone doesn't say. The prelude's symbols are copied into each resolution's arena; a union symbol carries its variants (a symbol can't point into another file's AST). Node ids are unique across a program's files: `parse_from(src, first_id)` continues after the previous file (the prelude).
- **The checker's types** are a value union (`Ty`, variants prefixed `Ty…`). Inference variables are an arena (`vars: Vec[VarState]`, `TyVar(id)`) with an undo trail, so prune / show / subst take the arena. Symbols are indices into the shared arena; type information (`TypeInfo`) is an arena too (`infos`, with `info_of: sym → index`): take what you need from `this.infos[i]` (clone a field list) before calling `&mut this` methods. Stage 0's `Sym.decl` / `A.FunDecl` references become a declaration index (`index: Map[int, Decl]`, node id → a copy of the declaration whose function bodies are emptied, so "has a body" is still known); bodies are checked by walking the files. Stage 0's `exp?: Ty` is `exp: Ty?`; its `Callable | Ty` is `Static` (`SCall` / `STy`).
- Stage 0's `assign` starts with an identity test (`from === to`); here only a variable meeting itself short-cuts. The difference shows only for a type value (`TyMeta`, `TyPackage`) compared with the very same object, which the corpus doesn't do.
- Numeric literals are defaulted from a list of literal variables (`lit_vars`), not by walking every recorded type after each function (stage 0's `finishInference`): same result, without the quadratic walk.
- **The ownership pass** keeps its function contexts on a stack (`ctxs`, the current one last) where stage 0 swaps one field. It knows nodes by id and span. Stage 0's `usesOf` (the Ident / This / RecordField uses of a binding) is rebuilt from the resolver's refs by label: captures (`capture x`) and `TypeOf(…)` are left out.
- Stage 0's callback helpers (`elementList`, `parseMembers`) become specialised loops (`expr_list`, `map_entries`, `record_items`, `parse_members` with a `MemberKind`): closures that mutate `this` are awkward under the ownership rules.

## Pitfalls found while porting

- An unqualified name in a pattern resolves through the prelude before the scrutinee's type (spec §6): a variant named `Range`, `Index` or like another type in scope (`Item`) silently means that type. Variants here are named `RangeExpr`, `IndexExpr`, `EValue`… (spec §18 #12).
- Keywords can't be names: fields and parameters use `ty`, `is_mut`, `is_async`, `is_await`, `else_branch`, `allow_inter`; reserved words too (`where` → `loc`); and `it` / `it1`… are reserved.
- A bare variant needs an expected type: annotate the first use (`let kind: ExprKind = match …`, `[EValue(x)] as Vec[Elem]`, `var value: Ty = TyUnknown`); later `match` / `if` arms get the earlier arms' type.
- Sigil letters can't be variables where the sigil is used: a local `t` next to a tuple `t(…)`, `m` next to `m{}`, `a` next to an `a[…]` index (`xs`, `target`, `no_env()`). `dyn` is reserved (`is_dyn`).
- `Box[T]` doesn't convert to `&T`: write `inner.get()`.
- The difftest is only as good as the corpus: after porting a rule, break it on purpose and check that `ms run difftest` notices; if it doesn't, add a case to stage 0's corpus (`test/check/inference.ms` got its widening join, `Default` of std types, auto `eq`, `-> void` function values and `for` values this way; `test/ownership/` its Copy types, handle captures, `recover`, loop liveness, `for await` and `&mut this` borrows).

## Commands (from `stage1/`)

```bash
ms check .                        # type-check and ownership-check stage 1
ms test                           # its unit tests
ms run difftest                   # stage 0 vs stage 1 on every file
ms run . -- lex file.ms           # the token dump of a file
ms run . -- parse file.ms         # the AST dump (diagnostics on stderr)
ms run . -- resolve --prelude ../minscript/std/prelude.ms file.ms   # the resolution dump
ms run . -- types --prelude ../minscript/std/prelude.ms file.ms     # the checker dump (stage 0: `ms types file.ms`)
ms run . -- ownership --prelude ../minscript/std/prelude.ms file.ms # the ownership diagnostics (stage 0: `ms ownership file.ms`)
```
