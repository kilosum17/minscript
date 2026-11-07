# MinScript Language Specification — v0.2 (Unified Draft)

**Status:** Unified draft. Supersedes `spec-v1.rs`, `spec-v2.rs`, `merge_1.rs`, `notes_1.md` (kept for history).
**Target:** Deterministic hand-written TypeScript lexer + recursive-descent / Pratt parser.
**Date:** 2026-11-07

Legend:

- **[D]** decided
- **[?]** proposed default, needs confirmation (§18)

---

## 0. Principles

MinScript combines:

- TypeScript's concise literals and collections.
- Rust's ownership and borrowing, **without lifetime annotations**.
- Go's small keyword set.
- A compiler that is fast and simple.

Convenience and concision come first, with as much performance as that allows.

Pipeline:

1. **Lexer**: tokens, spans, trivia, `ws_before` / `nl_before` flags, matching-delimiter index.
2. **Parser**: purely syntactic AST.
3. **Name resolution**: scopes, packages, imports.
4. **Type checker**: inference, generics, interfaces, coercions.
5. **Semantic analysis**: ownership, borrowing, escape analysis, comptime.
6. **Lowering**: HIR, then JS / WASM / C / LLVM back ends.

**Fundamental rule [D]:** parsing never needs type information, symbol resolution or interface resolution.

### 0.1 Change log

| Topic | spec-v1/v2 | v0.1 | v0.2 |
|---|---|---|---|
| Closures | `#{}`, `(a) => …` | `#{}`, `#[caps]{}` only | captures not exhaustive; implicit read-borrow |
| Generics | `<T>`, `::<T>` | `Vec[T]`, `f.[T](x)` | — |
| Sum types | `type X = \| A \| B` | `union X = { A  B }` | methods allowed in the body |
| Loops | `for` / `while` / `loop` | `for` only | — |
| Tagged records `'1{}` | yes | yes | **removed**: records are structural |
| Methods | `impl` only | `impl` only | **inline in `type`/`union`** + `impl` |
| Records vs structs | separate | separate | record ↔ struct conversion when shapes match |
| Fallback | `.or()` | `.or()` | **`??`** (lazy) + `.or()` |
| Conditions | `bool` only | `bool` only | **`bool`, `Option`, `Result`** are truthy |
| Interfaces as values | no | no | **yes**: `&Stringer` is dynamic dispatch |
| `int` | `i32` | `i32` | **platform width, ≥ 32 bits** |
| Overflow | debug panic / release wrap | same | **always panics** |
| Panics | abort | `recover {}` | unwind to the nearest `recover` |
| `to_string()` | | | **`to_str()`** |
| String ops | return `string` | | return `&str`; `try_*` variants return Option |
| Imports | single path | | `"pkg.*"`, `"pkg.{a, b}"`, `"pkg.item"` |
| Prelude | ? | | `log` included; `println` imported |
| Project config | `ms.json` | | **`mod.ms`** (MinScript code: `Config`, deps, scripts, tool sections) |
| Field defaults | — | — | `type T = { indent: int = 4 }` |
| `as` | numeric cast | numeric cast | **also a type annotation**: `g := [] as Vec[T]` |
| Inter-task communication | — | channels deferred | **`Topic` (broadcast), `Queue` (one consumer), `Signal` (state)**, one-shot `Promise.new()` |
| Closing / deadlocks | — | — | auto-close on last-handle drop; runtime `Deadlock` panic when all tasks are stuck |
| Waiting on several things | — | — | **`select { … }`**, random among ready arms; `for await`; `time.after`; `.cancel()` |

---

## 1. Lexical structure

### 1.1 Source [D]

- UTF-8. CRLF is normalized to LF. A BOM is stripped.
- Identifiers are ASCII.

```ts
type Token = {
    kind: TokenKind
    span: Span          // byte offsets + line/col
    ws_before: boolean  // whitespace or comment directly before
    nl_before: boolean  // a newline since the previous token
    match?: number      // openers: index of the matching closer
}
```

Comments are trivia, kept in a side list for the formatter and LSP.

### 1.2 Comments [D]

```rust
// line        /// doc (attaches to the next item)        /* block, /* nestable */ */
```

### 1.3 Identifiers [D]

`[A-Za-z_][A-Za-z0-9_]*`.

- A lone `_` is the wildcard.
- By convention, `PascalCase` is used for types, variants and interfaces, and `snake_case` for everything else (enforced by the linter).
- In patterns, an uppercase-initial identifier is a constructor or constant, and a lowercase one is a binding.

### 1.4 Keywords [D]

```text
Declarations: package import pub type union inter impl fun async let var mut extern
Control:      if else match select for in break continue return
Expressions:  await or as unsafe recover true false nil this Self
Type-level:   TypeOf
Reserved:     while loop yield macro where dyn
```

- **Implicit closure params:** `it`, and `it1`…`itN` (no leading zero). `it1 == it`. These are reserved identifiers.
- **Prelude names, not keywords:** `Ok Err Some None Result Option Promise Resolver Ref Topic Queue Signal Box Weak Vec Map Set Array Slice log assert panic Panic PanicKind`.
- **A keyword after `.` or `?.` is a plain identifier:** `x.or(5)`, `r.in(x)`.

### 1.5 Literals [D]

**Integers:** `123`, `1_000`, `0xFF`, `0b1010`, `0o17`.
- No suffixes.
- The default type is `int`.
- Out-of-range values are a compile error.

**Floats:** `1.5`, `1e9`, `2.5e-3`, `1_000.5`.
- `.5` and `5.` are not valid.
- The default type is `f64`; a float adopts `f32` when that type is expected.

**Number lexing:**
1. After a digit run, `.` belongs to the number only when a digit follows: `1..10` lexes as `1` `..` `10`, and `1.to_str()` as `1` `.` `to_str`.
2. When the previous token is a member `.`, only digits are lexed: `t.0.1` lexes as `t` `.` `0` `.` `1`.

**Booleans and absence:** `true`, `false`, `nil`. `nil` is a keyword alias of `None`.

**Characters:** `'a'`, `'\n'`, `'\u{1F600}'`. Type `char` is a Unicode scalar value.

**Strings:**
- `"…"` is single-line.
- Escapes: `\n \r \t \0 \\ \" \' \$ \xNN \u{…}`.
- Interpolation is `${expr}`. The lexer keeps a mode stack.
- `"""…"""` is multi-line. The first newline is dropped, and the common indentation (measured from the closing line) is stripped.
- Raw strings: `r"C:\path"`. No escapes or interpolation, may span lines, cannot contain `"`.

### 1.6 Glued sigil tokens [D]

These lex as single tokens only when glued, and only when the letter is a whole identifier:

| Token | Meaning | Valid in |
|---|---|---|
| `r{` | anonymous record literal / record type | expr, type |
| `m{` | map literal | expr |
| `s{` | set literal | expr |
| `t(` | tuple literal / type / pattern | expr, type, pattern |
| `a[` | fixed array literal | expr |
| `_{` | inferred struct/record literal | expr |
| `#{` | closure | expr |
| `#[` | closure capture list (must be followed by a glued `{`) | expr |
| `.[` | explicit generic arguments | expr (postfix) |
| `r"` | raw string | expr |

- **No-glue contexts:** a letter is not a sigil when the previous token is `.`, `fun`, `type`, `union` or `inter`.
- **Collisions:** `a[0]` is an array literal and `a [0]` indexes `a`; `t(1)` is a tuple and `t (1)` calls `t`. The resolver reports `E_SIGIL_SHADOWS_BINDING` when a sigil letter matches a visible binding.
- **Vec literals are plain `[…]`.** In prefix position `[` is a literal; in postfix position it indexes.

### 1.7 Operators [D]

```text
Arithmetic:  +  -  *  /  %
Bitwise:     &  |  ^  <<  >>          (unary bitwise-not is `!` on integers)
Compare:     ==  !=  <  <=  >  >=
Logical:     &&  ||  !
Nullish:     ??
Assign:      =  +=  -=  *=  /=  %=  &=  |=  ^=  <<=  >>=  ??=
Binding:     :=  :==
Range:       ..  ..=       Spread: ...
Arrows:      ->  =>        Option: ?  ?.
Other:       .  ,  :  ;  @  ( ) [ ] { }
Reserved:    ~  ++  --     (lexed, always a parse error with a hint)
```

Generics never use `<` / `>`, so maximal munch is always correct and no token splitting is needed.

---

## 2. Generics [D]

### 2.1 Parameters: `[…]` after the declared name

```rust
fun identity[T](value: T) -> T { value }
fun largest[T: PartialOrd[T]](items: &Vec[T]) -> &T { … }
type Box[T] = { value: T }
union Response[T, E] = { Success(T)  Failure(E) }
inter Convert[From, To] = { fun convert(&this, v: From) -> To }
impl[T] Box[T] { … }
```

- Bounds use `:`, with `&` for multiples: `[T: Reader & Writer]`.
- There is no `where` clause.
- Const params are deferred; built-in `Array[T, N]` takes an integer literal.

### 2.2 Type position: `Name[Args]`

```rust
Vec[int]   Map[string, Vec[User?]]   Promise[Result[User, string]]   Array[i32, 4]
```

The `[` must be glued to the name.

### 2.3 Expression position: `.[Args]`

Only needed when inference can't determine the types:

```rust
let user = json.parse.[User](json_str)     // Result[User, json.Error]
let ids  = collect.[i64](items)
let v    = Vec.new.[u8]()
let v2   = Vec.[u8].new()
let b    = Box.[i32]{ value: 1 }

let u: Result[User, json.Error] = json.parse(json_str)   // inferred from the expected type: no .[ ]
```

- `.[` is one postfix token and produces `GenericApply { target, args }`.
- It may not start a new line.
- When inference fails, `E_CANNOT_INFER_GENERIC` suggests `.[T]`.

---

## 3. Operators and precedence [D]

Tightest first:

