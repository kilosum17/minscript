# MinScript Syntax Specification — Draft 0.2

**Status:** Consolidated proposal  
**Target:** Deterministic TypeScript lexer and recursive-descent / Pratt parser  
**Design philosophy:** Compact syntax, explicit intent, predictable parsing, semantic analysis separated from syntax.

---

# 0. Language design principles

MinScript aims to combine:

- TypeScript's expressive, concise object and collection syntax.
- Rust's explicit ownership, borrowing and type safety.
- Go's simplicity in declarations and control flow.
- A lightweight, deterministic compiler implementation.

The compiler is divided into independent stages:

1. Lexer — produces tokens, spans and trivia.
2. Parser — produces a purely syntactic AST.
3. Name resolution — resolves identifiers, modules and scopes.
4. Type checker — inference, generics, interfaces and coercions.
5. Semantic analysis — borrowing, ownership, mutability and comptime.
6. Lowering and code generation.

**Fundamental rule:** Parsing must never require type information, symbol resolution or trait/interface resolution.

## 0.1 Decisions carried forward

| Topic | Decision |
|---|---|
| Interface keyword | `inter` |
| Function declaration | `fun` |
| Return arrow | `->` |
| Parameter borrowing | `name: &T`, `name: &mut T` |
| Mutable owned parameter | `mut name: T` |
| Integer alias | `int` = `i32` |
| Immutable declaration | `:=` = `let` |
| Mutable declaration | `:==` = `var` |
| Absent value | `None`, with `nil` as alias |
| Async | `async fun`; calls return `Promise<T>` |
| Modules | `package` and quoted `import` |
| Parser | Hand-written recursive descent / Pratt |
| Blocks | Last unterminated expression yields value |
| Semicolons | Optional; trailing `;` discards block value |
| Closures | `#{...}`, `(args) => ...` |
| Error propagation | `or` and `?` |
| Comments | `//`, `/* */`, `///` |

---

# 1. Lexical structure

## 1.1 Source

- UTF-8 source.
- Normalize CRLF to LF.
- Strip UTF-8 BOM.
- Tabs and spaces allowed.
- Identifiers are ASCII in v1.

Each token contains:

```ts
type Token = {
    kind: TokenKind
    span: Span
    ws_before: boolean
    nl_before: boolean
}
```

Additional lexer metadata:

- Matching closing delimiter index for opening delimiters.
- Comment trivia stored separately.
- String/interpolation mode information.
- Token source offsets.

Comments:

```rust
// Line comment

/* Block comment */

/* Nested
   /* block */
   comment
*/

/// Documentation comment
```

Block comments are nestable.

## 1.2 Identifiers

```text
[A-Za-z_][A-Za-z0-9_]*
```

- `_` alone is the wildcard.
- Identifiers are case-sensitive.
- Types and variants conventionally use `PascalCase`.
- Functions, variables and fields conventionally use `snake_case`.

The convention is enforced by linting, not parsing.

Pattern interpretation:

- Lowercase identifier: new binding.
- Uppercase identifier: constructor or constant path.

## 1.3 Reserved keywords

```text
Declarations:
package import pub type inter impl fun async let var mut extern

Control:
if else match for in while loop break continue return

Expressions:
await or as unsafe recover true false nil this Self

Type-level:
TypeOf
```

Additional reserved identifiers:

- `it`
- `it1`, `it2`, ... `itN`, where N is a positive integer without leading zeros.

`it1` is an alias of `it`.

These are not keywords:

```text
assert panic Ok Err Some None Result Option
Ref Box Weak
```

They are prelude names and can theoretically be shadowed.

`async` is a declaration modifier:

```rust
async fun fetch_user() -> User {
    ...
}
```

`main` may use `await` whether or not declared `async`.

Keywords following `.` or `?.` are treated as ordinary member identifiers:

```rust
x.or(5)
x.as<i32>       // if using a member without explicit turbofish
x.in(value)
```

For generic method calls, use the turbofish syntax defined in section 3.

## 1.4 Literals

### Integers

```rust
123
1_000
0xFF
0b1010
0o17
```

No suffixes.

- Default: `int` (`i32`).
- Expected type controls inference.
- Out-of-range literals produce compile errors.
- No silent integer widening.

### Floating point

```rust
1.5
1e9
2.5e-3
1_000.5
```

No `.5` or `5.`.

