# MinScript Language Specification — v0.4

**Status:** draft, self-contained. It replaces the v0.2 spec (`minscript/docs/spec.md`) and the v0.4 design note [`spec_04_ai.md`](spec_04_ai.md). The design note keeps the reasoning behind the v0.4 changes; this document is the reference.
**Implementation:** `ms_04/src/` (TypeScript, Node ≥ 23.6, no runtime dependencies).
**Date:** 2026-11-09

Legend: **[D]** decided. Anything marked otherwise, or listed in §22, uses its proposed default until it is decided.

---

## 0. Overview

MinScript aims for TypeScript's concision, Rust's safety without lifetime annotations, and Go's simplicity, with a compiler that stays fast and small.

**v0.4 is a value-semantics language with inferred sharing.** Every parameter is `T` (read) or `*T` (write). The compiler infers what each function reads, writes and keeps, per access path, and uses that to choose the mechanism: borrow, move, share, copy or lock. References never need lifetimes, because a stored reference is a counted share, not a borrow.

### 0.1 Principles [D]

The language exposes **intent** (read, write, shared); the compiler chooses **mechanism** (borrow, move, share, copy, lock).

1. **Two access modes.** A parameter is read (`T`) or written (`*T`). Nothing else appears in signatures.
2. **Values, not places.** Assignment, passing and storing have value semantics. Physically they are moves or counted shares; a real copy happens only on a write to a shared buffer.
3. **No stored borrows.** Borrows are an optimisation the compiler makes, never something a type can contain. This is the single rule that removes lifetimes.
4. **Mutation through many owners is declared.** `shared` marks it, once, at the declaration. Everything else has one owner.
5. **Silent copies are linted, never forbidden.** Concise code compiles; the linter shows where a copy-on-write would fire and how to avoid it.
6. **Unknown aliasing is conservative.** Dynamic calls and unknown indices widen to whole-object effects. Recursion is analysed precisely, up to a safety cap (§15).
7. **Parsing is purely syntactic.** It never needs types, symbols or interfaces.

### 0.2 Compile-speed budget [D]

Every analysis must be one of:

- local to one function body (linear in its size), or
- a bottom-up pass over the call graph in strongly-connected-component order, consuming fixed-size summaries.

Generic code is compiled once per definition, never once per type argument (§15.4). No analysis may solve constraints across the whole program, infer lifetime parameters on types, or iterate more than its summaries can grow: a fixpoint is allowed only over the finite summary lattice (paths have at most 4 segments, §9.5), so the number of rounds is bounded by summary size, not by program size. A feature that cannot meet this budget is out of the language.

### 0.3 Pipeline

1. **Lexer:** tokens with spans, trivia, `ws_before` / `nl_before` flags and the matching-delimiter index (§1).
2. **Parser:** a purely syntactic AST (§2–§8, grammar in §19).
3. **Name resolution:** scopes, packages, imports (§8.7).
4. **Type checker:** bidirectional inference, generics, interfaces (§13.5).
5. **Lowering** to HIR with explicit places (`user.tags[*]`).
6. **Effect summaries**, bottom-up by SCC (§9.5, §15).
7. **Access check:** `*` overlap, write views, concurrent statements, `Unique` moves.
8. **Mechanism selection:** view, move, share or copy for each use; heap promotion; `shared` lowering.
9. **Lints.**
10. **Back ends:** JS first (§16), then WASM and native.

---

## 1. Lexical structure

### 1.1 Source [D]

- UTF-8. CRLF counts as one newline, and becomes LF inside string values. A BOM is skipped.
- Identifiers are ASCII. Any other character outside strings and comments is `E_UNKNOWN_CHARACTER`.

```ts
type Token = {
    kind: TokenKind     // keywords, punctuators and sigils use their own text ("let", "??=", "r{");
                        // otherwise Ident, Int, Float, String, RawString, Char, Byte,
                        // TemplateHead, TemplateMiddle, TemplateTail, EOF
    start: number       // byte offsets into the UTF-8 source; a line table gives 1-based
    end: number         //   line / col on demand (col counts code points)
    wsBefore: boolean   // whitespace or a comment directly before
    nlBefore: boolean   // a newline since the previous token (one inside a block comment counts)
    match?: number      // openers: index of the matching closer
    value?: string | bigint | number   // Ident name, Int (bigint), Float, cooked String / Char text, Byte value
    multiline?: boolean // String / Template*: written with """
    synthetic?: boolean // a zero-width closer the lexer inserted for balance (below)
}
```

- Comments are trivia, kept in a side list for the formatter and the LSP.
- Newlines are not tokens. The parser applies §5.4 using `nlBefore`.
- Reserved and removed keywords (§1.4) lex as keywords, so the parser can report them with a fix-it.
- **Delimiters are balanced by the lexer.**
  - Every opener (sigils included) records its matching closer in `match`.
  - A closer that doesn't match the innermost opener is reported once (`E_UNMATCHED_DELIMITER`).
  - If it closes an outer opener, the inner ones are reported as unclosed. Otherwise it is lexed **as the expected closer**. A stray closer with nothing open is dropped.
  - Openers still unclosed at EOF are each reported.
  - Every unclosed opener gets a zero-width **synthetic** closer (and an unterminated template a zero-width `TemplateTail`), so the parser always sees a balanced stream and reports nothing more about it.

### 1.2 Comments [D]

```minscript
// line        /// doc (attaches to the next item or member)        /* block, /* nestable */ */
```

### 1.3 Identifiers [D]

`[A-Za-z_][A-Za-z0-9_]*`.

- A lone `_` is the wildcard.
- By convention `PascalCase` is used for types, variants and interfaces, `snake_case` for everything else, and `UPPER_CASE` for top-level constants (enforced by the linter).
- In patterns, an uppercase-initial identifier is a constructor or constant, and a lowercase one is a binding.

### 1.4 Keywords [D]

```text
Declarations: package import pub type union inter impl fn async let var extern
Control:      if else match select for in break continue return lock
Expressions:  await or as unsafe recover true false nil this Self
Type-level:   TypeOf
Contextual:   shared  (before `var`, or before a field name in a type body)
              once    (before a field name in a type body)
Removed:      fun mut              (reported with a fix-it: `fn`, and `*T` / `*this` / `var`)
Reserved:     while loop yield macro where dyn thread atomic
```

- **Contextual keywords** are identifiers everywhere else: a variable, a field or a package may be named `shared` or `once`. `shared` is a keyword only when the next token is `var`, `let`, or (in a type body) an identifier followed by `:`. The same holds for `once` before a field.
- **Implicit closure parameters:** `it`, and `it1`…`itN` (no leading zero). `it1 == it`. They are reserved identifiers.
- **Prelude names, not keywords:** `Ok Err Some None Result Option Promise Resolver Topic Queue Signal Sub Watcher Weak Vec Map Set Array Slice PMap PVec Symbol sym Identity Unique log assert panic Panic PanicKind all race`.
- **A keyword after `.` or `?.` is a plain identifier:** `x.or(5)`, `r.in(x)`, `m.lock()`.

### 1.5 Literals [D]

**Integers:** `123`, `1_000`, `0xFF`, `0b1010`, `0o17`.

- No suffixes. Radix prefixes are lowercase (`0x`, `0o`, `0b`). `_` may only sit between digits (`1_000`, not `1_` or `0x_F`).
- Identifier characters glued to a number make it invalid: `0b102`, `12px` and `1e` are each one `E_INVALID_NUMBER` token.
- The default type is `int`. Out-of-range values are a compile error.

**Floats:** `1.5`, `1e9`, `2.5e-3`, `1_000.5`.

- `.5` and `5.` are not valid. The default type is `f64`; a float adopts `f32` when that type is expected.

**Number lexing:**

1. After a digit run, `.` belongs to the number only when a digit follows: `1..10` lexes as `1` `..` `10`, and `1.to_str()` as `1` `.` `to_str`.
2. When the previous token is a member `.` (or `?.`), only digits are lexed: `t.0.1` lexes as `t` `.` `0` `.` `1`.
3. A `.` followed by a digit, after a token that can't end an expression, is the invalid float `.5` (`E_INVALID_NUMBER`, fix-it `0.5`). After a value it is member access: `t.5`.

**Booleans and absence:** `true`, `false`, `nil`. `nil` is a keyword alias of `None`.

**Characters:** `'a'`, `'\n'`, `'\u{1F600}'`. Type `char` is a Unicode scalar value.

- `''`, `'ab'` and an unclosed `'a` are `E_INVALID_CHAR`, each lexed as one token.
- The removed tagged-record form `'1{` is `E_TAGGED_RECORD_REMOVED`, lexed as `r{` for recovery.

**Strings:**

- `"…"` is single-line.
- Escapes: `\n \r \t \0 \\ \" \' \$ \xNN \u{…}`.
  - `\xNN` is ASCII only (00–7F) in strings and chars.
  - `\u{…}` takes 1–6 hex digits and must be a Unicode scalar value.
  - Anything else is `E_INVALID_ESCAPE`, and the character is kept.
- Interpolation is `${expr}`. The lexer keeps a mode stack.
  - `"a${x}b${y}c"` lexes as `TemplateHead("a") x TemplateMiddle("b") y TemplateTail("c")`.
  - Braces, strings and closures nest freely inside `${…}`.
  - Template tokens are always balanced: an unterminated template gets a zero-width `TemplateTail`.
  - A `$` not followed by `{` is literal; so is `\${`.
- `"…"` strings end on the line they start, **interpolations included**. A newline inside `"…${…` is `E_UNTERMINATED_STRING`. Use `"""` for multi-line text.
- `"""…"""` is multi-line, and interpolations inside it may span lines.
  - If only whitespace follows the opening `"""` on its line, that first newline is dropped.
  - If the closing `"""` is on a line of its own, that line's whitespace is the indentation stripped from every line, and the line itself is dropped. If the closing `"""` follows text, nothing is stripped.
  - A line indented less than the closing line loses only the whitespace it shares with it.
  - Indentation is measured on the source text. Escapes such as `\t` or `\n` are never stripped and never count as line breaks.
  - A lone `"` or `""` inside is literal. The first `"""` closes the string.
- **Raw strings:** `r"C:\path"`. No escapes or interpolation, may span lines, cannot contain `"`.

### 1.6 Byte literals [D]

Lexers and protocol code scan `bytes()` (§16.1), so they compare `u8`s against characters. `b'x'` is a literal of type `u8`:

```minscript
fn is_digit(c: u8) -> bool { c >= b'0' && c <= b'9' }

match c {
    b' ' | b'\t' | b'\r' => {}
    b'a'..=b'z' | b'A'..=b'Z' | b'_' => ident(start)
    _ => {}
}
```

- **Content:** one ASCII character, or one of the escapes `\n` `\r` `\t` `\0` `\\` `\'` `\"` `\xHH` (any byte, `00`–`FF`). A non-ASCII character such as `b'é'` is `E_BYTE_LITERAL_NOT_ASCII`, because it is several bytes in UTF-8: use `\xHH` for a single byte, or a `str`. Other escapes are `E_INVALID_ESCAPE`. `b''`, `b'ab'` and an unclosed `b'a` are `E_INVALID_CHAR`.
- **Type:** always `u8`. Byte literals work in expressions, in patterns and as range bounds (`b'a'..=b'z'`).
- **Lexing:** `b` followed immediately by `'` starts a byte literal, under the same glue rules as the sigils (§1.7). With a space between them (`b 'x'`) the tokens are the name `b` and a char literal. No valid code puts a name directly before a char literal, so the rule is unambiguous.
- `'x' as u8` stays valid. Byte strings (`b"GET "`) are deferred (§22).
- On JS a byte literal is a `number` constant.

### 1.7 Glued sigil tokens [D]

These lex as single tokens only when glued, and only when the letter is a whole identifier:

| Token | Meaning | Valid in |
| --- | --- | --- |
| `r{` | anonymous record literal / record type | expr, type, pattern |
| `m{` | map literal | expr |
| `s{` | set literal | expr |
| `t(` | tuple literal / type / pattern | expr, type, pattern |
| `a[` | fixed array literal | expr |
| `_{` | inferred struct / record literal | expr |
| `#{` | closure | expr |
| `#[` | attribute (§8.6); in an expression, the removed capture list (`E_CAPTURE_LIST_REMOVED`) | item, member |
| `.[` | explicit generic arguments | expr (postfix) |
| `r"` | raw string | expr |
| `b'` | byte literal (§1.6) | expr, pattern |

- **No-glue contexts:** a letter is not a sigil when the previous token is `.`, `?.`, `fn`, `type`, `union` or `inter`.
- **Collisions:** `a[0]` is an array literal and `a [0]` indexes `a`; `t(1)` is a tuple and `t (1)` calls `t`. The resolver reports `E_SIGIL_SHADOWS_BINDING` when the letter of `a[`, `t(`, `r{`, `m{` or `s{` names a visible variable, parameter, function or import. `b'` and `r"` are exempt: a name directly before a char or string literal is never valid code, so they can't be misread.
- **Vec literals are plain `[…]`.** In prefix position `[` is a literal; in postfix position it indexes.

### 1.8 Operators and punctuation [D]

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
Other:       .  ,  :  ;  ( ) [ ] { }
Reserved:    ~  ++  --     (lexed, always a parse error with a hint)
```

- Generics never use `<` / `>`, so maximal munch is always correct and no token splitting is needed.
- `*` is multiplication in expressions and the write mode in parameter lists (§8.3). The two never share a position.
- There are no prefix `&` or `*` operators: v0.4 has no borrow or dereference syntax (`E_BORROW_REMOVED`, §18). Raw pointers are `unsafe.Ptr[T]` with methods.
- `@` is not a token (`E_UNKNOWN_CHARACTER`); attributes are `#[…]` (§8.6).

---

## 2. Generics [D]

### 2.1 Parameters: `[…]` after the declared name

```minscript
fn identity[T](value: T) -> T { value }
fn largest[T: PartialOrd[T]](items: Vec[T]) -> T { … }
type Pair[A, B] { first: A, second: B }
union Response[T, E] { Success(T)  Failure(E) }
inter Convert[From, To] { fn convert(this, v: From) -> To }
impl[T] Pair[T, T] { … }
```

- Bounds use `:`, with `&` for several: `[T: Reader & Writer]`.
- `[T: Unique]` admits `Unique` types (§9.2); without it a type parameter is non-Unique.
- There is no `where` clause. Const parameters are deferred; the built-in `Array[T, N]` takes an integer literal.

### 2.2 Type position: `Name[Args]`

```minscript
Vec[int]   Map[str, Vec[User?]]   Promise[Result[User, str]]   Array[i32, 4]
```

The `[` must be glued to the name.

### 2.3 Expression position: `.[Args]`

Only needed when inference can't determine the types:

```minscript
let user = json.parse.[User](json_text)     // Result[User, json.Error]
let v    = Vec.new.[u8]()
let v2   = Vec.[u8].new()
let b    = Pair.[int, str]{ first: 1, second: "a" }

let u: Result[User, json.Error] = json.parse(json_text)   // inferred from the expected type
```

- `.[` is one postfix token and produces `GenericApply { target, args }`. It may not start a new line.
- When inference fails, `E_CANNOT_INFER_GENERIC` suggests `.[T]`.

---

## 3. Operators and precedence [D]

Tightest first:

| # | Operators | Assoc | Notes |
| --- | --- | --- | --- |
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
| 13 | `??` | right | mixing with `&&` / `\|\|` needs parentheses (`E_MIXED_NULLISH`) |
| 14 | `..` `..=` | none | |
| 15 | `or` | left | §4.6 |
| 16 | `=`, compound assignments, `??=` | right | assignment evaluates to `void` |

- `return`, `break` and `continue` are expressions of type `never`.
- The left side of an assignment must be a place: a name, a field, an index, or a chain of them (`E_INVALID_ASSIGNMENT_TARGET`).

### 3.1 `await` and `?`

The operand of `await` is a postfix chain up to the first `?` or `?.`. After that, the postfix loop continues on the awaited value.

```minscript
await read_file(p)?          // (await read_file(p))?
await get_user()?.name       // ((await get_user())?.name)
(await fetch()).trim()
```

### 3.2 `?`, `?.` and `??`

| Form | When the value is absent (`None` / `Err`) | Result |
| --- | --- | --- |
| `x?` | **returns** it from the enclosing function or closure | `T` |
| `x?.name` | the whole chain becomes `None` | `U?` |
| `x ?? y` | evaluates `y` (**lazily**) | `T`, or `T?` if `y: T?` |
| `x.or(y)` | `y` (evaluated eagerly; pass `#{…}` for lazy) | `T` |
| `x or y` | evaluates `y` and **returns it** from the function | `T` |

- `??` works on `Option[T]` and `Result[T, E]`; on a `Result` the error is discarded. `a ?? b ?? c` chains.
- `x ??= v` assigns when `x` (a `var` of type `T?`) is `None`.
- In type position `T?` means `Option[T]`, and `T??` is an error.

```minscript
let name  = user?.profile?.name ?? "anonymous"
let port  = env.get("PORT")?.to_int() ?? 8080
let token = cache.get(key) ?? fetch_token()        // fetch_token() runs only on a miss
```

### 3.3 `as`: type annotation and cast

`expr as T` has two meanings, chosen by the type checker. The parser always produces the same node, `As { expr, type }`.

1. **Type annotation** (no runtime cost): `expr` is checked with `T` as its expected type. If that succeeds, `as` only fixes the type. This is how values get a type that their value alone can't give: empty collections (`[]`, `m{}`, `s{}`), `nil`, numeric literals, `_{…}`, and generic calls inferred from their return type.
2. **Cast:** if the annotation fails and both `expr`'s type and `T` are numeric, it is a truncating / saturating cast. Any other case is `E_INVALID_CAST`.

```minscript
g := [] as Vec[Map[str, int]]             // annotation: the value comes first, then its type
var seen = s{} as Set[u64]
cache :== m{} as Map[str, User]
owner := nil as User?
timeout := 500 as u16                     // literal annotation (no conversion happens)
cfg := _{ host: "localhost", port: 80 } as Config
user := json.parse(raw) as Result[User, json.Error]   // instead of json.parse.[User](raw)

let small = big_number as u8              // cast: i64 → u8, truncating
let ratio = count as f64 / total as f64   // casts
```

- `let g: Vec[Map[str, int]] = []` and `g := [] as Vec[Map[str, int]]` mean the same thing. Annotations suit declarations where the type matters most; `as` suits places where the value matters most.
- `as` binds tighter than arithmetic, and its type operand is parsed greedily, `?` included: `x as i32?` is `x as Option[i32]`. The type after `as` has no `&` intersection, so `flags as u8 & MASK` is `(flags as u8) & MASK`.

---

## 4. Expressions

### 4.1 Blocks [D]

A block evaluates to its last expression when that expression has no trailing `;`. A trailing `;` discards the value. `return` is always available and never required.

```minscript
fn a() -> int { 5 }       // 5
fn c() -> int { 5; }      // E_INVALID_BLOCK_VALUE
```

### 4.2 Bare `{` is always a block [D]

There is no bare literal. `{ "a": 1 }` and `{ host: x }` are `E_BARE_BRACE_LITERAL`, with a fix-it to `m{}`, `r{}` or `_{}`.

**Struct literals:** `Path {` starts a struct literal only when:

- the path's last segment is PascalCase (`User {`, `models.User {`, `Payment.Card {`, `Pair.[int, str]{`);
- the `{` is on the same line; and
- the literal is not directly in an `if` / `for` / `match` / `lock` header.

Otherwise the `{` begins a block. In a header, `if x == P { a: 1 } { … }` is `E_STRUCT_LITERAL_IN_HEADER`; wrap the literal in parentheses: `if x == (P { a: 1 }) { … }`.

### 4.3 Literals [D]

```minscript
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
- Record and struct-literal keys are names, or (records only) strings: `r{ "content-type": "json" }`. A keyword followed by `:` is also accepted as a key (`r{ type: "user" }`). Any other key is `E_INVALID_RECORD_KEY`.
- `name` alone is shorthand for `name: name`.
- `...expr` spreads into every literal kind, and into call arguments that bind a variadic parameter (`log.println(prefix, ...args)`).
- `_{}` without an expected type is `E_CANNOT_INFER_STRUCT_TYPE`; it doubles as the named-arguments form: `serve(_{ host, port })`.
- Empty literals need a type from somewhere: an annotation, the context, or `as` (`[] as Vec[int]`).
- There is no bare `(a, b)` tuple: write `t(a, b)` (`E_BARE_TUPLE`).
- Records with the same shape are the same type, so arrays of records need no tagging:

```minscript
let routes = [
    r{ name: "TRM", lat: -1.2194, volume: 80 },
    r{ name: "Kasarani", lat: -1.2288, volume: 100 },
]   // Vec[r{ name: str, lat: f64, volume: int }]
```

### 4.4 Closures [D]

`#{…}` is the only closure syntax. Captures are always inferred (§9.9); there are no capture lists.

