# v0.4 sample projects

Two small projects written against `../docs/spec_04_ai.md`, for reading rather than running (there
is no v0.4 compiler yet). Between them they use every v0.4 feature. Comments name the spec section,
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
| `T` / `*T` parameters, unmarked call sites (§3) | calc `resolve.ms` (`out: *Resolved`), shop `workers.ms` (`o: *Order`) |
| `this` / `*this` (§3) | calc `parser.ms`, shop `gateway.ms` |
| Value semantics, move on last use, copy-on-write (§2) | shop `catalog_test.ms` (`test_copies_are_independent`), `main.ms` (`opening` snapshot, promo milk) |
| Views stored as shares; `str` (§5.1, §5.4) | calc `lexer.ms` (`Token.text`), shop `main.ms` (`payment`) |
| `detach()` (§5.4) | shop `catalog.ms` `load_csv` |
| Write view `-> *T` (§5.2) | shop `catalog.ms` `at_mut`, `store.ms` `reserve` |
| `(*T) -> R` closure parameter (§3) | shop `store.ms` `adjust`, `main.ms` restock |
| Inferred captures, non-escaping writes (§8.3) | shop `main.ms` (`started += 1` in `each_owned`) |
| Escaping closure + `shared var` (§6.3) | shop `main.ms` (`alerts`) |
| `var` in patterns and closure params (§8.4) | shop `workers.ms` (`for await var o`), `main.ms` (`Some(var milk)`), `catalog.ms` (`#{ var acc, t => … }`) |
| `shared` fields; copies alias them (§6.1) | shop `store.ms` `Store` |
| Writing shared state through `this` (§6.1) | shop `store.ms` `reserve`, `book` |
| `lock`, `lock a, b`, `lock` as an expression (§6.1) | shop `store.ms` |
| Top-level `var` (implicitly shared, atomic) (§6.4) | shop `store.ms` (`orders_seen`) |
| Top-level `let`, lazily initialised (§6.4) | calc `lexer.ms` (`KEYWORDS`) |
| Disjoint-path parallelism, `await all(…)` (§7) | shop `workers.ms` (`price` + `screen`) |
| Detached tasks; non-awaited calls with view arguments (§7) | shop `main.ms` (`worker(...).ignore()`), calc `main.ms` (`Promise.all(paths.map(…))`) |
| `Unique`, `consumes`, moves (§2.1) | shop `workers.ms` (`jobs: Sub[Order]`), `main.ms` |
| `[T: Unique]` generics (§2.1) | shop `workers.ms` `each_owned` |
| `Identity` types as map keys (§11.1) | calc `ast.ms`, `eval.ms` (`Map[Ident, f64]`), shop `order.ms` (`Customer`) |
| `once` fields, `AlreadySet` (§11.2) | calc `ast.ms` / `resolve.ms` (`Ident.decl`), shop `store.ms` (`tier`) |
| Byte literals `b'x'` (§5.5) | calc `lexer.ms` |
| `Symbol`, `sym()` (§11.3) | calc `lexer.ms`, `syntax_test.ms` |
| `PMap` (§11.5) | calc `resolve.ms` |
| `Weak[T]` (§5.3) | shop `order.ms` (`referred_by`), `main.ms` |
| `type X { }`, aliases with `=`, literal unions, records (§8.1) | shop `catalog.ms` (`Sku`), `order.ms` (`Channel`, `Line`), calc `token.ms` (`Punct`) |
| `inter` composition with `=`, default methods (§8.1) | shop `gateway.ms` |
| `impl Iface for Type`, operator interfaces | shop `catalog.ms` (`Money`) |
| Contextual `shared` / `once` (§8.5) | everywhere fields are declared |
| `select`, `for await`, labels, `recover`, `cancel` (v0.2) | shop `main.ms` |
| `mod.ms`, tests (v0.2 §17) | both `mod.ms`, `calc/src/syntax/syntax_test.ms`, `shop/src/catalog/catalog_test.ms` |

Not used: `Pool[T]` / `Id[T]` (§11.5, optional), `unsafe.Ptr`, `Drop`, `extern`, `Promise.new`.

## Questions that came up while writing

The spec doesn't settle these yet. Each sample takes the reading given here.

1. **An `async` `*this` call on a shared cell.** If the gateway were a `shared` field of `Store`,
   `await store.gateway.charge(...)` would hold the statement's write lock across the `await`. The
   samples avoid this with one gateway per worker. Proposal: `E_AWAIT_IN_LOCK` covers statement
   locks too, so a `shared` value can't be the receiver of an async `*this` call.
2. **`return` inside `lock`** (`Store.reserve`): assumed to release the lock, like leaving the block.
   §6.1 should say so, and also cover `break`, `continue` and `?`.
3. **Unions of identity types** (`Expr`, `Decl` in calc): assumed to compare and hash by variant plus
   payload pointer, so `Map[Decl, int]` works. §11.1 should cover this.
4. **`all(a, b)` vs `Promise.all(vec)`.** §7 uses a variadic `all(…)`, v0.2 has `Promise.all(Vec)`.
   Both appear here. Pick one, or keep both (variadic for fixed sets, a Vec for dynamic ones).
5. **Assumed std APIs** with no spec text yet: `PMap.new / with / get`, `x.weak()` / `w.upgrade()`
   on identity values, `Symbol.text()`, `Signal.get / set`.
6. ~~**Byte literals.**~~ Settled: `b'x'` of type `u8` (spec §5.5), used in calc `lexer.ms`.
7. **Closure parameters of a `Unique` type** (`#{ sub => worker(…, sub, …) }`): assumed to follow
   the same `consumes` inference as function parameters.