| # | Operators | Assoc | Notes |
|---|---|---|---|
| 1 | postfix `.x` `?.x` `(args)` `[i]` `.[T]` `?` | left | `(`, `[`, `.[` must not cross a newline |
| 2 | prefix `-` `!` `await` | right | §3.1 |
| 3 | `as T` | left | type annotation or cast (§3.3) |
| 4 | `*` `/` `%` | left | |
| 5 | `+` `-` | left | |
| 6 | `<<` `>>` | left | |
| 7 | `&` | left | |
| 8 | `^` | left | |
| 9 | `\|` | left | |
| 10 | `==` `!=` `<` `<=` `>` `>=` | none | chaining them is `E_NON_ASSOCIATIVE_OPERATOR` |
| 11 | `&&` | left | operands must be truthy (§4.7) |
| 12 | `\|\|` | left | |
| 13 | `??` | right | mixing with `&&`/`\|\|` needs parentheses (`E_MIXED_NULLISH`) |
| 14 | `..` `..=` | none | |
| 15 | `or` | left | §4.6 |
| 16 | `=`, compound assignments, `??=` | right | assignment evaluates to `void` |

- `return`, `break` and `continue` are expressions of type `never`.
- Unary `&` appears only in captures, in sub-borrows (`&this.value`) and in raw-pointer code. Unary `*` appears only in `unsafe`.

### 3.1 `await` and `?`

The operand of `await` is a postfix chain up to the first `?` or `?.`. After that, the postfix loop continues on the awaited value.

```rust
await read_file(p)?          // (await read_file(p))?
await get_user()?.name       // ((await get_user())?.name)
(await fetch()).trim()
```

### 3.2 `?`, `?.` and `??`

| Form | When the value is absent (`None` / `Err`) | Result |
|---|---|---|
| `x?` | **returns** from the enclosing function or closure | `T` |
| `x?.name` | the whole chain becomes `None` | `U?` |
| `x ?? y` | evaluates `y` (**lazily**) | `T`, or `T?` if `y: T?` |
| `x.or(y)` | `y` (evaluated eagerly; pass `#{…}` for lazy) | `T` |
| `x or y` | evaluates `y` and **returns it** from the function | `T` |

- `??` works on `Option[T]` and `Result[T, E]`; on a `Result` the error is discarded.
- `a ?? b ?? c` chains.
- `x ??= v` assigns when `x` (a `var` of type `T?`) is `None`.
- In type position `T?` means `Option[T]`, and `T??` is an error.

```rust
let name  = user?.profile?.name ?? "anonymous"
let port  = env.get("PORT")?.to_int() ?? 8080
let token = cache.get(key) ?? fetch_token()        // fetch_token() runs only on a miss
```

### 3.3 `as`: type annotation and cast

`expr as T` has two meanings, chosen by the type checker. The parser always produces the same node, `As { expr, type }`.

1. **Type annotation** (no runtime cost): `expr` is checked with `T` as its expected type. If that succeeds, `as` only fixes the type. This is how you give a type to values whose type can't be inferred from the value alone:
   - empty collections (`[]`, `m{}`, `s{}`);
   - `nil`;
   - numeric literals;
   - `_{…}`;
   - generic calls that are inferred from their return type.
2. **Cast:** if the annotation fails and both `expr`'s type and `T` are numeric (or both are raw pointers), it is a truncating/saturating cast. Any other case is `E_INVALID_CAST`.

```rust
g := [] as Vec[Map[string, int]]          // annotation: the value comes first, then its type
var seen = s{} as Set[u64]
cache :== m{} as Map[string, User]
owner := nil as User?
timeout := 500 as u16                     // literal annotation (no conversion happens)
cfg := _{ host: "localhost", port: 80 } as Config
user := json.parse(raw) as Result[User, json.Error]   // instead of json.parse.[User](raw)

let small = big_number as u8              // cast: i64 → u8, truncating
let ratio = count as f64 / total as f64   // casts
```

- `let g: Vec[Map[string, int]] = []` and `g := [] as Vec[Map[string, int]]` mean the same thing. Use whichever reads better: annotations suit declarations where the type matters most, and `as` suits places where the value matters most.
- `as` binds tighter than arithmetic (§3), and its type operand is parsed greedily, `?` included: `x as i32?` is `x as Option[i32]`.

---

## 4. Expressions

### 4.1 Blocks [D]

A block evaluates to its last expression when that expression has no trailing `;`. A trailing `;` discards the value. `return` is always available and never required.

```rust
fun a() -> int { 5 }       // 5
fun c() -> int { 5; }      // E_INVALID_BLOCK_VALUE
```

### 4.2 Bare `{` is always a block [D]

There is no bare literal. A struct literal `Name {…}` is not allowed directly in an `if`/`for`/`match` header; wrap it in parentheses.

### 4.3 Literals [D]

```rust
[1, 2, 3]                          // Vec[int]
a[1, 2, 3]                         // Array[int, 3]
t(1, "a")   t(x)   t()             // tuple, 1-tuple, unit
r{ name: "Ted", age: 26, ...base } // structural record
m{ "one": 1, key_expr(): 2 }       // Map; keys are expressions
s{ 1, 2, 3 }                       // Set
_{ host, port: 8080 }              // inferred from the expected type
User { id: 1, name }               // named struct literal
```

- Elements are separated by commas or newlines, and trailing commas are allowed.
- `...expr` spreads into every literal kind, and into call arguments that bind a variadic parameter (`log.println(prefix, ...args)`).
- `_{}` without an expected type is `E_CANNOT_INFER_STRUCT_TYPE`; it doubles as the named-arguments form: `serve(_{ host, port })`.
- Empty literals need a type from somewhere: an annotation, the surrounding context, or `as` (`[] as Vec[int]`, §3.3).
- There is no bare `(a, b)` tuple: write `t(a, b)`.
- Records with the same shape are the same type, so arrays of records need no tagging:

```rust
let routes = [
    r{ name: "TRM", lat: -1.2194, volume: 80 },
    r{ name: "Kasarani", lat: -1.2288, volume: 100 },
]   // Vec[r{ name: string, lat: f64, volume: int }]
```

### 4.4 Closures [D]

`#{…}` is the only closure syntax.

```rust
#{ it * 2 }                         // implicit: it == it1, it2 … itN
#{ compute_default() }              // zero params
#{ n, idx => n > 50 }               // named params
#{ x: i32, y: i32 -> i32 => x + y } // typed params + return type
#{ mut acc, cur => acc += cur; acc }
#{ n =>
    let sq = n * n
    sq + 5                          // last expression is the value
}

#[count]{ it + count }              // capture by value (move/copy)
#[&mut total]{ total += it }        // capture by mutable borrow
#[conn, &mut stats]{ msg => conn.send(msg); stats.sent += 1 }
```

**Capture list:** `#[` capture {`,` capture} `]{` body, where capture := `ident` | `&ident` | `&mut ident`. The `{` must be glued to `]`.

**Parsing the header** (bounded scan, no backtracking):
- After `#{`, scan at depth 0 (skipping bracket groups with the matching-delimiter index).
- If `=>` is reached, and every token before it is one of `ident mut , : & -> ? . _` or a skipped group, that prefix is the **parameter header**.
- If the scan reaches a newline, `;`, `}` or any other token first (including `or`), there is **no header**.
- So the header must be on the closure's first line.

**Rules:**
- `it`/`itN` may only be used in header-less closures (`E_IT_IN_NAMED_CLOSURE`). In nested closures the innermost `it` wins, and the linter warns.
- A callback may use fewer parameters than the callee supplies.
- `return` inside a closure returns from the closure.
- Closures are passed inside `(…)`; there is no trailing-closure syntax.
- Capture semantics are in §9.4.

### 4.5 Control-flow expressions [D]

```rust
let grade = if score >= 90 { "A" } else if score >= 75 { "B" } else { "C" }

let label = match n {
    0 => "zero"
    1..=5 => "small"
    x if x > 100 => "huge"
    _ => "other"
}

let adult = match {               // subject-less: the first true arm wins
    age >= 18 => true
    _ => false
}
```

- `if` without `else` is `void`. `match` must be exhaustive.
- Arms are separated by commas or newlines.
- Ranges: `a..b`, `a..=b`, `..b`, `a..`.

### 4.6 `or`: unwrap or return [D]

```rust
expr or RHS
expr or name => RHS
```

- `Ok(v)` / `Some(v)` evaluates to `v`.
- `Err(e)` / `None` evaluates RHS and **returns it from the enclosing function or closure**.
- `it` is the error payload; `or e => …` names it instead.
- RHS may be an expression, a block, `return …`, `break` or `continue`.

```rust
let bytes = await fs.read_file(path) or Err("IO failed: ${it}")
let user  = find_user(id) or e => { log.println(e); Err(e) }
let line  = lines.next() or break
```

The linter flags `x or <literal>` when the literal doesn't match the function's return type, since `??` was probably meant.

### 4.7 Truthiness [D]

The values allowed in an `if` / `for` condition and as operands of `&&`, `||` and `!` are:

| Type | true when |
|---|---|
| `bool` | `true` |
| `Option[T]` | `Some(_)` |
| `Result[T, E]` | `Ok(_)` |

```rust
let res = json.parse.[User](s)
if res { … }                   // instead of res.is_ok()
if !cache.get(k) { … }
if user && user_is_admin { … }
```

- Ints, strings and collections are **not** truthy (no `0` / `""` surprises). Use `n != 0` and `s.is_empty()`.
- `&&`, `||` and `!` always produce `bool`. Using `||` for a value fallback (`let x: string = a || b`) is `E_USE_NULLISH`, with a fix-it to `??`.
- Truthiness is a built-in rule, not a user-implementable interface [?].
- The linter warns on `Option[bool]` in a condition, because `Some(false)` is truthy.
- When you need the payload, use `if let Ok(user) = res { … }`.

### 4.8 String interpolation [D]

`"${expr}"`. The value must implement `Stringer`, which is auto-generated (§9.7).

### 4.9 `select`: wait on several Promises [D]

