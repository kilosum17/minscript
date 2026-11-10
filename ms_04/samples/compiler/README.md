# compiler: the MinScript front end, in MinScript

The lexer and parser of the TypeScript compiler (`src/lexer.ts`, `src/parser.ts`), ported to v0.4
MinScript as a sample. It will grow into the self-hosted compiler (spec §21 step 11) once the
grammar settles; until then the TypeScript compiler stays the reference.

```bash
ms run samples/compiler -- lex   file.ms...   # `== path`, the token dump (`ms lex`), `! start end CODE message` per diagnostic
ms run samples/compiler -- parse file.ms...   # `== path`, the AST dump (`ms parse`), the diagnostics
ms test samples/compiler                      # its MinScript tests
```

`test/compiler_sample.test.ts` runs both commands over every `.ms` file of the repo (139 files,
error corpora included) and requires the output to be identical to the TypeScript compiler's:
tokens, values, flags, AST field by field, and every diagnostic with its span.

| File | What |
| --- | --- |
| `src/syntax/token.ms` | `Token` (a value type), `Value`, `Diag`, keywords, punctuators |
| `src/syntax/lexer.ms` | the lexer: byte spans, `ws` / `nl` flags, matched delimiters, templates, escapes |
| `src/syntax/dump.ms` | the token dump and `LineMap` |
| `src/syntax/ast.ms` | the AST: one struct per node (`k` + `span`), kinds as unions with struct-like variants |
| `src/syntax/parser.ms` | the parser: recursive descent + Pratt; `T?` for recovery |
| `src/syntax/sexpr.ms` | the AST dump |
| `src/main.ms` | the command line |

## How it is written

- **Recovery without exceptions.** Where the TypeScript parser throws `Sync`, a function returns
  `None`, and `?` carries it to the nearest list element, statement or item, which skips ahead.
- **No closure captures the parser.** `list(close, newlines, item, juxtapose)` takes the element
  parser as `#{ p: *Parser => p.parse_type() }`: the parser is passed in, so the closure and the
  `*this` call never overlap.
- **Templates in a Vec.** Several stack entries refer to one string being lexed; they hold its
  index in `Lexer.templates` (v0.4 has no shared mutable object without `shared`).
- **Integers as decimal strings** in tokens: a literal may exceed i64 (`0xffff_ffff_ffff_ffff`).

## What writing it found

Fixed in the toolchain while porting (each with a test):

- `x?.m()` called `m` on the Option itself instead of its value (`examples/run/literals_and_chains.ms`).
- A struct spread `T { a: 1, ...base }` declared its base inside the first field only, so later
  fields read an undefined variable; record spreads evaluated their base once per field.
- A field named like a JS reserved word (`default`) broke the generated class.
- `Range { … }` with a union expected was the prelude's `Range`, not the union's variant (§7.7).
- `L_VIEW_FORCED_COPY` fired on `str` views (immutable: nothing can force their copy), on writes in
  branches the view isn't used in, and on writes deep inside callees; it now uses pass 8's
  liveness and fires only when a write passes through the buffer the view points into.
- `str.byte_at` / `len` / `substring` re-encoded the whole string on each call: lexing the corpus
  took 31 s; it takes under 1 s now (UTF-8 bytes cached, ASCII strings indexed directly).

Limitations of the language, open for discussion (spec §22):

- **Keywords can't be field names:** `match` (a token's closer), `type`, `else`, `package` became
  `closer`, `ty`, `els`, `pkg`. Compiler data is full of such names.
- **`it` is reserved everywhere**, also as a `for` variable or closure parameter name, where it is
  the most natural name for an item.
- **`x?.f` is optional chaining**, so applying `?` then reading a field needs parentheses:
  `(this.expect("import")?).start`.
- **`?.` covers one member**, not the rest of the chain as in JavaScript: `d.body?.stmts?.len()`.
- **A bare variant needs an expected type:** `empty := if b { Byte(0) } else { Text("") }` is
  `E_CANNOT_INFER_VARIANT`; `let empty: Value = …` works.
- **No local lint suppression:** a deliberate snapshot (`saved := this.labels; this.labels.push(l)`)
  warns, and only `mod.ms` levels can silence it, for the whole project.
- **Identity AST nodes cost two declarations per kind** (a struct and a variant wrapping it), as in
  the calc sample; struct-like variants can't be `Identity`. This sample uses plain values; name
  resolution will need side tables or identity nodes.
- **Speed:** on the JS back end the sample lexes the corpus in ~0.9 s and parses + dumps it in
  ~1.2 s, against 0.12 s and 0.32 s for the TypeScript compiler (4–7×; step 12's target is 1.5×).
  The costs are bounds-checked `byte_at`, overflow-checked arithmetic and statement positions.
