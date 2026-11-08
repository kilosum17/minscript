# stage1: the self-hosted MinScript compiler

The MinScript compiler, written in MinScript. It replaces the TypeScript compiler in `../minscript/` (stage 0) one pass at a time; stage 0 compiles and runs it until stage 1 can compile itself.

## Rules

- **Port, don't redesign.** Each pass mirrors its stage-0 file (`src/lexer/lexer.ms` ← `../minscript/src/lexer.ts`): the same algorithm, the same diagnostics (codes and messages), the same dump formats. Improvements go into stage 0 first (with its tests and the spec), then are ported.
- **Differential testing is the definition of done.** `ms run difftest` (`tools/difftest.sh`) runs stage 0 and stage 1 over every `.ms` file of the repository and requires identical output. Each ported pass adds its dump to it (lexer: `.tokens`; next: parser `.ast`, …). Stage 0's `npm test` runs it too.
- **Unit tests in MinScript**, next to the code: `*_test.ms` with `test_` functions (`ms test`).
- **Gaps in MinScript go into stage 0.** If the port needs something MinScript lacks (a std function, a checker fix), add it to `../minscript/` with tests and spec, as for any feature (`std.utf8` came from the lexer port). Don't work around it here.
- Follow `../minscript/CLAUDE.md` for MinScript style (bindings, closures, `as`, ownership) and `../minscript/docs/spec.md` for the language.

## Layout

- `mod.ms`: the project (`main` is `./src`); scripts: `difftest`.
- `src/main.ms`: the CLI (`ms run . -- lex <file.ms>…`).
- `src/lexer/`: `token.ms` (tokens, keyword and punctuator tables), `lexer.ms` (the lexer), `dump.ms` (the `.tokens` dump), `lexer_test.ms`.

## Representation choices (so far)

- Spans are records (`r{ start, end, line, col }`): Copy, passed by value.
- Token kinds are strings (a kind is its own text, as in stage 0).
- State shared between structures lives in an arena with indices (the lexer's string states: `strings: Vec[StringState]`, referenced from the mode stack by index), because MinScript values have one owner.
- Integer literal values are decimal strings (literals may exceed u64).

## Commands (from `stage1/`)

```bash
ms check .                        # type-check and ownership-check stage 1
ms test                           # its unit tests
ms run difftest                   # stage 0 vs stage 1 on every file
ms run . -- lex file.ms           # the token dump of a file
```
