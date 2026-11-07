package parser_closures

fun main() {
    // implicit params
    let c1 = #{ it * 2 }
    let c2 = #{ it1 + it2 }
    let c3 = #{ compute_default() }           // zero params
    let c4 = #{ }                             // empty body, void

    // named params: header ends at `=>` on the first line
    let c5 = #{ n => n * n }
    let c6 = #{ n, idx => n > 50 && idx > 0 }
    let c7 = #{ mut acc, cur => acc += cur; acc }

    // typed params and return type
    let c8 = #{ x: i32, y: i32 => x + y }
    let c9 = #{ a: i32, b: i32 -> i32 => a + b }
    let c10 = #{ v: Vec[i32] => v.len() }             // `[...]` group skipped during the header scan
    let c11 = #{ p: t(int, int) => p.0 + p.1 }         // `t(...)` group skipped
    let c12 = #{ f: &(i32) -> i32, x: i32 => f(x) }    // function-typed param
    let c13 = #{ o: r{ a: int } => o.a }               // `r{...}` group skipped
    let c14 = #{ u: models.User => u.name }            // `.` allowed in the header
    let c15 = #{ s: string? => s ?? "" }               // `?` allowed in the header

    // header-less: the scan stops at a token that can't be in a header
    let h1 = #{ f() or e => log.println(e) }           // `or` stops the scan: no header
    let h2 = #{ match it { 0 => "zero", _ => "other" } }    // `match` stops the scan
    let h3 = #{ if it { 1 } else { 2 } }
    let h4 = #{ x }                                    // reaches `}`: no header, body is `x`
    let h5 = #{                                        // first line empty: no header
        it + 1
    }

    // multi-line bodies, last expression is the value
    let m1 = #{ n =>
        let squared = n * n
        let offset = squared + 5
        offset
    }
    let m2 = #{
        let a = it1
        let b = it2
        a + b
    }
    let m3 = #{ n =>
        if n < 0 { return 0 }                          // returns from the closure
        n
    }
    let m4 = #{ x => x; }                              // trailing `;`: void

    // capture lists
    let k1 = #[count]{ it + count }                    // by value
    let k2 = #[&mut total]{ total += it }              // mutable borrow
    let k3 = #[&cfg]{ cfg.port }                       // explicit read borrow (redundant, lint)
    let k4 = #[]{ 42 }                                 // captures nothing
    let k5 = #[conn, &mut stats]{ msg =>
        conn.send(msg)
        stats.sent += 1
    }
    let k6 = #[n]{ x: i32 -> i32 => x + n }

    // closures as arguments
    let doubled = numbers.map(#{ it * 2 })
    let high = numbers.filter(#{ n, idx => n > 50 })
    numbers.for_each(#[&mut total]{ total += it })
    let n = adder(10, 12, #{ it1 + it2 })
    let sorted = users.sort_by(#{ a, b => a.age.cmp(b.age) })
    let fallback = timeout.or(#{ compute_expensive_default() })

    // nested closures: innermost `it` wins (lint warning)
    let nested = groups.map(#{ it.filter(#{ it > 0 }) })
    let nested_named = groups.map(#{ g => g.items.map(#{ it * g.factor }) })

    // immediately invoked, and called through a binding
    let r1 = #{ it * 2 }(4)
    let adder2 = make_adder(10)
    let r2 = adder2(5)
}

fun make_adder(n: i32) -> (i32) -> i32 {
    #[n]{ it + n }
}

fun apply(n: i32, f: &(i32) -> i32) -> i32 {
    f(n)
}