```minscript
#{ it * 2 }                         // implicit: it == it1, it2 … itN
#{ compute_default() }              // zero params
#{ n, idx => n > 50 }               // named params
#{ x: i32, y: i32 -> i32 => x + y } // typed params + return type
#{ var acc, cur => acc += cur; acc } // `var`: a mutable local copy of the parameter
#{ it.qty += 24 }                   // writes through a `(*Item) -> R` parameter (§9.4)
#{ n =>
    sq := n * n
    sq + 5                          // last expression is the value
}
```

**Parsing the header** (bounded scan, no backtracking):

- After `#{`, scan at depth 0 (skipping bracket groups with the matching-delimiter index).
- If `=>` is reached, and every token before it is one of `ident var , : * -> ? . _` or a skipped group, that prefix is the **parameter header**. (`mut` and `&` are also accepted by the scan, so the parser can report them: `E_MUT_REMOVED`, `E_BORROW_REMOVED`.)
- If the scan reaches a newline, `;`, `}` or any other token first (`or` included), there is **no header**. So the header must be on the closure's first line (`E_CLOSURE_HEADER_LINE` when a header-like prefix continues onto the next line).

```text
closure_param := ['var'] ident [':' ['*'] Type]
```

**Rules:**

- `it` / `itN` may only be used in header-less closures (`E_IT_IN_NAMED_CLOSURE`). In nested closures the innermost `it` wins, and the linter warns.
- A closure may take fewer parameters than its function type supplies.
- A closure parameter takes its mode from the expected function type: with `f: (*T) -> R`, `#{ n => n += 1 }` writes the caller's value. Writing a read-mode parameter is `E_WRITE_TO_IMMUTABLE`. `var p` makes a local copy that may be written.
- `return` inside a closure returns from the closure.
- Closures are passed inside `(…)`; there is no trailing-closure syntax.
- `#[x]{ … }` is the removed v0.2 capture list: `E_CAPTURE_LIST_REMOVED`, fix-it: drop the list. The closure is then parsed as `#{ … }`.

### 4.5 Control-flow expressions [D]

```minscript
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

let res = recover { risky() }     // Result[T, Panic] (§13.3)
let fd = unsafe { open(path, 0) } // unsafe block (§8.6)
```

- `if` without `else` is `void`. `match` must be exhaustive.
- **Labels:** in `break x` / `continue x`, `x` is a label only if an enclosing loop declares it (`x: for …`). Otherwise `break x` breaks with the value `x`. Labels are lexical, so the parser decides this.
- Arms are separated by commas or newlines. An arm body is an expression or a block.
- Ranges: `a..b`, `a..=b`, `..b`, `a..`.

### 4.6 `or`: unwrap or return [D]

```minscript
expr or RHS
expr or name => RHS
```

- `Ok(v)` / `Some(v)` evaluates to `v`.
- `Err(e)` / `None` evaluates RHS and **returns it from the enclosing function or closure**.
- `it` is the error payload; `or e => …` names it instead.
- RHS may be an expression, a block, `return …`, `break` or `continue`. A block RHS that ends in `return`, `break` or `continue` leaves accordingly.

```minscript
let bytes = await fs.read_file(path) or Err("IO failed: ${it}")
let user  = find_user(id) or e => { log.println(e); Err(e) }
let line  = lines.next() or break
```

The linter flags `x or <literal>` when the literal doesn't match the function's return type, since `??` was probably meant.

### 4.7 Truthiness [D]

The values allowed in an `if` / `for` condition and as operands of `&&`, `||` and `!` are:

| Type | true when |
| --- | --- |
| `bool` | `true` |
| `Option[T]` | `Some(_)` |
| `Result[T, E]` | `Ok(_)` |

```minscript
let res = json.parse.[User](s)
if res { … }                   // instead of res.is_ok()
if !cache.get(k) { … }
if user && user_is_admin { … }
```

- Ints, strings and collections are **not** truthy. Use `n != 0` and `s.is_empty()` (`E_NOT_TRUTHY`).
- `&&`, `||` and `!` always produce `bool`. Using `||` for a value fallback (`let x: str = a || b`) is `E_USE_NULLISH`, with a fix-it to `??`.
- Truthiness is a built-in rule, not a user-implementable interface, so a condition's meaning never depends on user code.
- The linter warns on `Option[bool]` in a condition, because `Some(false)` is truthy.
- When you need the payload, use `if let Ok(user) = res { … }`.

### 4.8 String interpolation [D]

`"${expr}"`. The value must implement `Stringer`, which is generated on demand (§13.2).

### 4.9 `select`: wait on several promises [D]

