# MinScript

MinScript is a language that aims for TypeScript-style concision, Rust-style ownership (with no lifetime annotations) and Go-style simplicity. This folder is the spec-first restart. A deterministic, hand-written TypeScript lexer and Pratt parser come next.

## Boundaries

- Work only inside `min_script/minscript/`. **Never modify files in the parent `min_script/` folder** (`cmd_ts/`, `ms_cmd_ts/`, `samples/`, `docs/`). Reading them for reference is fine.

## Layout

- `docs/spec.md`: **the source of truth** (v0.2 unified spec). Change the spec before or alongside any syntax change, and keep §0.1 (change log), §11 (diagnostics), §12 (EBNF), §13 (corpus) and §18 (open questions) in sync.
- `docs/spec-v1.rs`, `spec-v2.rs`, `merge_1.rs`, `notes_1.md`, `docs/history/samples/`: superseded and old-syntax material. Keep it for history, and don't update it.
- `test/`: corpus. See `test/README.md`.
  - `lexer/`, `parser/`: one feature per file. Expected-output snapshots (`.tokens` / `.ast`) come later, once the lexer and parser can generate them.
  - `errors/`: one case per function, with `//~ CODE` on the line where the diagnostic is expected.
  - `programs/`: realistic programs that must parse with zero diagnostics.

## Writing MinScript code (samples, tests, spec examples)

- **Balance the binding styles.** Mix `let`/`var` and `:=`/`:==` evenly so they complement each other, and don't let either take over.
  - `:=`/`:==` suit quick locals, counters, intermediates and `x := [] as Vec[T]`.
  - `let`/`var` suit type annotations, patterns (`let t(a, b) = …`, `let … else`) and declarations that stand out.
- **`as` is also a type annotation:** `g := [] as Vec[Map[string, int]]` is as valid as `let g: Vec[Map[string, int]] = []`. The user likes the value-first form, so use both.
- Follow v0.2 syntax:
  - closures are `#{…}` / `#[x, &mut y]{…}` (never `(a) => …`);
  - type generics are `Vec[T]`, explicit call generics are `f.[T](x)` (never `<T>`);
  - sum types are `union X = { A  B(T) }`; loops use `for` only;
  - Vec literals are `[]`; fallbacks use `??`; owned strings come from `to_str()`;
  - methods may be written inline in `type`/`union` bodies;
  - `log` is in the prelude, while `println` needs an import.
- Code should be valid against `docs/spec.md`. If you find a gap or contradiction while writing an example, fix the spec too and say so.