```rust
select {
    Some(job) = jobs.next() => process(job)          // pattern = promise => body
    Some(ev) = events.next() => log.println(ev)
    cfg = config_watch.next() => reload(cfg)
    time.after(5000) => log.println("idle")          // shorthand for `_ = time.after(5000)`
    else => log.println("nothing ready")             // optional: makes the select non-blocking
}
```

**Syntax:**
- An arm is `pattern = expr => body` or `expr => body`. The parser tells them apart by a `=` token at depth 0 before the arm's `=>`.
- Arms are separated by commas or newlines, like `match`.
- `else =>` is optional; if present it must be the last arm and may appear only once.
- `select` is an expression: its value is the value of the arm that ran.

**Semantics:**
1. **Start:** every arm's expression is evaluated top to bottom, and each must be a `Promise[T]` (`E_SELECT_ARM_NOT_PROMISE`). The select then waits until one of them completes.
2. **Choice:**
   - If several arms are ready at the same moment, **one is chosen at random**. This is fair: no arm can starve the others, the way Go's `select` works.
   - The chosen value is matched against the arm's pattern, and that arm's body runs.
3. **Disabled arms:**
   - A refutable pattern that doesn't match (e.g. `Some(job)` when the queue closed and `next()` returned `None`) **disables** that arm for this select, which keeps waiting on the others.
   - If every arm is disabled, the `else` arm runs. Without an `else`, the select panics with `SelectExhausted`.
4. **`else`:** when there is an `else` arm, the select doesn't wait at all. If no arm is ready immediately, `else` runs (a non-blocking select).
5. **Losing arms take nothing.** The std wait operations (`Subscription.next`, `Queue.publish`, `Watcher.next`, `time.after`, and network receives in `std.net`) are **cancel-safe**: a message is removed, or a slot is used, only by the arm that wins.
6. **Promises of your own tasks are different.** Such a task is already running (§9.6). Losing a select only stops waiting for it; the task carries on, as if `.ignore()`d. Call `.cancel()` on it to stop it.
7. **Borrowed receivers are allowed in arms.** Arm expressions count as awaited in the same expression (§9.6), so `sub.next()` on a `var` subscription is fine. Normal borrow rules still apply across arms: two arms both calling `sub.next()` take two `&mut` borrows of `sub` (an error). Use one arm per wait, and `match` inside its body.
8. **`break` and `continue`** inside an arm refer to the enclosing loop. `select` is not a loop.

---

## 5. Statements

### 5.1 Bindings [D]

```rust
let name = expr          var name = expr
name := expr             name :== expr           // sugar for let / var
let name: T = expr       name := expr as T       // same meaning (§3.3)
let pattern = expr else { diverge }
place = expr             place += expr           place ??= expr
```

- `:=` and `:==` take only a plain identifier.
- Assigning to an undeclared name is `E_UNDECLARED_ASSIGNMENT`.
- The `else` of `let … else` must diverge.

### 5.2 Destructuring and conditional patterns [D]

```rust
let t(width, height) = get_dimensions()
let Ok(data) = res else { return Err("read failed") }
let User { id, name, .. } = user
if let Some(u) = find(id) { … }
```

### 5.3 Loops: `for` only [D]

```rust
for { … }                          // infinite; `break value` makes it an expression
for count < 3 { … }                // conditional
for let Some(x) = iter.next() { }  // conditional pattern
for item in items { … }
for item, idx in items { … }       // Vec: (item, index); Map: (key, value)
for i in 0..10 { … }
for await msg in sub { … }         // async iteration: awaits `next()` each time
for await ready() { … }            // conditional loop whose condition awaits
outer: for row in grid { for c in row { if c < 0 { break outer } } }
```

How the parser classifies the header:
- `{` right after `for` is the infinite form.
- `let` right after `for` is the pattern form.
- Otherwise, scan to the header's `{` at depth 0:
  - with an `in` keyword, it is an iteration loop;
  - without one, it is a conditional loop.
- In an iteration loop, an `await` right after `for` makes it **async iteration**.
- In a conditional loop, `await` is just the start of the condition expression.

**Async iteration:**
- `for await x in e` requires `e: AsyncIterator[T]` (§10.2). Each step is `await e.next()`, and the loop ends at `None`.
- It is shorthand for `for { let Some(x) = await e.next() else { break }; … }`. When `e` is a place (e.g. `sub`), the place is borrowed mutably only during each `next()`, so the body may still use it (`sub.missed()`). Otherwise `e` is evaluated once into a hidden variable.
- It is only allowed where `await` is: in an `async fun`, or in `main`.
- The `await` keyword is required so that every suspension point stays visible.

### 5.4 Newlines and semicolons [D]

1. A statement ends at `;`, at a newline, or before `}` / EOF.
2. A newline does **not** end a statement when:
   - the previous token cannot end an expression (binary operator, `,`, `.`, `?.`, `(`, `[`, `{`, `=`, `:=`, `:==`, `=>`, `->`, `:`, `as`, `or`, `??`, `await`, `mut`, `&`, `!`, `#{`, `#[`, `.[`), or
   - the next token is `.`, `?.`, `&&`, `||`, `??`, `or`, `as`, `else`, `)`, `]`, `}` or `=>`.
3. A newline **does** end the statement when the next line starts with `(`, `[`, `{`, `-`, `+`, `*`, `&`, `!` or `.[`.
4. Postfix `(`, `[` and `.[` need `nl_before == false`. `.` and `?.` may cross a newline.
5. Newlines are ignored inside `(…)` and `[…]`, but they matter again inside a nested `{…}`.
6. `return`, `break` and `continue` followed by a terminator take no value.
7. Opening braces of declarations and control flow (including `select`) go on the header line.
8. A trailing `;` after a block's last expression discards its value. The formatter strips every other `;`.

---

## 6. Patterns [D]

| Pattern | Example |
|---|---|
| Literal | `1`, `"hi"`, `'c'`, `true`, `nil` |
| Wildcard | `_` |
| Binding | `user`, `mut user` |
| Constructor | `None`, `Cash`, `Payment.Cash` |
| Payload | `Ok(v)`, `Mpesa(code, amount)` |
| Struct / record | `Card { number, .. }`, `r{ name, .. }` |
| Tuple | `t(x, y, ..)` |
| Or | `Some(0) \| None` |
| Range | `1..=5`, `'a'..='z'` |

- Unqualified variants resolve through the prelude, then the scrutinee's type.
- There are no reference patterns and no parameter destructuring.

---

## 7. Types

### 7.1 Type grammar [D]

```text
Type         := Intersection
Intersection := Postfix ('&' Postfix)*         // bounds, `inter X = A & B`
Postfix      := Primary '?'?
Primary      := Path [ '[' TypeArgs ']' ]      // glued '['
              | '&' ['mut'] Type               // borrow
              | '*' ['mut'] Type               // raw pointer
              | 't(' [Types] ')'               // tuple
              | 'r{' [Fields] '}'              // structural record
              | '(' [Types] ')' '->' Type      // function (owned / escaping)
              | '(' Type ')'
              | 'TypeOf' '(' ValuePath ')'
              | StringLit | IntLit | 'true' | 'false'
```

- A `&` at the start of a type is a borrow; between two types it is an intersection.
- `&(T) -> U` is a **borrowed (non-escaping) function**; `(T) -> U` is an **owned (escaping) function**.
- When a `Path` names an interface, it denotes a dynamically dispatched value (§9.7).
- **`void`** is the unit type, and its only value is `t()`.
  - A payload of type `void` can be left out at construction: `Ok()` is `Ok(t())`, as in `Result[void, string]`. This is a semantic rule; the parser sees an ordinary call with zero arguments.
  - **`never`** is the type of diverging expressions.

### 7.2 Built-in types [D]

```text
bool  char  byte(=u8)
i8 i16 i32 i64  u8 u16 u32 u64  isize usize
int  (platform width, at least 32 bits)
f32 f64   void   never   string   str (only as &str = Slice[u8] view)
Slice[T]  Array[T, N]  Vec[T]  Map[K, V]  Set[T]
Option[T] (T?)  Result[T, E]  Promise[T]   Ref[T]  Box[T]  Weak[T]
```

**`int`:**
- It is 64-bit on 64-bit native targets, and 32-bit on WASM32 and JS (where 64-bit would need BigInt).
- The only guarantee is **at least 32 bits**. Use `i64` when values can exceed 2³¹.
- The linter flags `int` literals and constants outside the i32 range (`L_INT_NOT_PORTABLE`).

**`string` and `&str`:**
- `string` is owned and immutable.
- `&str` is a borrowed view (`Slice[u8]`).
- Strings are not integer-indexable. Use `.bytes()`, `.chars()` and `.substring(a, b)`; byte offsets must land on char boundaries.

Coercions done by the type checker:
- `string → &str` and `Vec[T]`/`Array[T,N] → Slice[T]` are free.
- `&str → string` copies, and is inserted implicitly where an owned `string` is required. The lint `L_IMPLICIT_STR_COPY` is off by default and can be enabled in the `lint` section of `mod.ms`, so the linter or LSP warns on these copies.

### 7.3 Type declarations, with inline methods [D]

```rust
pub type User: Stringer = {          // `: Interfaces` implemented inline (optional)
    pub id: u64
    pub name: string
    email: string?                    // private
    tags: Vec[string] = []            // field default
    active: bool = true

    pub fun new(id: u64, name: string) -> User {      // static
        User { id, name }             // email → None, tags → [], active → true
    }
    pub fun display_email(&this) -> &str { this.email ?? "none" }   // a method can't share a field's name
    pub fun rename(&mut this, name: string) { this.name = name }
    pub fun to_str(&this) -> string { "User(${this.id})" }   // Stringer
}

pub union Payment = {
    Cash
    Mpesa(string)
    Card { number: string, exp: string }

    pub fun is_cash(&this) -> bool { match this { Cash => true, _ => false } }
}

pub type Role = "Admin" | "Operator" | "Guest"     // literal union
type Point = r{ x: f64, y: f64 }                    // structural alias (no methods)
type Users = Vec[User]                              // alias
type Config = TypeOf(default_config)
```