- Default: `f64`.
- Expected `f32` adopts `f32`.

### Booleans and absence

```rust
true
false
nil
None
```

`nil` and `None` represent the same absent-value constructor.

### Characters

```rust
'a'
'\n'
'\u{1F600}'
```

`char` represents a Unicode scalar value.

### Strings

Single-line:

```rust
"Hello"
"Hello\nworld"
"User: ${user.name}"
```

Escapes:

```text
\n \r \t \0 \\ \" \' \$ \xNN \u{...}
```

Interpolation is supported through `${expression}`.

Plain strings cannot cross physical lines.

Multiline:

```rust
"""
    Hello
    ${user.name}
    World
"""
```

Rules:

- Interpolation and escapes are active.
- First newline after opener is dropped.
- Common leading indentation is stripped.

Raw strings:

```rust
r`C:\Users\John\Documents`
```

- No escapes.
- No interpolation.
- May span lines.
- Cannot contain a backtick.

The `r` and backtick must be glued.

## 1.5 Collection and record sigils

These are retained as core language syntax.

| Token | Meaning | Context |
|---|---|---|
| `r{` | Record literal / structural record type | Expression, type |
| `m{` | Map literal | Expression |
| `s{` | Set literal | Expression |
| `t(` | Tuple literal / type / pattern | Expression, type, pattern |
| `a[` | Fixed array literal | Expression |
| `_{` | Inferred struct/record literal | Expression |
| `'1{` | Tagged record literal | Expression |
| `#{` | Implicit closure | Expression |
| `#[` | Explicit closure capture list | Expression |
| `r`` | Raw string opener | Expression |

Sigils must be glued to their opening delimiter.

The lexer recognizes them as dedicated tokens.

### Identifier collision rule

The letters `r`, `m`, `s`, `t` and `a` remain legal identifiers.

However, glued sigil syntax takes precedence:

```rust
a[0]       // fixed array literal, not indexing variable a
a [0]      // indexing variable a
t(1, 2)    // tuple
t (1, 2)   // function call
```

When a sigil token conflicts with a visible binding, the resolver reports:

```text
E_SIGIL_SHADOWS_BINDING
```

The diagnostic suggests adding whitespace or renaming the binding.

This is a deliberate compromise to preserve compact literals without reserving ordinary identifiers.

## 1.6 Generic closing delimiters

The lexer uses maximal munch.

For example:

```rust
Vec<Promise<T>>
```

May produce:

```text
Vec < Promise < T >>
```

The type parser can split:

```text
>>
>=
>>=
```

when it expects a closing `>`.

Splitting is parser-driven, in-place and O(1). No re-lexing or backtracking.

---

# 2. Generics and turbofish

This is an important v2 change.

## 2.1 Generic type declarations

Generic arguments in type position use ordinary angle brackets:

```rust
Vec<int>
Map<string, int>
Set<User>
Promise<Result<User, Error>>
Array<i32, 4>
```

No whitespace restriction applies in type position.

## 2.2 Generic function declarations

```rust
fun identity<T>(value: T) -> T {
    value
}

fun convert<T, U: Converter>(value: T) -> U {
    ...
}
```

## 2.3 Generic calls

Expression-level explicit generic arguments use `::<...>`.

```rust
let user = parse::<User>(input)

let result = json.parse::<Config>(input)

let numbers = Vec.new::<i32>()

