package parser_literals

fun main() {
    // Vec
    let v0 = []
    let v1 = [1, 2, 3]
    let v2 = [1, 2, 3,]                       // trailing comma
    let v3 = [
        "red"
        "green",                              // commas and newlines both separate elements
        "blue"
    ]
    let v4 = [[1, 2], [3, 4]]
    let v5 = [...v1, 4, ...v2]

    // fixed array
    let a0 = a[]
    let a1 = a[100, 200, 300, 400]
    let a2 = a[...a1, 500]

    // tuple
    let t0 = t()                              // unit
    let t1 = t(1)                             // 1-tuple
    let t2 = t(777, "Teddy", true)
    let t3 = t(t(1, 2), [3])
    let uid = t2.0
    let deep = t3.0.1

    // record (structural)
    let r0 = r{}
    let r1 = r{ name: "Kilo", age: 32 as i64, active: true }
    let r2 = r{ name, age }                   // shorthand
    let r3 = r{ ...r1, age: 33 }              // spread + override
    let r4 = r{ "content-type": "json", skills: t("running", "football") }
    let r5 = r{
        endpoint: "/api/submit"
        timeout_ms: 500 as u16
        nested: r{ a: 1, b: [1, 2] }
    }

    // map: keys are arbitrary expressions
    let m0 = m{}
    let m1 = m{ "alice": 1, "bob": 2 }
    let m2 = m{ user.id: user, compute_key(): 3, "k" + suffix: 4 }
    let m3 = m{
        "admin": "full"
        "guest": "read"
    }
    let m4 = m{ ...m1, "carol": 3 }

    // set
    let s0 = s{}
    let s1 = s{ "fast", "safe" }
    let s2 = s{ ...s1, "concise" }

    // inferred: the type comes from the expected type
    let i1: Config = _{ host: "localhost", port: 8080 }
    configure_server(_{ host, port, secret_key })
    let i2: Vec[Point] = [_{ x: 1, y: 2 }, _{ x: 3, y: 4 }]

    // named struct literals
    let u1 = User { id: 1, name: "Ted" }
    let u2 = User { id, name, ...defaults }
    let u3 = User {
        id: 2
        name: "Shem"
    }
    let p1 = PaymentMethod.MobileMoney { phone: "+254700000000", provider: "M-Pesa" }
    let b1 = Box.[i32]{ value: 42 }
    let n1 = models.User { id: 3, name: "Q" }   // qualified type path
}
