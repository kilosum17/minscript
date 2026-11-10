# MinScript v0.4 for VS Code

Syntax highlighting for the v0.4 grammar (spec §1), and live errors, lints, hover, completion,
signature help, inlay type hints, go-to-definition, find-references, rename and an outline from
the ms_04 compiler (the language server in [`../lsp`](../lsp)). The server speaks standard LSP, so
other editors can use it too: `node tools/lsp/server.ts --stdio` (Node ≥ 23.6).

## Install (from this repository)

The extension starts the language server with your system Node (≥ 23.6), which runs the compiler's
TypeScript directly: no build step.

```bash
cd ms_04 && npm install                          # the compiler's and the server's dependencies
cd tools/vscode && npm install                   # the LSP client library (and the grammar tests')
ln -s "$PWD" ~/.vscode/extensions/minscript.minscript-v04-0.4.0
```

Then run **Developer: Reload Window** and open a `.ms` file. Only one MinScript extension should be
installed at a time (both claim `.ms`): remove the stage 0 one first
(`~/.vscode/extensions/minscript.minscript-0.1.0`, the v0.2 grammar) or disable it in the
Extensions view.

## Settings

| Setting | Default | |
|---|---|---|
| `minscript.node` | `node` | the Node executable (≥ 23.6) that runs the server |
| `minscript.serverPath` | (next to the extension) | path to `tools/lsp/server.ts` |
| `minscript.trace.server` | `off` | log LSP messages (Output → MinScript) |

**MinScript: Restart Language Server** restarts the server, e.g. after pulling compiler changes.

## What the server does

- **Packages and projects:** every `.ms` file in a folder that declares the same `package` is
  analysed together, with the packages it imports (std included). `package main` files of a folder
  are one package. In a project, the evaluated `mod.ms` gives `main` and the `path:` dependencies.
  Open editors override the files on disk; the edited package's `*_test.ms` files are included.
- **Diagnostics:** every pass (parser, resolver, checker, effects, access check) as you type, and
  the lints (warnings, at the project's levels) once the code has no errors. While a file has a
  syntax error, only syntax and name errors are shown.
- **Hover:** the type of a binding or expression, a function's signature with its `///` doc
  comment, a field's type and mode; where a declaration comes from (*prelude*, *package …*).
- **Go to definition / find references:** locals, functions, types, fields, methods, variants,
  across the package, into imported packages and the prelude.
- **Outline:** types with fields and methods, unions with variants, interfaces, impls, functions.
- **Completion** (`.` triggers it): after `x.` the fields, methods (interface defaults included)
  and generated methods; after `Type.` statics and variants; after `pkg.` the package's `pub`
  items. Names in scope otherwise; `import "std.` completes package folders. It works while the
  line doesn't parse yet.
- **Signature help** (`(` and `,`): the parameters with their modes (`*T`), the current one, the doc.
- **Inlay hints:** the inferred type after `let` / `var` / `:=` without one (not when the value
  shows it), closure parameters and `for` bindings.
- **Rename** (`F2`): locals, parameters, functions, types and globals of the package.

Not yet: formatting (ms_04 has no formatter yet), semantic highlighting, code actions (the fix-its
of diagnostics are shown in their message).

## Development

- `syntaxes/build-grammar.py` generates `syntaxes/minscript.tmLanguage.json` (`npm run grammar`).
  Edit the script, not the JSON; keep it in sync with spec §1 and `src/token.ts`.
- `npm test` here tokenizes MinScript with the TextMate engine VS Code uses
  (`test/grammar.test.mjs`), including every `.ms` file of the repository.
- The server's tests run with the compiler's: `npm test` in `ms_04` (`tools/lsp/*.test.ts`).
