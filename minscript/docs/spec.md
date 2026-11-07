# MinScript Language Specification — v0.1 (Unified Draft)

**Status:** First unified draft. Supersedes `spec-v1.rs`, `spec-v2.rs`, `merge_1.rs`, `notes_1.md` (kept for history).
**Target:** Deterministic hand-written TypeScript lexer + recursive-descent / Pratt parser.
**Date:** 2026-11-07

Legend used in this document:

- **[D]** decided (by you, or carried from earlier drafts unchanged)
- **[N]** new in this draft (decided now, from your latest instructions/samples)
- **[?]** proposed default, needs confirmation (see §16)

---

## 0. Principles

MinScript combines:

- TypeScript's concise literal and collection syntax.
- Rust's ownership, borrowing and type safety, **without lifetime annotations**.
- Go's small keyword set and simple control flow.
- A compiler that is fast and simple to implement.

Pipeline:

1. **Lexer**: tokens, spans, trivia, `ws_before` / `nl_before` flags, matching-delimiter index.
2. **Parser**: purely syntactic AST.
3. **Name resolution**: scopes, packages, imports.
4. **Type checker**: inference, generics, interfaces, coercions.
5. **Semantic analysis**: ownership, borrowing, mutability, escape analysis, comptime.
6. **Lowering**: HIR, then JS / WASM / C / LLVM back ends.

**Fundamental rule [D]:** parsing never needs type information, symbol resolution or interface resolution. A syntactically valid file parses without knowing whether any referenced name exists.

### 0.1 What changed versus spec-v1 / spec-v2

| Topic | Before | Now |
|---|---|---|
| Closures | `#{}`, `(a) => …`, `#[x](a) => …` | **Only `#{…}` and `#[captures]{…}`** [N] |
| Captures | names only | `#[x, &y, &mut z]{…}`: by value, borrow, mutable borrow [N] |
| Generic args in types | `Vec<T>` | `Vec[T]` [N] |
| Generic args in expressions | glued `<T>` (v1), `::<T>` (v2) | **`.[T]`**, e.g. `json.parse.[User](s)` [N] |
| Generic params | `fun f<T>`, `impl<T>` | `fun f[T]`, `impl[T]` [N] |
| `<` / `>` | needed whitespace rules and token splitting | always comparison operators, never generics [N] |
| Sum types | `type X = \| A \| B(T)` | `union X = { A  B(T) }` [N] |
| Loops | `for`, `while`, `loop` | `for` only (Go style) [N] |
| Raw strings | `` r`…` `` | `r"…"` [N] |
| Match guard | `x if cond =>` / `age > 18 =>` | `pat if cond =>`; subject-less `match { cond => … }` [N] |

---

## 1. Lexical structure

### 1.1 Source [D]

- UTF-8. CRLF is normalized to LF. A UTF-8 BOM is stripped.
- Tabs and spaces are both whitespace.
- Identifiers are ASCII in v0.1.

Every token carries:

```ts
type Token = {
    kind: TokenKind
    span: Span          // start/end byte offset, line, col
    ws_before: boolean  // any whitespace/comment immediately before
    nl_before: boolean  // a newline occurred since the previous token
    match?: number      // openers: index of the matching closer
}
```

Comments are trivia, kept in a side list for the formatter and LSP.

### 1.2 Comments [D]

```rust
// line comment
/// doc comment (attached to the next item)
/* block comment, /* nestable */ */
```

### 1.3 Identifiers [D]

```text
ident := [A-Za-z_][A-Za-z0-9_]*
```

- A lone `_` is the wildcard and is never a binding.
- The linter, not the parser, enforces the convention: `PascalCase` for types, variants and interfaces, and `snake_case` for everything else.
- Patterns rely on the convention: an uppercase-initial identifier is a constructor or constant path, and a lowercase one is a new binding (§6).

### 1.4 Keywords

```text
Declarations: package import pub type union inter impl fun async let var mut extern
Control:      if else match for in break continue return
Expressions:  await or as unsafe recover true false nil this Self
Type-level:   TypeOf
Reserved:     while loop yield macro where   (unused in v0.1, reserved so they can't become names)
```

- `union` is new [N]. `while` and `loop` are demoted to reserved [N] because `for` covers them (§5.4).
- **Implicit closure parameters [D]:** `it`, plus `it1`, `it2`, …, `itN` (N a positive integer with no leading zero). `it1 == it`. These are reserved identifiers, not keywords.
- **Prelude names, not keywords [D]:** `Ok Err Some None Result Option Ref Box Weak Promise assert panic`.
- **After `.` or `?.` [D]:** a keyword lexes as a plain identifier, so `x.or(5)`, `x.in(r)` and `p.match()` are member accesses. The lexer only needs the previous token for this.

### 1.5 Literals

**Integers [D]:** `123`, `1_000`, `0xFF`, `0b1010`, `0o17`.
- No suffixes. Use `as` or an expected type instead.
- The default type is `int`.
- An out-of-range literal is a compile error.

**Floats [D]:** `1.5`, `1e9`, `2.5e-3`, `1_000.5`.
- `.5` and `5.` are not valid.
- The default type is `f64`; a float adopts `f32` when the expected type is `f32`.

**Number lexing rules [D]:**
1. After a digit run, `.` belongs to the number only when a digit follows it. So `1..10` lexes as `1` `..` `10`, and `1.to_string()` lexes as `1` `.` `to_string`.
2. When the previous token is a member `.`, only digits are lexed. So `t.0.1` lexes as `t` `.` `0` `.` `1` (tuple indexing).

**Booleans and absence [D]:** `true`, `false`, `nil`. `nil` is a keyword alias of the prelude constructor `None`.

**Characters [D]:** `'a'`, `'\n'`, `'\u{1F600}'`. Type `char` is a Unicode scalar value.

**Strings [D]:**
- `"…"` is single-line. An unterminated string errors at the end of the line, which gives good error recovery.
- Escapes: `\n \r \t \0 \\ \" \' \$ \xNN \u{…}`.
- Interpolation is written `${expr}` and may nest strings. The lexer keeps a mode stack of string and interpolation states, tracking brace depth.
- `"""…"""` is multi-line, with escapes and interpolation active. The first newline after the opener is dropped, and the common leading indentation (measured from the closing `"""` line) is stripped.

**Raw strings [N]:** `r"C:\users\name"`.
- No escapes and no interpolation.
- May span lines.
- Cannot contain `"`; use `"""` for that.
- `r` must be glued to `"`.

### 1.6 Glued sigil tokens [D, updated]

These lex as **single tokens** only when the letter and the opener touch, and the letter is a whole identifier (not the tail of a longer one).

| Token | Meaning | Valid in |
|---|---|---|
| `r{` | anonymous record literal / record type | expr, type |
| `m{` | map literal | expr |
| `s{` | set literal | expr |
| `t(` | tuple literal / tuple type / tuple pattern | expr, type, pattern |
| `a[` | fixed array literal | expr |
| `_{` | inferred struct/record literal (type taken from the expected type) | expr |
| `'N{` | tagged record literal (`'` + digits + `{`) | expr |
| `#{` | closure | expr |
| `#[` | closure capture list (must be followed by a glued `{`) | expr |
| `.[` | explicit generic arguments [N] | expr (postfix) |
| `r"` | raw string | expr |

