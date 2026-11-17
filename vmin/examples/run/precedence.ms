package main

fn main4(){
    let a =1
    let b=2
    let c = -a + b            // (-a) + b
    let d = !a && b           // (!a) && b
    let e = -a.b()            // -(a.b())
    let f = -x as i32         // (-x) as i32
    let g = a + b as f64      // a + (b as f64)
    let h = await f()?        // (await f())?
    let i = await f() or g    // (await f()) or g
    let j = await a.b().c     // await (a.b().c)
    let h = a || b && c       // a || (b && c)
    let k = x = y = z or w    // x = (y = (z or w))

}