package lexer_keywords

fun main() {
    // a keyword after `.` or `?.` is a plain identifier
    let a = x.or(5)                     // IDENT DOT IDENT(or)
    let b = r.in(value)                 // IDENT DOT IDENT(in)
    let c = p.match()
    let d = q.type
    let e = cfg.for
    let f = opt?.or(1)                  // QUESTION_DOT IDENT(or)
    let g = x.as.[i32]()                // IDENT(as) GENERIC_OPEN …

    // keywords in normal position
    let h = x or 5                      // KW_OR
    let i = n as i64                    // KW_AS
    let j = await fetch()               // KW_AWAIT

    // implicit closure params: reserved identifiers, not keywords
    let k = items.map(#{ it })
    let l = pairs.map(#{ it1 + it2 + it10 })
    let m1 = item                       // plain IDENT: `it` is only a prefix
    let n1 = it01                       // plain IDENT: leading zero is not an implicit param
    let o1 = items_                     // plain IDENT

    // prelude names are identifiers, not keywords
    let p1 = Some(1)
    let p2 = None
    let p3 = nil                        // KW_NIL
    let p4 = Ok(log)
    let p5 = this_value                 // IDENT, not KW_THIS
    let p6 = Selfish                    // IDENT, not KW_SELF
}
