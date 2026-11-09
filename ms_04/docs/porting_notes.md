# Porting the v0.2 corpus to v0.4: gaps found

Source: `minscript/test/{programs,run,packages,projects,prelude,testing}` (47 `.ms` files), ported to
`ms_04/examples/` with their `.out` / `config.json` goldens.

**Status (2026-11-09): all 14 gaps are resolved.** Each proposal below was adopted into
`spec_04_ai.md` as written, and the examples now cite the spec section instead of a `GAP` marker.
Where each one landed: G1 §8.5 · G2 §6.1, §7 · G3, G4 §6.1 · G5, G12 §2.1 (+ `consumes` in §4,
`E_UNIQUE_TYPE_ARG` in §12.1) · G6 §4 · G7 §3, §8.2, §8.3 · G8, G9 §6.1 (+ `L_NESTED_LOCK`) ·
G10 §5.1 · G11, G13 §3 · G14 §7. With G1 adopted, the `shared` package and `shared()` function keep
their v0.2 names.

## Mechanical changes (no decision needed)

| v0.2 | v0.4 | Files |
| --- | --- | --- |
| `fun`, `pub fun` | `fn`, `pub fn` | all |
| `type X = { … }`, `union`, `inter` | `type X { … }` (aliases keep `=`) | all |
| `string`, `&str` | `str` | all |
| `&this` / `&mut this`, `x: &T` / `x: &mut T` | `this` / `*this`, `x: T` / `x: *T` | all |
| `#[&mut x]{ … }` | `#{ … }` | counter, integers, prelude_test |
| `let t(mut r, w) = …` | `let t(var r, w) = …` | websocket, ws_echo |
| `Ref(v)` + `get` / `update` / `read` | `shared var` + plain reads, writes and `lock` | ref_snapshot, cancel, order, users_json |
| `x.clone()` | plain assignment (copy-on-write) | clone_moves, ws_echo, ref_snapshot |
| `T: Clone` bound | dropped (non-Unique by default, G12) | users_json |
| `L_IMPLICIT_STR_COPY` | `L_IMPLICIT_COPY` | project/mod.ms |
| `pub` on an interface method | dropped (lint: redundant) | counter |

Goldens changed only where line numbers or renamed names show up in output (`values.out`,
`users_json.out`, `report.out`, `projects/basic/*`).

## Gaps

### G1. `shared` is a hard keyword, and the corpus uses it as a name

A package `shared` (`import "shared"`, `shared.money(…)`) and a function `shared()` no longer parse.
The port renames them to `common` and `both`.
**Proposal:** make `shared` contextual, like `once`. It is a keyword only before `var`, or before a
field name in a type body. One token of lookahead decides, so `shared.money()` stays an expression.

### G2. Passing a `shared` cell to a detached task (cancel.ms)

```minscript
async fn ticker(count: *int) { for { await time.sleep(2); count += 1 } }
shared var count = 0
t := ticker(count)          // not awaited here
```

§6.1 says this aliases the cell, and §7 says detached tasks may hold aliases of shared cells. But
§7's structured rule makes any non-awaited async call with a `*` argument `E_VIEW_ACROSS_TASK`.
**Proposal:** the structured rule doesn't apply to a `*` argument that is a `shared` place, because
the task keeps an alias and the summary records `keeps [count]`. Lowering: a `*T` parameter whose
summary has `keeps` or `awaits` receives a cell reference, never a raw pointer.

### G3. Does copying a struct alias its `shared` fields?

Topic, Queue, Signal and Promise are "std types built on shared cells" (§6.4). That only works as a
handle if `room2 := room` (or passing `room` to a task) aliases the state instead of snapshotting it.
§6.1 covers bindings and fields initialised *from a shared place*, not a copy of the containing
struct.
**Proposal:** a `shared` field is stored as a pointer to its cell. Copying the struct copies the
pointer, so copies alias the field while the rest of the struct follows copy-on-write. Say this in
§6.1. It also settles `Server { shared sessions }` copies.

### G4. Writing a `shared` field through a read-only receiver

`Topic.publish(this, v)` and `subscribe(this)` change shared state. §11.2 allows `once` writes
through a read view, but §6 says nothing about `shared` fields.
**Proposal:** allowed (interior mutability). The summary records the write as `writes [this.f]`
tagged shared, which doesn't require `*`.

### G5. Consuming or mutating a `Unique` parameter

These v0.2 forms are gone and have no replacement:

- `async fn worker(mut sub: Sub[int])` with `for await job in sub` (`next` is `*this`);
- `conn.split()`, `req.respond_with(r)`, `resolver.resolve(v)`, which consume a `T` parameter or `this`.

§3 only says that passing a Unique value to a `T` parameter whose summary says `keeps` moves it.
Moving into a local, or calling a `*this` method, isn't `keeps` as defined (stored beyond the call).
**Proposal:** add the effect `consumes [p]` (or fold it into `keeps`) for a Unique parameter that
the body moves or writes. The caller must then move the argument, and inside the body the parameter
acts as an owned `var`. This applies to Unique types only: value types keep the `var q = p` copy.

### G6. Effect summaries for `_builtin()` and `extern` functions

Builtins have no body, so `Vec.push` keeping `x`, `Topic.publish` keeping `v` and `split`
consuming `this` can't be inferred. §4 only widens extern calls to whole-parameter reads and
writes, and says nothing about `keeps`, `returns_view` or `consumes`. Without `keeps`, `out.push(tok)`
would not trigger the share or move, and a Unique argument would never move.
**Proposal:** a std-only attribute on builtin signatures, for example
`#[effects(keeps: [x], returns_view: [this])]`, checked against nothing. Plain `extern` defaults to
`keeps` on every non-`Copy` argument.