**No-glue contexts [N]:** a letter is *not* treated as a sigil when the previous token is `.`, `fun`, `type`, `union` or `inter`. So `fun t[T]()` declares a function named `t`, and `x.a[0]` indexes field `a`.

**Identifier collisions [D]:** `r m s t a` remain legal identifiers. The sigil wins lexically, so:

```rust
a[0]     // fixed array literal containing 0
a [0]    // indexing a variable named `a`
t(1, 2)  // tuple
t (1, 2) // calling a function named `t`
```

The resolver reports `E_SIGIL_SHADOWS_BINDING` when a sigil letter matches a visible binding, and suggests a space or a rename. The formatter never removes that space.

`'N{` versus a char literal: after `'`, if `'<char>'` matches it is a char; otherwise `'<digits>{` is a tag token.

### 1.7 Operators and punctuation

```text
Arithmetic:  +  -  *  /  %
Bitwise:     &  |  ^  <<  >>          (unary bitwise-not is `!` on integers)
Compare:     ==  !=  <  <=  >  >=
Logical:     &&  ||  !
Assign:      =  +=  -=  *=  /=  %=  &=  |=  ^=  <<=  >>=
Binding:     :=  :==
Range:       ..  ..=
Spread:      ...
Arrows:      ->  =>
Option:      ?  ?.
Other:       .  ,  :  ;  @  ( ) [ ] { }
Reserved:    ~  ??  ++  --            (lexed, always a parse error with a hint)
```

Because generics never use `<` / `>` [N], maximal munch is always correct: `>>` is always a shift, and the **type-argument token splitting from spec-v2 §1.6 is gone**.

---

## 2. Generics [N]

### 2.1 Declaring generic parameters

Generic parameters use square brackets directly after the declared name.

```rust
fun identity[T](value: T) -> T { value }

fun convert[T, U: Convert[T, U]](value: T) -> U { … }

type Box[T] = { value: T }

union Response[T, E] = {
    Success(T)
    Failure(E)
}

inter Convert[From, To] = {
    fun convert(&this, value: From) -> To
}

impl[T] Box[T] {
    pub fun get(&this) -> &T { &this.value }
}
```

- Bounds use `:` and `&` for multiple bounds: `[T: Reader & Writer]`.
- There is no `where` clause in v0.1.
- Const generic parameters (`[T, N: usize]`) are deferred. Built-in `Array[T, N]` accepts an integer literal argument.

### 2.2 Generic arguments in type position

Wherever the parser expects a type, `Name[…]` with the `[` glued to the name is a type application:

```rust
Vec[int]
Map[string, Vec[User?]]
Promise[Result[User, string]]
Array[i32, 4]
std.col.Vec[u8]
```

- The `[` must be glued (`ws_before == false`). Otherwise the type ends at the name.
- Type arguments are types or integer literals.

### 2.3 Explicit generic arguments in expressions: `.[…]`

In expression position, generic arguments are supplied with the **`.[` postfix**. It is only needed when inference cannot work out the types.

```rust
let user = json.parse.[User](json_str)      // User? — None when it doesn't parse as a User
let ids  = collect.[i64](items)
let v    = Vec.new.[u8]()                   // generic static method
let v2   = Vec.[u8].new()                   // generic type, then static member
let b    = Box.[i32]{ value: 1 }            // generic struct literal
let p    = parse_user.[User]("{\"id\":1}")
```

- `.[` is one token, and it is only legal as a postfix on an expression. Nothing else in the grammar starts with `.` followed by `[`, so there is no ambiguity.
- `expr.[Args]` produces an AST node `GenericApply { target, args: Type[] }`. The parser does not check what follows it; name resolution checks that the target is generic.
- `.[` may not start a new line. That would make it a chain continuation, and generic arguments aren't one.

When the types can be inferred, leave `.[…]` out:

```rust
let u: User? = json.parse(json_str)          // T inferred from the expected type
fun load() -> User? { json.parse(read()) }   // T inferred from the return type
```

The diagnostic `E_CANNOT_INFER_GENERIC` suggests the `.[…]` form.

---

## 3. Operators and precedence [D]

Tightest first:

| # | Operators | Assoc | Notes |
|---|---|---|---|
| 1 | postfix `.x` `?.x` `(args)` `[i]` `.[T]` `?` | left | `(` and `[` must not cross a newline |
| 2 | prefix `-` `!` `await` | right | see 3.1 |
| 3 | `as T` | left | |
| 4 | `*` `/` `%` | left | |
| 5 | `+` `-` | left | |
| 6 | `<<` `>>` | left | |
| 7 | `&` | left | bitwise; Rust precedence, not C's |
| 8 | `^` | left | |
| 9 | `\|` | left | |
| 10 | `==` `!=` `<` `<=` `>` `>=` | none | `a < b < c` is `E_NON_ASSOCIATIVE_OPERATOR` |
| 11 | `&&` | left | |
| 12 | `\|\|` | left | |
| 13 | `..` `..=` | none | |
| 14 | `or` | left | §4.6 |
| 15 | `=` and compound assignments | right | assignment evaluates to `void` |

- `return`, `break` and `continue` are expressions of type `never`, so `x or return` and `x or break` are valid.
- Unary `&` creates a borrow only where one is explicitly needed (§9.3). Unary `*` (dereference) appears only inside `unsafe`.

### 3.1 `await` and postfix `?` [D]

The operand of `await` is a postfix chain **up to but not including the first `?` or `?.`**. The postfix loop then continues on the awaited value.

```rust
await read_file(p)?          // (await read_file(p))?
await get_user()?.name       // ((await get_user())?.name)
(await fetch_name()).trim()  // method call on the result needs parentheses
```

### 3.2 `?` versus `?.` [D]

- `x?` (glued) **propagates**: `Err(e)` / `None` returns from the enclosing function or closure; otherwise it unwraps.
- `x?.name` **optional-chains**: if `x` is absent, the whole chain is `None`, with no early return.
- To propagate and then access a member, write `(x?).name`.
- In type position `T?` means `Option[T]`, and `T??` is an error.

---

## 4. Expressions

### 4.1 Blocks [D]

A `{…}` block (of a function, closure, `if`, `match` arm, `or`, `unsafe` or `recover`) evaluates to its last expression when that expression has no trailing `;`. A trailing `;` discards the value.

```rust
fun a() -> int { 5 }       // 5
fun b() { foo() }          // void function: the final value is discarded
fun c() -> int { 5; }      // error E_INVALID_BLOCK_VALUE
```

`return` is always available for early exit and is never required.

### 4.2 Bare `{` is always a block [D]

There is no bare map, record or struct literal. Literals always use a sigil or a type name.