```minscript
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
- `else =>` is optional; it must be the last arm and may appear once (`E_SELECT_ELSE_NOT_LAST`). `select { }` is `E_SELECT_EMPTY`.
- `select` is an expression: its value is the value of the arm that ran.

**Semantics:**

1. **Start:** every arm's expression is evaluated top to bottom, and each must be a `Promise[T]` (`E_SELECT_ARM_NOT_PROMISE`). The select then waits until one of them completes.
2. **Choice:** if several arms are ready at once, **one is chosen at random** (fair, like Go). The value is matched against the arm's pattern, and that arm's body runs.
3. **Disabled arms:** a refutable pattern that doesn't match (`Some(job)` when the queue closed and `next()` returned `None`) **disables** that arm for this select, which keeps waiting on the others. If every arm is disabled, the `else` arm runs; without one, the select panics with `SelectExhausted`.
4. **`else`:** with an `else` arm the select doesn't wait: if no arm is ready immediately, `else` runs.
5. **Losing arms take nothing.** The std wait operations (`Sub.next`, `Queue.publish`, `Watcher.next`, `time.after`, network receives) are **cancel-safe**: a message is removed, or a slot used, only by the arm that wins.
6. **Promises of your own tasks are different.** Such a task is already running (§11.1). Losing a select only stops waiting for it; the task carries on, as if `.ignore()`d. Call `.cancel()` to stop it.
7. **Arm expressions count as awaited in the same statement** (§11.2), so `sub.next()` on a `var` subscription is fine. Two arms both calling `sub.next()` on the same subscription overlap on a written path (`E_CONCURRENT_OVERLAP`): use one arm per wait and `match` inside its body.
8. **`break` and `continue`** inside an arm refer to the enclosing loop. `select` is not a loop.

### 4.10 `lock` [D]

```minscript
lock account {
    account.balance -= 100
    account.transactions.push(tx)
}
lock from, to { from.balance -= n; to.balance += n }   // several cells
n := lock tokens { tokens.push(x); tokens.len() }       // an expression
```

- `lock` takes one or more places, each rooted in a `shared` binding or field (§10), then a block. The places are parsed like a `for` header: no struct literal at depth 0 (§4.2).
- The block's value is the value of the `lock` expression.
- The semantics (ordering, re-entrancy, `return` inside the block, `E_AWAIT_IN_LOCK`) are in §10.1.

---

## 5. Statements

### 5.1 Bindings [D]

```minscript
let name = expr          var name = expr
name := expr             name :== expr           // sugar for let / var
let name: T = expr       name := expr as T       // same meaning (§3.3)
let pattern = expr else { diverge }
shared var name = expr                           // a cell every holder sees (§10)
place = expr             place += expr           place ??= expr
```

- `:=` and `:==` take only a plain identifier (`E_SHORT_DECL_TARGET`, which also covers `let x := 1`).
- Assigning to an undeclared name is `E_UNDECLARED_ASSIGNMENT`; assigning to a `let` / `:=` binding is `E_ASSIGN_IMMUTABLE`.
- The `else` of `let … else` must diverge (`E_LET_ELSE_MUST_DIVERGE`).
- `shared let` is `E_SHARED_IMMUTABLE`: immutable values are already shared freely.
- **Mutable pattern bindings** use `var`: `if let Some(var u) = find(id) { … }`, `let t(var a, b) = pair`. `mut x` anywhere is `E_MUT_REMOVED`.
- **Redeclaring a parameter as `var`.** `var p = p` at the top level of a body, as the body's first use of `p`, makes a writable local copy of the parameter `p` (§9.4). It is the only exception to `E_DUPLICATE_BINDING` for parameters.

### 5.2 Destructuring and conditional patterns [D]

```minscript
let t(width, height) = get_dimensions()
let Ok(data) = res else { return Err("read failed") }
let User { id, name, .. } = user
if let Some(u) = find(id) { … }
```

### 5.3 Loops: `for` only [D]

```minscript
for { … }                          // infinite; `break value` makes it an expression
for count < 3 { … }                // conditional
for let Some(x) = iter.next() { }  // conditional pattern
for item in items { … }
for item, idx in items { … }       // Vec: (item, index); Map: (key, value)
for i in 0..10 { … }
for var line in lines { … }        // a writable copy of each item
for await msg in sub { … }         // async iteration: awaits `next()` each time
for await ready() { … }            // conditional loop whose condition awaits
outer: for row in grid { for c in row { if c < 0 { break outer } } }
```

How the parser classifies the header:

- `{` right after `for` is the infinite form.
- `let` right after `for` is the pattern form.
- Otherwise, scan to the header's `{` at depth 0: with an `in` keyword it is an iteration loop; without one it is a conditional loop.
- In an iteration loop, an `await` right after `for` makes it **async iteration**. In a conditional loop, `await` is just the start of the condition.
- `while` and `loop` are reserved: `E_RESERVED_KEYWORD` with a hint, parsed as `for`.

**Async iteration:**

- `for await x in e` requires `e: AsyncIterator[T]` (§14.2). Each step is `await e.next()`, and the loop ends at `None`.
- It is shorthand for `for { let Some(x) = await e.next() else { break }; … }`. When `e` is a place, it is written only during each `next()`, so the body may still use it (`sub.missed()`). Otherwise `e` is evaluated once into a hidden variable.
- A `Unique` iterator parameter that a `for await` advances is *consumed* (§9.2).
- It is only allowed where `await` is: in an `async fn`, or in `main`. The `await` keyword is required, so every suspension point stays visible.

### 5.4 Newlines and semicolons [D]

1. A statement ends at `;`, at a newline, or before `}` / EOF.
2. A newline does **not** end a statement when:
   - the previous token cannot end an expression (a binary operator, `,`, `.`, `?.`, `(`, `[`, `{`, `=`, `:=`, `:==`, `=>`, `->`, `:`, `as`, `or`, `??`, `await`, `!`, `#{`, `.[`, `lock`), or
   - the next token is `.`, `?.`, `&&`, `||`, `??`, `or`, `as`, `else`, `)`, `]`, `}` or `=>`.
3. A newline **does** end the statement when the next line starts with `(`, `[`, `{`, `-`, `+`, `*`, `&`, `!` or `.[`.
   - Any other binary operator at the start of a line (`/`, `==`, `<`, `|`, …) also ends the statement. The next line then has no left operand, which is `E_UNEXPECTED_TOKEN`: put the operator at the end of the previous line.
   - `.[` at the start of a line is `E_GENERIC_ARGS_NEWLINE` (still parsed as generic arguments, for recovery).
4. Postfix `(`, `[` and `.[` need `nlBefore == false`. `.` and `?.` may cross a newline.
5. Newlines are ignored inside `(…)` and `[…]`, but they matter again inside a nested `{…}`.
6. `return`, `break` and `continue` followed by a terminator take no value.
7. Opening braces of declarations and control flow (including `select` and `lock`) go on the header line (`E_OPEN_BRACE_NEWLINE`).
8. A trailing `;` after a block's last expression discards its value. The formatter strips every other `;`.

---

## 6. Patterns [D]

| Pattern | Example |
| --- | --- |
| Literal | `1`, `-1`, `"hi"`, `'c'`, `b'c'`, `true`, `nil` |
| Wildcard | `_` |
| Binding | `user`, `var user` |
| Constructor | `None`, `Cash`, `Payment.Cash` |
| Payload | `Ok(v)`, `Mpesa(code, amount)` |
| Struct / record | `Card { number, .. }`, `Sold { order: id, total }`, `r{ name, .. }` |
| Tuple | `t(x, y, ..)` |
| Or | `Some(0) \| None` |
| Range | `1..=5`, `'a'..='z'`, `b'0'..=b'9'` |

- Unqualified variants resolve through the prelude, then the scrutinee's type. Construction in expressions follows the same idea, through the expected type (§7.7).
- `var x` binds a writable copy (§5.1). There are no reference patterns and no parameter destructuring.
- A malformed pattern is `E_INVALID_PATTERN`.

---

## 7. Types

### 7.1 Type grammar [D]

```text
Type         := Intersection
              | Intersection ('|' Intersection)+   // literal unions: only on the right of `type X =`
Intersection := Postfix ('&' Postfix)*            // bounds, `inter X = A & B`
Postfix      := Primary '?'?
Primary      := Path ['[' TypeArgs ']']            // glued '['
              | 't(' [Types] ')'                   // tuple
              | 'r{' [Fields] '}'                  // structural record
              | '(' [ParamType {',' ParamType}] ')' '->' Type   // function
              | '(' Type ')'
              | 'TypeOf' '(' ValuePath ')'
              | StringLit | IntLit | 'true' | 'false'
ParamType    := ['*'] Type
```

- A function type's parameters carry modes: `(T) -> R` reads, `(*T) -> R` may write the caller's value (§9.4). There is one function type: whether a closure escapes is in the callee's summary (`keeps [f]`), not in its type.
- `*T` elsewhere in a type is `E_STAR_TYPE_NOT_PARAM` (fix-it: remove `*`). It is allowed only on parameters, receivers and return types (§8.3).
- `&T` and `&mut T` are `E_BORROW_REMOVED` (fix-it: `T`, or `*T` on a parameter). `&` between two types is an intersection.
- `(A, B)` without `->` is `E_BARE_TUPLE` (fix-it `t(A, B)`). `(T)` is grouping.
- When a `Path` names an interface, it denotes a dynamically dispatched value (§13.2).
- **`void`** is the unit type, and its only value is `t()`. A payload of type `void` can be left out at construction: `Ok()` is `Ok(t())`. **`never`** is the type of diverging expressions.
- `Vec<int>` is `E_ANGLE_GENERICS` (fix-it `Vec[int]`), parsed as intended.

### 7.2 Built-in types [D]

```text
bool  char  byte (= u8)
i8 i16 i32 i64  u8 u16 u32 u64  isize usize
int (platform width, at least 32 bits)
f32 f64   void   never   str
Slice[T]  Array[T, N]  Vec[T]  Map[K, V]  Set[T]  PVec[T]  PMap[K, V]
Option[T] (T?)  Result[T, E]  Promise[T]  Weak[T]  Symbol
```

**`int`:** 64-bit on 64-bit native targets, 32-bit on WASM32 and JS. The only guarantee is **at least 32 bits**; use `i64` when values can exceed 2³¹. The linter flags `int` literals outside the i32 range (`L_INT_NOT_PORTABLE`).

**`Map` indexing:**

- `m[k] = v` **inserts** `k` if it's missing and **overwrites** the value otherwise.
- Reading `m[k]` (including `m[k] += 1` and `m[k].field = x`, which read first) panics if `k` is missing (`PanicKind.MissingKey`). Use `m.get(k) -> V?`, `m.get(k) ?? default`, or `m.entry(k).or_insert(v)` when the key may be absent.

**Removed:** `string` (now `str`, §7.3), `&T` / `&mut T` (§9.4), `Ref[T]` (now `shared var`, §10), `Box[T]` (recursive value types box automatically, and owned interface values are boxed implicitly), raw pointers `*mut T` (now `unsafe.Ptr[T]`).

### 7.3 One string type: `str` [D]

`str` is the only string type: immutable UTF-8 text. How it is stored is the compiler's business:

| Where the value is | Representation | Cost |
| --- | --- | --- |
| local view (`s.substring(a, b)`, `s.trim()`, a parameter) | pointer + length into an existing buffer | none |
| stored (field, global, collection, escaping closure, task) | counted share of the buffer + offset + length | one refcount increment |
| literal | static buffer, never freed | none |
| result of `+`, interpolation, `to_str()`, `to_lower()` | new buffer | one allocation |

- **Appending:** `var s = ""` then `s += part` appends in place when `s` is unique and its buffer has spare capacity (amortised O(1), like a string builder). If `s` is shared, the first append copies (§9.1).
- **Retention:** a stored slice keeps its whole buffer alive, so one token can keep a 10 MB source file in memory. That is what a compiler wants. Elsewhere, `s.detach()` copies a slice into its own exact-size buffer. The runtime never compacts automatically.
- **Indexing:** offsets are UTF-8 bytes; `chars()` gives characters, `bytes()` gives `Slice[u8]`. Strings are not integer-indexable (`E_NOT_INDEXABLE`); use `.bytes()`, `.chars()` and `.substring(a, b)`, whose offsets must land on char boundaries.
- The type name `string` is `E_STRING_TYPE_REMOVED` (resolver), fix-it `str`.

### 7.4 Type declarations [D]

Nominal declarations have a body and no `=`; aliases keep `=`.

```minscript
pub type User: Stringer {                  // `: Interfaces` implemented in the body (optional)
    pub id: u64
    pub name: str
    email: str?                            // private; T? fields default to None
    tags: Vec[str] = []                    // field default
    active: bool = true

    pub fn new(id: u64, name: str) -> User { User { id, name } }
    pub fn display_email(this) -> str { this.email ?? "none" }
    pub fn rename(*this, name: str) { this.name = name }
    fn to_str(this) -> str { "User(${this.id})" }   // Stringer
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
type Config = TypeOf(default_config)
```

- **Parser rule.** After `type` / `union` / `inter`, the name, optional `[Generics]` and optional `: Interfaces`, the next token decides: `{` opens a nominal body, `=` starts an alias. `type X = { … }` (and `union X = {`, `inter X = {`) is `E_TYPE_EQUALS_BODY`, fix-it: remove `=`; it is parsed as the body. The old `type X = | A | B` is `E_LEADING_PIPE_UNION`, fix-it `union X { A  B }`.
- In a body, a member starting with `fn`, `async fn`, `pub fn`, or an attribute (§8.6), is a method. Anything else is a field (or, in a `union`, a variant).
- **Fields:** `[pub] [shared | once] name: Type [= default]`.
  - `shared` fields are cells that every copy of the value sees (§10.1).
  - `once` fields are written at most once, on identity types only (§12.2).
- Fields and variants are separated by commas or newlines, and are private by default. Variants are as public as their union.
- **Field defaults:** `name: T = expr`. A field with a default, like a `T?` field (which defaults to `None`), may be left out of struct literals, `_{}` and record → struct conversions. The default is evaluated again for every value constructed, and cannot refer to other fields. Fields without a default are required (`E_MISSING_FIELD`).
- `type X: A, B { … }` declares that the body implements interfaces `A` and `B`. Marker interfaces go there too: `type Token: Identity { … }`.
- Methods can't be attached to aliases (`E_METHODS_ON_STRUCTURAL`). A method can't share a field's name.
- Recursive value types need no `Box`: `next: Node?` inside `type Node` is boxed automatically.

`impl` blocks remain, for splitting methods across files of the same package, bounded impls (`impl[T: Stringer] Stack[T] { … }`), and implementing an interface separately (`impl Reader for File { … }`). Inline methods and `impl` blocks for the same type may coexist; a duplicate method name is `E_DUPLICATE_METHOD`.

### 7.5 Nominal and structural typing [D]

| Kind | Identity | Example |
| --- | --- | --- |
| Named struct / union | **nominal** | `type User { … }` |
| Record | **structural**: same field names and types (order-insensitive) are the same type | `r{ id: u64 }` |
| Tuple | structural | `t(int, str)` |

**Conversions:**

- record → named struct: implicit when the shapes match exactly. Missing fields are allowed only if they have a default or are `T?`.
- named struct → record type: implicit when the shapes match exactly.
- named struct → a different named struct: **never implicit**, even with the same shape. Spread it: `let b: B = _{ ...a }`.
- No width subtyping: extra fields don't match. Use spread or `Pick[T, K]`.

```minscript
fn save(u: User) { … }
save(r{ id: 1, name: "Ted", tags: [] })     // OK: shape matches User (email: None)
```

### 7.6 Type-level forms [D]

- `TypeOf(path)` is the only keyword form.
- `KeyOf[T]`, `ElementOf[T]`, `IndexOf[T]`, `Partial[T]`, `Omit[T, K]` and `Pick[T, K]` are generic type names that the checker evaluates.

```minscript
pub type Route  = ElementOf[TypeOf(routes)]
pub type Fields = KeyOf[Route]              // "name" | "lat" | "volume"
```

### 7.7 Variant names are inferred from the expected type [D]

When the type checker knows that a `union` type is expected, a bare variant name resolves to that union's variant:

```minscript
fn send(msg: ws.Message) { … }

send(Text("hi"))                         // ws.Message.Text
send(Close)
fn area(s: Shape) -> f64 { … }
area(Circle { r: 1.0 })                  // struct-like variant
fn default_shape() -> Shape { Empty }    // the return type is the expected type
let event: Event = match o.status { Paid { total, .. } => Sold { order: o.id, total }, … }
```

- The expected type comes from the same places that drive `_{}`: a parameter type, an annotated binding (`let x: T` or `as T`), a field type, a return type, a `match` arm whose type is already known, a Vec element type, and so on.
- **Lookup order:** a variant of the expected union comes first, then ordinary name resolution. In a pattern, the scrutinee's type is the expected type, so `Empty =>` matches the variant even when the package also declares an item `Empty`. A local item with the same name stays reachable through its qualified path; shadowing a function or global of the package this way is the lint `L_SHADOWED_VARIANT`. A type of the same name (`union Shape { Square(Square) }`) is never ambiguous, since a type is not a value, and is not linted.
- **Branches guide each other:** without an expected type, a later `match` arm or `else` branch gets the named type the earlier branches settled on.
- With no expected union type, the bare name falls back to normal lookup. If that fails: `E_CANNOT_INFER_VARIANT`, fix-it `Union.Variant`.
- The qualified forms (`Message.Text`, `ws.Message.Text`) are always valid. **The parser is unaffected**: `Text("hi")` is a call and `Circle { r: 1.0 }` a struct literal either way.

---

## 8. Declarations and modules

### 8.1 File structure and imports [D]

```text
file    := package_decl import* item*
package := 'package' ident ('.' ident)*
import  := 'import' ['pub'] STRING ['as' ident]
```

```minscript
package app.users

import "std.json"                 // binds package `json`
import "std.io.println"           // binds one item
import "std.io.{print, println}"  // binds several items
import "std.collections.*"        // binds every pub item of the package
import "app.models" as models
import "./helpers"                // relative to this file's folder
import pub "./log"                // re-export
```

- **A folder is a package**: all its files declare the same package name, which matches the folder. **`main` is exempt**: it may live anywhere and is located through `mod.ms` (§17.6).
- Paths starting with `./` or `../` are relative. Otherwise the first segment is `std`, `app` (this project's source root), `build` / `ms` (the toolchain, §17), or a dependency.
- The resolver decides whether the last segment is a package or an item.
- `import` after the first item is `E_IMPORT_AFTER_ITEM`.
- **Glob imports** (`.*`): local declarations shadow glob-imported names. Two globs exporting the same name is an error only where that name is used (`E_AMBIGUOUS_IMPORT`). Unused imports cost nothing (item-level tree shaking).
- Everything is private by default. Using a non-`pub` item of another package is `E_PRIVATE_ITEM`.
- **The package graph is acyclic.** An import cycle is `E_IMPORT_CYCLE`, and the message shows it. Each package is checked and compiled independently, in dependency order (§15.3). Files inside one package may refer to each other freely.
- **Keyword names:** a `pub fn` may be named after a keyword, since other packages call it as `pkg.name` (`runtime.yield`).

**Loading:** `ms run`, `ms check` and the language server load the entry and, depth first, every package it imports.

- A folder entry (a project's `main`) makes every `package main` file in it one package (`E_NO_MAIN` if there is none). A single `package main` file outside a project is a package of its own. An entry file of another package brings the rest of its folder.
- `"std.x.y"` is the folder `std/x/y/`; `"app.x"` is the folder `x/` under the program's root; `"./x"` and `"../x"` are relative to the importing file. A path whose last segment isn't a folder names an item of the parent package (`"std.io.println"`).
- A first segment that is a `path:` dependency of `mod.ms` is that folder. Until `mod.ms` is evaluated (§17.5), the loader reads `path:` dependencies and `main:` from its literals.
- A `package main` folder can't be imported (`E_IMPORT_MAIN`). A path that points nowhere, or an item a package doesn't have, is `E_UNKNOWN_IMPORT`; an item that isn't `pub` is `E_PRIVATE_ITEM`. An import that closes a cycle is `E_IMPORT_CYCLE`, reported at that import.
- **Packages that aren't loaded.** A std package of §14.4 whose folder doesn't exist yet, and any dependency that isn't a `path:` one, loads as *not loaded*: importing it is not an error, its members are `unknown` (§13.5), and a glob import of it makes the file open (§8.7). A `std.` path outside §14.4 is `E_UNKNOWN_IMPORT`.
- In a std package, a function whose body is only `_builtin()` is provided by each back end's runtime. Every other std function is ordinary MinScript, compiled with the program.

### 8.2 Top-level items [D]

```text
item := attribute* ['pub'] (function | type | union | inter | impl | let | var | extern)
```

- Only declarations are allowed at the top level (`E_TOP_LEVEL_STATEMENT`).
- A top-level `let` is immutable and may have any initializer. Non-constant initializers run once, on first use, thread-safely (§10.4).
- A top-level `var` is implicitly `shared` (§10.4). Writing `shared var` is allowed.

### 8.3 Functions, parameters and receivers [D]

```text
function   := ['async'] 'fn' name [GenericParams] '(' [receiver [',']] [params] ')' ['->' ReturnType] Block
receiver   := ['*'] 'this'
params     := param {',' param} [',']
param      := name ':' ['*'] Type  |  '...' name ':' Type    // variadic, last; binds Slice[T]
ReturnType := ['*'] Type                                     // `-> *T`: a write view (§9.7)
```

```minscript
fn print_user(user: User) { log.println(user.name) }      // read
fn birthday(user: *User) { user.age += 1 }               // write: the caller sees it
pub async fn load(path: str) -> Result[Config, str] { … }
fn at_mut(*this, i: int) -> *T { this.items[i] }
```

- **Visibility:** everything is package-private by default; `pub` exports it. That covers `pub fn`, `pub async fn`, `pub type`, `pub union`, `pub inter`, `pub let`, `pub var`, and `pub` on fields and methods. `pub` comes first: `pub async fn load()`, `pub shared count: int`, `pub once ty: Type`.
- The meaning of `T` and `*T` is in §9.4.
- There are no default parameter values and no named arguments; `_{}` covers both.
- **Removed forms**, each reported once and parsed as the intended form:
  - `fun` is `E_RESERVED_KEYWORD` with the fix-it `fn`;
  - `mut x: T`, `mut this` are `E_MUT_REMOVED` (fix-it `x: *T` or `var x = x`; `*this`);
  - `&this`, `&mut this`, `x: &T`, `x: &mut T` are `E_BORROW_REMOVED` (fix-it `this` / `*this`, `T` / `*T`);
  - `self` is `E_UNKNOWN_RECEIVER` (fix-it `this`).
- `...xs` followed by more parameters is `E_VARIADIC_NOT_LAST`. A parameter without `:` is `E_EXPECTED_COLON`; any other malformed parameter is `E_INVALID_PARAM`.

### 8.4 `impl` [D]

```minscript
impl User { … }                  // inherent methods (same package as User)
impl[T] Pair[T, T] { … }
impl Reader for File { … }
impl Plus, Minus for Money { … }
```

- **Bounded impls:** `impl[T: Stringer] Vec[T] { fn join(…) }` declares methods only for types whose arguments meet the bounds; each call checks them (`E_BOUND_NOT_SATISFIED`).
- **Orphan rule:** `impl X for T` must be in the package that owns `X` or owns `T` (`E_ORPHAN_IMPL`). Inherent `impl T` must be in `T`'s package, in any file.
- Duplicate method names across interfaces are `E_AMBIGUOUS_IMPL_METHOD`.

### 8.5 `inter` [D]

```minscript
pub inter Reader { fn read(*this, buf: *Vec[u8]) -> Result[int, IoError] }
pub inter PartialOrd[T]: PartialEq[T] { fn partial_cmp(this, o: T) -> Ordering? }
pub inter ReadWriter = Reader & Writer
pub inter Refunder {
    async fn refund(*this, receipt: str) -> Result[void, str]
    fn can_refund(this, receipt: str) -> bool { receipt.starts_with("RCPT-") }   // default body
}
```

- Interfaces are implemented explicitly, with `impl` or with `type X: Inter { … }`.
- Interface methods are always exported; `pub` on them is allowed and flagged as redundant by the linter.
- Default method bodies are allowed. There are no associated types; use extra generic parameters.
- **Modes:** an interface method states its mode in the signature. An implementation may be less demanding (a `this` method satisfies a `*this` requirement), never more.
- **Marker interfaces** have no methods: `Copy`, `Identity`, `Unique` (§14.2). `Unique` may only be implemented in std or `extern` code (`E_UNIQUE_IMPL`).

### 8.6 `extern`, `unsafe`, attributes [D]

```minscript
extern "C" { pub fn malloc(size: usize) -> unsafe.Ptr[u8] }
let fd = unsafe { open(path, 0, 0) }

#[effects(keeps: [v])]
pub fn push(*this, v: T) { _builtin() }
```

- An `unsafe { }` block is required to call `extern` functions and to use `unsafe.Ptr[T]`.
- **Attributes** are `#[name]` or `#[name(args)]`, before an item or a member, one per line:

```text
attribute := '#[' ident ['(' attr_arg {',' attr_arg} ')'] ']'
attr_arg  := ident ':' '[' [attr_path {',' attr_path}] ']'
attr_path := (ident | 'this') {'.' ident}
```

- The only attribute in v0.4 is `effects` (§9.5), and only std may use it (`E_ATTRIBUTE_NOT_ALLOWED`, checker). An unknown attribute name is `E_UNKNOWN_ATTRIBUTE` (checker). A malformed attribute is `E_INVALID_ATTRIBUTE` (parser).

### 8.7 Name resolution [D]

Name resolution binds every name to its declaration, without types. It leaves the AST unchanged: its results are side tables keyed by AST node.

**Scopes**, innermost first:

1. closure / block / `match` arm / `if let` branch / loop body / `or` right-hand side / `lock` body;
2. the function: generic parameters, the receiver `this`, the parameters **and the top level of the body share one scope**;
3. the file's explicit imports;
4. the package: the items of every file in the package;
5. the file's glob imports;
6. the prelude's `pub` items, including the variants of `Option`, `Result` and `Ordering`;
7. the built-in types (§7.2) and the built-in package `unsafe` (§8.6).

**Rules:**

- **Order:** top-level items are order-independent within a package. Inside a function, a name is visible only after its declaration. The value of `let x = …` is resolved before `x` is bound, so `let a = a + 1` reads the outer `a`.
- **Shadowing:** a name may be redeclared only in an **inner** scope. Redeclaring it in the same scope is `E_DUPLICATE_BINDING`: that includes a parameter redeclared at the top level of the body (except `var p = p`, §5.1), a name bound twice in one pattern, and two parameters with the same name.
- **Items:** two items with the same name in one package are `E_DUPLICATE_DECLARATION`, as is an import that binds a name already used by an item. Local items shadow prelude names.
- **Imports:** `"std.json"` binds `json`; `"std.io.println"` binds `println`; `"pkg.{a, b}"` binds `a` and `b`, and `as` renames. A glob import of a loaded package binds its `pub` items below the package's own items. A glob of a package that isn't loaded makes the file *open*: unknown names in it are deferred, not reported.
- **Patterns:** lowercase names bind. Uppercase or qualified names are constructors. In an or-pattern, every alternative must bind the same names (`E_INCONSISTENT_OR_BINDINGS`). `Union.Variant` for a union of this package must name a real variant (`E_UNKNOWN_VARIANT`).
- **Implicit parameters:** `it` / `it1` … `itN` belong to the innermost header-less closure or unnamed `or`. Elsewhere they are `E_IT_OUTSIDE_CLOSURE`. They can't be declared (`E_RESERVED_IDENT`).
- **`this` and `Self`:** `this` exists only in methods with a receiver (`E_THIS_OUTSIDE_METHOD`). `Self` exists only inside `type`, `union`, `inter` and `impl` bodies (`E_SELF_OUTSIDE_TYPE`).
- **Captures:** each closure records the outer locals it uses (parameters, locals, `this`, and `it` from an outer provider), including uses inside nested closures. Globals and functions are never captured.
- **Types:** in type position a name must be a type (`E_UNDECLARED_TYPE`, `E_NOT_A_TYPE`). `string` is `E_STRING_TYPE_REMOVED`.
- **Sigils:** a sigil whose letter is a visible variable, parameter, function or import is `E_SIGIL_SHADOWS_BINDING` (§1.7).
- **Impls:** the orphan rule is checked here (`E_ORPHAN_IMPL`), as is `E_METHODS_ON_STRUCTURAL`. Duplicate members are reported across inline methods, fields and every `impl` of the type: `E_DUPLICATE_FIELD` (a field or variant twice), `E_DUPLICATE_METHOD` (a method twice, or a method named like a field). `E_AMBIGUOUS_IMPL_METHOD` is two implemented interfaces declaring the same method, unless the type defines that method itself; a method inherited through a super-interface counts once.
- **Attributes:** each path in `#[effects(…)]` starts at a parameter of the function, or at `this` in a method (`E_UNDECLARED_NAME`).
- **Members of a loaded package** (`lib.visible`, `models.User`) are resolved here: a missing one is `E_UNDECLARED_NAME` / `E_UNDECLARED_TYPE`, a non-`pub` one `E_PRIVATE_ITEM`.

**Deferred to the type checker** (they need types): member names (`x.name`, `Shape.Line`, and members of packages that aren't loaded, such as `json.parse` until std is written); bare uppercase names that aren't declared (variants inferred from the expected type, §7.7, or from the scrutinee in patterns); everything in an open file. The checker reports them as unknown if it can't resolve them either.

---

## 9. Values and ownership

### 9.1 Value semantics and copy-on-write [D]

Every value behaves as if it were copied on assignment; the compiler makes that free in almost every case.

```minscript
user := User { name: "John", age: 25 }
other := user          // value semantics: other is "a copy"
var edited = user
edited.age += 1        // user.age is still 25
```

**How each assignment is implemented** (decided by the compiler, in this order):

| Situation | Mechanism | Cost |
| --- | --- | --- |
| Source is `Copy` (primitives, small records of primitives) | bit copy | none |
| Source is not used again | move | none |
| Source is used again, nobody writes either side | share (refcount + 1) | one increment |
| Source is used again and one side is later written | share, then copy-on-write at the first write | one copy of the written buffer |

- There is **no use-after-move error** for ordinary values: using a value after it was "moved" just turns that move into a share. Only `Unique` types move for real (§9.2).
- **Granularity.** Copy-on-write is per buffer, not per object: writing `edited.age` copies only the `User` header, while `edited.tags` keeps sharing the same `Vec` buffer until it is written.
- **Lints, not errors.** `L_IMPLICIT_COPY` fires where the compiler cannot prove a write target is unique and the copied buffer is a collection or a string. The fix-its: drop the extra use, write through a `*T` parameter, or mark the value `shared` (§10).
- **`.clone()`** stays available for an explicit independent copy, but ordinary code doesn't need it.

### 9.2 Unique types [D]

Some values must have exactly one owner: files, sockets, `Sub[T]`, `Resolver[T]`, `Watcher[T]`. They implement the marker interface `Unique` (std and `extern` only).

- A `Unique` value really moves. Using it afterwards is `E_USE_AFTER_MOVE`, which exists only for these types.
- A `Unique` value cannot be stored in a `shared` binding.
- A struct containing a `Unique` field is itself `Unique`.
- **Consuming parameters.** A `Unique` parameter (or `this` receiver) that the body moves, or calls a `*this` method on (`for await` included), is *consumed*. Its summary records `consumes [p]` (§9.5), the caller must move the argument, and inside the body the parameter behaves as an owned `var`. So `async fn worker(sub: Sub[int]) { for await job in sub { … } }` and `conn.split()` need no extra syntax. The same inference applies to closure parameters of a `Unique` type (`#{ sub => worker(sub) }`).
- **Unique arguments.** Passing a `Unique` value to a `T` parameter whose summary says `keeps` or `consumes` moves it. Otherwise it lends a view.
- **Generics.** A type parameter is non-Unique by default; instantiating it with a `Unique` type is `E_UNIQUE_TYPE_ARG`. A function or type that accepts `Unique` arguments declares `[T: Unique]`. That bound admits Unique and non-Unique types alike, and the body is checked with move rules for `T`, so using a `T` value twice is `E_USE_AFTER_MOVE`. The check happens once, at the definition.
- **std containers admit Unique items.** `Vec`, `Slice`, `Array`, `Option`, `Result`, `Map` (values), `Promise`, `Queue`, `Sub`, `Resolver`, `PublishError` and the iterator interfaces declare `[T: Unique]`, so a `Vec[Sub[T]]` of subscriptions or a `Queue` of jobs carrying a `Resolver` is ordinary code. `Topic`, `Signal`, `Set` and `PMap` don't: they share their values.

### 9.3 Drop [D]

A value is dropped when its last share goes away. `Drop.drop(*this)` runs then, deterministically on native and WASM back ends. On JS, `Drop` runs for `Unique` types only (they are tracked exactly); other types rely on the GC. There is no `defer`.

### 9.4 Parameters and receivers: `T` and `*T` [D]

A signature says only whether the callee may change the argument. `*T` means "my writes are visible to the caller".

| Written | Meaning | Caller passes | Compiler picks |
| --- | --- | --- | --- |
| `user: User` | read-only | any value | view, move, share or bit copy |
| `user: *User` | read and write; the caller sees the changes | a mutable place: a `var`, a `*` parameter, or a field / element of one | exclusive view of the written paths |
| `this` | read-only receiver | any value | as `T` |
| `*this` | mutable receiver | a mutable place | as `*T` |

```minscript
fn print_user(user: User) { log.println(user.name, user.age) }
fn birthday(user: *User) { user.age += 1 }

var u = User { name: "Ann", age: 30 }
birthday(u)          // no marker at the call site; the LSP shows an inlay `*`
print_user(u)        // 31
```

- **Call sites are unmarked.** Passing an immutable binding to a `*T` parameter or a `*this` method is `E_WRITE_TO_IMMUTABLE`, with a fix-it changing `:=` to `:==` or `let` to `var`.
- **No aliasing writes in one call.** Two arguments of one call may not overlap on a path that either side writes: `swap(a.x, a.x)` is `E_OVERLAPPING_ACCESS`, while `swap(a.x, a.y)` is fine (§9.5 paths). The rule covers the **places passed as arguments**, which are live together for the whole call. Writes made while an argument expression is evaluated are sequenced left to right and never conflict: in `three(note(trace, "a"), note(trace, "b"))` each `note` call finishes before the next starts. When an earlier argument is a read view and a later argument's evaluation writes the same path (`f(trace, note(trace, "x"))`), the view keeps a copy-on-write snapshot and `L_VIEW_FORCED_COPY` fires.
- **A local mutable copy** of a `T` parameter is an ordinary `var`: `var acc = start`, free until written. `var p = p` redeclares the parameter itself (§5.1).
- **`*` is only an access mode, not a pointer type.** `*T` may appear on parameters, receivers, function-type parameters and return types. It may not appear in fields, `Vec[*T]`, globals or bindings (`E_STAR_TYPE_NOT_PARAM`).
- **Writing a `T` parameter** (or `this`) is `E_WRITE_TO_IMMUTABLE`, except through `shared` and `once` fields, which do their own synchronisation (§10.1, §12.2).
- **Function types** take the same two modes: `(T) -> R` or `(*T) -> R`. A closure's parameters take their mode from the expected type, so `fn update[R](this, f: (*T) -> R) -> R` is called as `signal.update(#{ n => n += 1 })` and the write reaches the caller's value. Captures are separate from parameter modes and always inferred (§9.9).

### 9.5 Effect summaries over access paths [D]

The compiler infers, for every function, which parameter paths it reads, writes, keeps, consumes, returns views of, and whether it suspends. Summaries are never written by the user; the LSP shows them and package interfaces store them (§15.3).

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

**The effects:**

| Effect | Meaning | Used for |
| --- | --- | --- |
| `reads [p]` | path `p` is read | conflict checks, parallelism |
| `writes [p]` | path `p` is written (only on `*` params, `*this`, `shared` fields and cells, `once` fields) | conflict checks, copy-on-write placement |
| `keeps [p]` | `p` is stored beyond the call: in a field of a parameter, a global, or a task that isn't awaited | move vs share at the call site, heap promotion |
| `consumes [p]` | a `Unique` parameter is moved or mutated by the body (§9.2) | forces a move at the call site |
| `returns_view [p]` | the result is a view into `p`, or holds shares of it (a returned Vec of views, a returned closure capturing `p`) | view checking in the caller (§9.6); the caller decides whether it keeps the result |
| `invokes [f(paths)]` | the function calls its function parameter `f`, passing those paths (`f(this.stock.items[*])`) | analysing a closure literal passed as `f` in place, at the call site |
| `awaits` | the function suspends | views across suspension (§11.2) |

- **Storing into the function's own locals is not keeping.** `out.push(v)` with a local `out` makes `out` hold `v`'s sources; if `out` is returned, they show up as `returns_view`, otherwise nowhere.
- **Aliases carry their sources.** A local bound from a parameter's path (`x := p.items`, a `for` item, a pattern binding) is a view of it: reads through the local are reads of the parameter. Writes through it reach the parameter only when it is a write view returned by `-> *T`; a copy is written in place (§9.1), so `var c = base; c.tags.push(t)` writes nothing of `base`.

**Paths.** A path is a parameter or `this` followed by up to **4** segments:

- `.field`: a named field or tuple index;
- `[k]`: a literal index or literal map key (`items[0]`, `users["alice"]`);
- `[*]`: any element, for every non-literal index.

A longer path is truncated to its first 4 segments, which only makes it cover more. Two paths **overlap** when one is a prefix of the other, or they differ only where one side has `[*]`. So `items[i]` and `items[j]` overlap unless the compiler sees `i` and `j` are distinct literals.

**Propagation.** A call substitutes the argument paths into the callee's summary: `u.profile.birthday()` contributes `writes [u.profile.age]` to the caller.

**Conservative cases.** Each widens to the whole parameter (`writes [user]` for a `*` parameter, `reads [user]` otherwise):

- calls through an interface value, a function value or a stored closure;
- calls into an `extern` function without an `#[effects]` attribute;
- paths still growing when a recursive cycle hits the safety cap (§15.1). Only those paths widen, and only to their first segment.

Closures passed directly to a known function (`items.map(#{ … })`) are not conservative: their bodies are analysed in place.

**Built-in and extern summaries.** A function whose body is `_builtin()` has nothing to infer from, so std states its summary with an attribute (§8.6):

```minscript
#[effects(keeps: [v])]
pub fn push(*this, v: T) { _builtin() }

#[effects(consumes: [this])]
pub fn split(this) -> t(Reader, Writer) { _builtin() }

#[effects(returns_view: [this])]
pub fn trim(this) -> str { _builtin() }
```

The attribute lists only `keeps`, `consumes` and `returns_view`; `reads` and `writes` follow from the parameter modes (whole parameter), and `awaits` from `async`. The compiler trusts it, so it is part of std's review surface. An `extern` function without the attribute keeps every non-`Copy` argument: values are shared rather than lent, and `Unique` arguments move.

**API stability.** For `pub` functions the summary is part of the package's public interface. `ms api diff` reports a summary that got wider (for example a new `keeps`) as a breaking change, because callers may stop compiling.

### 9.6 Read views [D]

A view type (`str`, `Slice[T]`, iterators, the results of collection getters) is **one type with two representations**: an uncounted pointer while it stays local, and a counted share once it is stored. The programmer never sees the difference, so views may go into fields and globals.

```minscript
type Token {
    kind: TokenKind
    text: str            // a view into the source buffer
}

fn lex(src: str) -> Vec[Token] {
    var out = [] as Vec[Token]
    // …
    out.push(Token { kind: Ident, text: src.substring(a, b) })   // keeps [src]
    out
}
```

- **Local views are free:** a pointer plus length, no refcount traffic.
- **Stored views share.** When a view goes into a field, global, escaping closure or task (the summary says `keeps`), the compiler stores a counted share of the **buffer** it points into. The owner can go out of scope; the buffer lives as long as any share does. No copy is made.
- **Views of `shared` cells are always counted.** A view taken from a `shared` cell (`before := tokens`, `first := sessions[k]`) outlives the statement's lock, and another task's writer cannot see an uncounted local pointer. Such a view is therefore always a counted share (an atomic count once the cell reaches another task), and every write to a `shared` cell checks uniqueness before writing in place.
- **Writes never invalidate a view.** If the owner is written while a view of it is live, the view is upgraded to a share and the write copies the owner's buffer. The view keeps seeing the old value. `L_VIEW_FORCED_COPY` flags it, because it usually means a loop like `for x in items { items.push(x) }`.
- **Returned views** carry `returns_view [p]`. The caller treats the result as a view of the argument path, under the same rules.
- **Small values.** A view of a value with no heap buffer (a small inline string, a fixed array on the stack) is copied when stored. The copy is bounded by the inline size limit (proposed 24 bytes, §22).
- So there is **no borrow-conflict error for read views**: a view of a local that must outlive it keeps the local's buffer alive (heap-promoted if it was on the stack).
- **Collection getters return views:** `get`, `first`, `find`, `max`, `filter`, `keys` and iteration all yield views, never clones.

### 9.7 Write views (`-> *T`) [D]

A function may return a write view into a `*` argument, for example `fn at_mut(*this, i: int) -> *T` or `map.entry(k)`.

- A write view can never be stored or upgraded: it is the one second-class value left.
- While it is live, any other access to an overlapping path is `E_ACCESS_DURING_WRITE_VIEW` (a local check over one body).
- It may be returned only when it derives from a `*` parameter or `*this`.

### 9.8 Graphs and back-references [D]

A struct that stores another struct stores a share of it: a snapshot. To see later changes, the target must be `shared` (§10). Cycles of `shared` values leak under refcounting; `Weak[T]` breaks them (§12.4), and `L_SHARED_CYCLE` warns when a type can form a cycle through `shared` or identity fields. For graphs built once (ASTs, type tables), `Identity` types (§12) are the recommended pattern and need no `shared` at all.

### 9.9 Closure captures [D]

Captures are inferred from the body; each is a view, a share or a move, chosen like any other use (§9.1).

```minscript
limit := 50
high := nums.filter(#{ it > limit })        // local view of limit
var total = 0
nums.for_each(#{ total += it })             // non-escaping: writes total in place
fn make_adder(n: int) -> (int) -> int { #{ it + n } }   // escaping: shares n
```

- A closure that does not escape (the callee's summary doesn't `keep` it) may write captured `var`s in place.
- A closure that escapes (stored, returned, or passed to a task) captures copies. Writing a captured non-shared `var` from it is `E_WRITE_TO_CAPTURED_COPY`, with the fix-it `shared var` (§10.3).
- A captured `Unique` value moves into the closure if the closure escapes or consumes it.

---

## 10. Shared mutable state: `shared` [D]

`shared` is the only ownership word in the language. It marks a binding or field whose changes every holder must see, and the compiler makes it thread-safe. Anything not marked `shared` has one owner and is passed as a value (§9.1).

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

### 10.1 Rules [D]

- **Aliasing.** Passing a `shared` place to a `*T` parameter (including one of a task that is not awaited, §11.2), initialising another `shared` binding or field from it, or capturing it in a closure **aliases the same cell**. Every other use reads a snapshot value: `let n = hits` is a plain `int`.
- **Copies alias `shared` fields.** A `shared` field is stored as a pointer to its cell. Copying the containing value (assignment, passing, storing) copies that pointer, so every copy sees the same cell, while the other fields follow copy-on-write. This is how std builds handles: `type Topic[T] { shared state: TopicState[T] }`, and passing a `Topic` to a task gives it the same topic.
- **Writes through read-only views.** A `shared` field may be written through `this` or a `T` parameter: the cell does its own locking. The write still appears in the summary (`writes [this.state]`), so it takes part in conflict checks. So `fn publish(this, v: T)` is a valid signature.
- **Statement-level safety.** Each statement that touches a `shared` cell is one critical section for that cell: a read lock if the statement only reads it, a write lock if it writes. So `users[k] = v` and `hits += 1` are always race-free.
- **Calls that receive the cell don't hold the caller's lock.** When a statement passes a `shared` place as a `*T` argument or a `*this` receiver, the callee gets the cell itself and locks statement by statement inside its own body. The caller's statement holds no lock across the call, so `await store.gateway.charge(…)` on a `shared` field is allowed; for atomicity across the callee's statements, the callee uses `lock`.
- **Multi-statement atomicity** needs `lock` (§4.10):
  - `lock a, b` acquires the cells in a fixed runtime order (by cell address), so two `lock` blocks can't deadlock each other.
  - `lock` is an expression: its value is the block's value.
  - **Leaving the block releases the lock**, however it is left: the end of the block, `return`, `break`, `continue`, `?`, `or` returning, or a panic unwinding through it.
  - **No relocking.** Statements inside `lock c { }` don't take `c`'s statement-level lock again (a local fact). Runtime locks are also re-entrant per task, so a function called inside the block that touches `c` does not deadlock.
  - Nested blocks, `lock a { lock b { } }`, don't get the fixed order of `lock a, b` and can deadlock against `lock b { lock a { } }`. `L_NESTED_LOCK` flags them, with a fix-it merging them into `lock a, b`.
  - `await` inside a `lock` block is `E_AWAIT_IN_LOCK`: a lock is never held across a suspension.
  - A `lock` place that isn't rooted in a `shared` binding or field is `E_LOCK_NOT_SHARED`.
- `shared` is only meaningful with `var` (or a field). `shared let` is `E_SHARED_IMMUTABLE`.

### 10.2 What the compiler lowers `shared` to [D]

The programmer states *that* a value is shared; the compiler chooses *how* from escape analysis and the statements that touch it.

| Usage the compiler sees | Lowering |
| --- | --- |
| Never reaches another task | plain cell, no lock (refcounted when stored in several places) |
| Scalar, every access is one load, store or read-modify-write | atomic |
| Mostly reads | `RwLock` |
| Otherwise | `Mutex` |
| Struct whose fields are never touched in the same statement or `lock` | one lock per field (optional optimisation) |

The JS back end is single-threaded per worker, so every `shared` lowers to a plain cell there. `lock` blocks still run without interleaving because they cannot contain `await`.

### 10.3 Forgetting `shared` [D]

Without `shared`, a value given to another place is a copy (cheap until written). Where that would surprise, the compiler reports it:

| Situation | Diagnostic |
| --- | --- |
| An escaping closure or task **writes** a captured `var` | `E_WRITE_TO_CAPTURED_COPY`, fix-it: `shared var` |
| A closure handed to a task reads a captured `var` that the spawning function writes afterwards | `L_TASK_SEES_SNAPSHOT` (warning), fix-it: `shared var` |
| A non-shared field is written after the struct was stored in two places | `L_DIVERGED_COPIES` (warning) |

### 10.4 Globals [D]

- A top-level `var` is implicitly `shared`, since any task can reach it. Writing `shared` there is allowed and the formatter keeps it.
- A top-level `let` is immutable and may have any initializer. Non-constant initializers run once, on first use, thread-safely.
- So a compiler's token list is simply `let TOKENS = lex(src)`, or a `shared var` that is filled once. No `Ref`, no arena.

---

## 11. Concurrency

### 11.1 Async tasks and promises [D]

- Calling `async fn f() -> T` **schedules the task immediately** on the work-stealing runtime and returns `Promise[T]`. There's no `spawn`, and call sites aren't coloured.
- `await p` suspends until `p` resolves. `main` may `await` without being declared `async`. `await` outside an `async fn` or `main` is `E_AWAIT_OUTSIDE_ASYNC`.
- **Waiting on several:**
  - `all(p1, …, pn) -> Promise[t(T1, …, Tn)]` and `race(p1, …, pn)` take a fixed set of promises of any types. They are prelude intrinsics (variadic over types), and the calls in them count as one statement for the concurrency check (§11.2).
  - `Promise.all(Vec[Promise[T]]) -> Promise[Vec[T]]` takes a dynamic number of promises of one type.
- `Promise` API: `.then(#{…})`, `.catch(#{…})`, `.ignore()` (fire and forget; errors and panics are logged; gives up the handle), `.timeout(ms) -> Promise[Result[T, Timeout]]`, `.cancel()`, `.is_done()`.
- **One-shot promises:** `Promise.new.[T]() -> t(Promise[T], Resolver[T])`. `resolver.resolve(v)` completes the promise (`resolve()` works for `void`). A `Resolver` is `Unique`; if it is dropped before resolving, the awaiter panics with `ResolverDropped`. Use them for "I'm ready" signals and request / response: put the resolver inside a `Queue` job.
- **Cancellation is cooperative.** `p.cancel()` asks the task to stop. The task stops at its next `await` (or `runtime.yield()`), unwinding as a panic does (`Drop` runs, `recover` sees `Cancelled`). Anyone awaiting a cancelled promise panics with `Cancelled`. `.ignore()` gives up the handle, so keep it to cancel later.
- `time.after(ms) -> Promise[void]` is a cancel-safe timer for `select`. `runtime.yield()` hands control back to the scheduler.

### 11.2 Disjoint paths run in parallel [D]

Two tasks may write the same non-shared value at the same time when their effect summaries touch disjoint paths and both are awaited before the value is used again. No lock is involved, because they never touch the same memory.

```minscript
async fn rename(u: *User, n: str) { u.name = n }      // writes [u.name]
async fn retag(u: *User, t: str)  { u.tags.push(t) }  // writes [u.tags]

var user = load()
await all(rename(user, "Ann"), retag(user, "admin"))    // OK: disjoint, runs in parallel
await all(rename(user, "Ann"), rename(user, "Bo"))      // E_CONCURRENT_OVERLAP: both write user.name
```

- **Structured rule.** An async call that receives a `*` argument, or a read view of a value someone else may write, must be awaited **in the same statement**. `all(…)`, `race(…)` and `select` arms count as the same statement. Storing such a promise is `E_VIEW_ACROSS_TASK`.
- **"May be written".** A read view is of a value someone else may write when it is rooted in a `var`, a `*` parameter or `*this`, through non-shared fields and elements. A view of a `let` / `:=` binding, of a `T` parameter or `this`, or of an identity value is not: it becomes a counted share, and the call needs no same-statement await.
- **Shared cells are exempt.** A `*` argument that is a `shared` place is passed as the cell itself (§10.1), and the task keeps an alias (`keeps [p]`). Such a call may be stored or detached: `t := ticker(count)` with `shared var count`. Lowering: a `*T` parameter whose summary has `keeps` or `awaits` receives a cell reference, never a raw pointer.
- **The check.** Within one statement, the compiler collects each concurrent call's substituted summary and rejects any pair where a `writes` path overlaps the other's `reads` or `writes`. Reads alone never conflict.
- **Detached tasks.** A task that is not awaited in the statement (stored, `.ignore()`d) receives only owned values: snapshots of non-shared data, aliases of `shared` cells, and moved `Unique` values. That is safe by construction, and §10.3 lints where a snapshot is probably not what was meant.
- **Higher-level invariants.** Disjoint memory does not mean independent meaning. When fields must change together, use a `shared` cell and a `lock` block; the compiler never infers grouping.
- **No `Send` / `Sync` markers.** Thread safety follows from three facts: non-shared values are owned by one task at a time (or split by disjoint paths), `shared` cells are locked or atomic, and `Unique` values move.

### 11.3 Inter-task communication: Topic, Queue, Signal [D]

There are no raw channels. Three std types cover the common patterns. Each is a struct with a `shared` field, so copying one aliases the same state (§10.1), and none needs `.clone()`.

| | Delivers | No one listening | Full | Payload |
| --- | --- | --- | --- | --- |
| `Topic[T]` | **every** subscriber gets each message | message dropped | per-subscriber buffer: oldest dropped, counted in `missed()`; **publish never waits** | shared per subscriber (copy-on-write) |
| `Queue[T]` | **one** subscriber per message: the one that has waited longest | buffered | **publish waits** for space (`try_publish` doesn't) | moved |
| `Signal[T]` | the **latest value**; watchers wake on change | stays as the current value | n/a: overwritten | shared |

**The method rule:** an operation that may wait is `async` and returns a promise. Each has a `try_` twin that never waits.

```minscript
// Topic: broadcast events
pub type TopicOptions { buffer: int = 64, replay: int = 0 }   // replay: last N messages for new subscribers
Topic.new.[T]() -> Topic[T]
Topic.with.[T](opts: TopicOptions) -> Topic[T]
fn publish(this, v: T) -> int              // never waits; returns how many subscribers got it
fn subscribe(this) -> Sub[T]
fn subscribers(this) -> int
fn close(this)                             // subscribers drain, then see None (also on last-handle drop)

// Queue: work distribution (competing consumers)
pub type QueueOptions { capacity: int = 1024 }
pub union PublishError[T] { Full(T)  Closed(T) }               // the value is handed back
Queue.new.[T]() -> Queue[T]
Queue.with.[T](opts: QueueOptions) -> Queue[T]
async fn publish(this, v: T) -> Result[void, PublishError[T]]                  // waits for space
fn try_publish(this, v: T) -> Result[void, PublishError[T]]
async fn publish_timeout(this, v: T, ms: int) -> Result[void, PublishError[T]]
fn subscribe(this) -> Sub[T]
fn len(this) -> int
fn close(this)

// Sub[T] (Unique): shared by Topic and Queue
async fn next(*this) -> T?                 // None once closed and drained; cancel-safe; AsyncIterator[T]
fn try_next(*this) -> T?
fn missed(*this) -> int                    // Topic: messages dropped since the last call (0 for Queue)
// dropping a Sub unsubscribes

// Signal: shared state
Signal(v: T) -> Signal[T]
fn get(this) -> T                          // a view of the current value
fn set(this, v: T)                         // notifies watchers (if T: PartialEq, only when it changed)
fn update[R](this, f: (*T) -> R) -> R      // notifies watchers; returns the closure's value, atomically
fn watch(this) -> Watcher[T]
// Watcher[T] (Unique)
async fn next(*this) -> T?                 // the latest value since this watcher last looked
```

```minscript
// broadcast: consume in another task, then close
room := Topic.new.[Chat]()
printer := print_chats(room.subscribe())         // subscribe before publishing
room.publish(r{ from: 1, text: "hi" })
room.close()                                     // printer drains "hi", then its loop ends
await printer
// async fn print_chats(sub: Sub[Chat]) { for await msg in sub { log.println(msg.text) } }

// work queue: each job reaches one worker
jobs := Queue.new.[Job]()
for i in 0..4 { worker(i, jobs.subscribe()).ignore() }
await jobs.publish(Job { id: 1 }) or e => log.warn("queue closed")

// request / response over a queue
let t(reply, resolver) = Promise.new.[Price]()
await jobs.publish(Job { id: 2, reply: resolver })
price := await reply

// state
online := Signal(0)
online.update(#{ n => n += 1 })
```

**Closing and lifetime:**

- A `Topic` or `Queue` closes explicitly with `close()`, or **automatically when its last handle is dropped**. Subscriptions don't count as handles. After closing, `publish` fails (Topic: returns 0; Queue: `Err(Closed(v))`); subscribers drain what is buffered, then `next()` returns `None`.
- A `Signal` behaves the same way: when its last handle drops, each `Watcher` returns its last unseen value (if any), then `None`.
- So `for await x in sub` ends only when the topic or queue is closed. If the **same task** still holds the handle and only closes it after the loop, it waits on itself forever. The lint `L_SELF_WAIT` flags that pattern; the runtime `Deadlock` check catches what the lint can't see.

**Picking one:** did something happen that everyone needs to know? **Topic**. Does someone need to do this work? **Queue**. What is it right now? **Signal**. A one-time answer? **`Promise.new()`**. Shared mutable data? **`shared var`**.

### 11.4 Deadlock detection [D]

The runtime panics with `Deadlock` when **every** task is waiting and nothing could wake any of them: no timers pending, no I/O registered, no foreign callbacks outstanding.

- The panic is raised in `main` and unwinds normally, so a `recover` in `main` can catch it. Its message lists each blocked task with the `await` site it is stuck on.
- Tasks waiting on I/O or a timer are never treated as deadlocked. The check is always on, in every build.

---

## 12. Identity types and compiler data

A type that implements `Identity` is a heap object compared and hashed by pointer, so programs can key maps by tokens, AST nodes or symbols with no ids and no arenas.

### 12.1 `Identity` [D]

```minscript
type Binary: Identity {
    op: BinOp
    left: Expr          // no Box: an identity value is already a pointer
    right: Expr
}

var seen = m{} as Map[Binary, int]   // hashed by pointer
seen[node] = 1
```

- `Identity` is a marker interface, like `Unique`; it adds no keyword.
- Each construction allocates one object. `==` and `hash` compare and hash the pointer. `.same_fields(o)` is generated for structural comparison.
- Fields are immutable after construction, except `once` fields (§12.2) and `shared` fields. Assigning a plain field of an identity value is `E_ASSIGN_IDENTITY_FIELD`; build a new value instead: `moved := Ident { ...old, span: new_span }` (a different object, so `moved == old` is false).
- Passing, storing and capturing an identity value is a refcount increment. It never copies, never triggers copy-on-write and needs no effect paths.
- Because the fields are immutable, identity values cross tasks with no lock.
- **Unions of identity types** compare and hash by variant plus payload, and an identity payload compares by pointer. So `union Decl { Global(LetDecl)  Param(Ident) }` with identity payloads works as a map key with pointer semantics, and `Global(d) == Global(d)` is true.
- The compiler may allocate identity objects created in a loop from internal chunks. Programs never see an arena.
- Cycles leak under refcounting. Parent pointers should be omitted (pass the parent down) or held as `Weak[T]`.

**Choosing a representation for compiler data:**

| Data | Representation | Why |
| --- | --- | --- |
| AST nodes, symbols, types, scopes | `Identity` types | map keys, sharing, recursion without `Box` |
| Tokens | a value type hashed with its span | a span is unique per file, so value hashing already acts as identity; no allocation per token |
| Hot, flat, numeric arrays | `Vec` of value types, or `Pool[T]` (§12.5) | cache-friendly layout |

### 12.2 `once` fields [D]

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

- The field's type when read is `T?`; a write takes a `T` (`node.ty = int_type`). Writing it is allowed through a read-only view, because a write-once cell is thread-safe.
- Lowering: an atomic compare-and-set on native and WASM, a plain property on JS.
- `once` fields are allowed only on identity types (`E_ONCE_OUTSIDE_IDENTITY`): on a value type, copy-on-write would make "once" ambiguous between copies.
- A field that must be rewritten later is a `shared` field instead. Side tables (`Map[Expr, Type]`) remain the alternative when a pass's output should stay separate from the tree.

### 12.3 Interned symbols [D]

A `Symbol` is an **interned string**: the program holds exactly one `Symbol` object for each distinct text, in a global table.

```minscript
a := sym("count")   // first time: hashes "count", creates the object, stores it in the table
b := sym("count")   // finds it: returns the same pointer
a == b              // true, O(1)
a.text()            // "count": a str view of the text
```

- **Representation:** an `Identity` object holding the text and its hash, computed once. `sym(text)` is O(length); after that `==` and `hash` are O(1).
- **Symbol vs token:** two tokens with the same text are different occurrences; their `Symbol`s are the same object.
- The table is a concurrent map; `sym` may be called from any task. It keeps every symbol for the whole run (a weak table is deferred, §22).

### 12.4 `Weak[T]` [D]

`Weak[T]` is a non-owning reference to an identity value or a `shared` cell; it doesn't keep its target alive.

- `x.weak() -> Weak[T]` on an identity value; `w.upgrade() -> T?` gives the value while some owner still holds it.
- Use it for back-references (a child's parent, a customer's referrer) that would otherwise form refcount cycles.

### 12.5 Persistent collections and pools [D]

- **`PMap[K, V]` and `PVec[T]`:** persistent collections whose copy-on-write costs O(log n) instead of O(n). Suited to scopes and environments that are copied and extended often.
  - `PMap.new.[K, V]()`, `m.with(k, v) -> PMap[K, V]` (a new version; the old one stays valid), `m.without(k)`, `m.get(k) -> V?`, `m.has(k)`, `m.len()`, iteration.
  - `PVec` has `push`, `set`, `pop` returning new versions, plus `get`, `len` and iteration.
- **`Pool[T]` and `Id[T]`:** a typed, generation-checked pool for data-oriented code that profiles show needs it. Views from `pool.get(id)` are free.

---

## 13. Other semantics

### 13.1 Numbers [D]

- Implicit **lossless widening** is allowed: `i8→i16→i32→i64`, `uN→uM` (M > N), `uN→i(2N)`, `i32/u32→f64`, `f32→f64`. `int` widens to `i64` and narrows from nothing.
- Every other conversion is explicit: `as` for truncating / saturating casts (§3.3), and `.to_int()`, `.to_u8()` … for checked conversions returning `Result`.
- **Overflow always panics**, in every build. Explicit alternatives: `.wrapping_add()`, `.saturating_add()`, `.checked_add() -> T?`.
- Arithmetic needs operands of the same number type; if one side widens losslessly to the other, the result is the wider type. Other types use the operator interfaces (`Plus`, `Minus`, …).

### 13.2 Interfaces: static and dynamic dispatch [D]

```minscript
fn show_static[T: Stringer](x: T) { … }     // one body; T's witness table is passed in (§15.4)
fn show_dyn(x: Stringer) { … }              // dynamic: data + vtable

let shapes: Vec[Shape] = [Circle { r: 1.0 }, Square { s: 2.0 }]   // owned interface values
```

- An interface value used as a parameter is a view and never allocates. An owned interface value (in a field, a Vec, or a return) is **boxed implicitly**.
- **Dyn safety** is checked at the use site: a method with its own generic parameters, or one that returns `Self` by value, can't be called through a dynamic value (`E_NOT_DYN_SAFE`).
- std uses the dynamic form for variadic printing: `pub fn println(...args: Stringer)`.

**Generated on demand** for any type whose fields all support them, unless the user writes their own:

| Interface | Generated as |
| --- | --- |
| `Stringer.to_str()` | `User { id: 1, name: "Ted" }`, showing only fields visible at the call site's package |
| `PartialEq.eq()` | field-wise (pointer equality for identity types) |
| `Hash.hash()` | field-wise (the pointer for identity types) |
| `Default.default()` | a struct whose every field has a default, is optional, or has a `Default` type |

**Built in:** numbers implement the operator interfaces and `Default` (0); `str` implements `Plus` (concatenation), `PlusAssign` and `Default` (`""`); `bool` implements `Default` (`false`); `Vec`, `Map`, `Set` and `Option` implement `Default` (empty, `None`).

### 13.3 Errors and panics [D]

- **Expected failures** use `Result` / `Option`, with `?`, `or`, `??` and truthiness.
- **Panics** come from `panic(msg)`, `assert(cond, msg)`, overflow, out-of-bounds indexing, missing map keys, failed unwraps and the runtime kinds of §18.4.

A panic **unwinds to the nearest enclosing `recover` block**, the same way in every build:

```minscript
let res = recover {                // Result[T, Panic]
    process(items, 10)             // panics deep inside: no Result drilling needed
}
let Err(p) = res else { … }
log.println(p.message, p.file, p.line, p.trace)
if p.kind == PanicKind.Deadlock { … }
```

- While unwinding, `Drop` runs for every owned value in the frames being unwound, and `lock` blocks release their locks.
- **Poisoning:** a `var` written inside a `recover` block (directly or through a `*` argument) that then panicked may be half-updated, so it is **poisoned**. Reading it before re-assigning it is `E_USE_OF_POISONED` on every path where the panic branch is taken. Assigning a fresh value clears it. A `shared` cell written by a panicking statement is checked at runtime instead: the next access panics until it is assigned again.
- A panic in an async task unwinds to the task boundary. The promise is then **rejected**: `await` re-panics in the awaiting task, and `.catch(#{…})` handles it.
- A panic with no enclosing `recover` (in `main`, or in an `.ignore()`d task) prints the message and trace. The process then exits (`main`), or the task is dropped (`.ignore()`).
- **Every panic kind is catchable.** The only failures that end the process without reaching `recover` are ones that leave the runtime unusable: out of memory and native stack exhaustion.
- Use `Result` for errors a caller should handle, and panic + `recover` for "this request or job failed" boundaries.

### 13.4 Introspection [D]

- `T._get_info()` and `value._get_info()` are compile-time intrinsics that return `TypeInfo { name, kind, fields }`, respecting call-site visibility.
- Names starting with `_` are reserved for intrinsics (`_builtin()`, `_get_info()`).
- `std.json` derives serialisation from them; `impl Serializer for T` overrides it.

### 13.5 Type checking [D]

The checker is **bidirectional**: every expression is checked against the type its context expects, if there is one. The expected type drives literals (`let x: u8 = 7`), empty collections and `nil`, `_{…}`, closure parameters and their modes (`items.map(#{ it * 2 })`), and variants named without their type (§7.7).

- **Inference:** generic calls get fresh inference variables, bound by unification with the arguments and the expected result. A variable may be bound by later code in the same function (`var v = []` then `v.push(1)` gives `Vec[int]`). Anything still unknown at the end of the function is `E_CANNOT_INFER_TYPE`; numeric literals then default to `int` / `f64`.
- **Calls:** missing arguments are allowed only for trailing parameters of type `void` (`Ok()`, `resolver.resolve()`). Calling a type calls its static `new`: `Signal(0)` is `Signal.new(0)`. `.[T]` on a static method without generics of its own supplies the type's generics: `Topic.new.[str]()` is `Topic[str].new()`.
- **Callbacks:** a closure may take fewer parameters than its function type. The `Vec` pipeline callbacks (`map`, `filter`, `any`, `find`, `for_each`, `fold`, …) receive `(item, index)` as views.
- **Errors:** `x?` needs the function to return an `Option` (for an Option) or a `Result` whose error type accepts the error. `x or rhs` returns `rhs` from the function, so `rhs` must match the function's result.
- **Iteration:** `for x in e` iterates `Vec`, `Array`, `Slice`, `Set`, `PVec` (with `for x, i in` giving the index), `Map` / `PMap` (`for k, v in`), `Range`, and anything with `next() -> T?` or `iter()`. A `str` needs `.chars()`, `.bytes()` or `.lines()` (`E_NOT_ITERABLE`).
- **Exhaustiveness:** a `match` on a union must cover every variant with an irrefutable payload, or have a catch-all. `bool` must cover `true` and `false`, and a literal union every literal. Other types, and a `match` without a subject, need `_ =>`.
- **Methods named after keywords** (`fn or`, `fn lock`) are allowed, since they are only called after `.`.
- **Gradual typing:** members of a package that isn't loaded (§8.1), and of a package checked on its own, have the type `unknown`. `unknown` is compatible with everything and never produces a diagnostic. Arguments of a call to something `unknown` are checked against `unknown`, so `[]`, `nil` and bare variant names there need no annotation. In an open file (§8.7) an unknown name is never an error.
- **The expected type is a hint, not an equation.** It guides inference before the arguments are checked (`let v: Vec[u8] = Vec.new()`), except when it is an interface: `log.println(xs.fold(0, #{ a, x => a + x }))` infers `int` for `fold`, which then must implement `Stringer`.
- **Missing trailing arguments** are allowed for `void` parameters, and for parameters whose type is still unknown, which become `void`: `Ok()` in an untyped closure is `Ok(t())`.
- **Exhaustiveness is checked on nested patterns**: `Some(Circle(_)) | Some(Square(_))` doesn't cover `Some(Empty)`. The message names a missing case.

---

## 14. Prelude and std

### 14.1 Prelude [D]

The prelude is MinScript (`std/prelude.ms`). It must parse, resolve, type-check and access-check cleanly, and its private items aren't visible to other packages.

- **The core** is the set of functions whose body is `_builtin()` (an intrinsic of type `never`), implemented by each back end: panics, storage and hashing (`Vec`, `Map`, `Set`, `PVec`, `PMap` access), `Range`, iterators, the string primitives (`len`, `substring`, `find`, `byte_at`, `to_lower`, `to_upper`, `to_float`, `bytes`, `chars`, `detach`), the integers' `wrapping_*` / `saturating_*` / `checked_*`, `sym` and `Symbol.text`, `Weak`, and everything concurrent (`Promise`, `all`, `race`, `Topic`, `Queue`, `Signal`, `Log`). Each carries an `#[effects]` attribute where it keeps, consumes or returns a view.
- **Everything else is MinScript** on top of the core: `Option` and `Result` methods, `assert`, the `Vec` lookups and pipelines, `Map.keys` / `values`, the string helpers (`trim`, `split`, `lines`, `replace`, `starts_with`, `to_int`, …). Their tests are MinScript too.
- Methods that need something of the items are declared only where the items have it: `impl[T: PartialOrd[T]] Vec[T] { max, min, sort }`, `impl[T: Stringer] Vec[T] { join }`, `impl[T: Plus[T, T] & Default] Vec[T] { sum }`.

**Names:**

- **Types:** `Option` / `Some` / `None` / `nil`, `Result` / `Ok` / `Err`, `Promise`, `Resolver`, `Topic`, `Queue`, `Signal`, `Sub`, `Watcher`, `Weak`, `Vec`, `Map`, `Set`, `PVec`, `PMap`, `Array`, `Slice`, `Symbol`, `Panic`, `PanicKind`, `Ordering` (`Less` / `Equal` / `Greater`).
- **Functions:** `assert`, `panic`, `sym`, `all`, `race`.
- **`log`:** `log.println`, `log.print`, `log.warn`, `log.error`.
- **The core interfaces** of §14.2.
- Bare `println` / `print` are **not** in the prelude: `import "std.io.{print, println}"`.
- `Option` / `Result` helpers: `.or(v | #{…})`, `.is_some()`, `.is_none()`, `.is_ok()`, `.is_err()`, `.map(#{…})`, `.map_err(#{…})`, `.ok()`, `.err()`, `.unwrap()` (panics).

### 14.2 Core interfaces [D]

```minscript
inter Copy {}
inter Identity {}                                   // compared and hashed by pointer (§12.1)
inter Unique {}                                     // one owner; std / extern only (§9.2)
inter Drop { fn drop(*this) }
inter Default { fn default() -> Self }
inter Stringer { fn to_str(this) -> str }
inter PartialEq[T] { fn eq(this, o: T) -> bool }
inter PartialOrd[T]: PartialEq[T] { fn partial_cmp(this, o: T) -> Ordering? }
inter Hash { fn hash(this) -> u64 }
inter Plus[R, O] { fn plus(this, rhs: R) -> O }     // `+`; also Minus, Times, Divide, Remainder
inter PlusAssign[R] { fn plus_assign(*this, rhs: R) } // `+=`; also MinusAssign, …
inter Index[I, T] { fn index(this, i: I) -> T }       // returns a view
inter IndexMut[I, T] { fn index_mut(*this, i: I) -> *T }
inter Iterator[T] { fn next(*this) -> T? }
inter AsyncIterator[T] { async fn next(*this) -> T? } // `for await`
inter Iterable[T] { fn iter(this) -> Iterator[T] }
```

`for x in c` uses `c.iter()`. Pipelines (`.map`, `.filter`, …) call `.iter()` implicitly. The v0.2 `Clone` interface is removed: every non-Unique type can be copied.

### 14.3 std conventions [D]

- `to_str()` converts anything to a `str`. `len()`, `has()`, `get() -> T?`. A string's `len()` and offsets are in UTF-8 bytes.
- `at(i)` allows negative indices. `x[i]` panics when out of bounds.
- **String processing returns views and doesn't fail:** `trim`, `substring`, `strip_prefix` / `strip_suffix` (unchanged if absent), `try_strip_prefix` / `try_strip_suffix` (`None` if absent), `split -> Vec[str]`. So `path.strip_suffix(".enc")` needs no fallback. `to_lower()` returns a new string.
- **Fallible parsing returns `Result`:** `json.parse.[T](s) -> Result[T, json.Error]`, `"42".to_int() -> Result[int, ParseError]`.

### 14.4 std packages [D]

Each std package is a folder under `std/`, written in MinScript; functions only the runtime can provide have the body `_builtin()`. Every std package must load and check cleanly.

| Package | Contents |
| --- | --- |
| `std.io` | `print`, `println`, `eprintln` (`...args: Stringer`), `async read_line() -> str` (`""` at the end of input) |
| `std.log` | the prelude's `log` functions as a package |
| `std.time` | `after(ms) -> Promise[void]` (cancel-safe), `async sleep(ms)`, `now() -> i64`, `Instant` (`now`, `elapsed`), `Duration` |
| `std.json` | `parse[T](text) -> Result[T, json.Error]`, `stringify[T](v: T) -> str`, `to_value[T](v: T) -> Value`, `from_value[T](v: Value) -> Result[T, json.Error]`, `union Value` for documents of unknown shape |
| `std.fs` | async `read_file` / `read_text` / `write_file` / `write_text` / `stat` / `exists` / `list_dir` / `walk_dir` / `create_dir` / `remove`; failures are `Result[_, fs.Error]` |
| `std.env` | `get(name) -> str?`, `set`, `args() -> Vec[str]`, `cwd() -> str` |
| `std.math` | `pi`, `e`, `abs`, `min`, `max`, `sqrt`, `pow`, `floor`, `ceil`, `round`, `sin`, `cos` |
| `std.crypto` | `encrypt_aes_gcm` / `decrypt_aes_gcm` (password-based), `sha256`, `random_bytes` |
| `std.runtime` | `async yield()`; `exit(code) -> never`; `async run_module(js, args) -> int` and `run_module_result(js, args, capture)` (run a compiled program in a new process); `shell(cmd, dir) -> int` |
| `std.utf8` | `decode(bytes: Slice[u8]) -> str` (invalid sequences → U+FFFD), `decode_range`, `encode(s: str) -> Vec[u8]`, `sequence_length(lead: u8)` |
| `std.unsafe` | `Ptr[T]` and its methods; usable only inside `unsafe { }` |
| `std.net.http` | HTTP/1.1 server (`listen`, `Server.accept`, `Request`, `Response`, `json_response`) and client (`get`, `post`, `send`) |
| `std.net.ws` | WebSockets: `listen`, `connect`, `Server.accept`, `Connection.split(this) -> t(Reader, Writer)` (consumes the connection), `Reader.receive` (cancel-safe), `Writer.send`, `union Message { Text(str)  Binary(Vec[u8])  Close }` |
| `std.testing` | assertions (`assert_eq`, `assert_ne`, `assert_true`, `assert_ok`, `assert_err`, `assert_some`, `fail`) and the runner `run_all` (§17.7); it imports nothing |
| `build` | the mod.ms API (§17): `Config`, `Tool`, `Script` (`sh`, `pkg`, `task`), `Args`, `run`, `target` (`Target`, `Os`), `env`, `evaluate(config)` |
| `ms.fmt`, `ms.test` | first-party tools' `Options` and `setup(o) -> Tool` (§17.4) |

**JSON mapping:** a struct is an object (a missing field takes its default, an optional field may be missing or `null`, any other missing field is an error); `Option` is the value or `null`; `Vec` is an array; `Map[str, V]` is an object; a union variant is `"Name"` without a payload and `{ "Name": [payload…] }` with one; a literal union is its literal; `i64` / `u64` are numbers.

---

## 15. Compiler architecture

The ownership work is one bottom-up pass that writes a summary per function, followed by local passes that read those summaries. Nothing in it is whole-program.

| # | Pass | Scope | Cost | Output |
| --- | --- | --- | --- | --- |
| 1–4 | Lex, parse, resolve, type-check | per file / package | linear | typed AST |
| 5 | Lower to HIR | per function | linear | HIR with explicit places (`user.tags[*]`) |
| 6 | **Effect summaries** | call graph, SCC order | linear in call edges × rounds; rounds bounded by summary size (§15.1) | one summary per function |
| 7 | **Access check** | per function | linear | `*` argument overlap, write views, concurrent statements, `Unique` moves |
| 8 | **Mechanism selection** | per function | linear | each use tagged view / move / share / copy; heap promotion; `shared` lowering |
| 9 | Lints | per function (plus the type graph) | linear | the §18.4 lints at their levels (`ms lint`) |
| 10 | Back ends | per function | linear | JS / WASM / native |

Passes don't modify the AST: the resolver and the checker return side tables keyed by AST node, and lowering builds a new tree. Lowering reads the checker's recorded decisions; it never re-derives type rules.

**The HIR [D]** (pass 5) is the small typed core every later pass and back end works on:

- **Places.** Every read, write and `*` argument names a place: a root (a local, a parameter, `this`, a global, or a computed value) and a path of fields, tuple indices and elements. Its access path is what summaries use: `this.stock.items[*]`, `users[0].age`, truncated to 4 segments (§9.5).
- **Resolved calls.** A call names its callee (`app.catalog.Inventory.at_mut`), gives each argument its mode (`read`, or `write` for a `*T` parameter or a `*this` receiver, passed as a place), and lists the type arguments the callee's witnesses need. A method of an interface called on a type parameter or an interface value is a dynamic call; a static of a type parameter (`T.default()`) goes through its witness; operators, indexing and iteration on named types are ordinary method calls.
- **Sugar removed.** `?`, `or`, `??`, `?.` and `if let` are `match`es with explicit `return`s, and `ok` / `fail` patterns match an Option or a Result alike. Truthiness is an explicit test. Inferred variants are qualified. Struct literals list every field, defaults filled in. Variadic arguments are packed into a Vec. A subject-less `match` is an `if` chain. `for x in e` stays a `foreach` (it reads `e[*]`); the other loops are `loop`.
- **Closures** list their captures, each marked as read or written by the body.
- **Witness parameters.** Each generic function records the type parameters it needs at run time, for JS and for native back ends (§15.4).

### 15.1 Pass 6: effect summaries [D]

- Functions are processed in reverse topological order of the call graph, one SCC at a time. Callees are always summarised before callers.
- A summary is a bounded set of paths (≤ 4 segments), so it has a finite size and a finite lattice.
- *One evaluation* walks a body once: it resolves the locals that alias parameter paths, collects the body's own effects and its calls, and substitutes each callee's current summary into its arguments' paths. It is linear in the body. (A local bound to a call's result is a view of what the callee's `returns_view` says, so a body can't be summarised once into call lists independent of its callees: inside a recursive component a member is re-evaluated, not just re-substituted.)
- *Fixpoint in a recursive SCC.* Every member starts from an empty summary. A worklist re-evaluates a member only when a callee's summary in the same SCC grew. Summaries only grow, and each is a bounded set of paths, so this terminates, with rounds bounded by summary size (§0.2). In practice it takes a handful of evaluations per member even for a parser-sized SCC: the calc sample's parser needs at most 6, and a ring of 60 functions each calling the next at most 3. Non-recursive functions are evaluated once.
- *Safety cap.* If a member of an SCC is re-evaluated more than 32 times, only the paths that changed in the last round are widened, each to its first segment (`writes [this.diagnostics[*].span]` becomes `writes [this.diagnostics]`). From then on, every new path in that SCC is added at its first segment. There are only as many of those as the parameters have fields, so the SCC finishes within a few more rounds, and `L_SUMMARY_WIDENED` names the SCC and the widened paths. Paths that were already stable keep their precision, so a view of `this.tokens` held across a call that writes `this.pos` stays valid.
- Calls through interfaces, function values and `extern` use the signature-level summary and never trigger iteration.

**Pass 7 details [D]** (the access check, one function body at a time, with the callees' summaries; it runs only on code without type errors):

- *Writable places.* A place is writable when its root is a `var` (or `:==`, a `var` pattern, a `*` parameter, `*this`, a closure parameter of mode `*`), a write view, or a `shared` binding, or when its path passes a `shared` or `once` field. Writing anything else is `E_ASSIGN_IMMUTABLE` (a read-mode closure parameter: `E_WRITE_TO_IMMUTABLE`); passing it to `*T` or `*this` is `E_WRITE_TO_IMMUTABLE`.
- *Overlapping arguments.* For each `*` argument, what the callee writes through it (from its summary, or all of it without one) must not overlap another argument's place. A read argument of a Copy type is a bit copy and holds nothing live. Paths through `shared` cells never conflict.
- *Write views* are live from their binding to their last use in the same block; any other access to an overlapping path in between is `E_ACCESS_DURING_WRITE_VIEW`.
- *Moves of `Unique` values* are tracked in evaluation order. A value moves when it is bound, stored, returned, captured by an escaping closure, or passed to a parameter whose summary keeps or consumes it; a `*` argument only lends it. After an `if` / `match` it may be moved if a branch that can finish moved it (a branch that returns, breaks or panics doesn't count). A loop body is checked as if run twice, so a move inside it is a use after move on the next iteration. Assigning the whole binding gives it a fresh value.
- *Tasks of one statement* are the calls inside `all(…)` / `race(…)` and the waits of `select` arms. Their summaries, substituted, must not overlap on a written non-shared path. An async call not awaited in its statement may only take owned values (`E_VIEW_ACROSS_TASK`).
- *Escaping closures* are those returned, stored outside the function's own locals, passed to a parameter that keeps them, or handed to a task that isn't awaited. A closure bound to a local and only called is not escaping.
- *Poisoning* is conservative: a `var` declared outside a `recover` block and written inside it is poisoned after the block, until it is assigned again.

### 15.2 Pass 8: mechanism selection [D]

One function body at a time, after the access check, with the callees' summaries. `ms mech file.ms` prints the result.

- *Uses.* Each read of a whole local or parameter is a **copy** (a Copy type), a **view** (it is only lent: an operand, a receiver, a match subject, an argument to a borrowed parameter), or, where the value is handed over (bound, stored in a field or a collection, returned, passed to an owned parameter), a **move** or a **share**.
- *Move vs share.* A handed-over use is a move if it is the last use of that binding on every path (a backward liveness scan; loops to a fixpoint); otherwise it is a share. A binding never moves when it is captured by a closure, is a `shared` cell or a write view, or is live after an enclosing `recover` (a panic can leave the block at any point). A read with a path (`u.tags`) that is handed over is a share.
- *Owned and borrowed parameters.* A parameter whose value the body moves (`var c = base` at its last use) is **owned**: callers hand it over, moving or sharing it, and never lend it. Every other parameter is **borrowed** and callers pass a view. A callee's ownership depends on its own callees', so it is computed to a fixpoint over the call graph, callees first; it only grows, so it terminates (the samples settle in one round, plus one that confirms). Parameters stay borrowed when not every caller is known statically: a function used as a value, an interface method, a closure parameter, a receiver. An `async fn` owns all its parameters, since its task outlives the call. A builtin owns what its `#[effects]` keeps or consumes.
- *Copy-on-write placement.* A write to a value that might be shared compiles to `if !unique(x) { x = copy(x) }`. Uniqueness proven by pass 8 removes the check at the root: a local whose every value is a fresh literal, never shared, and never lent to a call whose result may be a view of it. Checks below the root stay.
- *Heap promotion.* A local whose buffer is reached by a `keeps` (passed to a parameter the callee keeps, or captured by a closure that escapes) is allocated on the heap; everything else stays on the stack or in caller-provided return storage.
- *Meaning is unchanged.* Mechanism selection only removes shares and checks: a program prints the same with it as without (`ms run --no-mech`), which the test suite checks.

### 15.3 Packages, interfaces and caching [D]

- A package's **compiled interface** holds its types and its `pub` function summaries. Callers in other packages read only that: an analysis never needs a dependency's function bodies.
- **Early cutoff:** when a package is rebuilt and its interface is unchanged, dependents are not re-checked. Editing a function body therefore re-checks only that package unless its public summary changed.
- Each package's interface and generated JS are cached in `.ms-cache/`, keyed by a hash of its sources and its dependencies' interfaces. std and the prelude are checked once per toolchain version.
- Generic functions are type-checked once, at the definition (§9.2), and compiled once (§15.4). A package's interface never contains generic bodies, so editing one recompiles only its own package.

**Back-end memory model:**

- *Native and WASM:* non-atomic refcounts by default; atomic only for values that escape to another task (pass 8 knows). Reuse of a freed buffer of the same size (Perceus-style) is an optimisation for later.
- *JS:* the GC owns memory. Uniqueness for copy-on-write is tracked with a "shared" bit (§16.2). `Drop` runs only for `Unique` types.

### 15.4 Generics: one body, witness tables [D]

MinScript does not monomorphize. Like Go's dictionaries and Swift's witness tables, each generic function and each method of a generic type is compiled **once**, and a call passes what the body needs to know about its type arguments at run time. Compile time is the priority: a generic body is lowered, optimised and emitted once per program, whatever number of types it is used with, and there is no code bloat.

- **Witness tables.** For each type parameter the body needs at run time, the call passes a hidden argument: a pointer to a static, per-type table. It holds:
  - the **value witnesses**: size, alignment, and how to copy (share), move and drop a value of that type. They let the body hold, store and pass a `T` it knows nothing else about;
  - the **generated methods** the body uses: `eq`, `hash`, `to_str`, `default`;
  - for each bound (`[T: Stringer & Hash]`), the **interface's method table**: the same table a dynamic interface value carries (§13.2).
- **Only what is needed.** A pass after type checking records which type parameters each generic function needs at run time: those whose values it hashes, compares, prints, defaults, copies or drops, calls bound methods on, or passes to another generic function that needs them. The others get no hidden argument. On JS most generic code needs none: values are references and the GC owns them (§16).
- **Representation of a `T`.** Inside a generic body a `T` is handled through its table. On native back ends a value whose size isn't known statically lives in a buffer of the caller's frame (or the heap when kept) and is passed by pointer. Most v0.4 values are already one pointer (a refcounted buffer, §9.1), so the extra indirection is small.
- **Tables are built once per type**, statically when the type is known at compile time, or lazily at run time for a type built from other type parameters (`Vec[T]` inside a generic body), then cached.
- **Costs accepted:** a method call on a `T` is an indirect call, as through an interface value; a generic body is not inlined into its callers; small values such as an `int` move through memory inside generic code. Non-generic code pays nothing.
- **Prelude pipelines are the exception that matters.** `map`, `filter`, `for_each`, `any`, `find` and `fold` called with a closure literal are expanded at the call site into a loop over the concrete element type (§16.3), so the commonest generic code runs at full speed without monomorphization.
- **Specialization is not part of v0.4.** An opt-in specialization of hot generic functions, within one package, is an open question (§22) to revisit with profiles.

---

## 16. JS back end

Generated JS must run close to hand-written TypeScript. Profile (`ms run --profile`, which passes `--cpu-prof` to Node) before and after each change to these rules.

### 16.1 Values [D]

| MinScript | JS representation | Rule |
| --- | --- | --- |
| `int`, `i8`–`i32`, `u8`–`u32`, `f32`, `f64` | `number` | overflow check after `+ - *` (`Math.imul` for 32-bit `*`); skipped where the range is proven (loop counters, indices) |
| `i64`, `u64` | `BigInt` | correct but slow: `L_BIGINT_ON_JS`. Hashes are `u32`; spans and counters use `int` |
| `str` | JS `string` | a view is a `substring` (V8 shares the buffer); an `ascii` flag is cached per string so byte offsets equal UTF-16 indices; non-ASCII strings build an offset table once, on the first byte-offset call |
| `bytes()` | `Uint8Array`, cached per string | lexers should scan this, not the string |
| byte literal | `number` | |
| `T?` | `T` or `undefined` | when `T` can't itself be absent; otherwise (`T??`-like nesting, `void?`) a `{ some: v }` box |
| `Result[T, E]` | instance of `Ok` or `Err` | two classes with a fixed shape; `?` is one `instanceof` test |
| named struct | one JS class per type | the constructor assigns every field in declaration order (stable hidden class) |
| record `r{…}` | one JS class per normalised shape | fields sorted by name |
| union | one JS class per variant | an integer `tag` on the prototype; `match` is a `switch (x.tag)` |
| `Identity` type | JS class | `==` is `===`; used directly as `Map` / `Set` keys |
| `Symbol` | `{ text, hash }` object | the intern table is a JS `Map<string, Symbol>` |
| `Vec[T]` | JS `Array` | `$s` (shared) flag for copy-on-write |
| `Map[K, V]`, `Set[T]` | native `Map` / `Set` when keys are numbers, strings, `Symbol` or identity values | a runtime hash map using the generated `hash` / `eq` otherwise |

### 16.2 Copy-on-write on JS [D]

JS has no refcount, so the back end tracks one **shared bit** per buffer (`$s` on arrays, maps, sets and struct objects):

- A **share** sets `$s = true` on the value. A **move** does not.
- A **write** to a value with `$s` set first copies it (shallow; the copy has `$s = false`), then writes the copy.
- The bit is never cleared on the original, so JS may copy where native would not. That is correct, only slower; mechanism selection keeps shares rare.
- A move or a view sets nothing (§15.2). A builtin that returns a view of an element (`get`, `first`, an iterator's `next`) shares that element, and `iter()` shares its collection, so a later write to the collection copies instead of changing what the view sees.

### 16.3 Control and runtime [D]

- **Loops:** `for x in vec` and `for i in a..b` become index loops. `map` / `filter` / `for_each` / `any` / `find` / `fold` with a closure literal are inlined as loops; no iterator objects, no per-element `Option`.
- **Closures** passed to a function whose summary does not `keep` them are inlined when the callee is a prelude pipeline; otherwise they are ordinary JS functions.
- **Async:** only `async fn` compiles to a JS `async function`. Everything else is synchronous.
- **Panics** are instances of a `Panic` class thrown as exceptions. `recover` is `try/catch`. `try/finally` is emitted only where a `Unique` value needs `Drop`.
- **`shared`:** a plain variable or property (one JS thread per worker). `lock` blocks compile to a plain block.
- **`once`:** a property initialised to `undefined`; a write checks for `undefined` and panics otherwise.
- **String interpolation:** a template literal; `to_str()` is called only for non-primitive values.

---

## 17. Projects, tests and formatting

### 17.1 `mod.ms` [D]

A project has **one** configuration file at its root, `mod.ms`. It holds the project metadata, dependencies, scripts (`ms run dev`) and every tool's settings (build, fmt, lint, test, LSP, third-party tools). There is also one generated, machine-owned `mod.lock`. `ms config` prints the resolved `Config` as JSON.

```minscript
package mod

import "build.*"                    // toolchain API: Config, Script, sh, task, pkg, target, Os …
import "ms.fmt"                     // first-party tools (versioned with the toolchain)
import "ms.test"
import "acme.lint@^1.2"             // third-party tool: version pinned in the import

pub fn config() -> Config {
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
            "dev": sh("ms build --target js --watch --hot")
            "migrate": pkg("./tools/migrate")           // runs that package's main(args)
            "release": task(#{ args =>
                run("ms test")?
                run("ms build --target native --release")?
                Ok()
            })
        }
    }

    if target.os == Os.Android {                        // per-platform deps are ordinary code
        c.deps["android.ui"] = "^0.3.0"
    }

    c.tools([
        fmt.setup(_{ indent: 4 }),
        test.setup(_{ parallel: true }),
        lint.setup(_{ strict: true, warn: ["L_IMPLICIT_COPY"] }),
    ])
}
```

### 17.2 The `Config` type [D]

```minscript
// package build
pub type Config {
    pub name: str                             // required
    pub version: str                          // required (semver)
    pub main: str = ""                        // "": the default (§17.6)
    pub deps: Map[str, str] = m{}
    pub dev_deps: Map[str, str] = m{}
    pub scripts: Map[str, Script] = m{}
    sections: Map[str, json.Value] = m{}      // tool settings, via the methods below

    pub fn tools(this, ts: Vec[Tool]) -> Config { … }    // applies each tool in order
    pub fn set_section[T](*this, name: str, value: T) { … }
    pub fn section[T](this, name: str) -> Result[T, json.Error] { … }
    pub fn raw_section(this, name: str) -> json.Value? { … }
}
pub type Tool = (Config) -> Config
```

- `name` and `version` are named fields: a struct literal is self-describing, defaults let you skip what you don't need, and `ms config` prints it as is.
- **Dependencies are a `Map[str, str]`** (package to source spec): keys are unique, tools can look them up, and it prints as a JSON object. The value is a semver range (`"^2.1.0"`) or a prefixed source (`"path:…"`, `"git:…#rev"`), validated by the toolchain (`E_BAD_DEP_SPEC`).

### 17.3 Scripts: `ms run <name>` [D]

```minscript
pub union Script {
    Shell(str)                                 // sh("…"): a shell command line
    Package(str)                               // pkg("./tools/migrate"): runs that package's main
    Task((Args) -> Result[void, str])          // task(#{…}): inline MinScript
}
pub fn sh(cmd: str) -> Script { Shell(cmd) }
pub fn run(cmd: str) -> Result[void, str] { … }   // executes a command now (inside a task)
```

```bash
ms run dev
ms run migrate -- --steps 2      # everything after `--` is passed as Args
ms dev                           # shorthand, when `dev` isn't a built-in command
ms run                           # lists the available scripts
ms run .                         # runs the program (also: a folder, or a file)
ms config                        # prints the evaluated Config as JSON
```

- `ms run <x>` runs a program when `x` looks like a path (it contains `/`, ends in `.ms`, is `.` / `..`) or names an existing file or folder; otherwise it is a script of the nearest `mod.ms`.
- `Shell` scripts run in the project root, with the arguments appended (quoted). `Package` scripts run that folder's `package main` files, with the arguments in `env.args()`. A `Task` gets them as `Args`; an `Err` result fails the command.
- **Evaluation is separate from execution.** Evaluating `config()` is sandboxed (§17.5). A script body runs only when invoked, with normal permissions. Calling a `task` during evaluation is `E_SCRIPT_IN_EVAL`.
- Tools may register scripts. Script dependencies are ordinary code: a `task` that needs another script first calls it.

### 17.4 Tool sections and the pipeline [D]

- A tool is a function `(Config) -> Config`. `c.tools([...])` applies the tools **in order**; each reads the current `Config`, writes its own section, may read other tools' sections, may add scripts, and returns the result.

```minscript
// package ms.fmt
pub type Options {
    indent: int = 4
    max_width: int = 100
    trailing_commas: bool = true
}

pub fn setup(o: Options) -> Tool {
    #{ var c =>
        c.set_section("fmt", o)
        c
    }
}

// inside the fmt tool at run time:
let opts = cfg.section.[Options]("fmt") ?? Options {}   // all defaults
```

- Sections are typed in and out, and stored as a `json.Value` tree through the derived serialiser (§13.4), which gives `ms config` its JSON output.
- Reading another tool's section with its type means importing that tool's package (`c.section.[lint.Options]("lint")`); without the import, `raw_section("lint")` gives the untyped value. Two tools writing the same section is `E_SECTION_CONFLICT`.

### 17.5 Evaluation rules [D]

- `config()` runs in a **sandboxed, deterministic interpreter** (the JS back end): no network, no file writes, no processes. It may read `target`, `env` and files under the project root.
- The result is cached by a hash of `mod.ms`, `mod.lock`, `target` and the env vars that were read.
- **Bootstrapping:** packages imported by `mod.ms` itself carry their version in the import string (`"acme.lint@^1.2"`), so the toolchain can fetch them without evaluating the file first. `ms.*` tools are versioned with the toolchain.

### 17.6 Entry point [D]

- `main` (from `Config.main`) is the folder holding `package main`. Every `package main` file in it is one package; `app.x` imports start from this folder.
- If it's empty (the default), the toolchain uses `./src` when that folder exists, and the project root otherwise. A folder without `mod.ms` is run with the same default.
- The project is the nearest folder at or above the given path that has a `mod.ms`.

### 17.7 Testing: `ms test` [D]

```minscript
// src/models/item_test.ms: a test file is part of its package (it sees private items)
package models

import "std.testing.{assert_eq, assert_ok}"

fn test_price() {
    assert_eq(Item { name: "pen", cents: 150 }.cents, 150)
}

async fn test_load() {                       // async tests are awaited
    let items = assert_ok(await load("fixtures/items.json"))
    assert_eq(items.len(), 3)
}
```

```bash
ms test                      # every package at or under the current folder
ms test std src/models       # some folders
ms test --run price          # only tests whose name contains "price"
ms test --reporter dots
```

- **Test files** are `*_test.ms`, in the folder of the package they test, and declare that package. They are compiled only while their package is being tested.
- **Tests** are the top-level functions whose name starts with `test_`. They take no parameters and return nothing (`E_TEST_SIGNATURE`); they may be `async`. A test fails by panicking, usually through a `std.testing` assertion. The other tests still run.
- **The runner is MinScript:** `ms test` adds a generated file to each package, with a `main` that passes every test to `std.testing.run_all`, which runs each inside `recover`, times it, prints the report and returns the number of failures. `ms test` exits with status 1 if any test failed or a package didn't compile.

### 17.8 Formatting: `ms fmt` [D]

```bash
ms fmt                       # format every .ms file at or under the current folder, in place
ms fmt --check               # report unformatted files; exit 1 if there are any
```

- **Width:** a construct goes on one line if it fits in `max_width`. Otherwise it breaks only where §5.4 allows: arguments, parameters and elements inside `(…)` / `[…]` go one per line with a trailing comma; the entries of a `{…}` literal go one per line without commas; the branches of an `if` / `else` chain break together.
- **The author decides where the style has no opinion:** a body, literal, `match` or `select` written over several lines stays expanded; a one-liner stays one while it fits. Broken method chains and multi-line trailing closures keep their shape.
- **Fixed spellings:** 4-space indents, `{` on the header line, one space around binary operators and none around `..`, `#{ x => … }` closures, unions on one line separated by two spaces (`{ A  B(int) }`), `match` arms without commas once they are one per line. Literals are copied as written. `a [0]` and `t (x)` keep their space (§1.7).
- **Semicolons:** every `;` is removed except one after a block's last expression (§5.4 rule 8).
- **Comments and blank lines** are kept; several blank lines become one. A trailing `//` comment keeps its column if the code still ends before it, otherwise its run of consecutive lines is aligned two spaces after the longest one.
- **Guarantees:** the output parses to the same AST, keeps every comment, and formatting it again changes nothing. A file with a syntax error isn't changed.

---

## 18. Diagnostics

Each mistake produces **exactly one** diagnostic. Common mistakes are recognised and parsed as the intended form, then parsing continues (`report`); any other error skips to the next statement, item, member or arm (`fail`).

### 18.1 Lexer [D]

| Code | Meaning |
| --- | --- |
| `E_UNTERMINATED_STRING` | `"` not closed before the end of the line, or `"""` / `r"` before EOF |
| `E_UNTERMINATED_COMMENT` | `/*` not closed before EOF |
| `E_INVALID_ESCAPE` | an unknown `\x` escape |
| `E_INVALID_NUMBER` | `.5`, `0x`, `0b102`, `12px` |
| `E_INVALID_CHAR` | `''`, `'ab'`, unclosed `'a`; the same for `b'…'` |
| `E_BYTE_LITERAL_NOT_ASCII` | `b'é'`: fix-it `b'\xHH'` or a `str` (§1.6) |
| `E_UNKNOWN_CHARACTER` | a character that starts no token: `#` alone, `` ` ``, `@`, `$` outside a string, non-ASCII outside strings and comments |
| `E_UNMATCHED_DELIMITER` | a missing or mismatched closer |
| `E_TAGGED_RECORD_REMOVED` | `'1{…}`: fix-it `r{…}` |

### 18.2 Parser [D]

| Code | Meaning | Fix-it |
| --- | --- | --- |
| `E_UNEXPECTED_TOKEN` | a token that doesn't fit here | — |
| `E_TOP_LEVEL_STATEMENT` | a statement outside a function | — |
| `E_IMPORT_AFTER_ITEM` | `import` after the first item | move it up |
| `E_RESERVED_KEYWORD` | `fun`, `while`, `loop`, … | `fn`, `for` |
| `E_KEYWORD_AS_IDENT` | a keyword used as a binding name | — |
| `E_OPEN_BRACE_NEWLINE` | a declaration or control-flow `{` not on the header line | — |
| `E_TYPE_EQUALS_BODY` | `type X = { … }`, `union X = {`, `inter X = {` | remove `=` |
| `E_LEADING_PIPE_UNION` | `type X = \| A \| B` | `union X { A  B }` |
| `E_MUT_REMOVED` | `mut x: T`, `mut this`, `mut` in a pattern or closure parameter | `*T`, `*this`, `var` |
| `E_BORROW_REMOVED` | `&T`, `&mut T`, `&this`, `&mut this`, prefix `&x` / `*x` | `T` / `*T`, `this` / `*this`, drop it |
| `E_STAR_TYPE_NOT_PARAM` | `*T` outside a parameter, receiver, function-type parameter or return type | remove `*` |
| `E_CAPTURE_LIST_REMOVED` | `#[x]{ … }` | drop the list |
| `E_SHARED_IMMUTABLE` | `shared let` | `shared var` |
| `E_INVALID_ATTRIBUTE` | a malformed `#[…]`, or one not followed by an item or member | — |
| `E_INVALID_PARAM` | a malformed parameter | — |
| `E_UNKNOWN_RECEIVER` | `self`, `*self` | `this` |
| `E_VARIADIC_NOT_LAST` | `...xs` followed by more parameters | — |
| `E_EXPECTED_COLON` | a field or parameter missing `:` | — |
| `E_SHORT_DECL_TARGET` | `:=` / `:==` with a non-identifier left side, or `let x :=` | — |
| `E_CLOSURE_HEADER_LINE` | closure parameters (`a =>`) not on the closure's first line | — |
| `E_GENERIC_ARGS_NEWLINE` | `.[` at the start of a line | — |
| `E_EXPECTED_TYPE_ARGUMENTS` | empty `.[]` or `[]` type arguments | — |
| `E_ANGLE_GENERICS` | `Vec<T>`, `f<T>(x)` | `Vec[T]`, `f.[T](x)` |
| `E_ARROW_CLOSURE` | `(a) => …`, `fn(x) { }` as an expression | `#{ a => … }` |
| `E_NON_ASSOCIATIVE_OPERATOR` | `a < b < c` | parentheses |
| `E_MIXED_NULLISH` | `a ?? b \|\| c` without parentheses | parentheses |
| `E_INVALID_ASSIGNMENT_TARGET` | assignment to a non-place | — |
| `E_INVALID_PATTERN` | a malformed pattern | — |
| `E_INVALID_RECORD_KEY` | a record key that isn't an identifier or a string | — |
| `E_BARE_TUPLE` | `(a, b)` | `t(a, b)` |
| `E_BARE_BRACE_LITERAL` | `{ k: v }` | `_{}` / `r{}` / `m{}` |
| `E_STRUCT_LITERAL_IN_HEADER` | `if x == P { … }` | `(P { … })` |
| `E_RESERVED_OPERATOR` | `++`, `--`, `~` | `+= 1`, `-= 1`, `!` |
| `E_SELECT_EMPTY` | `select { }` | — |
| `E_SELECT_ELSE_NOT_LAST` | an `else` arm followed by other arms, or two `else` arms | — |

### 18.3 Resolver, checker and access check [D]

| Code | Pass | Meaning |
| --- | --- | --- |
| `E_SIGIL_SHADOWS_BINDING` | resolver | a sigil letter used while a binding of that name is visible |
| `E_STRING_TYPE_REMOVED` | resolver | the type name `string`: fix-it `str` |
| `E_UNDECLARED_NAME` | resolver | a name that isn't declared in any enclosing scope |
| `E_UNDECLARED_TYPE` | resolver | a type name that isn't declared |
| `E_UNDECLARED_ASSIGNMENT` | resolver | assignment to an undeclared name |
| `E_NOT_A_TYPE` | resolver | a value used where a type is expected |
| `E_DUPLICATE_DECLARATION` | resolver | two items, or an item and an import, with the same name in one package |
| `E_DUPLICATE_BINDING` | resolver | a name declared twice in the same scope, pattern or parameter list |
| `E_DUPLICATE_FIELD` | resolver | a field or variant declared, or given in a literal, twice |
| `E_DUPLICATE_METHOD` | resolver | a method declared twice (inline or in an `impl`), or a method named like a field |
| `E_AMBIGUOUS_IMPL_METHOD` | resolver | two implemented interfaces define the same method |
| `E_METHODS_ON_STRUCTURAL` | resolver | methods on an alias |
| `E_ORPHAN_IMPL` | resolver | `impl X for T` where neither `X` nor `T` is local |
| `E_INCONSISTENT_OR_BINDINGS` | resolver | or-pattern alternatives bind different names |
| `E_UNKNOWN_VARIANT` | resolver, checker | `Union.X` in a pattern where the union has no variant `X`, or a bare name the expected or matched union doesn't have |
| `E_IT_OUTSIDE_CLOSURE` | resolver | `it` / `itN` outside a header-less closure or unnamed `or` |
| `E_IT_IN_NAMED_CLOSURE` | resolver | `it` used in a closure with named parameters |
| `E_RESERVED_IDENT` | resolver | declaring `it` / `itN` |
| `E_THIS_OUTSIDE_METHOD` | resolver | `this` in a function without a receiver |
| `E_SELF_OUTSIDE_TYPE` | resolver | `Self` outside a type, union, interface or impl |
| `E_IMPORT_CYCLE` | loader | packages import each other |
| `E_UNKNOWN_IMPORT` | loader | an import path that names no package, or a missing item |
| `E_PRIVATE_ITEM` | loader | using a non-`pub` item of another package |
| `E_AMBIGUOUS_IMPORT` | resolver | a name exported by two glob imports, then used |
| `E_NO_MAIN` | loader | a program folder with no `package main` file |
| `E_IMPORT_MAIN` | loader | an import of a folder of `package main` files |
| `E_TYPE_MISMATCH` | checker | a value's type doesn't match what is expected |
| `E_INVALID_OPERANDS` | checker | an operator applied to types it doesn't support |
| `E_INVALID_TRY` | checker | `?` on something that isn't an Option / Result, or in a function whose result can't carry it |
| `E_ARG_COUNT` | checker | the wrong number of arguments or type arguments |
| `E_NOT_CALLABLE` | checker | calling a value that isn't a function |
| `E_UNKNOWN_FIELD` | checker | a field or method the type doesn't have |
| `E_UNKNOWN_MEMBER` | checker | `Type.x` where the type has no variant or static method `x` |
| `E_MISSING_METHOD` | checker | an interface method without an implementation |
| `E_MISSING_FIELD` | checker | a struct literal omits a required field |
| `E_BOUND_NOT_SATISFIED` | checker | a generic argument doesn't implement its bound |
| `E_UNIQUE_TYPE_ARG` | checker | a `Unique` type for a type parameter without `: Unique` |
| `E_UNIQUE_IMPL` | checker | implementing `Unique` outside std / `extern` |
| `E_NOT_DYN_SAFE` | checker | a generic or `Self`-returning method called on a dynamic value |
| `E_CANNOT_INFER_TYPE` | checker | a type still unknown at the end of the function |
| `E_CANNOT_INFER_GENERIC` | checker | fix-it `.[T]` |
| `E_CANNOT_INFER_STRUCT_TYPE` | checker | `_{}` with no expected type |
| `E_CANNOT_INFER_VARIANT` | checker | a bare variant name with no expected union type: fix-it `Union.Variant` |
| `E_INVALID_BLOCK_VALUE` | checker | a block value doesn't match the expected type |
| `E_INVALID_CAST` | checker | `as T` that is neither an annotation nor a numeric cast |
| `E_INT_OUT_OF_RANGE` | checker | an integer literal that doesn't fit its type |
| `E_NOT_TRUTHY` | checker | a condition of a type other than bool / Option / Result |
| `E_USE_NULLISH` | checker | `\|\|` used as a value fallback: fix-it `??` |
| `E_LET_ELSE_MUST_DIVERGE` | checker | the `else` block of `let … else` can finish normally |
| `E_BREAK_OUTSIDE_LOOP` | checker | `break` or `continue` outside a loop (a closure body starts outside any loop), e.g. `x := f() or break` at a function's top level |
| `E_BREAK_VALUE` | checker | `break value` in a loop other than `for { … }`, which has no value (§5.3) |
| `E_NOT_INDEXABLE` | checker | `x[i]` on a type that can't be indexed |
| `E_NOT_ITERABLE` | checker | `for … in` over a value that can't be iterated |
| `E_NON_EXHAUSTIVE_MATCH` | checker | a `match` that doesn't cover every case |
| `E_SELECT_ARM_NOT_PROMISE` | checker | a `select` arm expression that isn't a `Promise[T]` |
| `E_AWAIT_OUTSIDE_ASYNC` | checker | `await` / `for await` / `select` outside an `async fn` or `main` |
| `E_ONCE_OUTSIDE_IDENTITY` | checker | a `once` field on a non-identity type: fix-it `: Identity` |
| `E_ASSIGN_IDENTITY_FIELD` | checker | assigning a plain field of an identity value |
| `E_LOCK_NOT_SHARED` | checker | a `lock` place that isn't rooted in a `shared` binding or field |
| `E_ATTRIBUTE_NOT_ALLOWED` | checker | `#[effects]` outside std |
| `E_UNKNOWN_ATTRIBUTE` | checker | an attribute name other than `effects` |
| `E_TEST_SIGNATURE` | checker | a `test_` function that takes parameters, returns a value, or is generic |
| `E_ASSIGN_IMMUTABLE` | access | assigning to a `let` / `:=` binding or a `T` parameter |
| `E_WRITE_TO_IMMUTABLE` | access | an immutable binding passed to `*T` or `*this`, or a read-mode closure parameter written: fix-it `:==` / `var`, or `(*T)` in the function type |
| `E_OVERLAPPING_ACCESS` | access | two arguments of one call overlap on a written path |
| `E_ACCESS_DURING_WRITE_VIEW` | access | an overlapping use while a `*T` view is live |
| `E_USE_AFTER_MOVE` | access | use of a moved `Unique` value |
| `E_CONCURRENT_OVERLAP` | access | tasks in one statement overlap on a written path |
| `E_VIEW_ACROSS_TASK` | access | an async call with a `*` argument or a view not awaited in the same statement: fix-it `await` it there |
| `E_AWAIT_IN_LOCK` | access | `await` inside `lock` |
| `E_WRITE_TO_CAPTURED_COPY` | access | an escaping closure or task writes a captured non-shared `var`: fix-it `shared var` |
| `E_USE_OF_POISONED` | access | a value read after a caught panic, before re-assignment |
| `E_SCRIPT_IN_EVAL` | evaluation | a `task` script run while `mod.ms` is evaluated |
| `E_SECTION_CONFLICT` | evaluation | two tools write the same section |
| `E_BAD_DEP_SPEC` | evaluation | a dependency value that is neither a semver range nor a known prefix |

### 18.4 Lints [D]

Lints are pass 9 (§15): they run on code without errors, after mechanism selection, and never stop compilation unless denied. Each lint is `allow` (off), `warn` (the default) or `deny` (an error). Levels are set in `mod.ms`, `lint.setup(_{ allow: […], warn: […], deny: […], strict: true })` (`strict` denies every lint that warns), and then on the command line: `ms lint <entry> --deny L_IMPLICIT_COPY`. `ms check` shows lints with the other diagnostics. The prelude and std are never linted. Until `mod.ms` is evaluated (§17), the toolchain reads the `lint.setup` call statically: string lists and a bool literal.

| Code | Default | Fires when |
| --- | --- | --- |
| `L_IMPLICIT_COPY` | warn (collections), off (strings) | a write to a `Vec`, `Map` or `Set` reached from a binding that shares a source used again, or that holds a parameter the caller may still use (§9.1, Appendix A.2); writes through `*T` calls and write views count, by the callee's summary |
| `L_VIEW_FORCED_COPY` | warn | a write to a path that overlaps a view still used afterwards (§9.6), or to the collection a `for` loop iterates |
| `L_TASK_SEES_SNAPSHOT` | warn | a closure handed to a task not awaited in its statement captured a `var` the spawner writes afterwards (§10.3). Passing a non-Copy `var` itself is `E_VIEW_ACROSS_TASK`; passing a Copy value is an explicit snapshot |
| `L_DIVERGED_COPIES` | warn | a non-shared field is written after the value was stored in two places (§10.3) |
| `L_SHARED_CYCLE` | warn | a type can reach itself through a `shared` or `once` field (§9.8); plain fields of identity types are fixed at construction and can't close a cycle; `Weak[T]` breaks the edge |
| `L_SUMMARY_WIDENED` | warn | a recursive SCC hit the pass-6 safety cap and some paths were widened (§15.1) |
| `L_NESTED_LOCK` | warn | a `lock` block nested in another: fix-it `lock a, b` (§10.1) |
| `L_SELF_WAIT` | warn | `for await` over a subscription whose topic or queue the same task keeps open until after the loop (§11.3) |
| `L_SHADOWED_VARIANT` | warn | a function or global of the package has the name of a variant of the expected union, in an expression or a pattern (§7.7) |
| `L_INT_NOT_PORTABLE` | warn | an `int` literal outside the i32 range (§7.2) |
| `L_BIGINT_ON_JS` | warn on the JS target | `i64` / `u64` arithmetic, which lowers to `BigInt` (§16.1) |

### 18.5 Runtime panics [D]

`p.kind: PanicKind` as `recover` sees it. All are catchable (§13.3).

| Kind | Raised when |
| --- | --- |
| `User` | `panic(msg)`, a failed `assert` |
| `Overflow` | integer overflow |
| `OutOfBounds` | `x[i]` outside the collection |
| `MissingKey` | reading `m[k]` for a missing key |
| `Unwrap` | `.unwrap()` on `None` / `Err` |
| `AlreadySet` | a second write to a `once` field (§12.2) |
| `SelectExhausted` | every `select` arm is disabled and there is no `else` (§4.9) |
| `Cancelled` | awaiting a cancelled promise, or inside the cancelled task (§11.1) |
| `ResolverDropped` | a `Resolver` dropped without resolving its promise (§11.1) |
| `Deadlock` | every task is waiting and nothing can wake any of them (§11.4) |

---

## 19. Grammar (EBNF)

```text
file          = package_decl { import } { item } ;
package_decl  = "package" ident { "." ident } ;
import        = "import" [ "pub" ] STRING [ "as" ident ] ;   (* STRING: path[.item | .{a,b} | .*] *)

item          = { attribute } [ "pub" ] ( fn_decl | type_decl | union_decl | inter_decl
                                        | impl_decl | let_decl | var_decl | extern_decl ) ;
attribute     = "#[" ident [ "(" attr_arg { "," attr_arg } ")" ] "]" ;
attr_arg      = ident ":" "[" [ attr_path { "," attr_path } ] "]" ;
attr_path     = ( ident | "this" ) { "." ident } ;

generic_params= "[" generic_param { "," generic_param } [ "," ] "]" ;
generic_param = ident [ ":" bound ] ;
bound         = type_path { "&" type_path } ;
impl_list     = ":" type_path { "," type_path } ;

fn_decl       = [ "async" ] "fn" ident [ generic_params ]
                "(" [ receiver [ "," ] ] [ params ] ")" [ "->" ret_type ] block ;
fn_sig        = [ "async" ] "fn" ident [ generic_params ]
                "(" [ receiver [ "," ] ] [ params ] ")" [ "->" ret_type ] [ block ] ;
receiver      = [ "*" ] "this" ;
params        = param { "," param } [ "," ] ;
param         = ident ":" [ "*" ] type | "..." ident ":" type ;
ret_type      = [ "*" ] type ;

type_decl     = "type" ident [ generic_params ] [ impl_list ] ( struct_body | "=" type ) ;
struct_body   = "{" { member sep } "}" ;
member        = { attribute } [ "pub" ] ( fn_decl | field ) ;
field         = [ "shared" | "once" ] ident ":" type [ "=" expr ] ;
union_decl    = "union" ident [ generic_params ] [ impl_list ] "{" { ( variant | member ) sep } "}" ;
variant       = ident [ "(" type { "," type } [ "," ] ")" | "{" { field sep } "}" ] ;
inter_decl    = "inter" ident [ generic_params ] [ ":" bound ] ( inter_body | "=" bound ) ;
inter_body    = "{" { { attribute } [ "pub" ] fn_sig sep } "}" ;
impl_decl     = "impl" [ generic_params ] [ type_path { "," type_path } "for" ] type
                "{" { { attribute } [ "pub" ] fn_decl sep } "}" ;
let_decl      = "let" ident [ ":" type ] "=" expr ;
var_decl      = [ "shared" ] "var" ident [ ":" type ] "=" expr ;
extern_decl   = "extern" STRING "{" { { attribute } [ "pub" ] fn_sig sep } "}" ;

type          = intersection { "|" intersection } ;
intersection  = postfix_type { "&" postfix_type } ;
postfix_type  = primary_type [ "?" ] ;
primary_type  = type_path [ "[" type { "," type } [ "," ] "]" ]
              | "t(" [ type { "," type } [ "," ] ] ")"
              | "r{" [ rfield { sep rfield } ] "}"
              | "(" [ [ "*" ] type { "," [ "*" ] type } ] ")" "->" type
              | "(" type ")"
              | "TypeOf" "(" ident { "." ident } ")"
              | STRING | INT | "true" | "false" ;
rfield        = ident ":" type ;
type_path     = ident { "." ident } | "Self" ;

block         = "{" { stmt } "}" ;
stmt          = let_stmt | var_stmt | short_decl | for_stmt | expr [ ";" ] ;
let_stmt      = "let" pattern [ ":" type ] "=" expr [ "else" block ] ;
var_stmt      = [ "shared" ] "var" ident [ ":" type ] "=" expr ;
short_decl    = ident ( ":=" | ":==" ) expr ;
for_stmt      = [ ident ":" ] "for" ( block
                                    | "let" pattern "=" expr block
                                    | [ "await" ] pattern [ "," pattern ] "in" expr block
                                    | expr block ) ;

expr          = pratt( prefix, infix, postfix ) ;      (* precedence §3 *)
prefix        = "-" | "!" | "await" ;
primary       = literal | ident | "this" | "Self" | "(" expr ")"
              | vec_lit | array_lit | tuple_lit | record_lit | map_lit | set_lit
              | inferred_lit | struct_lit | closure
              | if_expr | match_expr | select_expr | lock_expr
              | "unsafe" block | "recover" block | block
              | "for" block                                   (* infinite for as an expression *)
              | "return" [ expr ] | "break" [ ident ] [ expr ] | "continue" [ ident ] ;
literal       = INT | FLOAT | STRING | RAW_STRING | template | CHAR | BYTE | "true" | "false" | "nil" ;
postfix       = "." ( ident | INT ) | "?." ident | ".[" type { "," type } "]"
              | "(" [ args ] ")" | "[" expr "]" | "?" ;
args          = arg { "," arg } [ "," ] ;
arg           = [ "..." ] expr ;
vec_lit       = "[" [ elem { "," elem } [ "," ] ] "]" ;
array_lit     = "a[" [ elem { "," elem } [ "," ] ] "]" ;
tuple_lit     = "t(" [ elem { "," elem } [ "," ] ] ")" ;
elem          = [ "..." ] expr ;
record_lit    = "r{" [ rec_item { sep rec_item } ] "}" ;
inferred_lit  = "_{" [ rec_item { sep rec_item } ] "}" ;
struct_lit    = type_path [ ".[" type { "," type } "]" ] "{" [ rec_item { sep rec_item } ] "}" ;
rec_item      = ( ident | STRING | keyword ) [ ":" expr ] | "..." expr ;
map_lit       = "m{" [ ( expr ":" expr | "..." expr ) { sep ( expr ":" expr | "..." expr ) } ] "}" ;
set_lit       = "s{" [ elem { sep elem } ] "}" ;
closure       = "#{" [ closure_head "=>" ] { stmt } "}" ;
closure_head  = cparam { "," cparam } [ "->" type ] ;
cparam        = [ "var" ] ident [ ":" [ "*" ] type ] ;
if_expr       = "if" ( expr | "let" pattern "=" expr ) block [ "else" ( if_expr | block ) ] ;
match_expr    = "match" [ expr ] "{" { arm sep } "}" ;
arm           = ( pattern [ "if" expr ] | expr ) "=>" ( expr | block ) ;
select_expr   = "select" "{" { select_arm sep } [ "else" "=>" ( expr | block ) [ sep ] ] "}" ;
select_arm    = [ pattern "=" ] expr "=>" ( expr | block ) ;   (* `pattern =` iff a depth-0 `=` precedes `=>` *)
lock_expr     = "lock" expr { "," expr } block ;               (* places; no struct literal at depth 0 *)
or_tail       = "or" [ ident "=>" ] ( expr | block ) ;

pattern       = alt_pattern { "|" alt_pattern } ;
alt_pattern   = literal_pat [ ( ".." | "..=" ) literal_pat ]
              | "_" | [ "var" ] ident
              | type_path [ "(" [ pattern { "," pattern } [ "," ".." ] ] ")"
                          | "{" [ field_pat { "," field_pat } ] [ "," ".." | ".." ] "}" ]
              | "t(" [ pattern { "," pattern } ] [ "," ".." ] ")"
              | "r{" [ field_pat { "," field_pat } ] [ "," ".." ] "}" ;
field_pat     = [ "var" ] ident [ ":" pattern ] ;
literal_pat   = [ "-" ] ( INT | FLOAT ) | STRING | CHAR | BYTE | "true" | "false" | "nil" ;

sep           = "," | NEWLINE ;
```

---

## 20. Parser test corpus

The corpus lives in `ms_04/test/`: `lexer/` (with `.tokens` snapshots), `parser/` (with `.ast` S-expression snapshots), `errors/` (with inline `//~ CODE` annotations, all checked), and the ported programs in `ms_04/examples/` and `ms_04/samples/`, which must parse with zero diagnostics. The cases below are the minimum set.

```minscript
t.0.1    1..10   1..=10   ..5    1.to_str()
a[0]     a [0]   t(1)    t (1)   [1, 2]   x[0]
fn t[T]() {}    x.a[0]
Vec[Map[str, Vec[User?]]]
json.parse.[User](s)   Vec.[u8].new()   Pair.[int, str]{ first: 1, second: "a" }
a<b   a < b   a>>b
'1{ id: 1 }                    // E_TAGGED_RECORD_REMOVED
b'x'   b'\n'   b'\xFF'   b'é'  // last: E_BYTE_LITERAL_NOT_ASCII
b 'x'                          // name, then char
r{ a: 1 }   r"raw\n"
x.or(1)   x or 1   x or e => Err(e)
a ?? b ?? c   a?.b ?? "x"   a ?? b || c   // last: E_MIXED_NULLISH
x ??= 5
g := [] as Vec[Map[str, int]]   x as i32?   a as f64 / b as f64
await f()?   await f()?.name   (await f()).trim()
if res { }   if !opt && flag { }
#{ it * 2 }   #{ it1 + it2 }   #{ x, y => x + y }   #{ x: i32 -> i32 => x * 2 }
#{ var acc, x => acc += x; acc }   #{ it.qty += 1 }
#{ f() or e => log(e) }        // no header
#[n]{ it + n }                 // E_CAPTURE_LIST_REMOVED
(a) => a                       // E_ARROW_CLOSURE
Vec<int>                       // E_ANGLE_GENERICS
fn f(u: *User, n: str) -> *Item { }   fn g(*this) { }   fn h(f: (*Item) -> int) { }
fun f() { }                    // E_RESERVED_KEYWORD (fix-it fn)
fn f(mut x: int) { }           // E_MUT_REMOVED
fn f(x: &str) { }              // E_BORROW_REMOVED
let v: *int = 1                // E_STAR_TYPE_NOT_PARAM
type User: Stringer { id: u64  fn to_str(this) -> str { "u" } }
type U = { id: u64 }           // E_TYPE_EQUALS_BODY
union P { Cash  Card { n: str }  fn is_cash(this) -> bool { true } }
type Node: Identity { name: Symbol  once ty: Type  shared hits: int = 0 }
inter R = A & B   inter S { fn f(this) -> int { 1 } }
shared var n = 0   shared let m = 1   // last: E_SHARED_IMMUTABLE
lock a { a += 1 }   lock a, b { }   n := lock t { t.len() }
#[effects(keeps: [v], returns_view: [this])]
import "std.io.*"   import "std.io.{print, println}"
for { }   for i < 3 { }   for x in xs { }   for k, v in m { }   for let Some(x) = it.next() { }
for var line in lines { }   for await var o in jobs { }
outer: for x in xs { break outer }
for await m in sub { }   for await ready() { }
send(Text("hi"))   area(Circle { r: 1.0 })   m[k] = v
select { Some(j) = q.next() => run(j), time.after(10) => idle(), else => skip() }
match { a > 1 => 1, _ => 0 }   match n { x if x > 5 => x, _ => 0 }   match c { b'a'..=b'z' => 1, _ => 0 }
let t(w, h) = dims()   let Ok(v) = r else { return }   if let Some(var u) = find(1) { }
if x == P { }
let r = recover { risky() }
foo
(bar)                          // two statements
user
    .profile                   // one chain
```

---

## 21. Implementation order

Build in this order so each step can be tested on its own. The JS back end can run programs from step 7 on, using the simplest safe mechanism (share everything, copy-on-write via the shared bit) until step 8 refines it.

| # | Step | Files | Done when |
| --- | --- | --- | --- |
| 1 | **Lexer + parser** (§1–§8, §19). **Done** (2026-11-09) | `src/lexer.ts`, `src/parser.ts`, `src/ast.ts`, `src/sexpr.ts` | `examples/` and `samples/` parse with zero diagnostics; every §18.1 / §18.2 code has an `errors/` test; the §20 corpus has snapshots |
| 2 | **Resolver and loader:** `Identity`, `Unique`, `Symbol`, `sym`, `Weak` in the prelude. **Done** (2026-11-10) | `src/resolve.ts`, `src/loader.ts`, `std/prelude.ms` | the prelude resolves cleanly; every program in `examples/` and `samples/` loads and resolves with exactly its annotated diagnostics; every resolver and loader code of §18.3 has a test |
| 3 | **Type checker:** view types as ordinary types; identity `==` / `hash`; `once` reads as `T?`; automatic boxing of recursive value types. **Done** (2026-11-10) | `src/types.ts`, `src/check.ts`, `src/check_dump.ts` | the prelude type-checks cleanly; every program in `examples/` and `samples/` type-checks with exactly its annotated diagnostics; every checker code of §18.3 has a `test/check/` case |
| 4 | **HIR with places:** every read and write names its path (`u.tags[*]`), truncated to 4 segments; which type parameters each generic function needs at run time (§15.4). **Done** (2026-11-10) | `src/hir.ts`, `src/lower.ts`, `src/witness.ts`, `src/hir_check.ts`, `src/hir_dump.ts` | `ms hir` prints paths and witness parameters; the prelude and every program of `examples/` and `samples/` lower to HIR that passes the validator |
| 5 | **Effect summaries** (§15.1), including `consumes`, `invokes` and `#[effects]`. **Done** (2026-11-10) | `src/effects.ts` | `ms effects` matches the golden file for Appendix A (`test/effects/`); a 60-function recursive ring converges without `L_SUMMARY_WIDENED`, and every program of `examples/` and `samples/` does too. The stage1 parser is v0.2 code: measure its SCC when it is ported (step 11) |
| 6 | **Access check** (pass 7, §15.1): the access errors of §18.3. **Done** (2026-11-10) | `src/access.ts` | one passing and one failing test per error (`test/access/`); every program of `examples/` and `samples/` passes, and the shop sample's commented-out mistakes give the errors their comments name |
| 7 | **JS back end** (§16) and runtime (shared bit, `Symbol` table, hash map, `Panic`, `once`). **Done** (2026-11-10) | `src/js/emit.ts`, `src/js/runtime.ts`, `src/js/run.ts` | every program of `examples/run/` and `examples/packages/` prints its `.out` (`test/run.test.ts`), except those that need std packages written in step 10, which are skipped by name; every program of `examples/` and `samples/` compiles to JS that parses. The std tests run on Node once step 10 writes them |
| 8 | **Mechanism selection** (§15.2). **Done** (2026-11-10) | `src/mechanism.ts` | Appendix A.2 shows a move on the second call (`test/mechanism/copy_on_write.ms`: 2 copies instead of 4); every `test/mechanism/` program prints the same with and without pass 8 |
| 9 | **Lints** (§18.4). **Done** (2026-11-10) | `src/lint.ts` | each lint has a firing and a quiet test (`test/lint/`); levels from `mod.ms` and the command line are tested; every lint comment in `examples/` and `samples/` fires and nothing else does |
| 10 | **std** in v0.4 MinScript | `std/**` | std tests pass |
| 11 | **Self-host:** port the stage1 compiler to v0.4 (identity AST nodes, `Symbol` identifiers, `once` fields) | self-hosted sources | it compiles itself |
| 12 | **Benchmark** against the TS compiler on the same input | — | within 1.5× of the TS compiler (proposed) |

---

## 22. Open questions

Each has a proposed default, which applies until it is decided.

| # | Question | Default |
| --- | --- | --- |
| 1 | **`shared` or `thread`?** `shared` covers single-task aliasing (no lock) and cross-task state (locked); `thread` reads as cross-thread only. | `shared`; `thread` reserved |
| 2 | **Call-site marker for `*T`:** unmarked (LSP inlay hint), or an optional `*u` at the call site that the formatter can enforce. | unmarked |
| 3 | **Path depth limit.** Measure on the compiler's own source before fixing it. | 4 segments |
| 4 | **Inline size for stored views** (§9.6). | 24 bytes |
| 5 | **Per-field locks** (§10.2): an optimisation only, or a guarantee? | optimisation only |
| 6 | **`L_IMPLICIT_COPY` default level.** | warn for collections, off for strings |
| 7 | **Summary stability** (§9.5): is a wider `pub fn` summary a breaking change enforced by tooling, or only reported? | reported by `ms api diff` |
| 8 | **Cycle handling:** `Weak[T]` plus a lint, or a cycle collector on native back ends. | `Weak[T]` + `L_SHARED_CYCLE` |
| 9 | **`==` on identity types:** pointer equality, or structural `==` plus `===` for identity. | pointer equality |
| 10 | **Default collections:** should `Map` itself be persistent? | only `PMap` |
| 11 | **`once` read type:** `T?`, or `T` with a panic when unset. | `T?` |
| 12 | **`i64` on JS:** `BigInt` (correct, slow) or a 53-bit `number` that panics past 2^53. | `BigInt` |
| 13 | **Weak symbol table**, for long-running programs that intern untrusted input. | deferred |
| 14 | **`[T: Unique]` spelling.** The bound means "may be Unique", which `: Unique` reads against. Alternative: `[T: ?Unique]`. | `: Unique` |
| 15 | **Byte strings** (§1.6): `b"GET "` as a static `Slice[u8]`. | deferred; `"GET ".bytes()` meanwhile |
| 16 | **Slice compaction** (§7.3): never automatic, or copy small slices of large buffers when stored. | never automatic |
| 17 | **Registry interfaces** (§15.3): a registry can't trust summaries computed by a publisher. Proposal: it stores sources and computes each interface once per package version and toolchain version. | not yet: `path:` and `git:` dependencies are checked from source |
| 18 | **Implicit `Some`:** may a `T` be used where `T?` is expected? | no: write `Some(5)` |
| 19 | **Error conversion with `?`:** convert through an interface when error types differ? | no: `.map_err(#{…})` |
| 20 | **`Option.or` / `Result.or`** take "a value or `#{…}`"; should there be `or(v)` and `or_else(#{…})`? | loose for now |
| 21 | **Specialization of generic code** (§15.4): an opt-in specialization of hot generic functions for concrete types, limited to one package so separate compilation holds (`--release` only, or an attribute). | none: every generic body is compiled once |

**Deferred features:** `any` and downcasting; associated types and `where` clauses; const generic params beyond `Array[T, N]`; default params and named args; range indexing (`v[1..3]`); expression-bodied functions; macros, custom operators and trailing closures; Unicode identifiers; width subtyping for records; positional struct construction; extension methods on foreign types; send arms in `select`; `select biased`; queue groups on topics; workspaces; dependency sources beyond `path:` and `git:`.

---

## Appendix A. Worked samples

Each sample shows the inferred summary in comments and what the compiler does. They double as golden tests for steps 5, 6 and 8 of §21. The full sample projects are `ms_04/samples/calc` (a lexer, parser, resolver and evaluator) and `ms_04/samples/shop` (workers, a shared store, a payment gateway).

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
- With `ann := …`, `birthday(ann)` is `E_WRITE_TO_IMMUTABLE` (fix-it `:==`).

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
- Second call: `b` moves, `c` is unique, `push` writes in place. `L_IMPLICIT_COPY` marks the `push`.

### A.3 Lexer: views into the source

```minscript
type Token {
    kind: TokenKind
    text: str
    span: Span
}

pub fn lex(src: str) -> Vec[Token] {     // reads [src] returns_view [src]
    var out = [] as Vec[Token]
    var i = 0
    bytes := src.bytes()
    for i < bytes.len() {
        start := i
        for i < bytes.len() && bytes[i] != b' ' { i += 1 }
        out.push(Token { kind: Word, text: src.substring(start, i), span: Span { start, end: i } })
        i += 1
    }
    out
}
```

- `substring` is a free local view; stored in a `Token` it becomes a counted share of `src`'s buffer. The source text is never copied.
- `out` moves to the caller. The tokens are stored in `out`, a local, so `lex` itself keeps nothing; its result holds shares of `src` (`returns_view [src]`), and the caller keeps them if it stores the tokens. `src` leaves scope; its buffer lives while the tokens do.

### A.4 Checker pass: `once` and `Symbol`

```minscript
type Ident: Identity {
    name: Symbol
    span: Span
    once ty: Type
}

fn check_ident(id: Ident, scope: Scope) -> Type {   // reads [id.name, scope] writes [id.ty]
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
- The escaping closure would write a copy of `n` and lose updates, so it's an error. With `shared var n` it becomes an atomic cell.

---

## Appendix B. Changes from v0.2

| v0.2 | v0.4 |
| --- | --- |
| `fun`, `pub fun` | `fn`, `pub fn` |
| `x: T` owned, `x: &T`, `x: &mut T`, `mut x: T` | `x: T` (read), `x: *T` (write) |
| `this`, `&this`, `&mut this`, `mut this` | `this`, `*this` |
| `type X = { … }`, `union X = { … }`, `inter X = { … }` | `type X { … }` etc.; `=` only for aliases |
| `string` and `&str` | `str` |
| Moves with `E_USE_AFTER_MOVE` everywhere | value semantics; moves only for `Unique` types |
| Borrows forbidden in fields | views stored as counted shares, no lifetimes |
| `E_BORROW_CONFLICT`, `E_RETURN_LOCAL_BORROW`, `E_BORROW_IN_FIELD`, `E_CLOSURE_ESCAPES_BORROW`, `E_MOVE_OUT_OF_BORROW` | removed: copy-on-write snapshots instead |
| `E_BORROW_ACROSS_SPAWN`, `E_MUT_BORROW_IMMUTABLE` | `E_VIEW_ACROSS_TASK`, `E_WRITE_TO_IMMUTABLE` |
| `Ref[T]`, implicit handle cloning | `shared var`, `shared` fields |
| — | `lock a, b { }` expressions |
| Capture lists `#[x]`, `#[&mut x]` | inferred captures |
| `&(T) -> U` vs `(T) -> U` | one function type with parameter modes: `(T) -> U`, `(*T) -> U` |
| Raw pointer type `*mut T` | `unsafe.Ptr[T]` |
| `mut` in patterns and closure params | `var` |
| `T: Clone` bounds, `.clone()` | none needed; `[T: Unique]` admits `Unique` types |
| `Box[T]` for recursive types | automatic |
| Top-level `var` forbidden; global `let` const-only | top-level `var` is shared; global `let` lazily initialised |
| `@attr` reserved | `#[effects(…)]` in std |
| node ids, arenas, side tables keyed by id | `Identity` types, `once` fields, `Symbol` |
| `'x' as u8` | `b'x'` |
| `L_IMPLICIT_STR_COPY` | removed (one string type) |
| Whole-variable borrow analysis | path summaries, refcount and copy-on-write |

**Trade-offs accepted:**

- Copies are not visible in the source; whether a write copies is a runtime uniqueness check, surfaced by lints.
- A stored value is a snapshot unless it is `shared`.
- Every back end needs refcounting (or the JS shared bit) and copy-on-write.
- A body change can widen a `pub fn` summary and break callers; `ms api diff` reports it.

Swift, Hylo and Koka use broadly this model (value semantics, inferred sharing, copy-on-write).
