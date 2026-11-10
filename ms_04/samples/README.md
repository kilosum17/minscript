# v0.4 sample projects

Two small projects written against [`../docs/spec.md`](../docs/spec.md), for reading. They parse with the v0.4
front end (`npm run check -- samples`); nothing type-checks or runs them yet. Between them they use every v0.4 feature. Comments name the spec section,
the mechanism the compiler would pick (move, share, view, copy-on-write, lock) and, in commented-out
lines, the diagnostic a wrong variant would get.

| Project | What it is | Shows mostly |
| --- | --- | --- |
| [`calc/`](calc/) | lexer, Pratt parser, resolver, evaluator for a tiny expression language | identity types, `once`, `Symbol`, views into the source, persistent scopes |
| [`shop/`](shop/) | an order-processing service: workers, a shared store, a payment gateway | `T` / `*T`, copy-on-write, `shared`, `lock`, tasks, disjoint-path concurrency, `Unique` |

Suggested reading order: `calc/src/syntax/{token,lexer,ast,parser}.ms`, `calc/src/sema/resolve.ms`,
then `shop/src/catalog/catalog.ms`, `shop/src/store/{store,workers}.ms`, `shop/src/main.ms`.

## Where each feature is

| Feature (spec §) | Where |
| --- | --- |
| `T` / `*T` parameters, unmarked call sites (§9.4) | calc `resolve.ms` (`out: *Resolved`), shop `workers.ms` (`o: *Order`) |
| `this` / `*this` (§9.4) | calc `parser.ms`, shop `gateway.ms` |
| Value semantics, move on last use, copy-on-write (§9.1) | shop `catalog_test.ms` (`test_copies_are_independent`), `main.ms` (`opening` snapshot, promo milk) |
| Views stored as shares; `str` (§9.6, §7.3) | calc `lexer.ms` (`Token.text`), shop `main.ms` (`payment`) |
| `detach()` (§7.3) | shop `catalog.ms` `load_csv` |
| Write view `-> *T` (§9.7) | shop `catalog.ms` `at_mut`, `store.ms` `reserve` |
| `(*T) -> R` closure parameter (§9.4) | shop `store.ms` `adjust`, `main.ms` restock |
| Inferred captures, non-escaping writes (§9.9) | shop `main.ms` (`started += 1` in `each_owned`) |
| Escaping closure + `shared var` (§10.3) | shop `main.ms` (`alerts`) |
| `var` in patterns and closure params (§5.1) | shop `workers.ms` (`for await var o`), `main.ms` (`Some(var milk)`), `catalog.ms` (`#{ var acc, t => … }`) |
| `shared` fields; copies alias them (§10.1) | shop `store.ms` `Store` |
| Writing shared state through `this` (§10.1) | shop `store.ms` `reserve`, `book` |
| `lock`, `lock a, b`, `lock` as an expression (§10.1) | shop `store.ms` |
| Top-level `var` (implicitly shared, atomic) (§10.4) | shop `store.ms` (`orders_seen`) |
| Top-level `let`, lazily initialised (§10.4) | calc `lexer.ms` (`KEYWORDS`) |
| Disjoint-path parallelism, `await all(…)` (§11.2) | shop `workers.ms` (`price` + `screen`) |
| Detached tasks; non-awaited calls with view arguments (§11.2) | shop `main.ms` (`worker(...).ignore()`), calc `main.ms` (`Promise.all(paths.map(…))`) |
| `Unique`, `consumes`, moves (§9.2) | shop `workers.ms` (`jobs: Sub[Order]`), `main.ms` |
| `[T: Unique]` generics (§9.2) | shop `workers.ms` `each_owned` |
| `Identity` types as map keys (§12.1) | calc `ast.ms`, `eval.ms` (`Map[Ident, f64]`), shop `order.ms` (`Customer`) |
| `once` fields, `AlreadySet` (§12.2) | calc `ast.ms` / `resolve.ms` (`Ident.decl`), shop `store.ms` (`tier`) |
| Byte literals `b'x'` (§1.6) | calc `lexer.ms` |
| `Symbol`, `sym()` (§12.3) | calc `lexer.ms`, `syntax_test.ms` |
| `PMap` (§12.5) | calc `resolve.ms` |
| `Weak[T]` (§12.4) | shop `order.ms` (`referred_by`), `main.ms` |
| `type X { }`, aliases with `=`, literal unions, records (§7.4) | shop `catalog.ms` (`Sku`), `order.ms` (`Channel`, `Line`), calc `token.ms` (`Punct`) |
| `inter` composition with `=`, default methods (§7.4) | shop `gateway.ms` |
| `impl Iface for Type`, operator interfaces | shop `catalog.ms` (`Money`) |
| Contextual `shared` / `once` (§1.4) | everywhere fields are declared |
| `select`, `for await`, labels, `recover`, `cancel` (v0.2) | shop `main.ms` |
| `mod.ms`, tests (§17) | both `mod.ms`, `calc/src/syntax/syntax_test.ms`, `shop/src/catalog/catalog_test.ms` |

Not used: `Pool[T]` / `Id[T]` (§12.5, optional), `unsafe.Ptr`, `Drop`, `extern`, `Promise.new`.

## Questions that came up while writing

All seven are now settled in [`../docs/spec.md`](../docs/spec.md):

1. **An `async` `*this` call on a shared cell** (`await store.gateway.charge(…)`): the callee gets the
   cell and locks statement by statement, so no lock is held across the `await` (§10.1). The samples
   still use one gateway per worker, which is simpler.
2. **`return` inside `lock`** releases the lock, as do `break`, `continue`, `?`, `or` and a panic (§10.1).
3. **Unions of identity types** compare and hash by variant plus payload pointer, so `Map[Decl, int]`
   works (§12.1).
4. **`all(a, b)` and `Promise.all(vec)`** are both kept: `all` / `race` for a fixed set of any types,
   `Promise.all` for a dynamic Vec of one type (§11.1).
5. **The std APIs the samples assumed** are specified: `PMap` (§12.5), `x.weak()` / `w.upgrade()`
   (§12.4), `Symbol.text()` (§12.3), `Signal.get` / `set` / `update` (§11.3).
6. **Byte literals:** `b'x'` of type `u8` (§1.6), used in calc `lexer.ms`.
7. **Closure parameters of a `Unique` type** follow the same `consumes` inference as function
   parameters (§9.2).

Also changed after review: calc's `Token` is a value type, not an `Identity` type, so the lexer
allocates nothing per token (§12.1, "Choosing a representation").
