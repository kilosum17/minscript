// `ms test` on failures (test/corpus.test.ts compares the report with `report.out`): each failing test
// is reported with its message, and the others still run.
package failing

import "std.testing.*"

fn test_passes() {
    assert_eq(1 + 1, 2)
}

fn test_wrong_value() {
    assert_eq("${21 * 2}", "41")
}

fn test_panics() {
    let xs = [1, 2, 3]
    log.println("about to index past the end")
    let _ = xs[10]
}

fn test_err_expected() {
    let r: Result[int, str] = Ok(3)
    let _ = assert_err(r)
}

fn test_runs_after_failures() {
    assert_some(Some(1))
}
