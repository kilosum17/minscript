package parser_precedence

async fun main() {
    let a1 = 1 + 2 * 3                  // (+ 1 (* 2 3))
    let a2 = (1 + 2) * 3                // (* (+ 1 2) 3)
    let a3 = 10 - 4 - 3                 // (- (- 10 4) 3)
    let a4 = 2 * 3 % 4                  // (% (* 2 3) 4)
    let a5 = -x * y                     // (* (- x) y)
    let a6 = -x.abs()                   // (- (call (. x abs)))
    let a7 = !a && b || c               // (|| (&& (! a) b) c)
    let a8 = a || b && c                // (|| a (&& b c))

    // bitwise: Rust ordering (tighter than comparison)
    let b1 = a & b == c                 // (== (& a b) c)
    let b2 = a | b ^ c & d              // (| a (^ b (& c d)))
    let b3 = x << 2 + 1                 // (<< x (+ 2 1))
    let b4 = flags & MASK != 0          // (!= (& flags MASK) 0)

    // `as`
    let c1 = n as i64 * 2               // (* (as n i64) 2)
    let c2 = -n as u8                   // (as (- n) u8)
    let c3 = x as f32 + y as f32
    let c4 = v as i32?                  // (as v (Option i32))

    // ranges
    let r1 = 0..n + 1                   // (.. 0 (+ n 1))
    let r2 = a..=b * 2
    let r3 = ..10
    let r4 = 5..

    // `??`: right associative, below || and above ranges
    let n1 = a ?? b ?? c                // (?? a (?? b c))
    let n2 = opt?.inner?.value ?? 0     // (?? (?. (?. opt inner) value) 0)
    let n3 = (a || b) ?? c
    let n4 = a ?? (b || c)
    let n5 = x ?? y + 1                 // (?? x (+ y 1))

    // `or`: below ranges, above assignment
    let o1 = read() or Err("failed")
    let o2 = await fetch() or Err(it)   // (or (await (fetch)) (Err it))
    let o3 = a ?? b or return           // (or (?? a b) return)

    // await and postfix `?`
    let w1 = await f()?                 // (? (await (f)))
    let w2 = await g()?.name            // (?. (? (await (g))) name)
    let w3 = (await h()).trim()
    let w4 = await client.receive()     // (await (call (. client receive)))
    let w5 = !await check()             // (! (await (check)))

    // postfix chains
    let p1 = x.y.z(1)[2].w
    let p2 = user?.profile.name         // (. (?. user profile) name)
    let p3 = (user?).name
    let p4 = get()?.items[0]
    let p5 = list.get(0)?.clone() ?? fallback

    // comparisons are non-associative but mix with logic
    let q1 = a == b && c != d
    let q2 = a < b || b >= c

    // assignment is right associative and has the lowest precedence
    var z = 0
    z = a + b * c
    z += x ?? 1
}
