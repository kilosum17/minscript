# MinScript Language Specification — v0.4 (draft)

> **Superseded by [`spec.md`](spec.md)**, the self-contained v0.4 reference. This note keeps the reasoning behind the v0.4 changes; its section numbers are not the reference ones.

Nov 9, 2026 · @kilo

## 0. Summary

v0.4 makes MinScript a **value-semantics language with inferred sharing**: every parameter is `T` (read) or `*T` (write), the compiler infers per-path effects, and references never need lifetimes because a stored reference is a counted share, not a borrow.

**Why v0.2/v0.3 went wrong.** Allowing borrows inside structs and globals means every struct type may carry hidden lifetime parameters. Inferring those without annotations is whole-program region inference, which is what made the checker slow and pushed the implementation toward arenas. v0.4 removes the cause instead of optimising it:

- **Borrows are second-class.** They exist only as parameters, locals and return values ("views"). They are never stored.
- **Storing is sharing.** When a value or a view goes into a field, a global or an escaping closure, the compiler stores a reference-counted share of the underlying buffer. No copy happens until someone writes (copy-on-write).
- **Shared mutation is declared once.** A binding or field that many places must see change is marked `shared`. The compiler picks a plain cell, an atomic, or an `RwLock` from how it is used.
- **Effects are inferred over access paths** (`user.name`, `user.tags`). They drive borrow checking, copy elision and disjoint-field parallelism.

The result: no `&`, no `&mut`, no `take`, no `Ref`, no capture lists, no lifetimes and no arenas in user code. The checker stays intraprocedural plus bottom-up summaries, which is linear in program size.

Syntax not mentioned here is retained from v0.2 (lexer, literals, operators, `match`, `select`, `or`, `??`, `mod.ms`).

## 1. Principles and compile-speed budget

The language exposes **intent** (read, write, shared); the compiler chooses **mechanism** (borrow, move, share, copy, lock).

1. **Two access modes.** A parameter is read (`T`) or written (`*T`). Nothing else appears in signatures.
2. **Values, not places.** Assignment, passing and storing have value semantics. Physically they are moves or counted shares; a real copy happens only on a write to a shared buffer.
3. **No stored borrows.** Borrows are an optimisation the compiler makes, never something a type can contain. This is the single rule that removes lifetimes.
4. **Mutation through many owners is declared.** `shared` marks it, once, at the declaration. Everything else is single-owner.
5. **Silent copies are linted, never forbidden.** Concise code compiles; the linter shows where a copy-on-write would fire and how to avoid it.
6. **Unknown aliasing is conservative.** Dynamic calls and unknown indices widen to whole-object effects. Recursion is analysed precisely, up to a safety cap (§9).
7. **Parsing stays purely syntactic** (unchanged from v0.2).

**Compile-speed budget \[D\].** Every analysis must be one of:

- local to one function body (linear in its size), or
- a bottom-up pass over the call graph in strongly-connected-component order, consuming fixed-size summaries.

No analysis may solve constraints across the whole program, infer lifetime parameters on types, or iterate more than its summaries can grow: a fixpoint is allowed only over the finite summary lattice (§4 paths have at most 4 segments), so the number of rounds is bounded by summary size, not by program size. A feature that cannot meet this budget is out of the language.

## 2. Values: sharing and copy-on-write

Every value behaves as if it were copied on assignment; the compiler makes that free in almost every case.

```minscript
user := User { name: "John", age: 25 }
other := user          // value semantics: other is "a copy"
var edited = user
edited.age += 1        // user.age is still 25
```

**How each assignment is implemented \[D\]** (decided by the compiler, in this order):

| Situation | Mechanism | Cost |
| --- | --- | --- |
| Source is `Copy` (primitives, small records of primitives) | bit copy | none |
| Source is not used again | move | none |
| Source is used again, nobody writes either side | share (refcount +1) | one increment |
| Source is used again and one side is later written | share, then copy-on-write at the first write | one copy of the written buffer |

There is **no use-after-move error**: using a value after it was "moved" just turns that move into a share. `E_USE_AFTER_MOVE` is removed.

**Copy-on-write granularity.** Copy-on-write is per buffer, not per object: writing `edited.age` copies only the `User` header, while `edited.tags` keeps sharing the same `Vec` buffer until it is written.

**Lints, not errors.** `L_IMPLICIT_COPY` fires where the compiler cannot prove a write target is unique and the copied buffer is a collection or a string. The fix-its are: drop the extra use, write through a `*T` parameter, or mark the value `shared` (§6).

**`.clone()`** stays available for an explicit independent copy, but it is rarely needed: copy-on-write already guarantees independence.

### 2.1 Unique types