let value = convert::<string, User>(input)
```

The parser recognizes `::` followed by `<` as the start of explicit generic arguments.

This is a single deterministic postfix construct.

## 2.4 Comparison operators

`<` and `>` remain ordinary comparison operators in expressions.

```rust
a < b
a<b
a > b
a >= b
```

Whitespace does not change their meaning.

The following is no longer allowed:

```rust
parse<User>(input)
```

Instead:

```rust
parse::<User>(input)
```

This eliminates the generic-versus-comparison ambiguity completely.

## 2.5 Generic arguments

Generic arguments may contain:

- Types.
- Integer literals.
- Other supported compile-time constants in future versions.

Example:

```rust
Array<i32, 4>
```

---

# 3. Operators and precedence

Highest to lowest:

| Level | Operators | Associativity |
|---|---|---|
| 1 | `.member`, `?.member`, `(args)`, `[index]`, `::<T>`, `?` | Left |
| 2 | `-`, `!`, `await` | Right |
| 3 | `as T` | Left |
| 4 | `*`, `/`, `%` | Left |
| 5 | `+`, `-` | Left |
| 6 | `<<`, `>>` | Left |
| 7 | `&` | Left |
| 8 | `^` | Left |
| 9 | `\|` | Left |
| 10 | `==`, `!=`, `<`, `<=`, `>`, `>=` | Non-associative |
| 11 | `&&` | Left |
| 12 | `\|\|` | Left |
| 13 | `..`, `..=` | Non-associative |
| 14 | `or` | Left |
| 15 | `=`, `+=`, `-=`, `*=`, `/=`, `%=` | Right |

Unary `&` and `*` are reserved for raw pointers and unsafe operations. Borrowing is expressed through types and implicit call-site borrowing.

## 3.1 Await

`await` is an ordinary prefix expression.

```rust
let user = await fetch_user()
```

For propagation:

```rust
let user = (await fetch_user())?
```

No special operand-truncation rule is required.

Method calls on awaited results:

```rust
(await fetch_name()).trim()
```

## 3.2 Error propagation and optional chaining

These are distinct operations.

```rust
value?
```

Propagation:

- `Ok(v)` unwraps to `v`.
- `Err(e)` returns from the enclosing function or closure.
- `Some(v)` unwraps to `v`.
- `None` returns from the enclosing function or closure.

Optional chaining:

```rust
user?.profile?.name
```

- Stops when the receiver is absent.
- The entire chain evaluates to `Option<T>`.
- Does not return from the enclosing function.

To propagate and access:

```rust
(user?) .name
```

The space is optional; parentheses establish the boundary.

In type position:

```rust
User?
```

Means:

```rust
Option<User>
```

`T??` is invalid.

---

# 4. Expressions

## 4.1 Blocks

A block yields its final expression if it has no trailing semicolon.

```rust
fun calculate() -> int {
    let x = 10
    x + 5
}
```

Value: `15`.

A trailing semicolon discards the value:

```rust
fun calculate() -> int {
    15;
}
```

This is a compile-time return-type error.

For void functions, a non-void final expression may be discarded.

## 4.2 Curly braces

Bare `{}` always represents a block.

There is no anonymous bare map or record literal.

Collections and records use their explicit sigils:

```rust
m{ "a": 1 }
s{ 1, 2 }
r{ name: "John" }
```

Named structs use their type name:

```rust
User {
    id: 1,
    name: "John"
}
```

Inferred construction:

```rust
_{
    id: 1,
    name: "John"
}
```

A named struct literal is not allowed in an ambiguous control-flow header without parentheses.

## 4.3 Error fallback: `or`

`or` is a language keyword, not a normal method.

```rust
let user = get_user() or return Err(it)
```

Forms:

```rust
expression or RHS
expression or name => RHS
```

When the left expression succeeds:

- `Ok(v)` unwraps to `v`.
- `Some(v)` unwraps to `v`.

When it fails:

- `Err(e)` evaluates RHS with `it = e`.
- `None` evaluates RHS without an error payload.

RHS executes and returns from the enclosing function or closure.

Example:

```rust
fun get_name(id: int) -> Result<string, string> {
    let user = find_user(id) or {
        return Err("User not found")
    }

    Ok(user.name)
}
```

Named binding:

```rust
let user = find_user(id) or error => {
    log(error)
    return Err(error)
}
```

`or` has lower precedence than ranges and higher precedence than assignment.

Ordinary methods remain available:

```rust
value.or(default)
value.or(#{ compute_default() })
```

These have normal method semantics and do not perform early return.

## 4.4 Literal syntax

### Records

```rust
r{
    id: 10,
    name: "John"
}
```

Rules:

- Keys are identifiers or quoted identifiers.
- Shorthand fields are allowed.
- Spread is allowed.

```rust
r{
    id,
    name,
    ...base
}
```

### Maps

```rust
m{
    "name": "John",
    "age": 20
}
```

Map keys are arbitrary expressions.

```rust
m{
    user.id: user,
    calculate_key(): value
}
```

### Sets

```rust
s{
    1,
    2,
    3
}
```

Duplicate handling is determined by the standard library's Set semantics.

### Tuples

```rust
t()
t(1)
t(1, "hello")
```

- `t()` is unit.
- `t(1)` is a one-element tuple.
- Tuples require the `t(...)` form.
- Parentheses alone are grouping, not tuples.

### Fixed arrays

```rust
a[1, 2, 3]
```

### Vectors

```rust
[1, 2, 3]
```

This is the standard growable `Vec<T>` literal.

### Tagged records

```rust
'1{
    id: 10,
    name: "John"
}
```

The tag is retained in the AST for semantic analysis.

### Named structs

```rust
User {
    id: 10,
    name: "John"
}
```

### Inferred structs

```rust
_{
    id: 10,
    name: "John"
}
```

`_{}` requires an expected type.

Otherwise:

```text
E_CANNOT_INFER_STRUCT_TYPE
```

### Spreads

Supported in:

- `r{}`
- `m{}`
- `s{}`
- `_{}` 
- `Name {}`
- `[]`
- `a[]`

Spread semantics are checked by the type checker.

Trailing commas are allowed everywhere.

## 4.5 Closures

Supported forms:

```rust
#{ it * 2 }

