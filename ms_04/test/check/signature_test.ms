// E_TEST_SIGNATURE (§17.7): in a `*_test.ms` file, `test_` functions take nothing and return nothing.
package errors

fn test_ok() {}

async fn test_async_ok() {}

fn test_with_param(n: int) {}                 //~ E_TEST_SIGNATURE

fn test_returns() -> int { 1 }                //~ E_TEST_SIGNATURE

fn helper(n: int) -> int { n }