### G7. `*` on a function type's parameter (clarification)

Captures are fine: `#{ total += it }` writes a captured `var` in place (§8.3), and dropping
`&(T) -> U` only removed the escaping/non-escaping split. The open point is the closure's own
*parameter*. `Signal.update(#{ n => n += 1 })` (v0.2 `f: &(&mut T) -> R`) needs
`fn update[R](this, f: (*T) -> R) -> R`. §3 allows `*` "on parameters", which arguably includes a
function type's parameters, but doesn't say so.
**Proposal:** state it in §3: `(*T) -> R` is a valid function type, and a closure parameter takes
its mode from the expected type, so the call site stays `#{ n => n += 1 }`. A closure that writes a
read-mode parameter is `E_WRITE_TO_IMMUTABLE`.

### G8. `lock` as an expression

`n := lock tokens { …; mid.len() }` is the natural port of `Ref.update` returning a value.
**Proposal:** `lock` is an expression whose value is its block's value, like `if` and `recover`.

### G9. Re-entrancy inside `lock`

Inside `lock tokens { tokens.push("q") }`, the statement-level rule (§6.1) would lock `tokens`
again, and a `Mutex` would deadlock. The same happens when a `lock` body calls a function that
touches the same global `var`.
**Proposal:** a statement inside `lock c` doesn't relock `c` (a local fact). Runtime locks are
re-entrant per task, so calls are covered too. Also state that two separate `lock` blocks,
nested, don't get the fixed address order of `lock a, b`, and lint that pattern.

### G10. Views into `shared` cells can't be free

`before := tokens` and `mid := tokens` read a shared cell, and the view outlives the statement's
lock. Another task's write can't see an uncounted local view, so it would write in place under it.
**Proposal:** add an exception to §5.1: a view taken from a `shared` cell is always a counted share
(atomic refcount once the cell reaches another task), and writes to shared cells always do the
uniqueness check.

### G11. Nested calls that each write the same place (order.ms)

`three(note(trace, "a"), if flag { note(trace, "bb") } else { 0 }, …)`: each argument writes
`trace` through its own `*` call. They run in sequence, but §3's "two arguments of one call may not
overlap on a written path" can be read as forbidding it.
**Proposal:** the overlap rule covers *place arguments that are live at the same time* (the
argument places of one call). Effects that happen while an argument expression is evaluated are
sequenced left to right and don't conflict. Still to decide: `f(trace, note(trace, "x"))`, where a
read view of `trace` is taken and `trace` is then written before `f` runs. Either a copy-on-write
snapshot plus `L_VIEW_FORCED_COPY` (consistent with §5.1), or an error.

### G12. Generics vs `Unique`

`first_or[T](items: Vec[T], fallback: T) -> T` no longer needs `T: Clone`. Is it valid with
`T = Sub[int]`? A generic body that uses a `T` value twice is wrong for Unique types, and checking
that at instantiation breaks the modular budget (§1).
**Proposal:** type parameters are non-Unique by default, and a function opts in with `[T: Unique]`
(the body then gets move rules for `T`). The v0.2 `Clone` interface is removed.

### G13. `mut p: T` has no concise replacement

`var p = p` at the top of the body is `E_DUPLICATE_BINDING` (v0.2 spec §8.7, shadowing), so the port
uses `var q = p`.
**Proposal:** allow redeclaring a parameter with `var` at the top level of the body, and only that
case.

### G14. "A view of a value someone else may write" (§7)

file_crypt.ms keeps promises (not awaited in the statement) whose arguments are views of `let`
bindings (`password`, the elements of `files`). That should be allowed, but §7 doesn't define
"may write".
**Proposal:** the argument is a view of an immutable binding (`let` / `:=`), of a read-only
parameter, or of an identity value. Those become shares. Views of a `var` or of a `*` parameter
need the same-statement await.

## Clarifications (no marker in the code)

- **`filter`, `map` and friends** return a *new* `Vec[T]` whose elements share the originals'
  buffers. `var picked = users.filter(…)`; `picked[0].tags.push(…)` copies that element only
  (prelude_test). State this in §11.4, which currently says only that the getters "yield views".
- **Mixed returns** such as `items.get(0) ?? fallback` and `this.email ?? "literal"` are "maybe a
  view". The summary keeps `returns_view` and the caller treats the result as a view, which is
  always sound.
- **`drain`** (Vec, Map) is now sugar for a move plus a fresh empty value. Keep it as API.
- **`L_BIGINT_ON_JS`** fires throughout integers.ms and on `Account.balance: i64` in basics.ms.
  Tests that use `i64` on purpose need a way to allow the lint (an attribute, or `mod.ms` lint
  config).

## Not covered by the old corpus

The old corpus never touches these v0.4 features, so each needs a new example (and one passing and
one failing test, §14 step 6): `Identity` + `once` + `Symbol`, multi-cell `lock a, b`, top-level
`var`, disjoint-field `await all(…)` / `E_CONCURRENT_OVERLAP`, write views (`-> *T`,
`E_ACCESS_DURING_WRITE_VIEW`), `E_WRITE_TO_CAPTURED_COPY`, `Weak[T]`, `Pool[T]`, and `s.detach()`.
The §A samples cover part of this list.