- In a body, a member starting with `fun`, `pub fun` or `async fun` is a method; anything else is a field (or, in a `union`, a variant).
- Fields and variants are separated by commas or newlines, and are private by default.
- **Field defaults:** `name: T = expr`.
  - A field with a default, like a `T?` field (which defaults to `None`), may be left out of struct literals, `_{}` and record → struct conversions.
  - The default expression is evaluated again for every value constructed, and cannot refer to other fields.
  - Fields without a default are required (`E_MISSING_FIELD`).
- `type X: A, B = {…}` declares that the body implements interfaces `A` and `B`.
- Methods can't be attached to structural aliases (`E_METHODS_ON_STRUCTURAL`).
- Recursive types use `Box`: `next: Box[Node[T]]?`.

`impl` blocks remain valid, for:
- splitting methods across files of the same package;
- generic or conditional impls (`impl[T: Stringer] Vec[T] { … }`);
- implementing an interface separately (`impl Reader for File { … }`).

Inline methods and `impl` blocks for the same type may coexist. A duplicate method name is `E_DUPLICATE_METHOD`.

### 7.4 Nominal and structural typing [D]

| Kind | Identity | Example |
|---|---|---|
| Named struct / union | **nominal** | `type User = {…}` |
| Record | **structural**: same field names and types (order-insensitive) means the same type | `r{ id: u64 }` |
| Tuple | structural | `t(int, string)` |

**Conversion rules:**
- record → named struct: implicit when the shapes match exactly. Missing fields are allowed only if they have a default or are `T?` (which become `None`).
- named struct → record type: implicit when the shapes match exactly.
- named struct → a different named struct: **never implicit**, even with the same shape. Spread it explicitly: `let b: B = _{ ...a }`.
- No width subtyping in v0.2: extra fields don't match. Use spread or `Pick[T, K]`.

This keeps nominal identity (so `Meters` and `Feet` stay distinct, methods have one owner, and the orphan rule works) while records stay the structural glue: a JSON shape, a config, or a quick return value can flow into a named type without boilerplate.

```rust
fun save(u: User) { … }
save(r{ id: 1, name: "Ted", tags: [] })     // OK: shape matches User (email: None)
fun log_pos(p: r{ x: f64, y: f64 }) { … }
log_pos(Point2D { x: 1.0, y: 2.0 })         // OK: exact shape
```

### 7.5 Type-level forms [D]

- `TypeOf(path)` is the only keyword form.
- `KeyOf[T]`, `ElementOf[T]`, `IndexOf[T]`, `Partial[T]`, `Omit[T, K]` and `Pick[T, K]` are generic type names that the checker evaluates.

```rust
pub type Route  = ElementOf[TypeOf(routes)]
pub type Fields = KeyOf[Route]              // "name" | "lat" | "volume"
```

---

## 8. Declarations and modules

### 8.1 File structure and imports [D]

```text
file    := package_decl import* item*
package := 'package' ident ('.' ident)*
import  := 'import' ['pub'] STRING ['as' ident]
item    := ['pub'] (fun | type | union | inter | impl | let | extern)
```

```rust
package app.users

import "std.json"                 // binds package `json`
import "std.io.println"           // binds one item
import "std.io.{print, println}"  // binds several items
import "std.collections.*"        // binds every pub item of the package
import "app.models" as models
import "./helpers"                // relative to this file's folder
import pub "./log"                // re-export
```

