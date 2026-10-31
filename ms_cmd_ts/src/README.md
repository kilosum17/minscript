# MinScript lexer + parser foundation

Dependency-free TypeScript lexer and recursive-descent / Pratt parser.

## Run

Node 22.16+:

```sh
node --experimental-strip-types run.ts sample.ms --ast
node --experimental-strip-types run.ts sample1.ms --ast
node --experimental-strip-types run.ts sample.ms --json
node --experimental-strip-types --test tests/parser.test.ts
```

The existing lexer API is preserved. `parser.ts` consumes the exact `Token[]` / `LexResult` emitted by `lexer.ts`; `parser/ast.ts` contains the shared AST types. `run.ts --ast` prints the syntax tree, while `--json` prints the AST, lexer result and parser diagnostics.

## Implemented grammar

- File/package/import declarations, functions, generic parameters, type declarations, interfaces, impl blocks and extern blocks.
- Square-bracket type arguments (`Vec[User]`) and generic calls (`parse[User](input)`). A call-site `[...]` is treated as generic arguments only when its matching `]` is immediately followed by `(`; otherwise it remains indexing.
- Primitive/path, optional, reference, pointer, tuple, record, function, `TypeOf` and intersection types; integer const arguments such as `Array[i32, 4]`.
- `let` / `var`, `:=` / `:==`, return/break/continue, if/if-let, while/while-let, for, loop, match, blocks and expression statements.
- Pratt expressions with unary/binary/assignment operators, calls, generic calls, member and optional-member access, indexing, `?` propagation, `await`, casts, ranges, strings/interpolation and `or` fallback.
- Collection sigils `r{}`, `m{}`, `s{}`, `t()`, `a[]`, `v[]`, `_{}`, `'N{}`, `#{}` and `#[...]` closures; named, typed and captured closure forms.
- Basic binding, wildcard, literal, constructor, tuple, struct, range and or-patterns.

## Current limits

This is a syntactic foundation, not a semantic analyzer. Name resolution, inferred-literal expected-type checks, sigil/binding shadow diagnostics, type checking, borrow checking and code generation are not implemented. The AST intentionally preserves syntax rather than resolving names. Some v1 grammar details remain partial: complete destructuring and pattern validation, attributes, full literal-union/sum-type validation, named struct literal parsing, all assignment-place rules, exhaustive newline continuation diagnostics, and full recovery quality. Do not treat a successful parse as semantic validity.
