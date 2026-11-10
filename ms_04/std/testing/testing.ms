package testing

// Tests (`ms test`, spec §17.7): assertions, and the runner. Each assertion panics with a message
// that says what was expected; the runner catches the panic and reports the test as failed. This
// package imports nothing, so any package (std included) can be tested from the inside: `ms test`
// adds a generated main to the package that calls `run_all`.

/// `got == want`, or the test fails showing both.
pub fn assert_eq[T: PartialEq[T] & Stringer](got: T, want: T) {
    if got != want {
        panic("assert_eq failed\n       got: ${got}\n      want: ${want}")
    }
}

/// `got != other`, or the test fails.
pub fn assert_ne[T: PartialEq[T] & Stringer](got: T, other: T) {
    if got == other {
        panic("assert_ne failed: both are ${got}")
    }
}

/// The condition holds, or the test fails with `msg`.
pub fn assert_true(cond: bool, msg: str) {
    if !cond {
        panic("assert_true failed: ${msg}")
    }
}

/// An `Ok` (returns its value), or the test fails showing the error.
pub fn assert_ok[T, E: Stringer](r: Result[T, E]) -> T {
    match r {
        Ok(v) => v
        Err(e) => panic("assert_ok failed: Err(${e})")
    }
}

/// An `Err` (returns the error), or the test fails.
pub fn assert_err[T, E](r: Result[T, E]) -> E {
    match r {
        Ok(_) => panic("assert_err failed: the result is Ok")
        Err(e) => e
    }
}

/// A `Some` (returns its value), or the test fails.
pub fn assert_some[T](o: T?) -> T {
    match o {
        Some(v) => v
        None => panic("assert_some failed: the option is None")
    }
}

/// Fails the test now.
pub fn fail(msg: str) -> never {
    panic(msg)
}

// ---- the runner ---------------------------------------------------------------------------------

/// One test: its name, and how to run it.
pub type Case {
    pub name: str
    pub run: TestFn
}

pub union TestFn {
    Sync(() -> void)
    Async(() -> Promise[void])
}

pub type Outcome {
    pub name: str
    pub ok: bool
    pub message: str
    pub ms: i64
}

/// Milliseconds, for timing tests.
fn clock() -> i64 { _builtin() }

/// Runs one test; a panic fails it (and doesn't stop the others).
pub async fn run_one(c: Case) -> Outcome {
    start := clock()
    let result = match c.run {
        Sync(f) => recover { f() }
        Async(f) => recover { await f() }
    }
    ms := clock() - start
    match result {
        Ok(_) => Outcome { name: c.name, ok: true, message: "", ms }
        Err(p) => Outcome { name: c.name, ok: false, message: p.message, ms }
    }
}

/// Runs every test of a package, prints a report ("spec": a line per test; "dots": a character per
/// test), and returns how many failed.
pub async fn run_all(package_name: str, cases: Vec[Case], reporter: str) -> int {
    log.println("== ${package_name}")
    var outcomes = [] as Vec[Outcome]
    for c in cases {
        out := await run_one(c)
        if reporter == "dots" {
            log.print(if out.ok { "." } else { "F" })
        } else {
            log.println("${if out.ok { "ok  " } else { "FAIL" }} ${out.name} (${out.ms} ms)")
        }
        outcomes.push(out)
    }
    if reporter == "dots" {
        log.println("")
    }
    failed := outcomes.filter(#{ x => !x.ok })
    for f in failed {
        log.println("--- FAIL ${f.name}\n    ${f.message.replace("\n", "\n    ")}")
    }
    passed := outcomes.len() - failed.len()
    log.println("${passed} passed, ${failed.len()} failed")
    failed.len()
}