- **A folder is a package**: all its files declare the same package name, which matches the folder.
- **`main` is exempt:** it may live anywhere (`./src`, the root, …) and is located through `mod.ms` (§17).
- Paths starting with `./` or `../` are relative. Otherwise the first segment is `std`, `app` (this project's source root), or a dependency.
- The resolver decides whether the last segment is a package or an item.
- **Glob imports** (`.*`):
  - Local declarations shadow glob-imported names.
  - Two globs exporting the same name is an error only where that name is used (`E_AMBIGUOUS_IMPORT`), with a fix-it to import the item explicitly.
  - Unused imports cost nothing: the compiler tree-shakes at item level.
- Everything is private by default.

### 8.2 Top-level items [D]

- Only declarations are allowed at the top level.
- Global `let`s are immutable, and their initializers must be const-evaluable or `Ref(…)`.
- Mutable global state goes through `Ref[T]`.
- Top-level `var` is `E_GLOBAL_VAR`.

### 8.3 Functions [D]

```text
fun      := ['async'] 'fun' ident [GenericParams] '(' [receiver ','] params ')' ['->' Type] Block
receiver := 'this' | '&this' | '&mut this' | 'mut this'
param    := ['mut'] ident ':' Type  |  '...' ident ':' Type     // variadic, last; binds Slice[T]
```

There are no default parameter values and no named arguments; `_{}` covers both.

### 8.4 `impl` [D]

```rust
impl User { … }                  // inherent methods (same package as User)
impl[T] Box[T] { … }
impl Reader for File { … }
impl Add, Sub for Money { … }
```

- **Orphan rule:** `impl X for T` must be in the package that owns `X` or owns `T`.
- Inherent `impl T` must be in `T`'s package, but may be in any file of that package.
- Duplicate method names across interfaces are `E_AMBIGUOUS_IMPL_METHOD`.

### 8.5 `inter` [D]

```rust
pub inter Reader = { fun read(&mut this, buf: &mut Vec[u8]) -> Result[int, IoError] }
pub inter PartialOrd[T]: PartialEq[T] = { fun partial_cmp(&this, o: &T) -> Ordering? }
pub inter ReadWriter = Reader & Writer
pub inter Stringer = { fun to_str(&this) -> string }
```

- Interfaces are implemented explicitly, either with `impl` or with `type X: Inter = {…}`.
- Methods are implicitly `pub`.
- Default method bodies are allowed.
- There are no associated types; use extra generic parameters.

### 8.6 `extern`, `unsafe`, attributes [D]

```rust
extern "C" { pub fun malloc(size: usize) -> *mut u8 }
let fd = unsafe { open(path.as_ptr(), 0, 0) }
```

`@attr` is reserved (`E_ATTRIBUTES_RESERVED`).

---

## 9. Semantics

### 9.1 Values, moves and copies [D]

- Primitives, and tuples or records made only of primitives, are `Copy`. Everything else moves.
- Using a moved-from binding is `E_USE_AFTER_MOVE`.
- `string` is immutable and shared, so it behaves as a value: there's no `.clone()` noise.

### 9.2 Parameter modes [D]

| Signature | Meaning | Call site |
|---|---|---|
| `x: T` | owned (moved, or copied if Copy) | `f(x)` |
| `mut x: T` | owned, mutable inside the callee | `f(x)` |
| `x: &T` | shared borrow | `f(x)`: implicit |
| `x: &mut T` | exclusive borrow | `f(x)`: needs a `var` binding |

Call sites never write `&`; the LSP shows hints. `&mut this` methods need a `var` receiver.

### 9.3 Borrows and scoped values (no lifetime syntax) [D]

1. Any number of shared borrows **or** exactly one mutable borrow may exist at a time.
2. A **scoped value** is any value that contains a borrow: `&T`, `&str`, `Slice[T]`, `Vec[&str]`, `Iterator[&T]`, or a closure with borrow captures.
3. Scoped values can be local variables, passed down to calls, and used in expressions. They **cannot** be:
   - stored in struct, union or record **fields** (field types may not contain borrows: `E_BORROW_IN_FIELD`),
   - stored in globals or `Ref`,
   - captured by value into escaping closures,
   - held across an un-awaited async call (§9.6).
4. A function may **return** a scoped value only when it derives from its receiver or borrowed parameters. The caller treats the result as borrowing from every borrowed argument (conservative, no annotations).
5. Each scoped value's set of owners is inferred inside the function body. Using an owner mutably while a scoped value derived from it is still live is an error.
6. To keep a value beyond its owner's scope, convert it to an owned one: `.to_str()`, `.to_vec()`, `.clone()`.
7. **Temporary extension:** when a `let` binds a scoped value that borrows from a temporary, the temporary lives until the end of the enclosing block. So `let name = (await io.read_line()).trim()` is valid.

```rust
let line = raw.trim()                 // &str borrowing `raw`
let parts = line.split(",")           // Vec[&str], scoped
let user = User { name: parts[0].to_str(), … }   // owned copy in a field
// or rely on the implicit &str → string copy (§7.2)
```

### 9.4 Closure captures and escaping [D]

| Capture | Written | Effect |
|---|---|---|
| implicit read | a free variable used without being listed | shared borrow (read-only) |
| by value | `#[x]` | moved, or copied if Copy |
| mutable borrow | `#[&mut x]` | exclusive borrow; `x` must be `var` |
| explicit read | `#[&x]` | same as implicit (allowed, lint: redundant) |

- **The capture list isn't exhaustive.** You list only what differs from the default (by-value captures and `&mut`); every other free local is borrowed read-only automatically.
- **A closure that holds any borrow is scoped** (§9.3). It may be called locally or passed to a `&(T) -> U` parameter.
- **An escaping closure** (returned, stored, sent to a task, or passed to `(T) -> U`) must hold only by-value captures. Otherwise it's `E_CLOSURE_ESCAPES_BORROW`, with a fix-it that adds `#[x]` for each implicitly borrowed local.
- Capturing a `Ref[T]` by value clones the handle.

```rust
fun apply(n: i32, f: &(i32) -> i32) -> i32 { f(n) }        // non-escaping
fun make_adder(n: i32) -> (i32) -> i32 { #[n]{ it + n } }   // escaping

limit := 50
high := nums.filter(#{ it > limit })        // implicit borrow
var total = 0
nums.for_each(#[&mut total]{ total += it })
```

### 9.5 Numbers [D]

- Implicit **lossless widening** is allowed: `i8→i16→i32→i64`, `uN→uM` (M > N), `uN→i(2N)`, `i32/u32→f64`, `f32→f64`. `int` widens to `i64` and narrows from nothing.
- Every other conversion is explicit:
  - `as` for truncating / saturating casts (when it isn't a plain type annotation, §3.3);
  - `.to_int()`, `.to_u8()` … for checked conversions, returning `Result`.
- **Overflow always panics**, in every build. Explicit alternatives: `.wrapping_add()`, `.saturating_add()`, `.checked_add() -> T?`. There is one behaviour for debug and release.

### 9.6 Async and concurrency [D]

- Calling `async fun f() -> T` **schedules the task immediately** on the work-stealing runtime and returns `Promise[T]`. There's no `spawn`, and call sites aren't coloured.
- `await p` suspends until `p` resolves. `main` may `await` without being declared `async`.
- `Promise` API:
  - `.then(#{…})`, `.catch(#{…})`;
  - `.ignore()`: fire and forget; errors and panics are logged; consumes the handle;
  - `Promise.all(Vec[Promise[T]]) -> Promise[Vec[T]]`;
  - `.timeout(ms) -> Promise[Result[T, Timeout]]`;
  - `.cancel()`, `.is_done()`.
- **One-shot promises:** `Promise.new.[T]() -> t(Promise[T], Resolver[T])`.
  - `resolver.resolve(v)` completes the promise; `resolve()` with no argument works for `void` (like `Ok()`).
  - If the resolver is dropped before resolving, the awaiter panics with `ResolverDropped`.
  - Use these for "I'm ready" signals and for request/response: put the resolver inside a `Queue` job.
- **Cancellation is cooperative.** `p.cancel()` asks the task to stop.
  - The task stops at its next `await` (or `runtime.yield()`), unwinding as a panic does (`Drop` runs, `recover` sees `Cancelled`).
  - Anyone awaiting a cancelled promise panics with `Cancelled`.
  - To cancel a task later, keep its handle; `.ignore()` gives the handle up.
- `time.after(ms) -> Promise[void]` is a cancel-safe timer for `select`.
- `runtime.yield()` hands control back to the scheduler cooperatively.
- **Borrows and await:** an async call with borrowed arguments or a borrowed receiver must be awaited in the same expression (`await client.receive()`). Storing such a Promise is `E_BORROW_ACROSS_SPAWN`; pass owned values or `Ref` handles instead.
- Thread safety comes from these rules plus `Ref`; there are no `Send`/`Sync` markers.

### 9.7 Interfaces: static and dynamic dispatch [D]

```rust
fun show_static[T: Stringer](x: &T) { … }   // monomorphized: zero cost
fun show_dyn(x: &Stringer) { … }            // dynamic: fat pointer (data + vtable)

let shapes: Vec[Shape] = [Circle { r: 1.0 }, Square { s: 2.0 }]   // owned interface values
```

**Dynamic values:**
- `&Inter` and `&mut Inter` are borrowed and never allocate.
- An owned `Inter` value (in a field, a Vec, or a return) is **boxed implicitly**.
- **Dyn safety** is checked at the use site: a method with its own generic parameters, or one that returns `Self` by value, can't be called through a dynamic value (`E_NOT_DYN_SAFE`).
- `std` uses the dynamic form, with no compiler intrinsics:

```rust
// std.log
pub fun println(...args: &Stringer) { … }   // args: Slice[&Stringer], no allocation
```

**Auto-generated implementations (on demand):** the compiler generates these for any type whose fields all support them, unless the user writes their own:

| Interface | Generated as |
|---|---|
| `Stringer.to_str()` | `User { id: 1, name: "Ted" }`, showing only fields visible at the call site's package |
| `Clone.clone()` | field-wise |
| `PartialEq.eq()` | field-wise |
| `Hash.hash()` | field-wise |

Generation only happens when the implementation is used, so unused code is never emitted.

### 9.8 Errors and panics [D]

- **Expected failures** use `Result` / `Option`, with `?`, `or`, `??` and truthiness.
- **Panics** come from `panic(msg)`, `assert(cond, msg)`, overflow, out-of-bounds indexing and failed unwraps.

A panic **unwinds to the nearest enclosing `recover` block**, the same way in every build:

```rust
let res = recover {                // Result[T, Panic]
    let items = [1, 3, 5]
    process(items, 10)             // panics deep inside: no Result drilling needed
}
let Err(p) = res else { … }
log.println(p.message, p.file, p.line, p.trace)   // origin of the panic is preserved
if p.kind == PanicKind.Deadlock { … }             // built-in kinds: §11 runtime panics; `panic(msg)` is PanicKind.User
```

- While unwinding, `Drop` runs for every owned value in the frames being unwound.
- **Poisoning:** a `var` that was mutably borrowed into a `recover` block that then panicked may be left half-updated, so it is marked **poisoned**.
  - Reading a poisoned value before re-assigning it is a compile error (`E_USE_OF_POISONED`) on every path where the panic branch is taken.
  - Assigning a fresh value clears the poison.
  - For a `Ref[T]` written by a panicking `update`, the poison is checked at runtime (the next access panics) until `.reset(v)` is called.
- A panic in an async task unwinds to the task boundary. The Promise is then **rejected**: `await` re-panics in the awaiting task, and `.catch(#{…})` handles it.
- A panic with no enclosing `recover` (in `main`, or in an `.ignore()`d task) prints the message and trace. The process then exits (`main`), or the task is dropped (`.ignore()`).
- There is no `defer`; cleanup uses `Drop.drop(mut this)` at scope exit.
- Use `Result` for errors a caller should handle, and panic + `recover` for "this request or job failed" boundaries (an HTTP handler, a CLI command, a task).

### 9.9 Heap and shared state [D]

| Type | Meaning | Key methods |
|---|---|---|
| `Box[T]` | unique heap allocation | `get()`, `set(v)` |
| `Ref[T]` | atomically ref-counted with an RwLock (many readers or one writer) | `get() -> T` (clone), `read(#{…})`, `update(#{ v => … })` (v: `&mut T`), `clone()`, `weak()` |
| `Weak[T]` | non-owning handle | `upgrade() -> Ref[T]?` |

### 9.10 Inter-task communication: Topic, Queue, Signal [D]

There are no raw channels. Three handle types cover the common patterns. Each is a cheap `Clone` handle that can be shared across tasks and threads, like `Ref`.

| | Delivers | No one listening | Full | Payload |
|---|---|---|---|---|
| `Topic[T]` | **every** subscriber gets each message | message dropped | per-subscriber buffer: oldest dropped, counted in `missed()`; **publish never waits** | cloned per subscriber (`T: Clone`) |
| `Queue[T]` | **one** subscriber per message: the one that has waited longest | buffered | **publish waits** for space (`try_publish` doesn't) | moved |
| `Signal[T]` | the **latest value**; watchers wake up on change | stays as the current value | n/a: overwritten | cloned on `get()` |

**The method rule:** an operation that may wait is `async`, and returns a Promise. Each has a `try_` twin that never waits.

API summary (signatures written informally as `receiver.method(…)`; all three types are in the prelude, `time.after` is in `std.time`):

```rust
// Topic: broadcast events
pub type TopicOptions = { buffer: int = 64, replay: int = 0 }   // replay: last N messages for new subscribers
Topic.new.[T]() -> Topic[T]
Topic.with.[T](opts: TopicOptions) -> Topic[T]
topic.publish(&this, v: T) -> int                     // sync, never waits; returns how many subscribers got it
topic.subscribe(&this) -> Subscription[T]
topic.subscribers(&this) -> int
topic.close(&this)                                    // subscribers drain, then see None (also on last-handle drop)

// Queue: work distribution (competing consumers)
pub type QueueOptions = { capacity: int = 1024 }
pub union PublishError[T] = { Full(T)  Closed(T) }    // the value is handed back
Queue.new.[T]() -> Queue[T]
Queue.with.[T](opts: QueueOptions) -> Queue[T]
async queue.publish(&this, v: T) -> Result[void, PublishError[T]]                     // waits for space
queue.try_publish(&this, v: T) -> Result[void, PublishError[T]]                       // Full if no space
async queue.publish_timeout(&this, v: T, ms: int) -> Result[void, PublishError[T]]    // Full on timeout
queue.subscribe(&this) -> Subscription[T]
queue.len(&this) -> int
queue.close(&this)

// shared by Topic and Queue
async sub.next(&mut this) -> T?          // None once closed and drained; cancel-safe; AsyncIterator[T]
sub.try_next(&mut this) -> T?
sub.missed(&mut this) -> int             // Topic: messages dropped since the last call (always 0 for Queue)
// dropping a Subscription unsubscribes

// Signal: shared state
Signal(v: T) -> Signal[T]
signal.get(&this) -> T                   // clone of the current value
signal.read[R](&this, f: &(&T) -> R) -> R
signal.set(&this, v: T)                  // notifies watchers (if T: PartialEq, only when the value changed)
signal.update(&this, f: &(&mut T) -> void)
signal.watch(&this) -> Watcher[T]
async watcher.next(&mut this) -> T?      // the latest value since this watcher last looked; intermediate values skipped
```

```rust
// broadcast: consume in another task. Looping on `sub` here while `room` is alive would hang:
// the loop ends only after close, and nothing could close it.
room := Topic.new.[Chat]()
printer := print_chats(room.subscribe())         // subscribe before publishing
room.publish(r{ from: 1, text: "hi" })
room.close()                                     // printer drains "hi", then its loop ends
await printer
// async fun print_chats(mut sub: Subscription[Chat]) { for await msg in sub { log.println(msg.text) } }

// work queue: each job reaches one worker; a fast worker simply takes more jobs
jobs := Queue.new.[Job]()
for i in 0..4 { worker(i, jobs.subscribe()).ignore() }
await jobs.publish(Job { id: 1 }) or e => log.warn("queue closed")

// request/response over a queue
let t(reply, resolver) = Promise.new.[Price]()
await jobs.publish(Job { id: 2, reply: resolver })
price := await reply

// state
online := Signal(0)
online.update(#{ n => n += 1 })
for await n in online.watch() { log.println("${n} online") }   // long-running: ends when the last Signal handle drops
```

**Closing and lifetime [D]:**
- A `Topic` or `Queue` closes explicitly with `close()`, or **automatically when its last handle is dropped**.
  - Subscriptions don't count as handles, so they don't keep it open.
  - After closing, `publish` fails (Topic: returns 0; Queue: `Err(Closed(v))`). Subscribers drain whatever is buffered, then `next()` returns `None`.
- A `Signal` behaves the same way: when its last handle drops, each `Watcher` returns its last unseen value (if any), then `None`. Watchers don't count as handles.
- So a loop such as `for await x in sub` ends only when the topic or queue is closed. If the **same task** still holds the handle and only closes it after the loop, the task waits on itself forever (`test/parser/tasks.ms`, `topics_hang`). Consume in a separate task, or close before the loop.

**Deadlock detection [D]:** the runtime panics with `Deadlock` when **every** task is waiting and nothing could wake any of them: no timers pending, no I/O registered, no foreign callbacks outstanding.
- The panic is raised in `main` and unwinds normally, so a `recover` in `main` can catch it.
- Its message lists each blocked task with the `await` site it's stuck on.
- Tasks waiting on I/O (a server's `accept()`) or on a timer are never treated as deadlocked. This check catches waits on Topic/Queue/Signal/Promise that only another task could complete, not every possible hang.
- The check is always on, in every build, like overflow and other panics.

**Picking one:**
- Did something happen, and does everyone need to know? Use a **Topic**.
- Does someone need to do this work? Use a **Queue**.
- What is it right now? Use a **Signal**.
- Is it a one-time answer? Use **`Promise.new()`**.
- Is it shared mutable data? Use **`Ref`**.

### 9.11 Introspection [D]

- `T._get_info()` and `value._get_info()` are compile-time intrinsics that return `TypeInfo { name, kind, fields }`, respecting call-site visibility.
- Names starting with `_` are reserved for intrinsics.
- `std.json` derives serialization from them; `impl Serializer for T` overrides it.

---

## 10. Prelude and std surface

### 10.1 Prelude

- **Types:** `Option`/`Some`/`None`/`nil`, `Result`/`Ok`/`Err`, `Promise`, `Resolver`, `Ref`, `Topic`, `Queue`, `Signal`, `Box`, `Weak`, `Vec`, `Map`, `Set`, `Array`, `Slice`, `Panic`, `PanicKind`.
- **Functions:** `assert`, `panic`.
- **`log`**: `log.println`, `log.print`, `log.warn`, `log.error`.
- **The core interfaces** in §10.2.

Bare `println` / `print` are **not** in the prelude: `import "std.io.{print, println}"`.

`Option` / `Result` helpers: `.or(v | #{…})`, `.is_some()`, `.is_none()`, `.is_ok()`, `.is_err()`, `.map(#{…})`, `.ok()`, `.err()`, `.unwrap()` (panics).

### 10.2 Core interfaces

```rust
inter Copy = {}
inter Clone = { fun clone(&this) -> Self }
inter Drop = { fun drop(mut this) }
inter Default = { fun default() -> Self }
inter Stringer = { fun to_str(&this) -> string }
inter PartialEq[T] = { fun eq(&this, o: &T) -> bool }
inter PartialOrd[T]: PartialEq[T] = { fun partial_cmp(&this, o: &T) -> Ordering? }
inter Hash = { fun hash(&this) -> u64 }
inter Add[R, O] = { fun add(&this, rhs: R) -> O }            // + Sub Mul Div Rem
inter AddAssign[R] = { fun add_assign(&mut this, rhs: R) }   // + Sub/Mul/Div/RemAssign
inter Index[I, T] = { fun index(&this, i: I) -> &T }
inter IndexMut[I, T] = { fun index_mut(&mut this, i: I) -> &mut T }
inter Iterator[T] = { fun next(&mut this) -> T? }
inter AsyncIterator[T] = { async fun next(&mut this) -> T? }      // `for await`
inter Iterable[T] = {
    fun iter(&this) -> Iterator[&T]
    fun iter_mut(&mut this) -> Iterator[&mut T]
    fun into_iter(this) -> Iterator[T]
}
```

`for x in c` uses `c.iter()`. Pipelines (`.map`, `.filter`, …) call `.iter()` implicitly.

### 10.3 std conventions [D]

**Naming:**
- `to_str()` converts anything to an owned `string`.
- `len()`, `has()`, `get() -> T?`.
- `at(i)` allows negative indices. `x[i]` panics when out of bounds.

**String processing returns views and doesn't fail:**

```rust
impl string {   // (shown on string; implemented once on &str)
    fun trim(&this) -> &str
    fun substring(&this, start: int, end: int) -> &str
    fun strip_prefix(&this, p: &str) -> &str          // returns self unchanged if absent
    fun strip_suffix(&this, s: &str) -> &str
    fun try_strip_prefix(&this, p: &str) -> &str?     // None if absent
    fun try_strip_suffix(&this, s: &str) -> &str?
    fun split(&this, sep: &str) -> Vec[&str]
    fun to_lower(&this) -> string                     // new owned string
    fun to_str(&this) -> string                       // owned copy
}
```

So `path.strip_suffix(".enc")` needs no `.or(path)`.

**Fallible parsing returns `Result`:**
- `json.parse.[T](s) -> Result[T, json.Error]`
- `"42".to_int() -> Result[int, ParseError]`

---

## 11. Diagnostics

| Code | Meaning |
|---|---|
| `E_UNMATCHED_DELIMITER` | missing or mismatched closer |
| `E_SIGIL_SHADOWS_BINDING` | sigil letter used while a binding of that name is visible |
| `E_ANGLE_GENERICS` | `Vec<T>` / `f<T>(x)`: fix-it `Vec[T]` / `f.[T](x)` |
| `E_ARROW_CLOSURE` | `(a) => …`, `fun(x) {}`: fix-it `#{ a => … }` |
| `E_CAPTURE_NOT_GLUED` | `#[x] {` |
| `E_IT_IN_NAMED_CLOSURE` | `it` used with named params |
| `E_NON_ASSOCIATIVE_OPERATOR` | `a < b < c` |
| `E_MIXED_NULLISH` | `a ?? b \|\| c` without parentheses |
| `E_USE_NULLISH` | `\|\|` used as a value fallback: fix-it `??` |
| `E_NOT_TRUTHY` | condition of a type other than bool/Option/Result |
| `E_INVALID_ASSIGNMENT_TARGET` | assignment to a non-place |
| `E_INVALID_PATTERN` | malformed pattern |
| `E_BARE_TUPLE` | `(a, b)`: fix-it `t(a, b)` |
| `E_BARE_BRACE_LITERAL` | `{ k: v }`: fix-it `_{}` / `r{}` / `m{}` |
| `E_TAGGED_RECORD_REMOVED` | `'1{…}`: fix-it `r{…}` |
| `E_STRUCT_LITERAL_IN_HEADER` | `if x == P { … }` |
| `E_RESERVED_OPERATOR` | `++`, `--`, `~` |
| `E_ATTRIBUTES_RESERVED` | `@attr` |
| `E_GLOBAL_VAR` | top-level `var` |
| `E_DUPLICATE_METHOD` | same method inline and in `impl` |
| `E_METHODS_ON_STRUCTURAL` | methods on a record alias |
| `E_AMBIGUOUS_IMPORT` | a name exported by two glob imports, then used |
| `E_CANNOT_INFER_STRUCT_TYPE` | `_{}` with no expected type |
| `E_CANNOT_INFER_GENERIC` | fix-it `.[T]` |
| `E_INVALID_BLOCK_VALUE` | block value doesn't match the expected type |
| `E_BORROW_IN_FIELD` | borrow type in a field declaration |
| `E_CLOSURE_ESCAPES_BORROW` | borrowing closure used as an escaping one |
| `E_BORROW_ACROSS_SPAWN` | un-awaited async call holding borrows |
| `E_NOT_DYN_SAFE` | generic / `Self`-returning method called on a dynamic value |
| `E_ORPHAN_IMPL` | `impl X for T` where neither `X` nor `T` is local |
| `E_INVALID_CAST` | `as T` that is neither a valid type annotation nor a numeric/pointer cast |
| `E_SELECT_ARM_NOT_PROMISE` | `select` arm expression is not a `Promise[T]` |
| `E_AWAIT_OUTSIDE_ASYNC` | `await` / `for await` / `select` outside an `async fun` or `main` |
| `E_SELECT_EMPTY` | `select { }` with no arms (parser) |
| `E_SELECT_ELSE_NOT_LAST` | `else` arm followed by other arms, or two `else` arms (parser) |
| `E_MISSING_FIELD` | struct literal omits a field that has no default and isn't optional |
| `E_USE_OF_POISONED` | value read after a caught panic, before re-assignment |
| `E_SCRIPT_IN_EVAL` | a `task` script called while `mod.ms` is being evaluated |

**Runtime panics** (`p.kind: PanicKind` as `recover` sees it; not compile-time diagnostics). Other kinds: `User` (`panic`, `assert`), `Overflow`, `OutOfBounds`, `Unwrap`.

| Kind | Raised when |
|---|---|
| `SelectExhausted` | every `select` arm is disabled and there is no `else` (§4.9) |
| `Cancelled` | awaiting a cancelled promise, or inside the cancelled task (§9.6) |
| `ResolverDropped` | a `Resolver` is dropped without resolving its promise (§9.6) |
| `Deadlock` | every task is waiting and nothing can wake any of them (§9.10) |

**Lexer and parser diagnostics** (exercised by `test/errors/`):

| Code | Meaning |
|---|---|
| `E_UNEXPECTED_TOKEN` | generic: a token that doesn't fit here |
| `E_UNTERMINATED_STRING` | `"` not closed before the end of the line |
| `E_UNTERMINATED_COMMENT` | `/*` not closed before EOF |
| `E_INVALID_ESCAPE` | unknown `\x` escape |
| `E_INVALID_NUMBER` | `.5`, `0x`, `0b102` |
| `E_INVALID_CHAR` | `'ab'`, `''` |
| `E_INVALID_RECORD_KEY` | record key that isn't an identifier or quoted identifier |
| `E_TOP_LEVEL_STATEMENT` | statement outside a function |
| `E_IMPORT_AFTER_ITEM` | `import` after the first item |
| `E_RESERVED_KEYWORD` | `while`, `loop`, … (with a hint: `for`) |
| `E_KEYWORD_AS_IDENT` | keyword used as a binding name |
| `E_OPEN_BRACE_NEWLINE` | declaration/control-flow `{` not on the header line |
| `E_LEADING_PIPE_UNION` | old `type X = \| A \| B` (fix-it: `union X = { A  B }`) |
| `E_INVALID_PARAM` | malformed parameter, e.g. `&items: T` |
| `E_UNKNOWN_RECEIVER` | `self`, `mut self` (fix-it: `this`) |
| `E_VARIADIC_NOT_LAST` | `...xs` followed by more parameters |
| `E_EXPECTED_COLON` | field or param missing `:` |
| `E_SHORT_DECL_TARGET` | `:=`/`:==` with a non-identifier left side, or `let x :=` |
| `E_CLOSURE_HEADER_LINE` | closure params (`a =>`) not on the closure's first line |
| `E_INVALID_CAPTURE` | capture that isn't `x`, `&x` or `&mut x` |
| `E_GENERIC_ARGS_NEWLINE` | `.[` at the start of a line |
| `E_EXPECTED_TYPE_ARGUMENTS` | empty `.[]` or `[]` type arguments |

---

## 12. Grammar summary (EBNF)

```text
file          = package_decl { import } { item } ;
package_decl  = "package" ident { "." ident } ;
import        = "import" [ "pub" ] STRING [ "as" ident ] ;   (* STRING: path[.item | .{a,b} | .*] *)

item          = [ "pub" ] ( fun_decl | type_decl | union_decl | inter_decl
                          | impl_decl | let_decl | extern_decl ) ;
generic_params= "[" generic_param { "," generic_param } [","] "]" ;
generic_param = ident [ ":" bound ] ;
bound         = type_path { "&" type_path } ;
impl_list     = ":" type_path { "," type_path } ;

fun_decl      = [ "async" ] "fun" ident [ generic_params ]
                "(" [ receiver [ "," ] ] [ params ] ")" [ "->" type ] block ;
receiver      = [ "&" [ "mut" ] | "mut" ] "this" ;
params        = param { "," param } [ "," ] ;
param         = [ "mut" ] ident ":" type | "..." ident ":" type ;

type_decl     = "type" ident [ generic_params ] [ impl_list ] "=" ( struct_body | type ) ;
struct_body   = "{" { ( field | method ) sep } "}" ;
field         = [ "pub" ] ident ":" type [ "=" expr ] ;
method        = [ "pub" ] fun_decl ;
union_decl    = "union" ident [ generic_params ] [ impl_list ] "=" "{" { ( variant | method ) sep } "}" ;
variant       = ident [ "(" type { "," type } ")" | "{" { field sep } "}" ] ;
inter_decl    = "inter" ident [ generic_params ] [ ":" bound ] "=" ( inter_body | bound ) ;
inter_body    = "{" { fun_sig sep } "}" ;
fun_sig       = [ "async" ] "fun" ident [ generic_params ] "(" [ receiver [","] ] [ params ] ")" [ "->" type ] [ block ] ;
impl_decl     = "impl" [ generic_params ] [ type_path { "," type_path } "for" ] type "{" { method } "}" ;
let_decl      = "let" ident [ ":" type ] "=" expr ;
extern_decl   = "extern" STRING "{" { [ "pub" ] fun_sig sep } "}" ;

block         = "{" { stmt } "}" ;
stmt          = let_stmt | var_stmt | short_decl | for_stmt | expr [ ";" ] ;
let_stmt      = "let" pattern [ ":" type ] "=" expr [ "else" block ] ;
var_stmt      = "var" ident [ ":" type ] "=" expr ;
short_decl    = ident ( ":=" | ":==" ) expr ;
for_stmt      = [ ident ":" ] "for" ( block
                                    | "let" pattern "=" expr block
                                    | [ "await" ] pattern [ "," pattern ] "in" expr block
                                    | expr block ) ;

expr          = pratt( prefix, infix, postfix ) ;      (* precedence §3 *)
primary       = literal | ident | "this" | "Self" | "(" expr ")"
              | vec_lit | array_lit | tuple_lit | record_lit | map_lit | set_lit
              | inferred_lit | struct_lit | closure
              | if_expr | match_expr | select_expr | "unsafe" block | "recover" block | block
              | "for" block                                   (* infinite for as an expression: `break value` *)
              | "return" [ expr ] | "break" [ ident ] [ expr ] | "continue" [ ident ] ;
postfix       = "." ( ident | INT ) | "?." ident | ".[" type_args "]"
              | "(" [ args ] ")" | "[" expr "]" | "?" ;
args          = arg { "," arg } [ "," ] ;
arg           = [ "..." ] expr ;
closure       = ( "#{" | "#[" [ capture { "," capture } ] "]{" ) [ closure_head "=>" ] { stmt } "}" ;
capture       = [ "&" [ "mut" ] ] ident ;
closure_head  = cparam { "," cparam } [ "->" type ] ;
cparam        = [ "mut" ] ident [ ":" type ] ;
if_expr       = "if" ( expr | "let" pattern "=" expr ) block [ "else" ( if_expr | block ) ] ;
match_expr    = "match" [ expr ] "{" { arm sep } "}" ;
arm           = ( pattern [ "if" expr ] | expr ) "=>" ( expr | block ) ;
select_expr   = "select" "{" { select_arm sep } [ "else" "=>" ( expr | block ) [ sep ] ] "}" ;
select_arm    = [ pattern "=" ] expr "=>" ( expr | block ) ;   (* `pattern =` present iff a depth-0 `=` precedes `=>` *)
or_tail       = "or" [ ident "=>" ] ( expr | block ) ;

sep           = "," | NEWLINE ;
```

---

## 13. Parser test corpus (minimum set)

The corpus lives in [`test/`](../test/README.md): `lexer/`, `parser/`, `errors/` (with inline `//~` diagnostics) and `programs/`. The cases below are the minimum set and are all covered there.

```rust
t.0.1    1..10   1..=10   ..5    1.to_str()
a[0]     a [0]   t(1)    t (1)   [1, 2]   x[0]
fun t[T]() {}    x.a[0]
Vec[Map[string, Vec[User?]]]
json.parse.[User](s)   Vec.[u8].new()   Box.[i32]{ value: 1 }
a<b   a < b   a>>b
'1{ id: 1 }              // E_TAGGED_RECORD_REMOVED
r{ a: 1 }   r"raw\n"
x.or(1)   x or 1   x or e => Err(e)
a ?? b ?? c   a?.b ?? "x"   a ?? b || c   // last: E_MIXED_NULLISH
x ??= 5
g := [] as Vec[Map[string, int]]   x as i32?   a as f64 / b as f64
await f()?   await f()?.name   (await f()).trim()
user?.name   (user?).name
if res { }   if !opt && flag { }
#{ it * 2 }   #{ it1 + it2 }   #{ x, y => x + y }   #{ x: i32 -> i32 => x * 2 }
#{ f() or e => log(e) }        // no header
#[n]{ it + n }   #[&mut total]{ total += it }   #[x] { }   // last: E_CAPTURE_NOT_GLUED
(a) => a                       // E_ARROW_CLOSURE
Vec<int>                       // E_ANGLE_GENERICS
type User: Stringer = { id: u64  fun to_str(&this) -> string { "u" } }
union P = { Cash  Card { n: string }  fun is_cash(&this) -> bool { true } }
import "std.io.*"   import "std.io.{print, println}"
for { }   for i < 3 { }   for x in xs { }   for k, v in m { }   for let Some(x) = it.next() { }
outer: for x in xs { break outer }
for await m in sub { }   for await ready() { }
select { Some(j) = q.next() => run(j), time.after(10) => idle(), else => skip() }
match { a > 1 => 1, _ => 0 }   match n { x if x > 5 => x, _ => 0 }
let t(w, h) = dims()   let Ok(v) = r else { return }
if x == P { }
let r = recover { risky() }
foo
(bar)                          // two statements
user
    .profile                   // one chain
```

Target: ≥ 60 tests before starting the type checker.

---

## 14. Back ends (goals)

- **JS:** first target, and the fastest feedback loop. It enables hot reload during development (including the planned Android UI framework), and serves as the interpreter for `mod.ms` (§17).
- **WASM, C (tiny-c), LLVM:** native targets sharing the same HIR.
- Panics lower to exceptions on JS, and to unwinding (landing pads / tables) on native targets.

---

## 15. Deferred (not in v0.2)

1. `any` and downcasting (`x.as_type.[User]()`).
2. Associated types, `where` clauses, const generic params beyond `Array[T, N]`.
3. Default params, named args, destructuring params.
4. Range indexing (`v[1..3] → Slice[T]`).
5. Expression-bodied functions.
6. Init-captures (`#[cfg = cfg.clone()]{…}`).
7. Attributes, macros, custom operators, trailing closures.
8. Unicode identifiers.
9. Width subtyping for records.
10. Positional struct construction.
11. Extension methods on foreign types.
12. Send arms in `select` (Go's `case ch <- v`); use `publish_timeout` / `try_publish` for now.
13. `select biased { }` (choose arms in order instead of at random).
14. Queue groups on Topics (`subscribe_group`), acknowledgements and redelivery.

---

## 16. Rewrites for existing docs and samples

| Old | New |
|---|---|
| `(n) => n * 2`, `fun(x) { … }` | `#{ it * 2 }`, `#{ x => … }` |
| `#[growable]{x => growable.push(x)}` | `#[&mut growable]{ x => growable.push(x) }` |
| `Vec<T>`, `fun f<T>`, `impl<T> X<T>` | `Vec[T]`, `fun f[T]`, `impl[T] X[T]` |
| `json.parse<T>(s)`, `parse::<T>(s)` | `json.parse.[T](s)`, which returns `Result` |
| `type R = \| Ok(T) \| Err(E)` | `union R = { Ok(T)  Err(E) }` |
| `type User = {…}` + `impl User {…}` | either (inline methods preferred for simple types) |
| `'1{ … }` | `r{ … }` |
| `while c {}`, `loop {}`, `while let` | `for c {}`, `for {}`, `for let` |
| `match age { age > 18 => … }` | `match { age > 18 => … }` |
| `` r`C:\x` `` | `r"C:\x"` |
| `v[1, 2]` | `[1, 2]` |
| `x.to_string()` | `x.to_str()` |
| `path.strip_suffix(".enc").or(path)` | `path.strip_suffix(".enc")` |
| `raw.or("x")`, `if res.is_ok()` | `raw ?? "x"`, `if res` |
| `let (w, h)`, `-> (int, int)` | `let t(w, h)`, `-> t(int, int)` |
| `{ host, port }` | `_{ host, port }` |
| `int32`, `List<T>`, `mut self` | `i32`, `Vec[T]`, `mut this` |
| `println(…)` (no import) | `log.println(…)`, or `import "std.io.println"` |
| `and`, `not`, `none` | `&&`, `!`, `None`/`nil` |
| `ms.json` | `mod.ms` |

---

## 17. Project file: `mod.ms` [D]

A project has **one** configuration file at its root, `mod.ms`. It replaces `ms.json`, and holds:
- the project metadata;
- dependencies;
- scripts (`ms run dev`);
- every tool's settings (build, fmt, lint, test, LSP, bundler, and third-party tools).

This keeps the project root free of per-tool config files. There is also one generated, machine-owned `mod.lock`. `ms config` prints the resolved `Config` as JSON.

### 17.1 Shape

```rust
package mod

import "build.*"                    // toolchain API: Config, Script, sh, task, pkg, target, Os …
import "ms.fmt"                     // first-party tools (version comes with the toolchain)
import "ms.test"
import "acme.lint@^1.2"             // third-party tool: version pinned in the import

pub fun config() -> Config {
    var c = Config {
        name: "sample1"
        version: "1.0.1"
        main: "./src"                                   // optional (§17.6)

        deps: m{
            "http": "^2.1.0"                            // registry, semver range
            "utils": "path:../utils"                    // local package
            "orm": "git:github.com/acme/orm#v0.4.1"     // git tag / rev
        }

        scripts: m{
            "dev":     sh("ms build --target js --watch --hot")
            "test":    sh("ms test --parallel")
            "migrate": pkg("./tools/migrate")           // runs that package's main(args)
            "release": task(#{ args =>
                run("ms test")?
                run("ms build --target native --release")?
                Ok()
            })
        }
    }

    if target.os == Os.Android {                        // per-platform deps
        c.deps["android.ui"] = "^0.3.0"
    }

    c.tools([                                           // tool pipeline (§17.4)
        fmt.setup(_{ indent: 4 }),
        test.setup(_{ parallel: true }),
        lint.setup(_{ strict: true, warn: ["L_IMPLICIT_STR_COPY"] }),
    ])
}
```

### 17.2 The `Config` type

```rust
// package build
pub type Config = {
    pub name: string                          // required
    pub version: string                       // required (semver)
    pub main: string?                         // default: §17.6
    pub deps: Map[string, string] = m{}
    pub dev_deps: Map[string, string] = m{}
    pub scripts: Map[string, Script] = m{}
    sections: Map[string, json.Value] = m{}   // tool settings, via the methods below

    pub fun tools(mut this, ts: Vec[Tool]) -> Config { … }    // applies each tool in order
    pub fun set_section[T](&mut this, name: string, value: T) { … }
    pub fun section[T](&this, name: string) -> Result[T, json.Error] { … }
    pub fun raw_section(&this, name: string) -> json.Value? { … }
}
pub type Tool = (Config) -> Config
```

**Why these choices:**

- **`name` and `version` are separate named fields**, not positional `new(name, version)` arguments. A struct literal is self-describing, field defaults (§7.3) let you skip what you don't need, and `ms config` can print it as-is.
- **Dependencies are a `Map[string, string]`** (package to source spec), not `Vec[t(string, string)]`:
  - keys are unique, so a duplicate dependency is impossible;
  - tools can do lookups (`c.deps.has("http")`);
  - it prints as a plain JSON object.
  - The value is a semver range (`"^2.1.0"`) or a prefixed source (`"path:…"`, `"git:…#rev"`), like npm. Everything fits in one string, and the toolchain validates the format (`E_BAD_DEP_SPEC`).
  - Per-platform or conditional dependencies are ordinary code (`if target.os == …`), so no special syntax is needed.

### 17.3 Scripts: `ms run <name>`

```rust
pub union Script = {
    Shell(string)                              // sh("…"): runs a shell command line
    Package(string)                            // pkg("./tools/migrate"): runs that package's main
    Task((&Args) -> Result[void, string])      // task(#{…}): inline MinScript
}
pub fun sh(cmd: string) -> Script { Shell(cmd) }                  // declares a shell script
pub fun run(cmd: string) -> Result[void, string] { … }           // executes a command now (inside a task)
```

```bash
ms run dev
ms run migrate -- --steps 2      # everything after `--` is passed as Args
ms dev                           # shorthand, when `dev` isn't a built-in command
ms run                           # lists the available scripts
```

- **Evaluation is separate from execution.** Working out the script list (evaluating `config()`) is sandboxed (§17.5). A script body runs **only** when invoked by `ms run`, with normal permissions (fs, net, processes). Calling a `task` during evaluation is `E_SCRIPT_IN_EVAL`.
- **`Package` scripts** are the preferred form for anything substantial, such as migrations or seeding. The code lives in a normal package with its own imports and dependencies, and `mod.ms` stays small.
- Tools may register scripts too: `lint.setup` can add `scripts["lint"]`, which makes `ms run lint` available.

### 17.4 Tool sections and the pipeline

- A tool is an escaping function `Config -> Config`.
- `c.tools([...])` applies the tools **in order**. Each one reads the current `Config`, writes its own section, may read other tools' sections, may add scripts, and returns the result.

```rust
// package ms.fmt
pub type Options = {
    indent: int = 4
    max_width: int = 100
    trailing_commas: bool = true
}

pub fun setup(o: Options) -> Tool {
    #[o]{ mut c =>
        c.set_section("fmt", o)
        c
    }
}

// inside the fmt tool at run time:
let opts = cfg.section.[Options]("fmt") ?? Options {}   // all defaults
```

**Section format:** neither `(string, any)` nor `Map[string, string]`. The signatures are

```rust
set_section[T](name: string, value: T)
section[T](name: string) -> Result[T, json.Error]
```

- **Typed in and out:** each tool reads back its own `Options` type, with no string parsing and no `any`.
- **Stored as a `json.Value` tree:** values are serialized with the auto-derived serializer (`_get_info()`, §9.11). That gives `ms config` a natural JSON output.
- **Cross-tool reads:**
  - Reading another tool's section with its type means importing that tool's package (`c.section.[lint.Options]("lint")`).
  - Without the import, `raw_section("lint")` gives the untyped `json.Value`.
  - The section name is, by convention, the tool's package name. Two tools writing the same section is `E_SECTION_CONFLICT` at evaluation time.

### 17.5 Evaluation rules

- `config()` runs in a **sandboxed, deterministic interpreter** (the JS back end). It has no network, no file writes and no processes. It may read `target`, `env` and files under the project root.
- The result is cached by a hash of `mod.ms`, `mod.lock`, `target` and the env vars that were read. The LSP re-evaluates only when these change.
- **Bootstrapping:**
  - Packages imported by `mod.ms` itself (tools) carry their version in the import string (`"acme.lint@^1.2"`), so the toolchain can fetch them **without evaluating the file first**.
  - `ms.*` tools are versioned with the toolchain.
  - Ordinary dependencies go in `deps`.

### 17.6 Entry point

- `main` (from `Config.main`) is the folder holding `package main`.
- If it's omitted, the toolchain uses `./src` when that folder exists, and the project root otherwise.

---

## 18. Open questions

| # | Question | Default used |
|---|---|---|
| 1 | Implicit boxing of owned interface values (`Vec[Shape]`) | yes |
| 2 | Should truthiness be user-implementable (a `Truthy` interface)? | no: built-in for bool/Option/Result only |
| 3 | `int` on the JS back end: i32 or f64-safe 53-bit | i32 |
| 4 | Field defaults (§7.3): only literals/const expressions, or any expression? | any expression, evaluated per construction |
| 5 | Dependency spec prefixes beyond `path:` / `git:` (e.g. `url:`, workspace members) | only `path:` and `git:` in v0.2 |
| 6 | Workspaces / monorepos: several projects under one `mod.ms` | deferred |
| 7 | Script dependencies (`"build"` runs `"gen"` first) | written in code inside a `task` for now |
| 8 | Handle types (`Ref`, `Topic`, `Queue`, `Signal`, `ws.Writer`) are cloned constantly. Should passing one by value clone it implicitly, as `Copy` does? | not yet: explicit `.clone()`, revisit after the hub example |
| 9 | Default `Topic` buffer (64) and `Queue` capacity (1024) | as stated |
| 10 | `Ref.read` / `update` return the closure's value (`read[R](f: &(&T) -> R) -> R`) | yes, matching `Signal.read` |
| 11 | Unqualified variant construction through the expected type (`send(Text("hi"))` when `Message` is expected) | not yet: qualify (`ws.Message.Text`) |
| 12 | Does `map[k] = v` insert a missing key, or panic? | insert (`IndexMut` on Map inserts); `map[k]` *read* panics |
| 13 | Should the compiler also warn (a lint) when a task loops over a subscription to a Topic/Queue whose handle it holds and closes only after the loop? | not yet: the runtime `Deadlock` panic covers the single-task case |
| 14 | Should `Deadlock` be catchable by `recover`, or always abort the process? | catchable in `main`, like any panic |

**Resolved in this revision:**
- implicit `&str → string` copies, with a configurable lint;
- poisoning after `recover`;
- auto `to_str()` shows every field visible at the call site;
- inherent `impl` blocks live in the type's package (any file);
- default method bodies are allowed in `inter`;
- `Config` replaces `Project`.
