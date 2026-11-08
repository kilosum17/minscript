package testing

// Tests (`ms test`, spec §17.7): assertions, and the runner.
// Each assertion panics with a message that says what was expected; the runner catches the panic
// and reports the test as failed. This package imports nothing, so any package (std included) can
// be tested from the inside: `ms test` adds a generated main to the package that calls `run_all`.

/// `got == want`, or the test fails showing both.
pub fun assert_eq[T: PartialEq[T] & Stringer](got: &T, want: &T) {
    if got != want {
        panic("assert_eq failed\n       got: ${got}\n      want: ${want}")
    }
}

/// `got != other`, or the test fails.
pub fun assert_ne[T: PartialEq[T] & Stringer](got: &T, other: &T) {
    if got == other {
        panic("assert_ne failed: both are ${got}")
    }
}

/// The condition holds, or the test fails with `msg`.
pub fun assert_true(cond: bool, msg: string) {
    if !cond {
        panic("assert_true failed: ${msg}")
    }
}

/// An `Ok` (returns its value), or the test fails showing the error.
pub fun assert_ok[T, E: Stringer](r: Result[T, E]) -> T {
    match r {
        Ok(v) => v
        Err(e) => panic("assert_ok failed: Err(${e})")
    }
}

/// An `Err` (returns the error), or the test fails.
pub fun assert_err[T, E](r: Result[T, E]) -> E {
    match r {
        Ok(_) => panic("assert_err failed: the result is Ok")
        Err(e) => e
    }
}

/// A `Some` (returns its value), or the test fails.
pub fun assert_some[T](o: T?) -> T {
    match o {
        Some(v) => v
        None => panic("assert_some failed: the option is None")
    }
}

/// Fails the test now.
pub fun fail(msg: string) -> never {
    panic(msg)
}

// ---- the runner ---------------------------------------------------------------------------------

/// One test: its name, and how to run it.
pub type Case = {
    pub name: string
    pub run: TestFn
}

pub union TestFn = {
    Sync(() -> void)
    Async(() -> Promise[void])
}

pub type Outcome = {
    pub name: string
    pub ok: bool
    pub message: string
    pub ms: i64
}

/// Milliseconds, for timing tests.
fun clock() -> i64 { _builtin() }

/// Runs one test; a panic fails it (and doesn't stop the others).
pub async fun run_one(c: &Case) -> Outcome {
    let start = clock()
    let result = match &c.run {
        Sync(f) => recover { f() }
        Async(f) => recover { await f() }
    }
    let ms = clock() - start
    match result {
        Ok(_) => Outcome { name: c.name.clone(), ok: true, message: "", ms }
        Err(p) => Outcome { name: c.name.clone(), ok: false, message: p.message.clone(), ms }
    }
}

/// Runs every test of a package, prints a report ("spec": a line per test; "dots": a character per
/// test), and returns how many failed.
pub async fun run_all(package_name: string, cases: Vec[Case], reporter: string) -> int {
    log.println("== ${package_name}")
    var outcomes = [] as Vec[Outcome]
    for c in cases.iter() {
        let out = await run_one(c)
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
    for f in failed.iter() {
        log.println("--- FAIL ${f.name}\n    ${f.message.replace("\n", "\n    ")}")
    }
    passed := outcomes.len() - failed.len()
    log.println("${passed} passed, ${failed.len()} failed")
    failed.len()
}
