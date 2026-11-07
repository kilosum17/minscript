# MinScript Syntax Decisions (Draft 0.1)

Goal: a deterministic, hand-written lexer + recursive-descent/Pratt parser (TypeScript frontend), no backtracking, no trait-resolution during parsing. Parsing stays purely syntactic. Name resolution, borrow rules, inference and comptime live in later passes.

Legend:
- **[D]** decided by you
- **[R]** my recommendation, confirm or override
- **[?]** open question, I give a default so work can continue

---

## 0. Decisions already made (applied throughout)

| Topic | Decision |
|---|---|
| Interface keyword | `inter` only |
| Return arrow | `->` only (never `:`) |
| Param forms | `name: T`, `name: &T`, `name: &mut T`; `mut name: T` for an owned, mutable local |
| Int alias | `int` = `i32` |
| Bindings | `:=` is sugar for `let`, `:==` is sugar for `var` |
| Absent value | `None` (prelude), `nil` (keyword alias of `None`). No lowercase `none`. |
| Variants | `Ok(x)` and `Result.Ok(x)` are both legal (prelude exports) |
| Modules | `package` only (no `namespace`). Imports always quoted: `import "std.log"` |
| String types | `string` = owned immutable string. `&str` = alias of `Slice<u8>`. `char`, `byte` and other basics get defined (see 7.4). |
| "No coloring" | No `spawn`/`launch`. Calling an async function enqueues it and returns `Promise<T>`; `await` consumes it. |
| Parser | Hand-written, not Lezer |
| Sigils | `r{ m{ s{ a[ t(` etc. are single tokens (glued, no whitespace) |
| Tag | `'1{` is the canonical tagged-record opener |
| Comments | `//`, `/* */` |
| Closures | `#{it}`, `#{a, b => ...}`, `(a) => ...`. No `fun(){}`. Captures via `#[...]` |
| Blocks | Last expression without `;` is the block's value. A trailing `;` makes it a statement (value discarded). |
| `or` | Keyword that unwraps or diverges, see 4.3 |

---

## 1. Lexical structure

### 1.1 Source and trivia [R]
- UTF-8, LF or CRLF (normalize to LF), strip BOM. Tabs allowed.
- Comments: `//` line, `/* */` **nestable**, `///` doc comment (kept as a token for tooling).
- Every token carries: `kind`, `span`, `ws_before` (bool), `nl_before` (bool), and for openers, the index of its matching closer (computed by the lexer, gives O(1) lookahead for closure detection).
- Comments are trivia, kept in a side list for the formatter and LSP.

### 1.2 Identifiers [R]
- `[A-Za-z_][A-Za-z0-9_]*` (ASCII for v1; Unicode later).
- A lone `_` is the wildcard, never a binding name.
- Convention (linter, not parser): types and variants `PascalCase`, everything else `snake_case`. Your examples mix `calculateArea` and `get_email`; pick snake_case.
- **Semantic exception:** in patterns, an identifier starting with an uppercase letter is a constructor/constant path, lowercase is a new binding (see 6).

### 1.3 Reserved words [D + R]

```
Declarations:  package import pub type inter impl fun async let var mut extern
Control:       if else match for in while loop break continue return
Expressions:   await or as unsafe recover true false nil this Self
Types:         TypeOf  (only special type-level form, see 7.6)
Reserved ids:  it, and it<N> for any positive integer N (it1 == it)
Reserved sym:  @ (attributes, future)
```

- **`it1..it20` cap [R]:** don't cap at 20. Reserve the pattern `it` or `it` followed by digits with no leading zero. A closure using `itK` where K exceeds the callee's arity is a type error, not a lexer limit.
- `assert`, `panic`, `Ok`, `Err`, `Some`, `None`, `Result`, `Option`, `Ref`, `Box`, `Weak` are **prelude names**, not keywords (shadowable in theory, linted).
- `async` stays as a **declaration modifier** (`pub async fun`) because the compiler must know to build a state machine and the declared `-> T` becomes `Promise<T>` at call sites. This does not contradict "no coloring", which concerns call sites.
- `main` may contain `await` whether or not it is written `async` [R].
- **Keywords after `.` or `?.` lex as plain identifiers** [R]. This makes `x.or(5)`, `x.as<T>()`, `x.in(..)` legal. The lexer only needs the previous token.

### 1.4 Literals

