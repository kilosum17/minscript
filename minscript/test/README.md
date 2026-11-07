# MinScript test corpus

The syntax under test is defined by [docs/spec.md](../docs/spec.md) (v0.2). The old samples written in pre-v0.2 syntax are in [docs/history/samples](../docs/history/samples).

| Folder | What it tests | Expected output |
|---|---|---|
| `lexer/` | tokenization: numbers, strings, sigils, operators, comments, keyword rules | `*.tokens` snapshot (added once the lexer runs) |
| `parser/` | one feature per file: declarations, expressions, closures, generics, control flow… | `*.ast` snapshot (added once the parser runs) |
| `errors/` | lexer/parser diagnostics, annotated inline | the `//~` annotations |
| `programs/` | realistic multi-feature programs | must lex and parse with **zero** diagnostics |

## Conventions

- Every file is a complete compilation unit: it starts with `package …` and only has items at the top level.
- Comments like `// (+ 1 (* 2 3))` give the intended structure in S-expression form. They are notes for whoever writes the `.ast` snapshot later.
- **Error annotations:** `//~ CODE` means the diagnostic `CODE` must be reported **on that line**. `//~ CODE CODE2` means both must be.
  - The parser must report every annotated diagnostic and no others.
  - The harness finds annotations by scanning the **raw source text**, so an annotation still counts when it sits inside an unterminated string or comment (see `errors/literals.ms` and `errors/unterminated_comment.ms`).
  - Each error case sits in its own top-level function, so the parser can recover at the next item and keep going.
- Cases where recovery isn't reliable (an unmatched delimiter, an unterminated block comment) get a file of their own.
- `errors/` only covers diagnostics that the lexer or parser can detect. Resolver and type-checker diagnostics (e.g. `E_SIGIL_SHADOWS_BINDING`, `E_CANNOT_INFER_GENERIC`) will go in `test/resolve/` and `test/check/` later.
- File names are `snake_case.ms`.