A struct literal `Name { … }` is **not allowed directly in the header of `if`, `for` or `match`**; wrap it in parentheses. This is the Rust rule, and it keeps `if x == P { … }` unambiguous.

### 4.3 Literals [D]

```rust
[1, 2, 3]                          // Vec[int]
a[1, 2, 3]                         // Array[int, 3]
t(1, "a", 2.5)                     // tuple; t(x) is a 1-tuple; t() is unit
r{ name: "Ted", age: 26, ...base } // anonymous record (structural)
m{ "one": 1, key_expr(): 2 }       // Map: keys are expressions
s{ 1, 2, 3 }                       // Set
_{ host, port: 8080 }              // inferred struct/record; needs an expected type
'1{ id: 1, name: "x" }             // tagged record (shape tag 1)
User { id: 1, name }               // named struct literal; shorthand fields
```

- Elements may be separated by commas or newlines, and trailing commas are allowed.
- Record and struct keys are identifiers or quoted identifiers.
- `...expr` spreads into `[]`, `a[]`, `r{}`, `m{}`, `s{}`, `_{}` and `Name {}`. The type checker checks spread compatibility.
- `_{}` without an expected type is `E_CANNOT_INFER_STRUCT_TYPE`. `_{}` is the named-arguments story: `configure_server(_{ host, port })`.
- Parentheses only group. **There is no bare `(a, b)` tuple**: use `t(a, b)` in expressions, types and patterns.

### 4.4 Closures [N]

`#{ … }` is **the only closure syntax**. Arrow functions `(a) => …`, `fun(x) {…}` and `#[x](a) => …` are all removed.

#### Forms

```rust
#{ it * 2 }                        // implicit params: it == it1, it2, …, itN
#{ it1 + it2 }
#{ compute_default() }             // zero params (no `it` used)
#{ n, idx => n > 50 }              // named params
#{ x: i32, y: i32 => x + y }       // typed params
#{ a: i32, b: i32 -> i32 => a + b }// typed params + return type
#{ mut acc, cur => acc += cur; acc }  // `mut` param (owned, mutable local)
#{ n =>                            // multi-line body; last expression is the value
    let squared = n * n
    squared + 5
}
```

#### Capture lists

```rust
#[count]{ count + it }             // capture `count` by value (move, or copy if Copy)
#[&cfg]{ cfg.port }                // capture by shared borrow
#[&mut total]{ total += it }       // capture by mutable borrow
#[]{ 42 }                          // captures nothing (explicitly)
#[conn, &mut stats]{ msg => conn.send(msg); stats.sent += 1 }
```

- Grammar: `#[` capture (`,` capture)* `]{` closure-body, where capture := `ident` | `&` `ident` | `&` `mut` `ident`.
- The `{` after `]` must be glued. A capture list is only valid as a closure prefix.

#### Parsing the header (deterministic, no backtracking)

After `#{`, the parser scans forward at bracket depth 0, using the lexer's matching-delimiter index to skip `(…)`, `[…]`, `t(…)` and `r{…}` groups. It stops at the first of these:

- `=>`: if every depth-0 token seen so far is one of `ident` `mut` `,` `:` `&` `->` `?` `.` `_`, then the tokens before `=>` are the **parameter header**.
- a token with `nl_before`, a `;`, the closing `}`, or any other token: there is **no header**, and the body starts right after `#{`.

So the header must sit on the first line of the closure. Because `or` is a keyword, `#{ f() or e => log(e) }` correctly has no header (§4.6).

#### Rules

- `it`, `itN` are only valid in header-less closures. Mixing them with named params is `E_IT_IN_NAMED_CLOSURE`.
- With nested header-less closures, the innermost `it` wins and the linter warns. Use named params to reach an outer value.
- Using `itK` where K exceeds the callee's arity is a type error, not a lexer limit.
- A callback may use fewer parameters than the callee supplies: `vec.for_each(#{ log.println(it) })` ignores the index the callee passes.
- `return` inside a closure returns from the closure.
- Assignment is a `void` expression, so `#{ it += 10 }` is valid when `it` is `&mut T`.
- There is no trailing-closure syntax: closures are always passed inside `(…)`.
- Capture semantics (implicit borrows, escaping) are in §9.4.

### 4.5 Control-flow expressions [D, updated]

```rust
let grade = if score >= 90 { "A" } else if score >= 75 { "B" } else { "C" }

let tier = match role {
    "Admin" => "Full Access"
    "Operator" => "Standard"
    _ => "Read Only"
}

let label = match n {
    0 => "zero",
    1..=5 => "small",
    x if x > 100 => "huge",           // guard [N: `if` is required]
    _ => "other",
}

let is_adult = match {                // subject-less match: first true arm wins [N]
    age > 18 => true
    _ => false
}
```

- `if` without `else` has type `void`.
- `if`/`match` are expressions when every branch is present. `match` must be exhaustive.
- Match arms are separated by commas or newlines; the comma after a block arm is optional.
- The parentheses around a condition are optional and are just grouping.
- `unsafe { … }` and `recover { … }` are block expressions (§9.8).

Ranges: `a..b`, `a..=b`, `..b`, `a..`. Open ranges are only valid where the consumer accepts them.

### 4.6 `or`: unwrap or diverge [D]

```rust
expr or RHS
expr or name => RHS
```

- If `expr` is `Ok(v)` or `Some(v)`, the whole expression evaluates to `v`.
- If `expr` is `Err(e)` or `None`, **RHS is evaluated and returned from the enclosing function or closure**. `return` is implied, though `or return X` is also allowed.
- In RHS, `it` is the `Err` payload (unavailable for `Option`). `or e => …` names the payload instead.
- RHS may be an expression, a block, `return …`, `break` or `continue`.

```rust
let bytes  = await fs.read_file(path) or Err("IO failed: ${it}")
let prefix = get_env_prefix() or Err("missing prefix")
let user   = find_user(id) or e => {
    log.println(e)
    Err(e)
}
let line   = lines.next() or break
```

**`.or(…)` is an ordinary method**, a value fallback that never returns early:

```rust
let email   = raw_email.or("guest@minscript.dev")
let timeout = cfg.timeout.or(#{ compute_default() })
```

Because `x or 0` returns `0` from the function while `x.or(0)` is a fallback, the linter flags `or <literal>` in a function whose return type is not that literal's type.

### 4.7 String interpolation [D]

`"${expr}"` only; there is no bare `$name`. The interpolated value must implement `Stringer` (§10.3).

---

## 5. Statements

### 5.1 Bindings [D]

```rust
let name = expr           // immutable
var name = expr           // mutable
name := expr              // sugar for let
name :== expr             // sugar for var
let name: T = expr
let pattern = expr else { diverge }
place = expr              // assignment; never declares
place += expr             // compound assignment
```

- `:=` and `:==` take only a plain identifier on the left.
- Assigning to an undeclared name is `E_UNDECLARED_ASSIGNMENT`.
- The `else` block of `let … else` must diverge (`return`, `break`, `continue` or `panic`).