#{ a, b => a + b }

(a, b) => a + b

(a: i32, b: i32) -> i32 => {
    a + b
}
```

Implicit closure parameters:

- `it` = first argument.
- `it1` = first argument.
- `it2` = second argument.
- `itN` = Nth argument.

Named closures cannot use implicit `it`.

Explicit captures:

```rust
#[x, y]#{ x + y }

#[x](value) => x + value
```

Captures:

- Escaping closures must declare captures explicitly.
- Non-escaping closures may capture read-only values implicitly.
- Borrowing and capture validation happen semantically.

No `fun() {}` closure syntax.

No trailing-closure syntax in v1.

Parenthesized closure detection uses the lexer's matching-delimiter index.

## 4.6 Other expressions

```rust
if condition {
    ...
} else {
    ...
}

match value {
    Some(x) => x
    None => 0
}

unsafe {
    ...
}

recover {
    ...
}
```

`if` without `else` is void.

`if` and `match` with complete branches are expressions.

Ranges:

```rust
1..10
1..=10
..10
1..
```

Open ranges are permitted only in contexts that support them.

---

# 5. Statements and declarations

## 5.1 Bindings

```rust
let name = expression
var name = expression

name := expression
name :== expression
```

Equivalent:

```rust
name := expression       // let name = expression
name :== expression      // var name = expression
```

Assignment:

```rust
name = expression
```

Assignment never declares a variable.

`:=` and `:==` accept only a plain identifier on the left in v1.

Use `let` for patterns and explicit annotations.

## 5.2 Pattern declarations

```rust
let t(width, height) = get_dimensions()

let Some(user) = find_user() else {
    return
}
```

The `else` block must diverge.

## 5.3 Conditional patterns

```rust
if let Some(user) = result {
    ...
}

while let Some(item) = iterator.next() {
    ...
}
```

## 5.4 Loops

```rust
for item in items {
    ...
}

while condition {
    ...
}

loop {
    ...
}
```

Multiple bindings:

```rust
for key, value in map {
    ...
}
```

The iteration contract is defined through an interface, not hardcoded into the parser.

`break value` is only permitted from `loop`.

Labels are supported using identifiers:

```rust
outer: for item in items {
    if condition {
        break outer
    }
}
```

## 5.5 Newlines and semicolons

Tokens carry `nl_before`.

The parser determines statement termination.

Rules:

1. Explicit `;` terminates a statement.
2. Newline normally terminates a statement.
3. Newline does not terminate when the previous token requires an operand or continuation.
4. Leading `.`, `?.` can continue a member chain.
5. Postfix calls and indexes cannot begin across a newline.
6. Newlines inside `()` and `[]` are ignored.
7. Newlines inside nested blocks remain meaningful.
8. `return`, `break` and `continue` without a value terminate at newline, `;`, `}` or EOF.
9. A trailing semicolon after a block's final expression discards its value.

Opening braces for declarations and control-flow constructs must appear on the same line as the header in v1.

Examples:

```rust
let result =
    calculate(
        first,
        second
    )

let user = get_user()
    .profile
    .name
