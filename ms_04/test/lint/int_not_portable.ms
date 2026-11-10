// L_INT_NOT_PORTABLE (§7.2): an `int` literal outside the i32 range.
package main

fn main() {
    big := 3000000000                            //~ L_INT_NOT_PORTABLE
    small := 2147483647
    wide := 3000000000 as i64                    // quiet: a cast, not arithmetic
    log.println(big, small, wide)
}