### 5.2 Conditional patterns [D]

```rust
if let Some(user) = find(id) { … } else { … }
for let Some(item) = iter.next() { … }    // replaces `while let`
```

### 5.3 Pattern destructuring [D]

```rust
let t(width, height) = get_dimensions()
let Ok(data) = res else { return Err("read failed") }
let User { id, name, .. } = user
```

### 5.4 Loops: `for` only [N]

```rust
for { … }                       // infinite
for count < 3 { … }             // conditional (old `while`)
for let Some(x) = it.next() { } // conditional pattern (old `while let`)
for item in items { … }         // iteration
for item, idx in items { … }    // two bindings: (item, index) for Vec, (key, value) for Map
for i in 0..10 { … }
```

How the parser classifies the header (deterministic):

1. `{` straight after `for`: infinite loop.
2. `let` straight after `for`: conditional pattern.
3. otherwise, scan to the header's `{` at depth 0. If an `in` keyword appears, it is an iteration loop; otherwise it is a conditional loop.

`break value` is only allowed in an infinite `for { }`, which is then an expression. `break` and `continue` take optional labels:

```rust
outer: for row in grid {
    for cell in row {
        if cell == 0 { continue outer }
        if cell < 0 { break outer }
    }
}
```

A label is `ident :` directly before `for` at statement start. Labels don't use `'`, which keeps them clear of char and tag literals.

The `for a, b in x` behaviour is defined by std interfaces (`Iterable`, `Pairs`, §10.2), not hard-coded in the parser.

### 5.5 Newlines and semicolons [D]

Tokens carry `nl_before`, and the parser decides where statements end. It never inserts virtual `;` tokens.

1. A statement ends at `;`, at a newline, or before `}` / EOF.
2. A newline does **not** end a statement when:
   - the previous token cannot end an expression: a binary operator, `,`, `.`, `?.`, `(`, `[`, `{`, `=`, `:=`, `:==`, `=>`, `->`, `:`, `as`, `or`, `await`, `mut`, `&`, `!`, `#{`, `#[`, `.[`, or
   - the next token is `.`, `?.`, `&&`, `||`, `or`, `as`, `else`, `)`, `]`, `}` or `=>`.
3. A newline **does** end the statement when the next line starts with `(`, `[`, `{`, `-`, `+`, `*`, `&`, `!` or `.[`. Write continuation operators at the end of the line.
4. Postfix `(` call, `[` index and `.[` generics require `nl_before == false`. `.` and `?.` may cross a newline (method chains).
5. Newlines are ignored inside `(…)` and `[…]`, but they matter again inside a nested `{…}`.
6. `return`, `break` and `continue` followed by a terminator take no value.
7. The opening `{` of `fun`, `if`, `else`, `for`, `match`, `impl`, `inter`, `type` and `union` must be on the header line (K&R).
8. A trailing `;` after a block's final expression discards its value. The formatter strips every other `;`.

```rust
let result =
    calculate(first, second)

let name = get_user()
    .profile
    ?.display_name
```

---

## 6. Patterns [D]

| Pattern | Example |
|---|---|
| Literal | `1`, `"hi"`, `'c'`, `true`, `nil` |
| Wildcard | `_` |
| Binding | `user`, `mut user` |
| Constructor | `None`, `Cash`, `Payment.Cash` |
| Payload | `Ok(v)`, `Mpesa(code, amount)` |
| Struct | `Card { number, exp: e, .. }` |
| Tuple | `t(x, y, ..)` |
| Or | `Some(0) \| None` |
| Range | `1..=5`, `'a'..='z'` |

- Identifier case decides the meaning: lowercase binds, uppercase is a constructor or constant.
- Unqualified variants resolve through the prelude first, then the scrutinee's type: `Cash` and `Payment.Cash` are both valid in `match payment`.
- `nil` and `None` are the same pattern.
- v0.1 has no reference patterns and no destructuring in function parameters.

---

## 7. Types

### 7.1 Type grammar [N: brackets]

```text
Type         := Intersection
Intersection := Postfix ('&' Postfix)*         // only legal in bounds and `inter X = A & B`
Postfix      := Primary '?'?                   // T? == Option[T]
Primary      := Path [ '[' TypeArgs ']' ]      // '[' glued
              | '&' ['mut'] Type               // borrow (params, receivers, captures)
              | '*' ['mut'] Type               // raw pointer (extern/unsafe)
              | 't(' [Type (',' Type)*] ')'    // tuple type
              | 'r{' [Field (',' Field)*] '}'  // structural record type
              | '(' [Type (',' Type)*] ')' '->' Type   // function type (right-assoc)
              | '(' Type ')'                   // grouping
              | 'TypeOf' '(' ValuePath ')'
              | StringLit | IntLit | 'true' | 'false'  // literal types
TypeArgs     := (Type | IntLit) (',' (Type | IntLit))*
```

- A `&` at the start of a type is a borrow; between two complete types it is an intersection.
- A function type always has `->`; a tuple type always uses `t(…)`.
- `void` is the unit / no-value type. `never` is the type of diverging expressions.

### 7.2 Built-in types [D]

```text
bool  char  byte(=u8)
i8 i16 i32 i64  u8 u16 u32 u64  isize usize
int (= i32)     f32 f64
void  never  string
Slice[T]  Array[T, N]  Vec[T]  Map[K, V]  Set[T]
Option[T] (T?)  Result[T, E]  Promise[T]
Ref[T]  Box[T]  Weak[T]
```

- `string` is owned and immutable. It cannot be indexed by integer; use `.bytes()`, `.chars()` or `.substring(a, b)`. Offsets are byte-based and must land on char boundaries.
- `Slice[T]` is a borrowed view (pointer + length). `string → Slice[u8]` and `Vec[T]`/`Array[T,N] → Slice[T]` are built-in coercions done by the type checker (see `test/samples/slices.rs`).
- There is no `any` and there are no interface-typed values in v0.1 (§9.7).

### 7.3 Type declarations [N: `union`]

**Nominal struct**

```rust
pub type User = {
    pub id: u64
    pub name: string
    email: string?          // private field; optional
    tags: Vec[string]
}
```

**Structural record alias**

```rust
type Point = r{ x: f64, y: f64 }
```

**Sum type**, using the `union` keyword with a block body:

```rust
pub union Payment = {
    Cash
    Mpesa(string)
    Card { number: string, exp: string }
}

pub union Result[T, E] = {
    Ok(T)
    Err(E)
}
```

- Variants are separated by newlines or commas.
- Variant forms are `Name`, `Name(T, …)` and `Name { field: T, … }`.
- Variants live in the union's namespace (`Payment.Cash`), and match patterns may use them unqualified.

**Literal union**

```rust
pub type Role = "Admin" | "Operator" | "Guest"
```

Unions of arbitrary existing types (`int | string`) are not supported: use a `union`.

**Alias**

```rust
type UserId = u64
type Config = TypeOf(default_config)
type Users = Vec[User]
```

**Fields:**
- Separators are commas or newlines, and a trailing comma is allowed.
- Fields are private by default; add `pub` per field.
- Recursive types must use `Box`: `next: Box[Node[T]]?`.

### 7.4 Type-level forms [D]

- `TypeOf(path)` is the only keyword type form. It takes a value path (`a.b.c`), with no calls.
- `KeyOf[T]`, `IndexOf[T]`, `ElementOf[T]`, `Partial[T]`, `Omit[T, K]` and `Pick[T, K]` are ordinary generic type names. The type checker evaluates them.

```rust
let routes = [ '1{ name: "TRM", volume: 80 }, '1{ name: "Kasarani", volume: 100 } ]
pub type Route  = ElementOf[TypeOf(routes)]
pub type Fields = KeyOf[Route]              // "name" | "volume"
```

---

## 8. Declarations and modules

### 8.1 File structure [D]

```text
file    := package_decl import* item*
package := 'package' ident ('.' ident)*
import  := 'import' ['pub'] STRING ['as' ident]
item    := ['pub'] (fun | type | union | inter | impl | let | extern)
```

```rust
package app.users

import "std.log"
import "std.collections" as col
import "./models"            // relative to this file's folder
import pub "./log"           // re-export
```

- **A folder is a package**: every file in it declares the same package name, which matches the folder.
- Import paths starting with `./` or `../` are relative; otherwise the path is dotted and its first segment is a root (`std`, `app` for the current project's source root, or a dependency from `ms.json`).
- The bound name is the last segment (`"std.collections"` binds `collections`) unless renamed with `as`.
- `import pub` re-exports the imported module from this package.
- Imports must come before any item.
- **Everything is private by default**; `pub` exports it.

### 8.2 Top-level items [D]

Only declarations are allowed at the top level; there are no free statements.

- `let` globals are **immutable**, and their initializers must be const-evaluable or a `Ref(…)` constructor.
- Mutable global state must go through `Ref[T]`:

```rust
pub let MAX_CONNECTIONS: i32 = 10_000
pub let sessions = Ref(m{ "admin": 0 })   // Ref[Map[string, int]]
```

`var` is not allowed at the top level (`E_GLOBAL_VAR`).

### 8.3 Functions [D]

```text
fun      := ['async'] 'fun' ident [GenericParams] '(' [receiver ','] params ')' ['->' Type] Block
receiver := 'this' | '&' 'this' | '&' 'mut' 'this' | 'mut' 'this'
param    := ['mut'] ident ':' Type
          | '...' ident ':' Type          // variadic; binds Vec[T]; must be last
```

```rust
pub fun area(w: f32, h: f32) -> f32 { w * h }

pub fun reset(mut x: i32, y: &mut i32) {   // x is an owned mutable local; y is a mutable borrow
    x = 0
    y = 0
}
```

- Parameter passing modes are covered in §9.2.
- There are no default parameter values and no named arguments; `_{}` covers both.

### 8.4 `impl` [D]

```rust
impl User {
    pub fun new(id: u64, name: string) -> User {      // static: no receiver
        User { id, name, email: nil, tags: [] }
    }
    pub fun email(&this) -> string { this.email.or("none") }
    pub fun rename(&mut this, name: string) { this.name = name }
}

impl[T] Box[T] { … }
impl Reader for File { … }
impl Add, Sub for Money { … }     // one body implementing several interfaces
```

- `Self` is available inside every `inter` and `impl`.
- If two interfaces in one `impl` declare the same method name, it is `E_AMBIGUOUS_IMPL_METHOD`.
- **Orphan rule [?]:** `impl X for T` must be in the package that owns `X` or `T`.

### 8.5 `inter` [D]

```rust
pub inter Reader = {
    fun read(&mut this, buf: &mut Vec[u8]) -> Result[int, string]
}

pub inter PartialOrd[T]: PartialEq[T] = {     // super-interface
    fun partial_cmp(&this, other: &T) -> Option[Ordering]
}

pub inter ReadWriter = Reader & Writer        // composition, no body

pub inter Default = {
    fun default() -> Self
}
```

- Interfaces are implemented **explicitly** with `impl … for …`. This keeps type checking O(1) per lookup.
- Interface methods are implicitly `pub`.
- Default method bodies are [?] (§16).
- There are no associated types; use extra generic parameters (`Add[RHS, Out]`).

### 8.6 `extern` and `unsafe` [D]

```rust
extern "C" {
    pub fun malloc(size: usize) -> *mut u8
    pub fun free(ptr: *mut u8)
}

pub fun open_fd(path: string) -> Result[i32, string] {
    let fd = unsafe { open(path.as_ptr(), 0, 0) }
    if fd < 0 { return Err("open failed: ${fd}") }
    Ok(fd)
}
```

### 8.7 Attributes [D: reserved]

`@name` / `@name(args)` before an item is reserved for later use (`@test`, `@inline`). The lexer emits `@`; the v0.1 parser reports `E_ATTRIBUTES_RESERVED`.

---

## 9. Semantics (summary for the later passes)

These rules don't affect the parser. They are recorded so that the syntax stays consistent with them.

### 9.1 Values, moves and copies [D]

- Primitives (ints, floats, `bool`, `char`) and tuples or records made only of them implement `Copy`: assigning them copies.
- Every other value **moves** on assignment or by-value passing. Using a moved-from binding is `E_USE_AFTER_MOVE`.
- `string` is immutable and cheap to share; it behaves as Copy for the user (implemented as an immutable shared buffer).
- The compiler generates `.clone()` on demand for types that don't define one.

### 9.2 Parameter modes [D]

| Signature | Meaning | Call site |
|---|---|---|
| `x: T` | owned (moved, or copied if Copy) | `f(x)` |
| `mut x: T` | owned, and mutable inside the callee | `f(x)` |
| `x: &T` | shared borrow | `f(x)`: borrow is implicit |
| `x: &mut T` | exclusive mutable borrow | `f(x)`: needs a `var` binding |

- Call sites never write `&`. The signature decides, and the LSP shows inlay hints.
- `&mut this` methods can't be called on a `let` binding (`E_MUT_BORROW_OF_IMMUTABLE`).

### 9.3 Borrow rules (no lifetimes) [D]

1. Any number of shared borrows **or** exactly one mutable borrow may exist at a time.
2. A value can't be used through its owner while a mutable borrow of it is live.
3. **Borrows are scoped to the call** (or closure) that receives them. A borrow cannot be stored in a struct, a collection or a global.
4. A function may **return** a borrow only when it derives from the receiver or a borrowed parameter (elision-like, as in `Index.index(&this) -> &T`). The returned borrow lives until the end of the caller's statement, or of its enclosing block when bound with `let`.
5. Explicit `&x` / `&mut x` expressions appear only in capture lists, in returning a sub-borrow (`&this.value`), and in raw-pointer code.

### 9.4 Closure captures and escaping [N]

| Capture | Written | Effect |
|---|---|---|
| implicit | free variable used inside `#{}` with no capture list | **shared borrow**, read-only |
| by value | `#[x]` | `x` is moved, or copied if Copy, into the closure |
| borrow | `#[&x]` | shared borrow (same as implicit, but explicit) |
| mutable borrow | `#[&mut x]` | exclusive borrow; `x` must be `var` |

- Without a capture list, a closure may **read** any visible local or global. Writing to a captured local requires `#[&mut x]`.
- Once a capture list is present, it is complete: using a local that isn't listed is `E_UNLISTED_CAPTURE`. Globals are always readable.
- **A closure is non-escaping when it holds any borrow** (implicit or explicit). Per §9.3 rule 3, such a closure can only be passed to a borrowed function parameter (`f: &(T) -> U`), or called locally inside the scope where it was created.
- **An escaping closure** has only by-value captures. It can be returned, stored, sent to another task, or passed to an owned function parameter (`f: (T) -> U`).
- Passing a borrowing closure where an owned function type is expected is `E_CLOSURE_ESCAPES_BORROW`, with a fix-it to convert the captures to `#[x]`.
- Capturing a `Ref[T]` by value clones the handle (increments the reference count).

```rust
fun apply(n: i32, f: &(i32) -> i32) -> i32 { f(n) }        // non-escaping parameter
fun make_adder(n: i32) -> (i32) -> i32 { #[n]{ it + n } }   // escaping: by-value capture

limit := 50
high := nums.filter(#{ it > limit })        // implicit borrow of `limit`: fine

var total = 0
nums.for_each(#[&mut total]{ total += it })

let adder = make_adder(10)
log.println(adder(5))                         // 15
```

### 9.5 Numeric conversions [D + ?]

- Implicit **lossless widening** is allowed: `i8→i16→i32→i64`, `u8→u16→u32→u64`, `uN → i(2N)`, `i32/u32→f64`, `f32→f64`.
- Everything else needs `as` (truncating or saturating cast) or a `.to_*()` method that returns `Option` / `Result` (checked conversion).
- Overflow panics in debug builds and wraps in release builds [?].

### 9.6 Async and concurrency [D]

- `async fun f() -> T` makes the call `f()` return `Promise[T]`. The call **immediately schedules** the task on the work-stealing runtime; there is no `spawn` keyword and no function colouring at call sites.
- `await p` suspends until `p` resolves. `main` may `await` whether or not it is declared `async`.
- `Promise[T]` methods: `.then(#{…})`, `.catch(#{…})`, `.ignore()` (fire and forget; errors and panics are logged, not propagated), and the static `Promise.all(Vec[Promise[T]]) -> Promise[Vec[T]]`.
- `runtime.yield()` hands control back to the scheduler cooperatively.
- **Borrows and await [N]:** an async call with borrowed arguments (including a `&this` / `&mut this` receiver) must be **awaited in the same expression**: `await client.receive()`. Storing the `Promise` of such a call is `E_BORROW_ACROSS_SPAWN`. Pass owned values or `Ref` handles instead.
- Thread safety comes from these rules plus `Ref`; there are no `Send`/`Sync` marker interfaces.

### 9.7 Interfaces and dispatch [D]

- Static dispatch only (monomorphization) in v0.1.
- There are no interface-typed values (`Vec[Stringer]`) and no `any`.
- Variadic std functions such as `log.println(...args: T)` with `T: Stringer` are compiler intrinsics.

### 9.8 Errors and panics [D]

- Recoverable errors use `Result[T, E]` / `Option[T]`, propagated with `?` and `or`.
- `panic(msg)` and `assert(cond, msg)` are unrecoverable at the call site.
- `recover { … }` evaluates to `Result[T, PanicInfo]`: `Ok(block value)` normally, or `Err(info)` with message, file, line and package if the block panics.
- There is no `defer`. Resources are released by the compiler-inserted `Drop.drop(mut this)` at scope exit.

### 9.9 Heap and shared-state types [D]

| Type | Meaning | Key methods |
|---|---|---|
| `Box[T]` | unique heap allocation (recursive types) | `get()`, `set(v)` |
| `Ref[T]` | atomically ref-counted + RwLock (many readers / one writer) | `get() -> T` (clone), `read(#{…})`, `update(#{ v => … })` (v: `&mut T`), `clone()`, `weak()` |
| `Weak[T]` | non-owning `Ref`, to break cycles | `upgrade() -> Ref[T]?` |

```rust
let cfg = Ref(Config { host: "127.0.0.1", port: 8080 })
let worker_cfg = cfg                       // shares the handle (refcount 2)
cfg.update(#{ c => c.port = 9090 })
log.println(worker_cfg.get().port)         // 9090
```

### 9.10 Introspection [D]

- `T._get_info()` and `value._get_info()` are compile-time intrinsics that return `TypeInfo { name, kind, fields }`. Only fields visible at the call site are included, so private fields stay hidden from other packages.
- Methods whose names start with `_` are reserved for intrinsics.
- `std.json` builds its serializers on `_get_info()`, so no struct tags are needed. `impl Serializer for T` overrides that.

---

## 10. Prelude and std surface (sketch)

This section only fixes the names; the full std API is a separate document.

### 10.1 Prelude (available without imports)

`Option`/`Some`/`None`/`nil`, `Result`/`Ok`/`Err`, `Promise`, `Ref`, `Box`, `Weak`, `Vec`, `Map`, `Set`, `Array`, `Slice`, `assert`, `panic`, and the core interfaces below. Whether `log`/`println` are in the prelude is [?].

`Option`/`Result` helpers: `.or(v | #{…})`, `.is_some()`, `.is_none()`, `.is_ok()`, `.is_err()`, `.map(#{…})`, `.ok()`, `.err()`.

### 10.2 Core interfaces

```rust
inter Copy = {}
inter Clone = { fun clone(&this) -> Self }
inter Drop = { fun drop(mut this) }
inter Default = { fun default() -> Self }
inter Stringer = { fun to_string(&this) -> string }
inter PartialEq[T] = { fun eq(&this, other: &T) -> bool }        // == !=
inter PartialOrd[T]: PartialEq[T] = { fun partial_cmp(&this, other: &T) -> Ordering? } // < <= > >=
inter Hash = { fun hash(&this) -> u64 }                           // Map keys, Set items
inter Add[R, O] = { fun add(&this, rhs: R) -> O }                 // also Sub Mul Div Rem
inter AddAssign[R] = { fun add_assign(&mut this, rhs: R) }        // also Sub/Mul/Div/Rem-Assign
inter Index[I, T] = { fun index(&this, i: I) -> &T }              // x[i]
inter IndexMut[I, T] = { fun index_mut(&mut this, i: I) -> &mut T }   // x[i] = v, x[i] += v
inter Iterator[T] = { fun next(&mut this) -> T? }
inter Iterable[T] = {
    fun iter(&this) -> Iterator[&T]
    fun iter_mut(&mut this) -> Iterator[&mut T]
    fun into_iter(this) -> Iterator[T]
}
```

- `for x in c` calls `c.iter()` (yielding `&T`).
- `for x in c.iter_mut()` and `for x in c.into_iter()` are explicit.
- Pipelines (`.map`, `.filter`, …) on a collection call `.iter()` implicitly.

### 10.3 Naming conventions for std [D]

- `len()` (not `size`/`length`), `has()` (membership or substring), `get()` → `Option`.
- `at(i)` allows negative indexing. `x[i]` panics when out of bounds.
- `strip_suffix()` returns `Option`. `substring()` is for strings and `slice()` for Vecs.

---

## 11. Diagnostics (parser and resolver set)

| Code | Meaning |
|---|---|
| `E_UNMATCHED_DELIMITER` | missing or mismatched closer |
| `E_SIGIL_SHADOWS_BINDING` | `a[`, `t(` etc. used where a binding with that name is visible |
| `E_ANGLE_GENERICS` | `Vec<T>` or `f<T>(x)`: fix-it `Vec[T]` / `f.[T](x)` |
| `E_ARROW_CLOSURE` | `(a) => …` or `fun(x) {}`: fix-it `#{ a => … }` |
| `E_CAPTURE_NOT_GLUED` | `#[x] {`: `{` must touch `]` |
| `E_IT_IN_NAMED_CLOSURE` | `it` used in a closure that has named params |
| `E_NON_ASSOCIATIVE_OPERATOR` | `a < b < c`, `1..2..3` |
| `E_INVALID_ASSIGNMENT_TARGET` | assignment to a non-place |
| `E_INVALID_PATTERN` | malformed pattern |
| `E_BARE_TUPLE` | `(a, b)` used as a tuple: fix-it `t(a, b)` |
| `E_BARE_BRACE_LITERAL` | `{ k: v }` where a literal was intended: fix-it `_{…}` / `r{…}` / `m{…}` |
| `E_STRUCT_LITERAL_IN_HEADER` | `if x == P { … }` with struct literal `P {…}` |
| `E_RESERVED_OPERATOR` | `++`, `--`, `??`, `~` |
| `E_ATTRIBUTES_RESERVED` | `@attr` before an item |
| `E_GLOBAL_VAR` | top-level `var` |
| `E_CANNOT_INFER_STRUCT_TYPE` | `_{}` with no expected type |
| `E_CANNOT_INFER_GENERIC` | generic argument not inferable: fix-it `.[T]` |
| `E_INVALID_BLOCK_VALUE` | block value doesn't match the expected type |
| `E_CLOSURE_ESCAPES_BORROW` | borrowing closure used where an escaping one is required |
| `E_UNLISTED_CAPTURE` | local used but missing from the explicit capture list |
| `E_BORROW_ACROSS_SPAWN` | un-awaited async call holding borrows |

---

## 12. Grammar summary (EBNF)

```text
file          = package_decl { import } { item } ;
package_decl  = "package" ident { "." ident } ;
import        = "import" [ "pub" ] STRING [ "as" ident ] ;

item          = { attr } [ "pub" ] ( fun_decl | type_decl | union_decl | inter_decl
                                   | impl_decl | let_decl | extern_decl ) ;
generic_params= "[" generic_param { "," generic_param } [","] "]" ;
generic_param = ident [ ":" bound ] ;
bound         = type_path { "&" type_path } ;

fun_decl      = [ "async" ] "fun" ident [ generic_params ]
                "(" [ receiver [ "," ] ] [ params ] ")" [ "->" type ] block ;
receiver      = [ "&" [ "mut" ] | "mut" ] "this" ;
params        = param { "," param } [ "," ] ;
param         = [ "mut" ] ident ":" type | "..." ident ":" type ;

type_decl     = "type" ident [ generic_params ] "=" ( struct_body | type ) ;
struct_body   = "{" { field sep } "}" ;
field         = [ "pub" ] ident ":" type ;
union_decl    = "union" ident [ generic_params ] "=" "{" { variant sep } "}" ;
variant       = ident [ "(" type { "," type } ")" | struct_body ] ;
inter_decl    = "inter" ident [ generic_params ] [ ":" bound ] "=" ( inter_body | bound ) ;
inter_body    = "{" { fun_sig sep } "}" ;
fun_sig       = [ "async" ] "fun" ident [ generic_params ] "(" [ receiver [","] ] [ params ] ")" [ "->" type ] [ block ] ;
impl_decl     = "impl" [ generic_params ] [ type_path { "," type_path } "for" ] type "{" { item } "}" ;
let_decl      = "let" ident [ ":" type ] "=" expr ;
extern_decl   = "extern" STRING "{" { [ "pub" ] fun_sig sep } "}" ;

block         = "{" { stmt } "}" ;
stmt          = let_stmt | var_stmt | short_decl | for_stmt | item_in_block | expr [ ";" ] ;
let_stmt      = "let" pattern [ ":" type ] "=" expr [ "else" block ] ;
var_stmt      = "var" ident [ ":" type ] "=" expr ;
short_decl    = ident ( ":=" | ":==" ) expr ;
for_stmt      = [ ident ":" ] "for" ( block
                                    | "let" pattern "=" expr block
                                    | pattern [ "," pattern ] "in" expr block
                                    | expr block ) ;

expr          = pratt( prefix, infix, postfix )         (* precedence table §3 *)
primary       = literal | ident | "this" | "Self" | "(" expr ")"
              | vec_lit | array_lit | tuple_lit | record_lit | map_lit | set_lit
              | inferred_lit | tagged_lit | struct_lit | closure
              | if_expr | match_expr | unsafe_block | recover_block | block
              | "return" [ expr ] | "break" [ ident ] [ expr ] | "continue" [ ident ] ;
postfix       = "." ( ident | INT ) | "?." ident | ".[" type_args "]"
              | "(" [ args ] ")" | "[" expr "]" | "?" ;
closure       = [ "#[" [ capture { "," capture } ] "]{" | "#{" ]   (* "]{" glued *)
                [ closure_head "=>" ] { stmt } "}" ;
capture       = [ "&" [ "mut" ] ] ident ;
closure_head  = cparam { "," cparam } [ "->" type ] ;
cparam        = [ "mut" ] ident [ ":" type ] ;
if_expr       = "if" ( expr | "let" pattern "=" expr ) block [ "else" ( if_expr | block ) ] ;
match_expr    = "match" [ expr ] "{" { arm sep } "}" ;
arm           = ( pattern [ "if" expr ] | expr ) "=>" ( expr | block ) ;   (* expr arm only in subject-less match *)
or_expr       = expr "or" [ ident "=>" ] ( expr | block ) ;

sep           = "," | NEWLINE ;
```

---

## 13. Parser test corpus (minimum set)

Each case checks the token stream, the AST shape, the spans and the expected diagnostics.

```rust
t.0.1                    // tuple index chain
1..10   1..=10   ..5     // ranges
1.to_string()            // int then member
a[0]    a [0]            // array literal vs index
t(1)    t (1)            // tuple vs call
fun t[T]() {}            // no-glue after `fun`
x.a[0]                   // no-glue after `.`
Vec[Map[string, Vec[User?]]]   // nested type args
json.parse.[User](s)     // explicit generics
Vec.[u8].new()           // generic type then static member
Box.[i32]{ value: 1 }    // generic struct literal
a<b   a < b   a>>b       // always comparison/shift
'1{ id: 1 }   '1'        // tag vs char
r{ a: 1 }   r"raw\n"     // record vs raw string
x.or(1)   x or 1   x or e => Err(e)
await f()?   await f()?.name   (await f()).trim()
user?.name   (user?).name
#{ it * 2 }   #{ it1 + it2 }
#{ x, y => x + y }   #{ x: i32 -> i32 => x * 2 }
#{ f() or e => log(e) }  // no header: `or` stops the scan
#[n]{ it + n }   #[&cfg]{ cfg.port }   #[&mut total]{ total += it }
#[x] { }                 // E_CAPTURE_NOT_GLUED
(a) => a                 // E_ARROW_CLOSURE
Vec<int>                 // E_ANGLE_GENERICS
for { }   for i < 3 { }   for x in xs { }   for k, v in m { }   for let Some(x) = it.next() { }
outer: for x in xs { break outer }
match { a > 1 => 1, _ => 0 }
match n { x if x > 5 => x, _ => 0 }
let t(w, h) = dims()
let Ok(v) = r else { return }
if x == P { }            // P not parsed as a struct literal
let s = """
    multi ${name}
    """
foo
(bar)                    // two statements (R3)
user
    .profile             // one chained expression
```

Target: ≥ 60 tests before starting the type checker.

---

## 14. Deferred (not in v0.1)

1. Dynamic dispatch / interface-typed values, and `any`.
2. Associated types; `where` clauses; const generic params beyond `Array[T, N]`.
3. Default parameter values, named arguments, and destructuring parameters.
4. Range indexing (`v[1..3] → Slice[T]`).
5. Expression-bodied functions (`fun f(x: int) -> int => x * 2`).
6. Init-captures (`#[cfg = cfg.clone()]{…}`).
7. Attributes (`@test`, `@inline`) and user macros.
8. Unicode identifiers.
9. Custom operators.
10. Trailing-closure syntax.
11. Positional struct construction (`Config("0.0.0.0", 3000)`).
12. Record mutation helpers (`.patch()`, `.set(key, v)`).
13. Signals / channels (pub-sub, MPSC).
14. Tooling: linter, test runner, LSP, doc generator, debugger.

---

## 15. Rewrites for existing docs and samples

| Old | New |
|---|---|
| `(n) => n * 2`, `(a, b) => { … }` | `#{ it * 2 }`, `#{ a, b => … }` |
| `fun(file_path) { … }` | `#{ file_path => … }` |
| `#[growable]{x => growable.push(x)}` | `#[&mut growable]{ x => growable.push(x) }` |
| `#[items, scale](x) => …` | `#[&mut items, scale]{ x => … }` |
| `(a: i32, b: i32) -> i32 { … }` | `#{ a: i32, b: i32 -> i32 => … }` |
| `Vec<T>`, `fun f<T>`, `impl<T> X<T>` | `Vec[T]`, `fun f[T]`, `impl[T] X[T]` |
| `json.parse<T>(s)`, `parse::<T>(s)`, `json.parse[T](s)` | `json.parse.[T](s)` |
| `List.new<u8>()` | `Vec.new.[u8]()` |
| `type R = \| Ok(T) \| Err(E)` | `union R = { Ok(T)  Err(E) }` |
| `union R[T,E] = { … info: string[T] }` | the field type `string[T]` is invalid (`string` isn't generic) |
| `while cond { }`, `loop { }`, `while true` | `for cond { }`, `for { }` |
| `while let Some(x) = …` | `for let Some(x) = … { }` |
| `match age { age > 18 => … }` | `match { age > 18 => … }` |
| `` r`C:\x` `` | `r"C:\x"` |
| `v[1, 2]` | `[1, 2]` [?] |
| `let (w, h) = …`, `-> (int, int)` | `let t(w, h) = …`, `-> t(int, int)` |
| `{ host, port }`, `User.new2({…})` | `_{ host, port }`, `User.new2(_{…})` |
| `let m = { "a": 1 }` | `m{ "a": 1 }` |
| `int32`, `int64`, `List<T>` | `i32`, `i64`, `Vec[T]` |
| `mut self`, `self` | `mut this`, `this` |
| `inter<Self> Default` | `inter Default` (`Self` is implicit) |
| `fun f(): T`, `inline fun` | `fun f() -> T`, `@inline` (deferred) |
| `res: = recover{}` | `res := recover { }` |
| `Type(conf)`, `KeyOf(TypeOf(m))` | `TypeOf(conf)`, `KeyOf[TypeOf(m)]` |
| `and`, `not`, `none`, `some()` | `&&`, `!`, `None`/`nil`, `Some()` |
| `namespace std.sys { }` | `package std.sys` |
| `Result<nil, string>` | `Result[void, string]` |
| `local_no = 20` (new var) | `local_no := 20` |

---

## 16. Open questions (each has a working default)

| # | Question | Default used in this draft |
|---|---|---|
| 1 | Vec literal: `[1,2]` or `v[1,2]` (your newest samples use `v[`) | **`[1,2]`**. Now that generics use `.[`, a prefix `[` is unambiguous, and `v` is a very common binding name (`#{ k, v => v[0] }`) that `v[` would break. |
| 2 | `int` = `i32`, or platform width (notes_1) | `i32` (spec-v1/v2 decision) |
| 3 | Is `union` + block body acceptable in place of `type X = \| A \| B`? | yes (from sample1.ms) |
| 4 | Go-style `for` only, dropping `while`/`loop`? | yes (from sample2.ms) |
| 5 | `r"…"` raw strings in place of `` r`…` `` | `r"…"` (from sample1.ms) |
| 6 | Borrowed vs owned function types (`&(T)->U` non-escaping, `(T)->U` escaping) as the escape-analysis mechanism | yes (§9.4) |
| 7 | Implicit capture = shared borrow only; mutation needs `#[&mut x]` | yes |
| 8 | Once a capture list is present, it must be complete | yes |
| 9 | `json.parse` returns `T?` (as in your example) or `Result[T, ParseError]` | `T?` in examples; I'd recommend `Result` for the std API so callers get an error message |
| 10 | `log`/`println` in the prelude | `log` is prelude; `println` is not |
| 11 | Default method bodies in `inter` | allowed (grammar permits an optional block) |
| 12 | `'N{}` tags: numeric shape groups (`'1`, `'2` …) | yes; same N in one literal context → same type |
| 13 | Missing record fields auto-fill | only `T?` fields become `None`; the rest are required |
| 14 | Overflow | panic in debug, wrap in release |
| 15 | Orphan rule | `impl X for T` only in the package owning `X` or `T` |
| 16 | Entry point | `fun main()` in `package main`; the folder-name rule is relaxed for `main` |