```

A newline before `(` or `[` starts a new statement rather than extending the previous expression.

---

# 6. Patterns

Supported patterns:

| Pattern | Example |
|---|---|
| Literal | `1`, `"hello"`, `true`, `nil` |
| Wildcard | `_` |
| Binding | `user` |
| Constructor | `Some`, `None`, `PaymentMethod.Cash` |
| Payload | `Ok(value)` |
| Struct | `User { id, name }` |
| Tuple | `t(x, y)` |
| Or | `Some(x) \| None` |
| Range | `1..=10` |

Rules:

- Lowercase identifiers create bindings.
- Uppercase identifiers represent constructors or constants.
- Unqualified variants resolve through the prelude and then the scrutinee's type.
- No reference patterns in v1.
- No destructuring in function parameters in v1.
- `nil` and `None` represent the same pattern.

Match:

```rust
match payment {
    Cash => process_cash()
    Mpesa(receipt) => process_mpesa(receipt)
    Card { number, .. } => process_card(number)
}
```

Match arms are separated by commas or newlines.

---

# 7. Types

## 7.1 Type grammar

Conceptual grammar:

```text
Type       := Intersection
Intersection := Postfix ('&' Postfix)*
Postfix    := Primary '?'*
Primary    := Path ['<' TypeArgs '>']
            | '&' ['mut'] Type
            | '*' ['mut'] Type
            | 't(' Types ')'
            | 'r{' Fields '}'
            | '(' Types ')' '->' Type
            | '(' Type ')'
            | 'TypeOf' '(' PathExpr ')'
            | StringLit
            | IntLit
            | 'true'
            | 'false'

TypeArgs   := (Type | IntLit)
              (',' (Type | IntLit))*
```

`&` at the beginning of a type means a reference.

`&` between completed types means intersection, only legal in interface definitions and bounds.

Examples:

```rust
User
Vec<User>
Map<string, User>
Set<int>
Promise<Result<User, Error>>
User?
&User
&mut User
*mut u8
t(int, string)
r{ id: int, name: string }
(int, int) -> int
```

Function types always use `->`.

## 7.2 Type declarations

### Nominal structs

```rust
type User = {
    pub id: int,
    name: string
}
```

The body is a nominal struct declaration.

### Structural records

```rust
type User = r{
    id: int,
    name: string
}
```

Structural records are compatible according to their field structure and type rules.

### Sum types

```rust
type Payment = 
    | Cash
    | Mpesa(string)
    | Card { number: string }
```

Sum types must start with a leading `|`.

Variants belong to the declared type's namespace.

### Literal unions

```rust
type Role = "Admin" | "Operator"
```

Literal unions are supported.

Unions of arbitrary existing types are not supported in v1.

### Aliases

```rust
type UserId = int
type Config = TypeOf(config)
type UserList = Vec<User>
```

## 7.3 Built-in types

```text
bool
char
byte
i8 i16 i32 i64
u8 u16 u32 u64
isize usize
int
f32 f64
void never
string
Slice<T>
Array<T, N>
Vec<T>
Map<K, V>
Set<T>
Promise<T>
Option<T>
Result<T, E>
Ref<T>
Box<T>
Weak<T>
```

`int` aliases `i32`.

`byte` aliases `u8`.

`&str` aliases `Slice<u8>`.

`Vec<T>` is the standard growable collection.

`Array<T, N>` is a fixed-size array.

`string` is owned and immutable.

Indexing a string by integer is not supported. Use:

```rust
text.bytes()
text.chars()
text.substring(start, end)
```

String offsets are byte-based and must land on character boundaries.

## 7.4 Type-level intrinsics

`TypeOf` is a special type-level form:

```rust
TypeOf(config)
```

It accepts only a value path.

Other operations are ordinary generic type names:

```rust
KeyOf<T>
IndexOf<T>
ElementOf<T>
Partial<T>
Omit<T, K>
Pick<T, K>
```

The type checker implements their compile-time behavior.

---

# 8. Declarations and modules

## 8.1 File structure

```text
file := package-decl import* item*

package-decl := 'package' ident

import := 'import' ['pub'] STRING ['as' ident]
```

Example:

```rust
package app.users

import "std.log"
import "std.collections.vec"
import "app.models.user" as models
```

Imports are only allowed at the top of a file.

Relative paths begin with `./` or `../`.

Other imports are dotted package paths.

## 8.2 Functions

```rust
pub fun get_user(id: int) -> User? {
    ...
}
```

Parameters:

```rust
name: T
name: &T
name: &mut T
mut name: T
...name: T
```

Variadic parameters bind a `Vec<T>`.

## 8.3 Receivers

Supported forms:

```rust
this
&this
&mut this
mut this
```

Examples:

```rust
impl User {
    fun get_id(&this) -> int {
        this.id
    }

    fun update(mut this, name: string) {
        this.name = name
    }
}
```

Static functions have no receiver.

`Self` is available in interfaces and implementations.

## 8.4 Generics

```rust
fun identity<T>(value: T) -> T {
    value
}

fun compare<T: PartialOrd>(a: T, b: T) -> bool {
    ...
}
```

Multiple bounds:

```rust
fun process<T: Reader & Writer>(value: T) {
    ...
}
```

No `where` clause in v1.

Const generics remain a later feature.

## 8.5 Implementations

```rust
impl User {
    ...
}

impl<T> Container<T> {
    ...
}

impl Reader for File {
    ...
}

impl Reader, Writer for File {
    ...
}
```

One implementation body may implement multiple interfaces.

Duplicate method names from multiple interfaces are an error unless explicitly resolved by the language's implementation rules.

Orphan rules apply to interfaces and types.

## 8.6 Interfaces

```rust
inter Reader = {
    fun read(&mut this, buffer: Vec<u8>) -> Result<int, string>
}
```

Superinterfaces:

```rust
inter PartialOrd<T>: PartialEq<T> = {
    ...
}
```

Composition:

```rust
inter ReadWriter = Reader & Writer
```

Associated types are deferred in v1. Additional generic parameters are used instead.

## 8.7 Extern and unsafe

```rust
extern "C" {
    pub fun malloc(size: usize) -> *mut u8
}
```

Unsafe expressions:

```rust
unsafe {
    ...
}
```

## 8.8 Global declarations

```rust
pub let VERSION: string = "1.0"
let cache = Ref(...)
```

Only these declarations are allowed at the top level:

- package
- import
- let
- type
- inter
- impl
- fun
- extern

Attributes are reserved for a future version:

```rust
@test
@inline
```

---

# 9. Type-system decisions

The following are semantic rules, not parser rules.

| Topic | Rule |
|---|---|
| Copy | `Copy` interface; primitives implement it |
| Move | All non-Copy values move by default |
| Borrowing | Implicit at compatible call sites |
| Mutable borrowing | Requires exclusive mutable access |
| Returned borrows | Allowed if derived from receiver or parameters |
| Interface bounds | Static dispatch initially |
| Interface values | No dynamic dispatch in v1 |
| `any` | Not supported in v1 |
| String coercion | `string` to `Slice<u8>` |
| Vec coercion | `Vec<T>` to `Slice<T>` |
| Numeric casts | `as` |
| Fallible conversion | `.to_*()` methods |
| Overflow | Debug panic, release wrapping (provisional) |

Returned references use elision-like rules without explicit lifetime syntax.

Example:

```rust
inter Index<T> = {
    fun index(&this, i: int) -> &T
}
```

The compiler verifies that the returned borrow is derived from a valid input borrow.

---

# 10. Diagnostics

The compiler should provide actionable diagnostics early.

Important diagnostics:

| Code | Meaning |
|---|---|
| `E_SIGIL_SHADOWS_BINDING` | Sigil conflicts with a visible binding |
| `E_EXPECTED_TYPE_ARGUMENTS` | Invalid generic argument syntax |
| `E_UNEXPECTED_GENERIC_ARGUMENTS` | Missing `::` before expression generic arguments |
| `E_UNMATCHED_DELIMITER` | Missing closing delimiter |
| `E_CANNOT_INFER_STRUCT_TYPE` | `_{} ` has no expected type |
| `E_INVALID_PATTERN` | Invalid pattern |
| `E_INVALID_ASSIGNMENT_TARGET` | Assignment to non-place expression |
| `E_NON_ASSOCIATIVE_OPERATOR` | Chained comparison or range |
| `E_INVALID_BLOCK_VALUE` | Block value does not match expected return type |

Examples:

```rust
parse<User>(input)
```

Diagnostic:

```text
Generic arguments in expression position require ::<...>

Suggested:
parse::<User>(input)
```

---

# 11. Parser implementation

## 11.1 Lexer

Implement:

1. Identifier and keyword recognition.
2. Number literals.
3. String mode stack and interpolation.
4. Comments and trivia.
5. Glued sigil tokens.
6. Operator maximal munch.
7. `ws_before` and `nl_before`.
8. Matching delimiter indexes.
9. Character and raw string handling.

The lexer should not resolve identifiers or understand types.

## 11.2 Parser

Recursive descent:

- Packages and imports.
- Declarations.
- Types.
- Statements.
- Patterns.
- Blocks.

Pratt parser:

- Prefix expressions.
- Binary expressions.
- Postfix expressions.
- Assignment.
- Ranges.
- `or`.

Special postfix parser support:

```text
.member
?.member
(args)
[index]
::<TypeArgs>
?
```

The parser handles generic closing-token splitting in type and turbofish contexts.

## 11.3 AST

The AST remains purely syntactic.

For example:

```rust
user.profile.name
```

Produces a generic member-access chain.

The parser does not determine whether `user` is a variable, module, namespace or type.

Similarly:

```rust
Map<string, User>
```

Produces a generic type application.

Resolution and validation happen later.

## 11.4 Testing

Before implementing semantic analysis, establish a parser corpus covering:

```rust
t.0.1
1..10
a[0]
a [0]
Vec<Promise<User>>
parse::<User>(input)
a<b
a < b
'1{}
r{}
m{}
s{}
a[]
x.or(1)
x or 1
(await f())?
user?.name
#{ it * 2 }
#{ x, y => x + y }
```

Each test should verify:

- Token stream.
- AST structure.
- Source spans.
- Expected diagnostics.

Aim for at least 50 parser tests before adding the type checker.

---

# 12. Deferred features

These are intentionally not part of v1:

1. Dynamic interface dispatch.
2. `any` and heterogeneous collections.
3. Associated interface types.
4. `where` clauses.
5. Const generics beyond the basic array length mechanism.
6. Range indexing.
7. Default parameter values.
8. Named function arguments.
9. Destructuring parameters.
10. Unicode identifiers.
11. Expression-bodied function declarations.
12. Advanced attributes and compiler intrinsics.
13. Advanced compile-time reflection.
14. Custom operators.

---

# 13. Remaining decisions

These require explicit confirmation before the language specification becomes stable.

| # | Topic | Proposed default |
|---|---|---|
| 1 | `'1{}` tags | Numeric shape tags; different tags represent different shapes |
| 2 | Optional fields in inferred records | Missing optional fields become `None`; required fields must be supplied |
| 3 | `?` vs `?.` | Keep separate propagation and chaining |
| 4 | Interface-typed values | No dynamic dispatch in v1 |
| 5 | Copy and move | `Copy` interface for primitives |
| 6 | Returned borrows | Receiver/parameter-derived borrows only |
| 7 | Collection naming | `Vec`, `Map`, `Set` |
| 8 | Conversion | `as` for casts, `.to_*()` for fallible conversions |
| 9 | Range indexing | Defer |
| 10 | Overflow | Debug panic, release wrap |
| 11 | Entry package | Resolve `package main` exception |
| 12 | Nested `it` | Innermost closure wins; warn on shadowing |
| 13 | `log` prelude | Decide whether `log` is implicitly available |
| 14 | `import pub` | Re-export imported module symbols |
| 15 | `a[0]` collision | Keep glued sigils; use whitespace for indexing a binding named `a` |
| 16 | `t(1)` collision | Keep glued tuple sigil; use whitespace for calling a function named `t` |

---

# 14. Recommended implementation sequence

**Phase 1 — Lexer**

Build tokenization and source tracking. No AST yet.

**Phase 2 — Parser**

Implement declarations, statements, expressions, patterns and types.

**Phase 3 — AST validation**

Run the parser corpus and verify deterministic output.

**Phase 4 — Name resolution**

Implement scopes, packages, imports and symbol tables.

**Phase 5 — Type checker**

Implement inference, generics, interfaces and collection types.

**Phase 6 — Semantic analysis**

Implement Copy, move, borrowing, mutability and lifetime validation.

**Phase 7 — Comptime**

Implement type-level intrinsics and compile-time evaluation.

**Phase 8 — Backend**

Lower to an intermediate representation and generate target code.

---

**Core v2 decisions:** Preserve compact collection sigils, use ordinary `<>` for type generics, require `::<T>` for expression-level generics, and keep parsing independent of semantic information.

The compiler should be able to parse a syntactically valid file without knowing whether any referenced variable, function, type or interface exists.
