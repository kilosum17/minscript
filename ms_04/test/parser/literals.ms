package corpus

fn literals() {
    a := [1, 2, 3]
    b := a[1, 2, 3]
    c := t(1, "a")
    d := t()
    e := r{ name: "Ted", age: 26, ...base }
    f := m{ "one": 1, key(): 2 }
    g := s{ 1, 2, 3 }
    h := _{ host, port: 8080 }
    i := User { id: 1, name }
    j := r{ "content-type": "json", type: "user" }
    k := Pair.[int, str]{ first: 1, second: "a" }
    l := models.User { id: 2 }
    n := [] as Vec[Map[str, int]]
    o := m{} as Map[str, User]
    p := nil as User?
    q := 'c'
    r1 := b'x'
    r2 := b'\n'
    r3 := b'\xFF'
    s1 := r"raw\n"
    s2 := "a${x}b${y + 1}c"
    s3 := """
        multi
          line ${name}
        """
    u := 0xFF + 0b1010 + 0o17 + 1_000
    v := 2.5e-3
    w := true && !false
}
