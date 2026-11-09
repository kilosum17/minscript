# MinScript for VS Code

Syntax highlighting, plus live errors, completion, signature help, inlay type hints, hover,
go-to-definition, find-references, rename, formatting and an outline from the MinScript compiler (the language
server is `ms1 lsp`, in [`../../src/lsp`](../../src/lsp), written in MinScript). The server speaks standard
LSP, so other editors can use it too: run `node bin/ms1.js lsp` (Node ≥ 23.6) from their LSP client.

## Install (from this repository)

The extension starts `bin/ms1.js lsp` with your system Node (≥ 23.6): the toolchain's seed (stage 1
compiled by itself) and its runtime, so no build step is needed.

```bash
cd tools/vscode && npm install                    # the LSP client library
ln -s "$PWD" ~/.vscode/extensions/minscript-dev
```

Then run **Developer: Reload Window** in VS Code and open any `.ms` file. Remove the symlink to uninstall.

To work on the extension itself instead, open `tools/vscode` in VS Code and press **F5**: a new window
starts with the extension loaded, on the `test/` corpus.

## Settings

| Setting | Default | |
|---|---|---|
| `minscript.node` | `node` | the Node executable (≥ 23.6) that runs the server |
| `minscript.serverPath` | (next to the extension) | path to `bin/ms1.js` |
| `minscript.trace.server` | `off` | log LSP messages (Output → MinScript) |

**MinScript: Restart Language Server** restarts the server, e.g. after pulling compiler changes.

## What the server does

- **Packages and projects:** every `.ms` file in a folder that declares the same `package` is analysed together, with the packages it imports (std included, with real signatures). In a project (a folder with a `mod.ms`), every `package main` file of `main` is one package, and `path:` dependencies are found. Open editors override the files on disk.
- **Diagnostics:** every compiler pass reports as you type. While the file has a syntax error, only syntax and name errors are shown; type and ownership errors would mostly be noise then.
- **Hover:** the inferred type of a binding, a function's signature with its `///` doc comment, a field's type. Items from the prelude are marked *prelude*.
- **Go to definition / find references:** locals, functions, types, fields, methods and variants, across the files of the package and into `std/prelude.ms`.
- **Outline:** types with their fields and methods, unions with their variants, functions, impls.
- **Completion** (`.` triggers it; also `Ctrl+Space`):
  - after `x.`: fields first, then methods (a bounded `impl`'s only when the items meet its bounds), then the auto-generated `to_str` / `clone` / `eq` / `hash`; after `Type.`: statics and variants; after `pkg.`: the package's `pub` items. It works while the line is incomplete (`log.println(user.`).
  - names: locals in scope with their types, the package's items, imports, the prelude, keywords;
  - in `import "…"`: `std`, `app` and `path:` dependencies, then their folders.
- **Signature help** (`(` and `,` trigger it): the parameters, the current one highlighted, and the doc comment.
- **Inlay hints:** inferred types after `let` / `:=` without a type (not when the value already shows it: `User { … }`, literals, `as`), closure parameters and `for` bindings. VS Code's `editor.inlayHints.enabled` turns them off (or on `Ctrl+Alt` only).
- **Rename** (`F2`): locals, parameters, functions, types and globals of the package, across its files. The record shorthand `P { name }` becomes `P { name: new }`. std names, `this` and `it` can't be renamed.

- **Formatting** (*Format Document*, `Shift+Alt+F`): `ms fmt`'s style (spec §17.8), with the project's `fmt` settings from mod.ms, or the editor's tab size outside a project. To format on save, add to your settings:

  ```json
  "[minscript]": { "editor.formatOnSave": true }
  ```

Not yet: semantic highlighting, renaming fields and methods, code actions (quick fixes).

## Development

- `syntaxes/build-grammar.py` generates `syntaxes/minscript.tmLanguage.json` (`npm run grammar`). Edit the script, not the JSON. Keep it in sync with spec §1.
- `npm test` here tokenizes MinScript with the TextMate engine VS Code uses (`test/grammar.test.mjs`).
- The language server is checked against stage 0's with `tools/lsp_compare.mjs` (the same requests to both servers; see stage1/CLAUDE.md).