**Integers [R]:** `123`, `1_000`, `0xFF`, `0b1010`, `0o17`. No suffixes (use `as u16` or inference from the expected type). Untyped literal defaults to `int` (= `i32`) when there is no expected type. An out-of-range literal is a compile error asking for an annotation, never silent widening.

**Floats [R]:** `1.5`, `1e9`, `2.5e-3`, `1_000.5`. No `.5` or `5.`. Default type `f64`; adopts `f32` when the expected type is `f32`.

**Number lexing rules (important):**
1. After a digit run, `.` is part of the number only if followed by a digit. So `1..10` lexes as `1`, `..`, `10`, and `1.to_string()` is `1` `.` `to_string`.
2. **Tuple index:** if the previous token is a member-dot, lex only digits (no fraction). So `t.0.1` becomes `t` `.` `0` `.` `1`. The lexer does not need types for this, just one token of lookbehind. (You were right that it isn't a problem.)

**Bools / nil:** `true`, `false`, `nil`.

**Chars [R]:** `'a'`, `'\n'`, `'\u{1F600}'`. Type `char` = Unicode scalar value.

**Strings:**
- `"..."` single-line, escapes `\n \r \t \0 \\ \" \' \$ \xNN \u{...}`, interpolation `${expr}`. Nested strings inside `${}` allowed (lexer keeps a mode stack: string / interpolation with brace depth).
- `"""..."""` **multi-line** [R], interpolation and escapes active, common leading indentation stripped, first newline after the opener dropped.
- ``r`...` `` **raw** [D, adapted]: no escapes, no interpolation, may span lines, cannot contain a backtick (use `"""` then). The `r` is glued to the backtick, so it joins the sigil family.
- Plain `"..."` may NOT span lines (an unterminated string errors at the end of the line, which gives far better recovery).

### 1.5 Glued sigil tokens [D]

These are lexed as single tokens, only when there is **no whitespace** between letter and opener and the letter is not the tail of a longer identifier.

| Token | Meaning | Position |
|---|---|---|
| `r{` | record literal / record type | expr, type |
| `m{` | map literal | expr |
| `s{` | set literal | expr |
| `t(` | tuple literal / tuple type / tuple pattern | expr, type, pattern |
| `a[` | fixed array literal | expr |
| `_{` | context-inferred struct/record literal (also valid in patterns later) | expr |
| `'1{` | tagged record literal (`'` + digits + `{`) | expr |
| `#{` | closure, implicit params | expr |
| `#[` | closure capture list | expr |
| ``r` `` | raw string | expr |

Notes:
- You wrote `t{` in your message. I assumed you mean `t(` (tuple) and that no `t{` exists, see 7.3. Tell me if you intended otherwise.
- `'1{` vs char `'1'`: after `'`, if the pattern `'<char>'` matches it's a char literal, otherwise `'<digits>{` is a tag token. No lifetimes or loop labels use `'`, so no other conflicts (loop labels use `name:`, see 9).

**Your question: do the sigils force removing `r m s t a` as variable names?**

The problem is real: `a[0]` is both "index variable `a`" and "one-element array literal", and `t(1)` is both "call function `t`" and "tuple". Because the sigil rule is lexical, `a[0]` silently becomes an array literal.

| Option | Effect | Verdict |
|---|---|---|
| A. Keep letters legal as identifiers; sigil only when glued; resolver errors if a sigil literal letter matches a visible binding | `(a, b) => a + b` keeps working. `a[0]` with a variable `a` is an error with the hint "write `a [0]` or rename". | **[R]** |
| B. Reserve `r m s t a` as identifiers entirely | Simplest, but kills `a`, `b` style names (`(a, b) => a + b` appears in your own docs) | no |
| C. Non-letter sigils (`@[`, `%{`) | No collisions at all | only if you ever regret letters |

Option A costs one resolver check (error `E_SIGIL_SHADOWS_BINDING`) and no lexer state.

### 1.6 Generics and `>>`: token splitting explained

Problem: max-munch lexing turns `Vec<Promise<T>>` into `Vec` `<` `Promise` `<` `T` `>>`, and `>>` is a shift operator. Same for `>=` in `let x: Vec<int>= ...` and `>>=`.

Token splitting is **not slow**: it is O(1) per use. When the type parser needs a `>` and the current token is `>>`, `>=` or `>>=`, it replaces the current token in place with the remainder (`>`, `=`, `>=`) and carries on. No re-lexing, no backtracking. Rust and Swift both do something like this.

| Option | How | Cost | Verdict |
|---|---|---|---|
| 1. Parser-driven splitting | Lexer stays context-free. Type-arg parser splits `>>`/`>=`/`>>=` on demand | one small function | **[R]** |
| 2. Never lex `>>`: lexer emits single `>` tokens with an "adjacent to next" flag. The expression parser fuses two adjacent `>` into shift | no splitting, but the expression parser fuses | fine, slightly more Pratt code | alternative |
| 3. Lexer tracks generic depth | context-sensitive lexer | fragile with expressions | no |

### 1.7 Generic arguments at call sites: the no-whitespace rule [D, specified]

Rule (purely token-flag based, no backtracking):

> In **expression position**, a `<` with `ws_before == false` that directly follows an identifier (or a path segment, or a method name after `.`) **always** begins type arguments. A `<` with whitespace before it is a comparison.

- `json.parse<Config>(s)`, `List.new<u8>()`, `x.as<T>()`: type args.
- `a < b`, `a <b`: comparison.
- `i<n`: error with the fix-it "add spaces around comparison `<`" (the formatter always writes spaces).
- After the closing `>` the next token must be `(` (call), `{` (struct literal) or `.` (static member), else error.
- In **type position** `<` is always type arguments, no whitespace restriction.
- Type args may contain types and integer literals (`Array<i32, 4>`).
- This avoids `::` turbofish clutter, as you wanted.

---

## 2. Newlines, semicolons, whitespace

You have no required semicolons, so the parser must decide where statements end. Rules **[R]**:

**R1. Tokens carry `nl_before`; the parser decides.** No virtual `;` tokens.

**R2. A statement ends at an explicit `;`, at a newline, or before `}` / EOF.** A newline does NOT end a statement when:
- the previous token is one of: a binary operator, `,`, `.`, `?.`, `(`, `[`, `{`, `=`, `:=`, `:==`, `=>`, `->`, `:`, `|`, `as`, `or`, `await`, `mut`, `&`, `!`, `-` (unary or binary) etc. (anything that cannot end an expression), OR
- the next token is one of: `.`, `?.`, `&&`, `||`, `or`, `as`, `else`, `)`, `]`, `}`, `=>`, `->`, `|` in a type or match context.

**R3. A newline DOES end the statement** (new statement starts) when the next line begins with `(`, `[`, `{`, `-`, `+`, `*`, `&`, `<` or `!`. Operators of that kind must be written at the **end** of the continued line. This kills the classic `a\n(b)` and `a\n[b]` bugs.

**R4.** Postfix `(` call, `[` index, and glued `<` are only accepted when `nl_before == false`. Postfix `.` and `?.` are accepted across a newline (method chains).

**R5.** Inside `(...)` and `[...]` newlines are ignored, except inside a nested `{...}` block, where they matter again. Keep a delimiter stack in the lexer.

**R6.** `return`, `break`, `continue` followed by a terminator (newline, `;`, `}`) take no value.

**R7.** Opening `{` of `fun`, `if`, `else`, `for`, `while`, `loop`, `match`, `impl`, `inter`, `type` must be on the same line as its header (K&R). Relaxing later is backward compatible.

**R8. Semicolons are meaningful in one place:** a trailing `;` after the last expression of a block discards its value. The formatter may strip `;` everywhere **except** that position. (You said "mostly stripped", so this is the exception that matters.) A newline never discards the value, only `;` does.

```
fun a() -> int { 5 }      // value 5
fun b() { foo() }         // last expr value discarded implicitly when return type is void
fun c() -> int { 5; }     // error: block yields void
```

**R9.** Whitespace-sensitive tokens (flag `ws_before` / glued checks): sigil openers, generic `<`, postfix `?` and `?.` (must touch the preceding token), `#{`, `#[`.

---

## 3. Operators and precedence

Tightest to loosest:

| # | Operators | Assoc | Notes |
|---|---|---|---|
| 1 | postfix: `.x` `?.x` `(args)` `[i]` `<T>`(glued) `?` | left | `?` propagates, `?.` optional-chains (3.2) |
| 2 | prefix: `-` `!` `await` | right | `await` has a special rule (3.1). Unary `&` / `*` exist only for unsafe/raw pointers: borrows are implicit at call sites. |
| 3 | `as T` | left | |
| 4 | `*` `/` `%` | left | |
| 5 | `+` `-` | left | |
| 6 | `<<` `>>` | left | |
| 7 | `&` | left | bitwise, Rust ordering (not C's) |
| 8 | `^` | left | |
| 9 | `\|` | left | |
| 10 | `==` `!=` `<` `<=` `>` `>=` | none | non-associative |
| 11 | `&&` | left | |
| 12 | `\|\|` | left | |
| 13 | `..` `..=` | none | ranges |
| 14 | `or` | left | see 4.3 |
| 15 | `=` `+=` `-=` `*=` `/=` `%=` | right | assignment is an expression of type void (so `#{ n => n += 10 }` works) |

`return`, `break`, `continue` are expressions of type never, so `x or return` is valid.

### 3.1 `await` and `?` [R]

Your docs write `await f()?` meaning `(await f())?`. A plain prefix `await` would parse it as `await (f()?)`. Rule:

> `await`'s operand is a postfix chain **up to (not including)** the first `?` or `?.`. After building the await node, the postfix loop continues (so `?`, `?.`, `.m()` apply to the awaited result).

So `await read_file(p)?` = `(await read_file(p))?` and `await get_user()?.name` = `((await get_user())?.name)`. A method call on the result still wants parentheses: `(await f()).trim()`, as in your example.

### 3.2 `?` versus `?.` [R]

Your doc uses `?` for early-return propagation AND optional chaining. These are different semantics, so make them different tokens:
- `x?` (glued): if `Err`/`None`, **return from the enclosing function/closure**; else unwrap.
- `x?.name` (token `?.`): if `None`/`Err`, the **whole chain evaluates to `None`**, no return; else continue. Result is `Option<...>`.
- To propagate and then access a member: `(x?).name`.
- In type position `T?` is `Option<T>`, binding greedily: `x as i32?` means `x as Option<i32>`.

---

## 4. Expressions

### 4.1 Blocks and value flow [D]
- Any `{ ... }` block (function, closure, `if`, `match` arm, `or`, `unsafe`, `recover`) yields its last expression if it has no trailing `;`.
- `return` stays available for early exit and nowhere requires it.
- `if` without `else` is void; branch values are discarded.
- `if`/`match` with all branches are expressions.
- For void functions/closures, a non-void last expression is discarded rather than an error (so `forEach(#{ v.push(it) })` works). A lint can warn on discarded `Result`.

### 4.2 Bare `{` is only ever a block [R]
No bare `{ ... }` map/record/struct literal exists. Maps are `m{}`, records `r{}`, inferred literals `_{}`, structs `Name { }`. This eliminates block/literal ambiguity. Struct literal `Name { f: v }` is **disallowed in header position** of `if`, `while`, `for ... in`, and `match` (wrap in parens if needed), the Rust rule.

### 4.3 `or` [D, specified]

```
expr or RHS
expr or name => RHS        // optional named binding of the error, instead of `it`
```

- If `expr` is `Ok(v)`/`Some(v)`: the whole `or` expression evaluates to `v`.
- If `expr` is `Err(e)`/`None`: RHS is evaluated and **returned from the enclosing function or closure** (that's the "or is a way to define returns" rule). No `return` keyword is needed but `or return X` is also legal.
- RHS may be an expression, a `{ block }` (its last expression is the return value, a trailing `;` makes it return void), or `return ...`/`break`/`continue`.
- `it` is bound to the `Err` payload inside RHS (void/unavailable for `Option`).
- If `or` appears inside a closure, "enclosing function" means the closure. In a nested `#{}` closure, `it` in an `or` RHS shadows the closure's `it` (innermost wins; warn). Use `or e => ...` to avoid the clash.
- `.or(x)` and `.or(#{...})` are ordinary methods (value fallback, no return). The lexer rule "keyword after `.` is an identifier" is what keeps them apart.
- Precedence: below `..`, above assignment. `let n = await f() or Err(it)` parses as `(await f()) or Err(it)`.
- `or` is not `||`; both exist (`||` is boolean).

### 4.4 Literal forms [D]

```
r{ a: 1, b: "x", ...base }      // record: ident (or quoted ident) keys, shorthand `r{ a, b }`, spread
m{ "k": 1, expr: v }            // map: key is an EXPRESSION
s{ 1, 2, 3 }                    // set
t(1, "a", 2.5)                  // tuple; t(1) one-tuple; t() unit
a[1, 2, 3]                      // fixed array
[1, 2, 3]                       // Vec
'1{ id: 1, name: "x" }          // tagged record
_{ host, port }                 // inferred struct/record (type from expected type)
Name { f: 1, g }                // named struct literal, shorthand allowed
Name(1, 2, 3)                   // positional construction (all fields visible)
```

- Trailing commas allowed everywhere. Newlines separate elements as well as commas.
- `...expr` spread allowed in `r{}`, `Name {}`, `_{}` and `[]` (token `...` is distinct from `..`).
- `_{...}` needs an expected type (param type, annotation, return type, field type). Otherwise error `cannot infer type for _{}`. This replaces your bare `configure_server({ host, port })` and replaces default/named-argument syntax. **Recommendation:** no default parameter values and no named arguments in v1, `_{}` is the named-args story.
- Parens mean grouping only. **There is no bare `(a, b)` tuple** [R]. Use `t(a, b)` in expressions, types and patterns. This removes the `(a, b) =>` vs tuple ambiguity completely.

### 4.5 Closures [D, with one recommendation]

| Form | Params | Body |
|---|---|---|
| `#{ it * 2 }` | implicit `it`, `it1`, `it2`, ... (`it` == `it1`) | block contents |
| `#{ n, idx => n + idx }` | named, no parens, no types | block contents |
| `(a, b) => expr` | parens required, optional `: T` per param | expression |
| `(a, b) => { ...; value }` | same | block |
| `(a: i32) -> i32 => expr_or_block` | optional return type [R] | expr or block |
| `#[x, y]{ ... }` / `#[x](a) => ...` | explicit capture list prefix [R] | |

- Remove `fun(x) {}` [D]. Remove bare `[x](a) => ...` [R]: a leading `[` is also a Vec literal/index and would need unbounded lookahead. A single `#[...]` prefix works for both closure styles.
- Detecting `(`...`)` as a closure: the lexer precomputed the matching `)`. If the token after it is `=>` or `->`, it is a closure. O(1), no backtracking.
- `it` is not usable inside a named-param closure (error). In nested `#{}` closures the innermost `it` wins; use the named form to reach the outer value.
- Escaping closures must list captures explicitly (`#[x]`), non-escaping ones capture read-only: semantic pass.
- A mixed form `#{ it, x => ...}` is an error.
- No trailing-closure syntax in v1: closure is always an argument inside `( )`.

### 4.6 Other expressions
- `if c { } else if c { } else { }`, `match v { pat [if guard] => expr_or_block [,|newline] ... }`.
- `unsafe { }`, `recover { }` are keyword blocks (whitespace before `{` allowed).
- Ranges `a..b`, `a..=b`, and open forms `..b`, `a..` where an index/slice context needs them [?].
- `x as T` numeric/pointer cast. Implicit promotion is C-like, demotions need `as` or `.to_int()`-style methods [?: pick one or both].
- Interpolation `"${expr}"` only (no bare `$name`).

---

## 5. Statements

```
let pat [: T] = expr [else { diverging block }]
var name [: T] = expr
name := expr         // = let name = expr
name :== expr        // = var name = expr
place = expr         // assignment, never declares
expr [;]
```

- `:=` and `:==` accept only a plain identifier on the left in v1 [R] (no type annotation, no patterns). Use `let` for anything richer.
- A bare `x = 20` where `x` is undeclared is an error (your doc example `local_no = 20` needs `let`/`:=`).
- `let ... else`: pattern may be refutable; the `else` block must diverge.
- Add `if let pat = expr { }` and `while let pat = expr { }` [R]. Cheap, symmetrical with `let ... else`.
- Loops: `for pat in expr { }`, `for a, b in expr { }`, `while cond { }`, `loop { }`, with `break [value]` only from `loop`.
- Labels [R]: `outer: for ... { break outer }` (no `'`, avoids char/tag clash). Optional, can defer.

---

## 6. Patterns

```
literal           1  "a"  true  nil  'c'
wildcard          _
binding           lower_ident            // lowercase = new binding
constructor path  Cash  PaymentMethod.Cash  None   // Uppercase = variant/const, error if unresolved
payload           Ok(p)  Some(p)  Variant(p, q)
struct-like       Variant { a, b: p, .. }   Type { a, .. }
tuple             t(p, q, ..)
or                p | q                      // top level of an arm, or inside parens
range             1..=5
```

- The Upper/lower rule makes the parser deterministic and the resolver simple.
- Unqualified variants resolve through (1) prelude, (2) the scrutinee's type in `match`, per your example.
- No `&` patterns (borrows are implicit). No destructuring in function parameters in v1.
- `nil` pattern is the same as `None`.
- Match arm separator: comma **or** newline, comma optional after a block arm.
- `for a, b in x` [?]: define via an interface, e.g. `inter Pairs<A, B>` so Vec yields `(item, index)` and Map yields `(key, value)`. I recommend this so the behavior is declared in std, not hardcoded.

---

## 7. Types

### 7.1 Type expression grammar [R]

```
Type      := Postfix ( '&' Postfix )*                 // `&` infix = intersection, only legal in bounds / inter defs
Postfix   := Primary '?'*                             // T?  == Option<T>, '?' glued; T?? is an error
Primary   := Path [ '<' TypeArgs '>' ]                // Vec<int>, std.col.Vec<T>, Map<string, int>
           | '&' [ 'mut' ] Type                       // reference (params/locals only; semantic check)
           | '*' [ 'mut' ] Type                       // raw pointer (extern/unsafe only)
           | 't(' Types ')'                           // tuple type
           | 'r{' Fields '}'                          // structural record type
           | '(' Types ')' '->' Type                  // function type; right-assoc
           | '(' Type ')'                             // grouping
           | 'TypeOf' '(' PathExpr ')'
           | StringLit | IntLit | 'true' | 'false'     // literal types
TypeArgs  := (Type | IntLit) ( ',' (Type | IntLit) )*
```

- `&` is unambiguous: prefix at the start of a type = borrow, infix after a complete type = intersection.
- `T?` is a type-position suffix and expression `?` is a value-position suffix. The positions never overlap.
- **No `;` inside types** (the semicolon is a statement terminator now): use `Array<i32, 4>` not `Array<T; N>`.
- Function type vs tuple: `(i32, i32) -> i32` always has `->`; tuple type is `t(i32, i32)`. `-> t(int, int)` replaces `-> (int, int)` from your docs.
- No `any` in v1 [?], see open question 5.

### 7.2 Type declaration right-hand sides

| Form | Meaning |
|---|---|
| `type User = { pub id: string, name: string }` | **nominal struct** body (only legal as a `type` RHS) |
| `type P = r{ x: int }` | alias of a **structural** record type |
| `type R<T, E> =\n  \| Ok(T)\n  \| Err(E)` | **sum type**: must start with a leading `\|` (declares variants in the type's namespace) |
| `type Role = "Admin" \| "Operator"` | **literal union** (first member is a literal) |
| `type X = SomeType`, `type C = TypeOf(config)` | alias |

Rules:
- Sum types require a leading `|`. This cleanly separates "two unit variants" from "union of two existing types".
- Union of existing types (`int | string`) is **not** supported in v1 [R]. Use a sum type.
- Variant payloads: `Name`, `Name(T, U)`, `Name { f: T }`.
- Struct field separators: comma or newline, trailing comma ok. `pub` per field.
- Intersection `A & B` is legal in `inter X = A & B` and bounds `T: A & B`.

### 7.3 Your `t{}` question
You proposed `t{}` as a type literal. I recommend **not** adding it: the same sigil token appears in type position (`r{ name: string }` is the record **type**, `t(i32, string)` the tuple **type**), and position tells the parser which it is. One fewer token.

### 7.4 Built-in basic types [R]
`bool`, `char` (Unicode scalar), `byte` (= `u8`), `i8 i16 i32 i64 u8 u16 u32 u64 isize usize`, `int` = `i32`, `f32 f64`, `void`, `never`, `string`, `Slice<T>`, `&str` = `Slice<u8>`, `Array<T, N>`, `Vec<T>`, `Map<K, V>`, `Set<T>`, `Promise<T>`, `Option<T>`, `Result<T, E>`, `Ref<T>`, `Box<T>`, `Weak<T>`.
- Pick `Vec` (not `List`): your std doc says vec, your slice doc says List.
- `&str` is special-cased in the type checker as `Slice<u8>` (so `&str` doesn't mean "reference to a `str`"). `&[T]` is `Slice<T>`.
- Slice doc: `slice()` should return `Slice<T>`, not `&Slice<T>`.
- Indexing a `string` by integer: don't allow. Provide `.bytes()`, `.chars()`, and `substring(a, b)` with byte offsets that must land on char boundaries.

### 7.5 Layout coercion
`string`/`Vec<T>` to `Slice<T>` coercion is a typechecker rule, not syntax. Nothing needed in the parser.

### 7.6 `TypeOf / KeyOf / IndexOf / Partial / Omit / Type(...)` [R]

| Name | Treatment |
|---|---|
| `TypeOf(path)` | **only keyword-like form** in the type grammar. Takes a *value path* (`a.b.c`, no calls, no arbitrary expressions), which also matches your "only when the declaration is in scope" rule. |
| `KeyOf<T>`, `IndexOf<T>`, `ElementOf<T>`, `Partial<T>`, `Omit<T, K>`, `Pick<T, K>` | **ordinary generic type names**, evaluated by the type checker as compile-time intrinsics. The parser sees plain `Name<Args>`. |
| `Type(conf)` (your docs) | rename to `TypeOf(conf)` |
| `KeyOf(TypeOf(m))` (your docs) | rewrite as `KeyOf<TypeOf(m)>` |

---

## 8. Declarations

```
file       := package-decl import* item*
package    := 'package' ident            // must equal the folder name
import     := 'import' ['pub'] STRING ['as' ident]
```

- Import path strings: starting with `./` or `../` = relative file; otherwise dotted, first segment is a root (`std`, `app`, or a dependency from `ms.json`). Bound name = last segment (`"std.col.vec"` gives `vec`).
- Imports only at the top of a file. Your example uses `log.println` with only `import "std.io"` shown: decide if `log` is in the prelude [?].

```
item := ['pub'] ( fun | type | inter | impl | let | extern )
fun  := ['async'] 'fun' name ['<' GenericParams '>'] '(' [receiver ','] params ')' ['->' Type] block
receiver := 'this' | '&' 'this' | '&' 'mut' 'this' | 'mut' 'this'
param    := ['mut'] name ':' Type | '...' name ':' Type     // variadic: binds a Vec<T>
```

- Receivers [R]: `this` (move/copy), `&this`, `&mut this`, `mut this` (owned and mutable). Unify your docs, which mix `mut this`, `&mut this` and `mut self`.
- Static functions have no receiver.
- Expression-bodied `fun f(x: int) -> int => x * 2` is easy to add since closures already use `=>` [?: defer].
- Methods named with a leading `_` (`_get_info`) are compiler intrinsics by convention.

**Generics:** `<T, U: Reader & Writer>`. No `where` in v1. Const generics for array length `Array<T, N>`: `<T, const N: usize>` [?: defer].

**impl:**
```
impl Type { ... }
impl<T> Type<T> { ... }
impl Inter for Type { ... }
impl A, B for Type { ... }         // one body; compiler matches methods by name; error if two interfaces declare the same method name
```
Orphan rule [?]: `impl string {...}` only inside the package that owns `string` (std).

**inter:**
```
inter Reader = { fun read(&mut this, buf: Vec<u8>) -> Result<int, string> }
inter PartialOrd<T> : PartialEq<T> = { ... }      // requires supertrait
inter ReadWriter = Reader & Writer                // pure composition, no body
```
- `Self` is implicitly available inside every `inter` and `impl`. Drop `inter<Self> Default`.
- Methods may have default bodies [?]. Associated types (`Add<RHS, Output>` extra param vs `type Output`) [?: keep extra type params in v1].

**extern/unsafe:**
```
extern "C" { pub fun malloc(size: usize) -> *mut u8 }
unsafe { ... }          // expression block
```

**global let:** `pub let NAME: T = const_expr`, `let c = Ref(...)`. Top level allows only: `package`, `import`, `let`, `type`, `inter`, `impl`, `fun`, `extern`.

**Attributes** [?]: reserve `@name(args)` before items (`@test`, `@inline`). `#` is only used for closures.

---

## 9. Doc rewrites needed (before to after)

| Before | After |
|---|---|
| `fun f(): T` (slice doc) | `fun f() -> T` |
| `inline fun` | decide: attribute `@inline` or keyword |
| `fun reset_point(mut x: int32, &mut y: int32)` | `fun reset_point(mut x: i32, y: &mut i32)` |
| `fun fun_name(&items: List<i32>, ...)` | `items: &Vec<i32>` |
| `let (w, h) = get_dimensions()` | `let t(w, h) = get_dimensions()` |
| `-> (int, int)` | `-> t(int, int)` |
| `configure_server({ host, port })` | `configure_server(_{ host, port })` |
| `User.new2({id: "1", name: "Ted"})` | `User.new2(_{ id: "1", name: "Ted" })` |
| `.map(fun(file_path) { ... })` | `.map((file_path) => { ... })` |
| `(a: i32, b: i32) -> i32 { ... }` | `(a: i32, b: i32) -> i32 => { ... }` |
| `let user_map = { "A": 1 }` | `let user_map = m{ "A": 1 }` |
| `res: = recover{ ... }` | `res := recover { ... }` |
| `Type(conf)`, `KeyOf(TypeOf(m))` | `TypeOf(conf)`, `KeyOf<TypeOf(m)>` |
| `impl log { pub print(...) }` | `impl log { pub fun print(...) }` |
| `namespace std.sys { }` | package `std.sys` |
| `import std.log` | `import "std.log"` |
| `none`, `Nil` | `None` / `nil` |
| `Result<nil, string>` | `Result<void, string>` (or `Result<t(), string>`) |
| `local_no = 20` | `local_no := 20` |
| `get_user()?.name` as chain | `get_user()?.name` (now optional chain) or `(get_user()?).name` |

---

## 10. Open questions (each has a default so you can start)

1. **What does `'1` mean?** My reading: a *shape tag* so all `'1{...}` entries unify into one record type (`Record<"mg"|"nz", {id, name}>`), and a different number would mean a different shape. Are `'2`, `'3` legal? Default: `'<digits>{` lexes, parser stores the number, the typechecker groups by number.
2. **Missing keys in `_{}`/records "get default values"** (`routes.push({ name:'' ... })`): needs a `Default` interface or only `T?` fields auto-`None`. Default: only optional fields auto-fill; everything else must be written.
3. **Optional chaining vs propagation**: confirm the `?` / `?.` split in 3.2.
4. **Interfaces as types** (`Vec<Stringer>` in `print`, `any[]` in `println`) means dynamic dispatch/boxing. Default: no interface-typed values and no `any` in v1; `print` takes `...args: T` with `T: Stringer`, implemented as a std intrinsic.
5. **Copy vs move**: which types are implicitly copied (`i32`, `bool`, ...)? Default: a `Copy` marker inter that primitives implement; everything else moves.
6. **Returned borrows**: `Index::index(&this) -> &Target` returns a borrow, but you forbid returning borrows. Default: a borrow in return position is allowed only when derived from the receiver/params (elision-like, no lifetime syntax).
7. **`len` field vs `len()` method** on `Slice`, and the std naming drift: `size`/`len`, `has`/`contains`, `strip_suffix`/`remove_suffix`, `substring`/`slice`, `Vec`/`List`. Pick one set before writing std. Default: `len()`, `has()`, `strip_suffix()`, `substring()` (strings) / `slice()` (vecs), `Vec`.
8. **Casting**: `as` only, or `as` plus `.to_int()` methods? Default: `as` for numeric/pointer casts; `.to_*()` for fallible/lossy semantic conversions.
9. **Range indexing** `v[1..3]` producing a `Slice<T>` via `Index<Range, Slice<T>>`? Default: add after v1.
10. **Overflow** behavior: panic in debug, wrap in release? Default: panic in debug, wrap in release.
11. **Doc `package main` + folder name** rule for the entry package, and whether `import pub` re-exports.
12. **Nested `it`** (4.5) and `or`'s `it` (4.3): confirm the "innermost wins + warn" rule.

---

## 11. Suggested build order

1. **Lexer** with trivia, flags (`ws_before`, `nl_before`), the glued-token table, string mode stack, after-dot rule, matching-delimiter table.
2. **Test corpus**: about 40 snippets lifted from your docs (after the rewrites in section 9), each with expected token streams for the weird cases: `t.0.1`, `1..10`, `a[0]`, `Vec<Promise<T>>`, `i<n`, `'1{`/`'a'`, `r{`/``r` ``, `x.or(1)`/`x or 1`, `await f()?`.
3. **Parser**: recursive descent for items/statements/types/patterns, Pratt for expressions, parser-driven `>` splitting, closure detection via the matching-delimiter table.
4. **Diagnostics early**: `E_SIGIL_SHADOWS_BINDING`, "add spaces around `<`", "tuples use `t(...)`", and statement-continuation hints. These are the new rules most likely to surprise users.
5. **AST**: keep it dumb and syntactic (generic member chain `a.b.c`, name resolution later). Mark `_get_info`/`TypeOf` as semantic-pass territory.
6. **Formatter / LSP**: a lossless token stream + trivia makes round-tripping straightforward.


## 12. Replies to <>
We are introducing turbofish to types 

// Types
let users: Vec<User> = []

// Generic functions
let value = parse::<User>(input)
let numbers = collect::<i32>(items)

// Generic methods
let result = json.parse::<Config>(input)
let value = x.as::<i32>()