Some values must have exactly one owner: files, sockets, `Sub[T]`, `Resolver[T]`, `Watcher[T]`. They implement the marker interface `Unique` (std and `extern` only, like v0.2's `Handle`).

- A `Unique` value really moves. Using it afterwards is `E_USE_AFTER_MOVE`, which survives only for these types.
- A `Unique` value cannot be stored in a `shared` binding without `lock` (§6).
- A struct containing a `Unique` field is itself `Unique`.
- **Consuming parameters \[D\].** A `Unique` parameter (or `this` receiver) that the body moves, or calls a `*this` method on (`for await` included), is *consumed*. Its summary records `consumes [p]` (§4), the caller must move the argument, and inside the body the parameter behaves as an owned `var`. So `async fn worker(sub: Sub[int]) { for await job in sub { ... } }` and `conn.split()` need no extra syntax. This applies only to `Unique` types: for any other type, the body writes a local copy (§3).
- **Generics \[D\].** A type parameter is non-Unique by default, and instantiating it with a `Unique` type is `E_UNIQUE_TYPE_ARG`. A function or type that accepts `Unique` arguments declares `[T: Unique]`. That bound admits Unique and non-Unique types alike, and the body is checked with move rules for `T`, so using a `T` value twice is `E_USE_AFTER_MOVE`. The check happens once, at the definition. v0.2's `Clone` interface is removed: every non-Unique type can be copied (§2).

### 2.2 Drop

A value is dropped when its last share goes away. `Drop.drop(*this)` runs then, deterministically on native and WASM back ends. On JS, `Drop` runs for `Unique` types only (they are tracked exactly); other types rely on the GC.

## 3. Parameters and receivers: `T` and `*T`

A signature says only whether the callee may change the argument; `*T` means "my writes are visible to the caller", as in Go.

| Written | Meaning | Caller passes | Compiler picks |
| --- | --- | --- | --- |
| `user: User` | read-only | any value | shared view, move, share or bit copy |
| `user: *User` | read and write; caller sees the changes | a mutable place: a `var`, a `*` parameter, or a field / element of one | exclusive view of the written paths |
| `this` | read-only receiver | any value | as `T` |
| `*this` | mutable receiver | a mutable place | as `*T` |

```minscript
fn print_user(user: User) {
    log.println(user.name, user.age)
}

fn birthday(user: *User) {
    user.age += 1
}

var u = User { name: "Ann", age: 30 }
birthday(u)          // no & at the call site; the LSP shows an inlay `*`
print_user(u)        // 31
```

**Rules \[D\]:**

- **Call sites are unmarked.** Passing an immutable binding to a `*T` parameter is `E_WRITE_TO_IMMUTABLE`, with a fix-it changing `:=` to `:==` or `let` to `var`.
- **No aliasing writes in one call.** Two arguments of one call may not overlap on a path that either side writes: `swap(a.x, a.x)` is `E_OVERLAPPING_ACCESS`, while `swap(a.x, a.y)` is fine (paths are disjoint, §4). The rule covers the **places passed as arguments**, which are live together for the whole call. Writes that happen while an argument expression is evaluated are sequenced left to right and never conflict: in `three(note(trace, "a"), note(trace, "b"))` each `note` call finishes before the next starts. When an earlier argument is a read view and a later argument's evaluation writes the same path (`f(trace, note(trace, "x"))`), the view keeps a copy-on-write snapshot (§5.1) and `L_VIEW_FORCED_COPY` fires.
- **A local mutable copy** of a `T` parameter is an ordinary `var`: `var acc = start`. It is free until written (§2). A parameter may be redeclared with `var` under its own name at the top level of the body (`var p = p`), as the body's first use of it. That is the only exception to `E_DUPLICATE_BINDING` for parameters. The v0.3 `mut x: T` form is removed, because `mut` and `*` would read as the same thing.
- **`*` is only an access mode, not a pointer type.** `*T` may appear on parameters, receivers and return types (§5.2). It may not appear in fields, `Vec[*T]`, globals or bindings. Raw pointers move to `unsafe.Ptr[T]`.
- **Unique arguments.** Passing a `Unique` value to a `T` parameter whose summary says `keeps` or `consumes` (§4, §2.1) moves it. Otherwise it lends a view.
- **Function types.** A function type's parameters take the same two modes: `(T) -> R` or `(*T) -> R`. A closure's parameters take their mode from the expected type, so `fn update[R](this, f: (*T) -> R) -> R` is called as `signal.update(#{ n => n += 1 })` and the write reaches the caller's value. Writing a read-mode closure parameter is `E_WRITE_TO_IMMUTABLE`. Captures are separate from parameter modes and are always inferred (§8.3).
- **Interface methods** state their mode in the signature (`fn read(*this, buf: *Vec[u8]) -> ...`). Implementations may be less demanding (a `this` method satisfies a `*this` requirement), never more.

**Parsing.** In a parameter list, `*` before `this` or before a type is a prefix of that parameter. In type position elsewhere, a leading `*` is `E_STAR_TYPE_NOT_PARAM`. Multiplication is unaffected because types and expressions never share a position.

## 4. Effect summaries over access paths

The compiler infers, for every function, which parameter paths it reads, writes, keeps, returns views of, and holds across an `await`. These summaries are never written by the user; they are shown by the LSP and stored in package metadata.

```minscript
type User {
    name: str
    age: int
    tags: Vec[str]

    fn get_name(this) -> str { this.name }
    fn birthday(*this) { this.age += 1 }
    fn tag(*this, t: str) { this.tags.push(t) }
}
```

```text
User.get_name   reads [this.name]                 returns_view [this.name]
User.birthday   reads [this.age]  writes [this.age]
User.tag        writes [this.tags]                keeps [t]
```

**The six effects \[D\]:**

| Effect | Meaning | Used for |
| --- | --- | --- |
| `reads [p]` | path `p` is read | conflict checks, parallelism |
| `writes [p]` | path `p` is written (only on `*` params / `*this` / `shared` fields and cells) | conflict checks, copy-on-write placement |
| `keeps [p]` | `p` is stored beyond the call (field, global, escaping closure, task) | move-vs-share at the call site, heap promotion |
| `consumes [p]` | a `Unique` parameter is moved or mutated by the body (§2.1) | forces a move at the call site |
| `returns_view [p]` | the result is a view into `p` | view checking in the caller (§5) |
| `awaits` | the function suspends | views across suspension, `shared` lock scope |

**Paths \[D\].** A path is a parameter or `this` followed by up to **4** segments:

- `.field` — a named field or tuple index;
- `[k]` — a literal index or literal map key (`items[0]`, `users["alice"]`);
- `[*]` — any element, for every non-literal index.

A path longer than 4 segments is truncated to its first 4, which only makes it cover more. Two paths **overlap** when one is a prefix of the other, or they differ only where one side has `[*]`. `items[i]` and `items[j]` therefore overlap unless the compiler sees `i` and `j` are distinct literals.

**Propagation.** A call substitutes the argument paths into the callee's summary: `u.profile.birthday()` contributes `writes [u.profile.age]` to the caller.

**Conservative cases \[D\]** — each widens to the whole parameter (`writes [user]` for a `*` param, `reads [user]` otherwise):

- calls through an interface value, a function value or a stored closure;
- calls into an `extern` function;
- paths that are still growing when a recursive cycle hits the safety cap (§9). Only those paths widen, and only to their first segment; the rest of the summary stays precise.

Closures passed directly to a known function (`items.map(#{ ... })`) are not conservative: their bodies are analysed in place.

**Built-in and extern summaries \[D\].** A function whose body is `_builtin()` has nothing to infer from, so std states its summary with an attribute that only std may use:

```minscript
#[effects(keeps: [v])]
pub fn push(*this, v: T) { _builtin() }

#[effects(consumes: [this])]
pub fn split(this) -> t(Reader, Writer) { _builtin() }

#[effects(returns_view: [this])]
pub fn trim(this) -> str { _builtin() }
```

The attribute lists only `keeps`, `consumes` and `returns_view`. `reads` and `writes` follow from the parameter modes (whole parameter). The compiler trusts it, so it is part of std's review surface. An `extern` function without the attribute is assumed to keep every non-`Copy` argument. That is the safe default: values are shared rather than lent, and `Unique` arguments move.

**API stability.** For `pub` functions the summary is part of the package's public interface. `ms api diff` reports a summary that got wider (for example a new `keeps`) as a breaking change, because callers may stop compiling.

## 5. Views: references without lifetimes

A view type (`str`, `Slice[T]`, iterators) is **one type with two representations**: an uncounted pointer while it stays local, and a counted share once it is stored. The programmer never sees the difference, so views may go into fields and globals.

### 5.1 Read views

```minscript
type Token {
    kind: TokenKind
    text: str            // a view into the source buffer
}

fn lex(src: str) -> Vec[Token] {
    var out = []
    // ...
    out.push(Token { kind: Ident, text: src.substring(a, b) })   // keeps [src]
    out
}

let TOKENS = lex(read_source())   // a global: every token shares src's buffer
```

- **Local views are free.** A view used only inside the function is a raw pointer plus length. No refcount traffic.
- **Stored views share.** When a view goes into a field, global, escaping closure or task (the summary says `keeps`), the compiler stores a counted share of the **buffer** it points into. The owner can go out of scope; the buffer lives as long as any share does. No copy is made.
- **Views of `shared` cells are always counted.** A view taken from a `shared` cell (`before := tokens`, `first := sessions[k]`) outlives the statement's lock, and another task's writer cannot see an uncounted local pointer. Such a view is therefore always a counted share (an atomic count once the cell reaches another task), and every write to a `shared` cell checks uniqueness before writing in place.
- **Writes never invalidate a view.** If the owner is written while a view of it is live, the view is upgraded to a share and the write copies the owner's buffer (copy-on-write). The view keeps seeing the old value, the same snapshot rule as v0.2's `Ref.get()`. `L_VIEW_FORCED_COPY` flags it, because it usually means a loop like `for x in items { items.push(x) }`.
- **Returned views** carry `returns_view [p]` in the summary. The caller treats the result as a view of the argument path, under the same three rules.

There is therefore **no borrow-conflict error for read views**. `E_BORROW_CONFLICT`, `E_RETURN_LOCAL_BORROW` and `E_BORROW_IN_FIELD` are removed: a view of a local that must outlive it simply keeps the local's buffer alive (heap-promoted if it was on the stack).

**Small values.** A view of a value with no heap buffer (a small inline string, a fixed array on the stack) is copied when stored. The copy is bounded by the inline size limit (proposed 24 bytes), so it is never expensive.

### 5.2 Write views (`-> *T`)

A function may return a write view into a `*` argument, for example `fn at_mut(*this, i: int) -> *T` or `map.entry(k)`.

- A write view can never be stored or upgraded: it is the one second-class value left.
- While it is live, any other access to an overlapping path is `E_ACCESS_DURING_WRITE_VIEW`. This is a local check over one function body.
- It may be returned only when it derives from a `*` parameter or `*this`.

### 5.3 Graphs and back-references

A struct that stores another struct stores a share of it: a snapshot. To see later changes, the target must be `shared` (§6). Cycles of `shared` values leak; `Weak[T]` breaks them, and `L_SHARED_CYCLE` warns when a type can form a cycle through `shared` fields. For graphs built once (ASTs, type tables), `Identity` types (§11) are the recommended pattern and need no `shared` at all.

### 5.4 One string type: `str` \[D\]

`str` is the only string type: immutable UTF-8 text. v0.2's owned `string` and borrowed `&str` were two types for one idea; with implicit views (§5.1) the difference is only how the compiler stores the value.

| Where the value is | Representation | Cost |
| --- | --- | --- |
| local view (`s.substring(a, b)`, `s.trim()`, a parameter) | pointer + length into an existing buffer | none |
| stored (field, global, collection, escaping closure, task) | counted share of the buffer + offset + length | one refcount increment |
| literal | static buffer, never freed | none |
| result of `+`, interpolation, `to_str()`, `to_lower()` | new buffer | one allocation |

- **Appending:** `var s = ""` then `s += part` appends in place when `s` is unique and its buffer has spare capacity (amortised O(1), like a string builder). If `s` is shared, the first append copies (§2).
- **API:** every std function that took or returned `string` or `&str` now uses `str`, and `to_str()` returns `str`. The v0.2 implicit `&str` → `string` copy and the lint `L_IMPLICIT_STR_COPY` are removed.
- **Retention:** a stored slice keeps its whole buffer alive, so one token can keep a 10 MB source file in memory. That is what a compiler wants. Elsewhere, `s.detach()` copies a slice into its own exact-size buffer. The runtime never compacts automatically, so costs stay predictable.
- **Indexing:** unchanged from v0.2. Offsets are UTF-8 bytes, `chars()` gives characters, `bytes()` gives `Slice[u8]`.
- **Diagnostics:** the type name `string` is `E_STRING_TYPE_REMOVED`, with a fix-it to `str`.
- On JS a `str` is a JS string (§13.1).

### 5.5 Byte literals \[D\]

Lexers and protocol code scan `bytes()` (§13.1), so they compare `u8`s against characters. `b'x'` is a literal of type `u8`, so they don't need `'x' as u8`:

```minscript
fn is_digit(c: u8) -> bool { c >= b'0' && c <= b'9' }

match c {
    b' ' | b'\t' | b'\r' => {}
    b'a'..=b'z' | b'A'..=b'Z' | b'_' => ident(start)
    _ => {}
}
```

- **Content:** one ASCII character, or one of the escapes `\n` `\r` `\t` `\0` `\\` `\'` `\xHH` (any byte, `00`–`FF`). A non-ASCII character such as `b'é'` is `E_BYTE_LITERAL_NOT_ASCII`, because it is several bytes in UTF-8. Use `\xHH` for a single byte, or a `str`. Other escapes are v0.2's `E_INVALID_ESCAPE`.
- **Type:** always `u8`. Byte literals work in expressions, in patterns and as range bounds (`b'a'..=b'z'`).
- **Lexing:** `b` followed immediately by `'` starts a byte literal. With a space between them (`b 'x'`) the two tokens are the name `b` and a char literal. No other valid code puts a name directly before a char literal, so the rule is unambiguous.
- `'x' as u8` stays valid. Byte strings (`b"GET "` as `Slice[u8]`) are deferred (§15).
- On JS a byte literal is a `number` constant.

## 6. Shared mutable state: `shared`

`shared` is the only ownership word in the language: it marks a binding or field whose changes every holder must see, and the compiler makes it thread-safe. Anything not marked `shared` is single-owner and is passed as a value (§2).

```minscript
shared var hits = 0                          // global or local
shared var users = m{} as Map[str, User]

type Server {
    port: int
    shared sessions: Map[int, Session]       // a shared field
}

async fn handle(req: Request, users: *Map[str, User]) {
    users[req.user] = load(req.user)         // one write = one write lock
}

handle(req, users)                           // passes the cell itself, not a copy
hits += 1                                    // lowered to an atomic add
```

### 6.1 Rules \[D\]

- **Aliasing.** Passing a `shared` place to a `*T` parameter (including one of a task that is not awaited, §7), initialising another `shared` binding or field from it, or capturing it in a closure **aliases the same cell**. Every other use reads a snapshot value: `let n = hits` is a plain `int`.
- **Copies alias `shared` fields.** A `shared` field is stored as a pointer to its cell. Copying the containing value (assignment, passing, storing, §2) copies that pointer, so every copy sees the same cell, while the other fields follow copy-on-write as usual. This is how std builds handles: `type Topic[T] { shared state: TopicState[T] }`, and passing a `Topic` to a task gives it the same topic.
- **Writes through read-only views.** A `shared` field may be written through `this` or a `T` parameter, like a `once` field (§11.2): the cell does its own locking. The write still appears in the summary as `writes [this.state]`, so it takes part in conflict checks. So `fn publish(this, v: T)` is a valid signature.
- **Statement-level safety.** Each statement that touches a `shared` cell is one critical section for that cell: a read lock if the statement only reads it, a write lock if it writes. So `users[k] = v` and `hits += 1` are always race-free.
- **Multi-statement atomicity** needs `lock`:

```minscript
lock account {
    account.balance -= 100
    account.transactions.push(tx)
}
lock from, to { from.balance -= n; to.balance += n }   // several cells
```

- `lock a, b` acquires cells in a fixed runtime order (by cell address), so two `lock` blocks can't deadlock each other.
- `lock` is an expression: its value is the block's value, like `if` and `recover`. `n := lock tokens { tokens.push(x); tokens.len() }`.
- **No relocking.** Statements inside `lock c { }` don't take `c`'s statement-level lock again (a local fact). Runtime locks are also re-entrant per task, so a function called inside the block that touches `c` (a global `var`, say) does not deadlock.
- Nested blocks, `lock a { lock b { } }`, don't get the fixed order of `lock a, b` and can deadlock against `lock b { lock a { } }`. `L_NESTED_LOCK` flags them, with a fix-it merging them into `lock a, b`.
- `await` inside `lock` is `E_AWAIT_IN_LOCK`. A lock is never held across a suspension.
- `shared` is only meaningful with `var` (or a field of a type). `shared let` is `E_SHARED_IMMUTABLE`: immutable values are already shared freely.

### 6.2 What the compiler lowers `shared` to

The programmer states *that* a value is shared; the compiler chooses *how* from escape analysis and the statements that touch it.

| Usage the compiler sees | Lowering |
| --- | --- |
| Never reaches another task | plain cell, no lock (refcounted when stored in several places) |
| Scalar, every access is one load, store or read-modify-write | atomic |
| Mostly reads | `RwLock` |
| Otherwise | `Mutex` |
| Struct whose fields are never touched in the same statement or `lock` | one lock per field (optional optimisation) |

The JS back end is single-threaded per worker, so every `shared` lowers to a plain cell there; `lock` blocks still run without interleaving because they cannot contain `await`.

### 6.3 Forgetting `shared`

Without `shared`, a value given to another place is a copy (cheap until written, §2). Where that would surprise, the compiler reports it:

| Situation | Diagnostic |
| --- | --- |
| An escaping closure or task **writes** a captured `var` | `E_WRITE_TO_CAPTURED_COPY`, fix-it: `shared var` |
| A task reads a `var` that the spawning function writes afterwards | `L_TASK_SEES_SNAPSHOT` (warning), fix-it: `shared var` |
| A non-shared field is written after the struct was stored in two places | `L_DIVERGED_COPIES` (warning) |

### 6.4 Globals

- A top-level `var` is implicitly `shared`, since any task can reach it. Writing `shared` there is allowed and the formatter keeps it.
- A top-level `let` is immutable and may have any initializer. Non-constant initializers run once, on first use, thread-safely.
- So the compiler's token list is simply `let TOKENS = lex(src)` or a `shared var` that is filled once. No `Ref`, no arena.

`Ref[T]` is removed: `shared var` covers it. `Topic`, `Queue`, `Signal` and `Promise` stay as std types, built on `shared` cells.

## 7. Concurrency: disjoint paths run in parallel

Two tasks may write the same non-shared value at the same time when their effect summaries touch disjoint paths and both are awaited before the value is used again. No lock is involved, because they never touch the same memory.

```minscript
async fn rename(u: *User, n: str) { u.name = n }      // writes [u.name]
async fn retag(u: *User, t: str)  { u.tags.push(t) }  // writes [u.tags]

var user = load()
await all(rename(user, "Ann"), retag(user, "admin"))    // OK: disjoint, runs in parallel
await all(rename(user, "Ann"), rename(user, "Bo"))      // E_CONCURRENT_OVERLAP: both write user.name
```

**Structured rule \[D\].** An async call that receives a `*` argument, or a read view of a value someone else may write, must be awaited **in the same statement**. `all(...)`, `race(...)` and `select` arms count as the same statement. Storing such a promise is `E_VIEW_ACROSS_TASK`. This is the v0.2 "await in the same expression" rule, widened from one call to one statement.

- **"May be written".** A read view is of a value someone else may write when it is rooted in a `var`, a `*` parameter or `*this`, through non-shared fields and elements. A view of a `let` / `:=` binding, of a `T` parameter or `this`, or of an identity value is not: it becomes a counted share, and the call needs no same-statement await.
- **Shared cells are exempt.** A `*` argument that is a `shared` place is passed as the cell itself (§6.1), and the task keeps an alias (`keeps [p]`). Such a call may be stored or detached: `t := ticker(count)` with `shared var count`. Lowering: a `*T` parameter whose summary has `keeps` or `awaits` receives a cell reference, never a raw pointer.

**The check.** Within one statement, the compiler collects each concurrent call's substituted summary and rejects any pair where a `writes` path overlaps the other's `reads` or `writes` (§4 overlap). Reads alone never conflict.

**Detached tasks.** A task that is not awaited in the statement (stored, `.ignore()`d) receives only owned values: snapshots of non-shared data, and aliases of `shared` cells. That is safe by construction, and §6.3 lints where a snapshot is probably not what was meant.

**Higher-level invariants.** Disjoint memory does not mean independent meaning. When fields must change together, the programmer uses a `shared` cell and a `lock` block; the compiler never infers grouping.

**No `Send` / `Sync` markers.** Thread safety follows from three facts: non-shared values are owned by one task at a time (or split by disjoint paths), `shared` cells are locked or atomic, and `Unique` values move.

## 8. Declaration syntax

Nominal declarations drop the `=`; only aliases keep it. Every item is private to its package unless marked `pub`, functions included (`pub fn`). Methods may sit inline in the type body as in v0.2.

### 8.1 Types, unions, interfaces \[D\]

```minscript
pub type User: Stringer {                  // nominal: no `=`
    pub name: str
    age: int = 0
    tags: Vec[str] = []

    pub fn new(name: str) -> User { User { name } }
    pub fn rename(*this, name: str) { this.name = name }
    fn to_str(this) -> str { "User(${this.name})" }
}

pub union Payment {
    Cash
    Mpesa(str)
    Card { number: str, exp: str }

    pub fn is_cash(this) -> bool { match this { Cash => true, _ => false } }
}

pub inter Stringer { fn to_str(this) -> str }
pub inter ReadWriter = Reader & Writer     // composition is an alias: keeps `=`

type Users = Vec[User]                     // alias
type Role = "Admin" | "Operator" | "Guest" // literal union: alias
type Point = r{ x: f64, y: f64 }           // structural alias
```

**Parser rule.** After `type` / `union` / `inter`, the name, optional `[Generics]` and optional `: Interfaces`, the next token decides: `{` opens a nominal body, `=` starts an alias. Both are one-token decisions. `type X = { ... }` is `E_TYPE_EQUALS_BODY`, with a fix-it removing the `=`.

### 8.2 Functions and methods \[D\]

```text
item       := ['pub'] (function | type | union | inter | impl | let | var | extern)
function   := ['async'] 'fn' name [GenericParams]
              '(' [receiver ','] params ')' ['->' ReturnType] Block
receiver   := 'this' | '*this'
param      := name ':' ['*'] Type | '...' name ':' Type
ReturnType := ['*'] Type
FnType     := '(' [['*'] Type {',' ['*'] Type}] ')' '->' Type
member     := ['pub'] (function | field)          // inside type / union / impl bodies
field      := ['shared' | 'once'] name ':' Type ['=' Expr]
```

- **One visibility rule.** Everything is package-private by default; `pub` exports it. That covers `pub fn`, `pub async fn`, `pub type`, `pub union`, `pub inter`, `pub let`, `pub var`, and `pub` on fields and methods.
- `pub` comes first: `pub async fn load()`, `pub shared count: int`, `pub once ty: Type`.
- Interface methods are always exported; writing `pub` on them is allowed and flagged as redundant by the linter.
- `impl` blocks stay for splitting methods across files, bounded impls and implementing an interface separately.

### 8.3 Closures \[D\]

`#{ ... }` stays the only closure syntax. **Capture lists are removed:** the compiler infers every capture from the body (view, share or move, §2 and §5). `#[` is reserved and reports `E_CAPTURE_LIST_REMOVED`.

```minscript
limit := 50
high := nums.filter(#{ it > limit })        // local view of limit
var total = 0
nums.for_each(#{ total += it })             // non-escaping: writes total in place
fn make_adder(n: int) -> (int) -> int { #{ it + n } }   // escaping: shares n
```

Function types lose the v0.2 `&(T) -> U` form: whether a closure escapes is now in the callee's summary (`keeps [f]`), not its type. A function type's parameters keep their modes, `(T) -> U` and `(*T) -> U`, and a closure's parameters take theirs from the expected type (§3).

### 8.4 Bindings and patterns

- `let` / `var` / `:=` / `:==` are unchanged.
- The keyword `mut` is removed. Mutable pattern bindings and closure parameters use `var`: `#{ var acc, x => acc += x; acc }`, `if let Some(var u) = find(id) { ... }`.

### 8.5 Keywords

```text
Added:    fn lock
Contextual (identifiers everywhere else):
          shared                  before `var`, or before a field name in a type body
          once                    before a field name in a type body
Removed:  fun mut
Reserved: thread atomic           (see §15)
```

## 9. Compiler architecture

The ownership work becomes one bottom-up pass that writes a summary per function, followed by local passes that read those summaries. Nothing in it is whole-program.

| # | Pass | Scope | Cost | Output |
| --- | --- | --- | --- | --- |
| 1–4 | Lex, parse, resolve, type-check | as v0.2 | linear | typed AST |
| 5 | Lower to HIR | per function | linear | HIR with explicit places (`user.tags[*]`) |
| 6 | **Effect summaries** | call graph, SCC order | linear in call edges × rounds; rounds bounded by summary size (§9) | one summary per function |
| 7 | **Access check** | per function | linear | `*` argument overlap, write views, concurrent statements, `Unique` moves |
| 8 | **Mechanism selection** | per function | linear | each use tagged view / move / share / copy; heap promotion; `shared` lowering |
| 9 | Lints | per function | linear | §2, §5 and §6.3 warnings |
| 10 | Back ends | per function | linear | JS / WASM / native |

**Pass 6 details.**

- Functions are processed in reverse topological order of the call graph, one SCC at a time. Callees are always summarised before callers.
- A summary is a bounded set of paths (≤ 4 segments), so it has a finite size and a finite lattice.
- *Precomputed call lists.* Before any iteration, each body is scanned once into its **local effects** (what it does to its own parameters directly) and its **call list**: every call with the argument path substituted for each callee parameter. Bodies are never walked again; a round only substitutes callee summaries into call lists, so it costs one step per call edge.
- *Fixpoint in a recursive SCC.* Every member starts from its local effects. A worklist re-evaluates a member only when a callee's summary in the same SCC grew. Summaries only grow, and each is a bounded set of paths, so this terminates. Its rounds are bounded by summary size (§1), and in practice a handful even for a parser-sized SCC: around 50 functions and a few hundred call edges cost a few thousand substitutions. Non-recursive functions need no iteration, and simple self-recursion converges in one extra round.
- *Safety cap.* If one SCC has not converged after 32 rounds, only the paths that changed in the last round are widened, each to its first segment (`writes [this.diagnostics[*].span]` becomes `writes [this.diagnostics]`). From then on, every new path in that SCC is added at its first segment. There are only as many of those as the parameters have fields, so the SCC finishes within a few more rounds, and `L_SUMMARY_WIDENED` names the SCC and the widened paths. Paths that were already stable keep their precision, so a view of `this.tokens` held across a call that writes `this.pos` stays valid.
- Calls through interfaces, function values and `extern` use the signature-level summary and never trigger iteration.

**Pass 8 details.**

- *Move vs share.* A use is a move if it is the last use of that binding on every path (a backward liveness scan); otherwise it is a share.
- *Copy-on-write placement.* A write to a value that might be shared compiles to `if !unique(x) { x = copy(x) }`. Uniqueness proven by pass 8 (for example a fresh `var` never shared) removes the check entirely.
- *Heap promotion.* A local whose buffer is reached by a `keeps` or a stored view is allocated on the heap; everything else stays on the stack or in caller-provided return storage.

**Incremental builds.** A package's compiled interface holds its types and its `pub` function summaries. When a package is rebuilt and its summaries are unchanged, dependents are not re-checked (early cutoff). Editing a function body therefore re-checks only that package unless its public summary changed.

**Back ends.**

- *Native and WASM:* non-atomic refcounts by default; atomic only for values that escape to another task (pass 8 knows). Reuse of a freed buffer of the same size (Perceus-style) is an optimisation for later.
- *JS:* the GC owns memory. Uniqueness for copy-on-write is tracked with a "shared" bit set when a second holder is created and never cleared, so JS may copy slightly more often than native. `Drop` runs only for `Unique` types.

**What is removed from the implementation:** lifetime/region inference, arenas, the whole-variable borrow tracker of `src/ownership.ts`, and the handle-cloning special cases.

## 10. Removed or replaced

| v0.2 / v0.3 | v0.4 |
| --- | --- |
| `fun`, `pub fun` | `fn`, `pub fn` |
| `x: T` owned, `x: &T`, `x: &mut T`, `mut x: T` | `x: T` (read), `x: *T` (write) |
| `this`, `&this`, `&mut this`, `mut this` | `this`, `*this` |
| `type X = { ... }`, `union X = { ... }`, `inter X = { ... }` | `type X { ... }` etc.; `=` only for aliases |
| Moves with `E_USE_AFTER_MOVE` everywhere | value semantics; moves only for `Unique` types |
| Borrows forbidden in fields (v0.2) / inferred lifetimes in fields (v0.3) | views stored as counted shares, no lifetimes |
| `E_BORROW_CONFLICT`, `E_RETURN_LOCAL_BORROW`, `E_BORROW_IN_FIELD` | removed; copy-on-write snapshot instead |
| `Ref[T]`, implicit handle cloning | `shared var`, `shared` fields |
| `atomic var`, `synchronized x { }` (v0.3) | inferred atomics; `lock x { }` |
| Capture lists `#[x]`, `#[&mut x]` | inferred captures |
| `&(T) -> U` vs `(T) -> U` | one function type; escape is in the summary |
| Raw pointer type `*mut T` | `unsafe.Ptr[T]` |
| `mut` in patterns and closure params | `var` |
| `mut x: T` on an owned `Unique` parameter (`mut sub: Sub[T]`) | `sub: Sub[T]`, inferred `consumes` (§2.1) |
| `T: Clone` bounds | none needed; `[T: Unique]` admits `Unique` types (§2.1) |
| `Ref.update(#{ v => ... })` on `&(&mut T) -> R` | `lock c { ... }`, or `(*T) -> R` function types (§3) |
| Top-level `var` forbidden; global `let` const-only | top-level `var` is shared; global `let` lazily initialised |
| Whole-variable borrow analysis, arenas | path summaries, refcount + copy-on-write |

Also replaced in §11: `Box` for recursive value types becomes automatic; collection getters return views instead of clones; node ids and arenas give way to `Identity` types, `once` fields and `Symbol`.

Also replaced: `string` and `&str` merge into one `str` type (§5.4), and functions are exported with `pub fn` like every other item (no `fnp`).

## 11. Identity types and compiler data

A type that implements `Identity` is a heap object compared and hashed by pointer, so programs can key maps by tokens, AST nodes or symbols with no ids and no arenas. This section exists because self-hosting v0.2 needed ids, arenas and side-table workarounds for exactly this.

### 11.1 `Identity` \[D\]

```minscript
type Token: Identity {
    kind: TokenKind
    text: str
    span: Span
}

type Binary: Identity {
    op: BinOp
    left: Expr          // no Box: an identity value is already a pointer
    right: Expr
}

var symbols = m{} as Map[Token, Symbol]   // hashed by pointer
symbols[tok] = sym
```

- `Identity` is a marker interface, like `Unique`; it adds no keyword.
- Each construction allocates one object. `==` and `hash` compare and hash the pointer. `.same_fields(o)` is generated for structural comparison.
- Fields are immutable after construction, except `once` fields (§11.2). A `shared` field is allowed but rarely needed.
- Passing, storing and capturing an identity value is a refcount increment. It never copies, never triggers copy-on-write and needs no effect paths, so the checker does almost no work for it.
- Because the fields are immutable, identity values cross tasks with no lock.
- Allocation: the compiler may allocate identity objects created in a loop from internal chunks. This is an implementation detail; programs never see an arena.
- Cycles leak under refcounting. Parent pointers in a tree should be omitted (pass the parent down) or held as `Weak[T]`. `L_SHARED_CYCLE` also covers identity types.

**Changing an identity value** means building a new one. The new object has a new identity:

```minscript
moved := Ident { ...old, span: new_span }
moved == old        // false: a different object
```

Passes that add information to existing nodes use `once` fields (§11.2) or side tables, never mutation. A non-`once`, non-`shared` field of an identity value is never assignable after construction (`E_ASSIGN_IDENTITY_FIELD`).

**Choosing a representation for compiler data:**

| Data | Representation | Why |
| --- | --- | --- |
| AST nodes, symbols, types, scopes | `Identity` types | map keys, sharing, recursion without `Box` |
| Tokens | `Identity`, or a value type hashed with its span | a span is unique per file, so value hashing already acts as identity |
| Hot, flat, numeric arrays | `Vec` of value types, or `Pool[T]` (§11.5) | cache-friendly layout |

### 11.2 `once` fields \[D\]

A `once` field is written at most once after construction, then read without locking. It is how passes attach results to nodes.

```minscript
type Ident: Identity {
    name: Symbol
    once resolved: Decl     // set by name resolution
    once ty: Type           // set by the type checker
}

node.ty = int_type          // first write: OK
node.ty = other             // second write: panics with PanicKind.AlreadySet
t := node.ty ?? unknown     // reading an unset once field gives None
```

- The field's type when read is `T?`. Writing it is allowed through a read-only view, because a write-once cell is thread-safe.
- Lowering: an atomic compare-and-set on native and WASM, and a plain property on JS.
- Side tables (`Map[Expr, Type]`) remain the alternative when a pass's output should stay separate from the tree.

* `once` fields are allowed only on identity types (`E_ONCE_OUTSIDE_IDENTITY`): on a value type, copy-on-write would make "once" ambiguous between copies.
* A field that must be rewritten later is a `shared` field instead: it can change any number of times, at the cost of a lock per access.

### 11.3 Interned symbols \[D\]

A `Symbol` is an **interned string**: the program holds exactly one `Symbol` object for each distinct text, in a global table from text to object. It is not a hash (hashes can collide) and not a box of another type.

```minscript
a := sym("count")   // first time: hashes "count", creates the object, stores it in the table
b := sym("count")   // finds it: returns the same pointer
c := sym("total")   // different text: a different object

a == b              // true, O(1): same pointer
a == c              // false, O(1)
a.text()            // "count": a str view of the text
```

- **Representation:** an `Identity` object holding the text (`str`) and its hash, computed once.
- **Costs:** `sym(text)` is O(length) (hash + table lookup). After that, `==` is a pointer comparison and `hash` returns the stored value: both O(1).
- **Guarantee:** same text gives the same object; different text never does.
- **Symbol vs. token:** two tokens with the same text are different objects (different occurrences); their `name: Symbol` fields are the same object. So `t1.name == t2.name` is true while `t1 == t2` is false.
- **Usage pattern:** the lexer interns each identifier once; resolver and checker compare and hash pointers only.
- **Thread safety:** the table is a concurrent map; `sym` may be called from any task.
- **Lifetime:** in v0.4 the table keeps every symbol for the whole run. A weak table is deferred (§15).

### 11.4 Other changes from the self-hosting lessons \[D\]

- **Recursive value types box automatically.** `next: Node?` inside `type Node` no longer needs `Box[Node]`.
- **Collection getters return views, not clones.** `get`, `first`, `find`, `max`, `filter`, `keys` and iteration all yield views (§5). This reverses v0.2 §9.12, where each lookup cloned.
- **No `.clone()` in ordinary code.** Copy-on-write (§2) and identity types cover what v0.2 needed it for: moving out of borrows, `for` items and `Ref.get()`.

### 11.5 std options

- **`Pool[T]` and `Id[T]`:** a typed, generation-checked pool for data-oriented code that profiles show needs it. Views from `pool.get(id)` are free.
- **`PMap[K, V]` and `PVec[T]`:** persistent collections whose copy-on-write costs O(log n) instead of O(n). Suited to scopes and environments that are copied and extended often.

## 12. Diagnostics

v0.4 adds 18 errors and 8 lints, and removes 9 v0.2 ownership errors. Every v0.2 diagnostic not listed here is unchanged.

### 12.1 New errors

| Code | Pass | Meaning | Fix-it |
| --- | --- | --- | --- |
| `E_BYTE_LITERAL_NOT_ASCII` | lexer | `b'é'`: a byte literal holding a non-ASCII character (§5.5) | `b'\xHH'` or a `str` |
| `E_TYPE_EQUALS_BODY` | parser | `type X = { ... }` | remove `=` |
| `E_CAPTURE_LIST_REMOVED` | parser | `#[x]{ ... }` | drop the list |
| `E_STAR_TYPE_NOT_PARAM` | parser | `*T` outside a parameter, receiver or return type | remove `*` |
| `E_MUT_REMOVED` | parser | `mut x: T`, `mut this`, `mut` in a pattern | `*T`, `*this`, `var` |
| `E_SHARED_IMMUTABLE` | resolver | `shared let` | `shared var` |
| `E_ONCE_OUTSIDE_IDENTITY` | checker | `once` field on a non-identity type | add `: Identity` |
| `E_ASSIGN_IDENTITY_FIELD` | checker | assigning a plain field of an identity value | rebuild with spread |
| `E_UNIQUE_TYPE_ARG` | checker | a `Unique` type given for a type parameter without `: Unique` | add `: Unique` to the parameter |
| `E_WRITE_TO_IMMUTABLE` | access | immutable binding passed to `*T` or `*this`, or a read-mode closure parameter written | `:=` → `:==`, `let` → `var`; `(*T)` in the function type |
| `E_OVERLAPPING_ACCESS` | access | two arguments of one call overlap on a written path | — |
| `E_ACCESS_DURING_WRITE_VIEW` | access | overlapping use while a `*T` view is live | — |
| `E_USE_AFTER_MOVE` | access | use of a moved `Unique` value (only `Unique` types now) | — |
| `E_CONCURRENT_OVERLAP` | access | tasks in one statement overlap on a written path | — |
| `E_VIEW_ACROSS_TASK` | access | async call with a `*` argument or a view not awaited in the same statement | `await` it there |
| `E_AWAIT_IN_LOCK` | access | `await` inside `lock` | move the `await` out |
| `E_WRITE_TO_CAPTURED_COPY` | access | escaping closure or task writes a captured non-shared `var` | `shared var` |

Also new: `E_STRING_TYPE_REMOVED` (resolver), the type name `string`; fix-it `str` (§5.4).

### 12.2 New lints

| Code | Default | Fires when |
| --- | --- | --- |
| `L_IMPLICIT_COPY` | warn (collections), off (strings) | a write may copy a shared buffer |
| `L_VIEW_FORCED_COPY` | warn | a write forces a live view to keep an old copy |
| `L_TASK_SEES_SNAPSHOT` | warn | a task reads a `var` the spawner writes afterwards |
| `L_DIVERGED_COPIES` | warn | a non-shared field is written after the value was stored in two places |
| `L_SHARED_CYCLE` | warn | a type can form a refcount cycle through `shared` or identity fields |
| `L_SUMMARY_WIDENED` | warn | a recursive SCC hit the pass-6 safety cap and some of its paths were widened (§9) |
| `L_NESTED_LOCK` | warn | a `lock` block nested in another `lock` block (fix-it: `lock a, b`) |

Back-end lint: `L_BIGINT_ON_JS` (on for the JS target) fires on `i64` / `u64` arithmetic, which lowers to `BigInt` (§13.1).

### 12.3 Runtime panics

- `PanicKind.AlreadySet`: second write to a `once` field.

### 12.4 Removed

`E_BORROW_CONFLICT`, `E_RETURN_LOCAL_BORROW`, `E_BORROW_IN_FIELD`, `E_CLOSURE_ESCAPES_BORROW`, `E_MOVE_OUT_OF_BORROW`, `E_BORROW_ACROSS_SPAWN` (now `E_VIEW_ACROSS_TASK`), `E_MUT_BORROW_IMMUTABLE` (now `E_WRITE_TO_IMMUTABLE`), `E_GLOBAL_VAR`, `E_INVALID_CAPTURE`.

## 13. JS back-end representation rules

Generated JS must run close to hand-written TypeScript; the v0.2 self-hosted compiler ran about 4× slower than the TS one. Each rule below targets a cost that most likely contributed to that gap, so profile (`ms run --profile`, which passes `--cpu-prof` to Node) before and after each.

### 13.1 Values \[D\]

| MinScript | JS representation | Rule |
| --- | --- | --- |
| `int`, `i8`–`i32`, `u8`–`u32`, `f32`, `f64` | `number` | overflow check after `+ - *` (`Math.imul` for 32-bit `*`); skipped where the range is proven (loop counters, indices) |
| `i64`, `u64` | `BigInt` | correct but slow: `L_BIGINT_ON_JS` (on for the JS target). Hashes are `u32`; spans and counters use `int` |
| `str` | JS `string` | a view is a `substring` (V8 shares the buffer); an `ascii` flag is cached per string so byte offsets equal UTF-16 indices; non-ASCII strings build an offset table once, on first byte-offset call |
| `bytes()` | `Uint8Array`, cached per string | lexers should scan this, not the string |
| `T?` | `T` or `undefined` | when `T` can't itself be absent; otherwise (`T??`-like nesting, `void?`) a `{ some: v }` box |
| `Result[T, E]` | instance of `Ok` or `Err` | two classes, fixed shape; `?` is one `instanceof` test |
| named struct | one JS class per type | constructor assigns every field in declaration order (stable hidden class) |
| record `r{...}` | one JS class per normalized shape | fields sorted by name |
| union | one JS class per variant | integer `tag` on the prototype; `match` is a `switch (x.tag)` |
| `Identity` type | JS class | `==` is `===`; used directly as `Map` / `Set` keys |
| `Symbol` | `{ text, hash }` object | intern table is a JS `Map<string, Symbol>` |
| `Vec[T]` | JS `Array` | `$s` (shared) flag for copy-on-write, below |
| `Map[K, V]`, `Set[T]` | native `Map` / `Set` when keys are numbers, strings, `Symbol` or identity values | runtime hash map using the generated `hash` / `eq` otherwise |

### 13.2 Copy-on-write on JS \[D\]

JS has no refcount, so the back end tracks one **shared bit** per buffer (`$s` on arrays, maps, sets and struct objects):

- A **share** (§2) sets `$s = true` on the value. A **move** does not.
- A **write** to a value with `$s` set first copies it (shallow; the copy has `$s = false`), then writes the copy.
- The bit is never cleared on the original, so JS may copy where native would not. That is correct, only slower; mechanism selection (§9 pass 8) keeps shares rare.

### 13.3 Control and runtime \[D\]

- **Loops:** `for x in vec` and `for i in a..b` become index loops. `map` / `filter` / `for_each` / `any` / `find` / `fold` with a closure literal are inlined as loops; no iterator objects, no per-element `Option`.
- **Closures** passed to a function whose summary does not `keep` them are inlined when the callee is a prelude pipeline; otherwise they are ordinary JS functions.
- **Async:** only `async fn` compiles to a JS `async function`. Everything else is synchronous.
- **Panics** are instances of a `Panic` class thrown as exceptions. `recover` is `try/catch`. `try/finally` is emitted only where a `Unique` value needs `Drop`.
- **`shared`:** a plain variable or property (one JS thread per worker). `lock` blocks compile to a plain block.
- **`once`:** a property initialised to `undefined`; a write checks for `undefined` and panics otherwise.
- **String interpolation:** a template literal; `to_str()` is called only for non-primitive values.

### 13.4 Build caching \[D\]

Each package's checked interface (types, `pub` function summaries) and generated JS are cached in `.ms-cache/`, keyed by a hash of its sources and its dependencies' interfaces. std and the prelude are therefore checked once per toolchain version, not on every run.

## 14. Implementation order

Build in this order so each step can be tested on its own. The JS back end can run programs from step 7 on, using the simplest safe mechanism (share everything, copy-on-write via the shared bit) until step 8 refines it.

| # | Step | Files (adjust to your layout) | Done when |
| --- | --- | --- | --- |
| 1 | **Lexer + parser:** `fn`/`pub fn`, `*` on params / receivers / return types / function-type params, `type X { }` and alias `=`, contextual `shared` and `once`, `shared var`, `lock` expressions, `var` in patterns, byte literals `b'x'` (§5.5), `#[effects(...)]` in std; removed forms report the §12.1 parser errors | `src/lexer.ts`, `src/parser.ts` | parser corpus updated; every removed form has a test with its fix-it |
| 2 | **Resolver:** new keywords; `Identity`, `Unique`, `Symbol`, `sym`, `Weak` in the prelude; top-level `var` allowed | `src/resolve.ts`, `std/prelude.ms` | prelude resolves cleanly |
| 3 | **Type checker:** drop `&T` / `&mut T`; view types (`str`, `Slice[T]`) as ordinary types; identity `==` / `hash`; `once` reads as `T?`; automatic boxing of recursive value types | `src/check.ts` | std and prelude type-check |
| 4 | **HIR with places:** every read and write names its path (`u.tags[*]`), truncated to 4 segments | `src/hir.ts` | `ms dump-hir` prints paths |
| 5 | **Effect summaries** (§9 pass 6), bottom-up by SCC, including `consumes` and the std `#[effects]` attribute | new `src/effects.ts` | `ms dump-effects` matches golden files for the §A samples; the stage1 parser's SCC converges without `L_SUMMARY_WIDENED` |
| 6 | **Access check** (§9 pass 7): the access-pass errors of §12.1 | replaces `src/ownership.ts` | one passing and one failing test per error |
| 7 | **JS back end, representation rules** (§13) and runtime (shared bit, `Symbol` table, hash map, `Panic`, `once`) | `src/js/*` | std tests pass on Node |
| 8 | **Mechanism selection** (§9 pass 8): move on last use, view vs share, copy-on-write checks only where needed | new `src/mechanism.ts` | the §A sample 2 output shows a move on the second call |
| 9 | **Lints** (§12.2) | `src/lint.ts` | each lint has a firing and a quiet test |
| 10 | **Port std:** remove `.clone()`, `Ref` → `shared var`, getters return views | `std/**` | std tests pass |
| 11 | **Port the self-hosted compiler:** tokens and AST nodes as identity types, identifiers as `Symbol`, pass results in `once` fields or side tables | self-hosted sources | it compiles itself |
| 12 | **Benchmark** against the TS compiler on the same input | — | target: within 1.5× of the TS compiler (proposed; v0.2 was about 4×) |

Take one `--cpu-prof` profile after step 11, before tuning anything, and work down its top functions.

## 15. Open questions

Each has a proposed default; the default applies until it is decided.

1. **`shared` or `thread`?** `shared` is proposed because the same keyword covers single-task aliasing (no lock) and cross-task state (locked). `thread` reads as cross-thread only. Default: `shared`; `thread` reserved.
2. **Visibility.** Decided: `pub` on every kind of item, functions included (`pub fn`); `fnp` is dropped (§8.2).
3. **Call-site marker for `*T`.** Unmarked (Go-like concision, LSP hint) or an optional `*u` at the call site that the formatter can enforce. Default: unmarked.
4. **Path depth limit.** 4 segments proposed. Measure on the compiler's own source before fixing it.
5. **Inline size for stored views** (§5.1). 24 bytes proposed.
6. **Per-field locks** (§6.2). Optimisation only, or a guarantee programmers can rely on? Default: optimisation only.
7. **`L_IMPLICIT_COPY` default level.** On as a warning, or off with a `perf` lint profile in `mod.ms`. Default: warning for collections, off for strings.
8. **Summary stability** (§4). Is a wider `pub fn` summary a breaking change enforced by tooling, or only reported? Default: reported by `ms api diff`.
9. **Cycle handling.** `Weak[T]` plus a lint, or a cycle collector on native back ends. Default: `Weak[T]` + `L_SHARED_CYCLE`.

Added with §11:

- **`==` on identity types.** Pointer equality (proposed), or keep `==` structural and add `===` for identity.
- **Default collections.** Should `Map` itself be persistent, or only `PMap`? Default: only `PMap`.
- **`once` read type.** `T?` (proposed), or `T` with a panic when unset.

Added with §11–§14:

- **`i64` on JS.** `BigInt` (proposed, correct, slow) or a 53-bit `number` that panics past 2^53 (fast, narrower).
- **Weak symbol table.** Needed only for long-running programs that intern untrusted input. Default: deferred.
- **Benchmark target.** Within 1.5× of the TS compiler proposed; confirm after the first profile.

* **`[T: Unique]` spelling** (§2.1). The bound means "may be Unique", which `: Unique` reads against. Alternative: `[T: ?Unique]`. Default: `: Unique`.

* **Byte strings** (§5.5). `b"GET "` as a static `Slice[u8]` for protocol code. Default: deferred; `"GET ".bytes()` works meanwhile.

* **Slice compaction** (§5.4). Never automatic (proposed), or copy small slices of large buffers when they are stored.

## Appendix A. Worked samples

Each sample shows the inferred summary in comments and what the compiler does. They double as golden tests for steps 5, 6 and 8 of §14.

### A.1 `T` and `*T`

```minscript
type User {
    name: str
    age: int
    tags: Vec[str]
}

fn greet(u: User) -> str { "Hi ${u.name}" }      // reads [u.name]
fn birthday(u: *User) { u.age += 1 }              // reads/writes [u.age]

var ann = User { name: "Ann", age: 30, tags: [] }
birthday(ann)
log.println(greet(ann))
```

- `greet` receives a plain pointer: no refcount, no copy.
- `birthday` gets exclusive access to `ann.age` only; the call site is unmarked (the LSP shows `*ann`).
- With `ann := ...`, `birthday(ann)` is `E_WRITE_TO_IMMUTABLE` (fix-it `:==`).

### A.2 Value semantics and copy-on-write

```minscript
fn with_tag(base: Config, t: str) -> Config {
    var c = base          // share
    c.tags.push(t)        // copy-on-write if base is still held elsewhere
    c
}

a := load_config()
b := with_tag(a, "x")     // a is used below: shared
log.println(a.tags.len(), b.tags.len())   // 0, 1
c := with_tag(b, "y")     // last use of b: moved
```

- First call: `push` finds the buffer shared and copies `tags` once; `a` is untouched.
- Second call: `b` moves, `c` is unique, `push` writes in place.
- One body, both behaviours, decided by a runtime uniqueness check. `L_IMPLICIT_COPY` marks the `push`.

### A.3 Lexer: tokens as map keys

```minscript
type Token: Identity {
    kind: TokenKind
    text: str
    span: Span
}

pub fn lex(src: str) -> Vec[Token] {     // reads [src] keeps [src]
    var out = [] as Vec[Token]
    var i = 0
    for i < src.len() {
        start := i
        // ... advance i ...
        out.push(Token { kind: Ident, text: src.substring(start, i), span: Span { start, end: i } })
    }
    out
}

fn main() {
    src := await fs.read_text("main.ms") or panic("can't read")
    tokens := lex(src)
    var first_seen = m{} as Map[Token, int]
    for tok, idx in tokens { first_seen[tok] = idx }
}
```

- `substring` is a free local view; stored in a `Token` it becomes a counted share of `src`'s buffer. The source text is never copied.
- Tokens created in the loop are allocated from internal chunks.
- `out` moves to the caller. `src` leaves scope; its buffer lives while the tokens do.
- `Map[Token, int]` hashes pointers (a native JS `Map`).

### A.4 Checker pass: `once` and `Symbol`

```minscript
type Ident: Identity {
    name: Symbol
    span: Span
    once ty: Type
}

fn check_ident(id: Ident, scope: Scope) -> Type {   // reads [scope]
    t := scope.lookup(id.name) ?? Type.Unknown
    id.ty = t
    t
}
```

- `id` is a pointer; its fields are immutable, so no paths are tracked.
- `id.ty = t` is a compare-and-set (native) or a checked property set (JS); a second write panics with `AlreadySet`.
- `lookup(id.name)` hashes a pointer, never characters.

### A.5 Disjoint-field concurrency

```minscript
async fn rename(u: *User, n: str) { u.name = n }      // writes [u.name]
async fn retag(u: *User, t: str) { u.tags.push(t) }   // writes [u.tags]

var user = load_user()
await all(rename(user, "Ann"), retag(user, "admin"))    // OK: parallel, no lock
await all(rename(user, "Ann"), rename(user, "Bo"))      // E_CONCURRENT_OVERLAP
p := rename(user, "x")                                    // E_VIEW_ACROSS_TASK
```

- Substituted summaries: `writes [user.name]` and `writes [user.tags]` are disjoint, so both run at once.
- Two writes to `user.name` in one statement are rejected at compile time.
- A `*` argument can't be held by a stored promise.

### A.6 Shared state in a server

```minscript
var requests = 0                                   // top-level var: shared
var sessions = m{} as Map[int, Session]

pub async fn handle(req: Request) {
    requests += 1                                  // atomic add
    sessions[req.id] = Session.new(req)            // one write lock
    lock sessions {
        if !sessions.has(req.user) { sessions[req.user] = Session.guest() }
    }
}

fn make_counter() -> () -> int {
    var n = 0
    #{ n += 1; n }        // E_WRITE_TO_CAPTURED_COPY, fix-it: shared var n
}
```

- `requests` lowers to an atomic; `sessions` to a read-write lock (native) or a plain object (JS).
- The `lock` block holds one write lock for the check and the insert; `await` inside it is rejected.
- The escaping closure writes a copy of `n`, which would lose updates, so it's an error. With `shared var n` it becomes an atomic cell.

## Appendix B. How much simpler v0.4 is

The programmer learns fewer forms and meets fewer ownership errors; the cost moves into the back ends and into lints.

| Concept | v0.2 | v0.4 |
| --- | --- | --- |
| Parameter modes | 4 (`T`, `mut T`, `&T`, `&mut T`) | 2 (`T`, `*T`) |
| Receiver forms | 4 | 2 |
| Common ownership errors | 7 | 3 (overlapping `*` args, concurrent overlap, write to captured copy) |
| Shared state | `Ref` + `get` / `read` / `update` / `set`, handle-cloning rules | `shared var`, `lock` |
| Closures | 3 capture forms, 2 function types | no capture lists, 1 function type |
| Manual work | `.clone()`, `Box`, ids and arenas | mostly none |
| New concepts | — | `Identity`, `once`, `Symbol`, snapshot semantics |

**Trade-offs accepted:**

- Copies are not visible in the source; whether a write copies is a runtime uniqueness check, surfaced by lints.
- A stored value is a snapshot unless it is `shared`.
- Every back end needs refcounting (or the JS shared bit) and copy-on-write.
- A body change can widen a `pub fn` summary and break callers; `ms api diff` reports it.

Swift, Hylo and Koka use broadly this model (value semantics, inferred sharing, copy-on-write).

