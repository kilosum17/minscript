// The prelude's methods written in MinScript (std/prelude.ms), tested from outside: `ms test examples/prelude`.
// v0.4 port: no `.clone()`, inferred captures, getters return views (spec §9.6).
package prelude_test

import "std.testing.*"
import "std.json"

type User { name: str, tags: Vec[str] }

// ---- Option / Result ------------------------------------------------------------------------------

fn test_option() {
    let some: int? = Some(2)
    let none: int? = None
    assert_true(some.is_some() && none.is_none(), "is_some / is_none")
    assert_eq(some.map(#{ it * 10 }) ?? 0, 20)
    assert_eq(none.map(#{ it * 10 }) ?? -1, -1)
    assert_eq(some.and_then(#{ n => if n > 1 { Some(n + 1) } else { None } }) ?? 0, 3)
    assert_eq(some.filter(#{ n => n > 5 }).is_none(), true)
    assert_eq(some.ok_or("missing").is_ok(), true)
    assert_eq(none.ok_or("missing").unwrap_err(), "missing")
    assert_eq(some.unwrap(), 2)
    assert_eq(some.expect("present"), 2)
}

fn test_unwrap_of_none_is_an_unwrap_panic() {
    let none: int? = None
    let r = recover { none.unwrap() }
    match r {
        Ok(_) => fail("unwrap of None must panic")
        Err(p) => {
            assert_eq(p.message, "unwrap of None")
            assert_true(p.kind == Unwrap, "the panic kind is Unwrap")
        }
    }
}

fn test_result() {
    let ok: Result[int, str] = Ok(4)
    let err: Result[int, str] = Err("bad")
    assert_true(ok.is_ok() && err.is_err(), "is_ok / is_err")
    assert_eq(ok.map(#{ it + 1 }).unwrap(), 5)
    assert_eq(err.map_err(#{ e => "${e}!" }).unwrap_err(), "bad!")
    assert_eq(ok.and_then(#{ n => if n > 3 { Ok(n * 2) } else { Err("small") } }).unwrap(), 8)
    assert_eq(ok.ok() ?? 0, 4)
    assert_eq(err.err() ?? "", "bad")
    let r = recover { err.unwrap() }
    assert_eq(assert_err(r).message, "unwrap of Err(bad)")
}

// ---- Vec ------------------------------------------------------------------------------------------

fn test_vec_access() {
    let xs = [10, 20, 30]
    assert_eq(xs.get(1) ?? 0, 20)
    assert_true(xs.get(3).is_none() && xs.get(-1).is_none(), "get is bounds-checked")
    assert_eq(xs.at(-1) ?? 0, 30)
    assert_eq(xs.first() ?? 0, 10)
    assert_eq(xs.last() ?? 0, 30)
    assert_true(xs.contains(20) && !xs.contains(25), "contains")
    assert_eq(xs.index_of(30) ?? -1, 2)
    let empty = [] as Vec[int]
    assert_true(empty.is_empty() && empty.first().is_none() && empty.last().is_none(), "empty")
}

fn test_vec_changes() {
    var xs = [3, 1, 2]
    xs.extend([5, 4])
    assert_eq(xs.join(","), "3,1,2,5,4")
    xs.sort()
    assert_eq(xs.join(","), "1,2,3,4,5")
    xs.reverse()
    assert_eq(xs.join(","), "5,4,3,2,1")
    xs.truncate(2)
    assert_eq(xs.join(","), "5,4")
    xs.swap(0, 1)
    assert_eq(xs.join(","), "4,5")
    xs.clear()
    assert_true(xs.is_empty(), "clear")
    var one = [1]
    one.reverse()
    assert_eq(one.len(), 1)
}

fn test_vec_pipelines() {
    let xs = [1, 2, 3, 4]
    assert_eq(xs.map(#{ n, i => n * 10 + i }).join(","), "10,21,32,43")
    assert_eq(xs.filter(#{ it % 2 == 0 }).join(","), "2,4")
    assert_eq(xs.find(#{ it > 2 }) ?? 0, 3)
    assert_true(xs.any(#{ it == 4 }) && xs.all(#{ it > 0 }) && !xs.all(#{ it > 1 }), "any / all")
    assert_eq(xs.count(#{ it > 1 }), 3)
    assert_eq(xs.fold(0, #{ acc, n => acc + n }), 10)
    assert_eq(xs.reduce(1, #{ acc, n => acc * n }), 24)
    assert_eq(xs.sum(), 10)
    assert_eq(xs.max() ?? 0, 4)
    assert_eq(xs.min() ?? 0, 1)
    assert_eq(xs.take(2).join(","), "1,2")
    assert_eq(xs.skip(3).join(","), "4")
    assert_eq(xs.to_vec().len(), 4)
    var seen = 0
    xs.for_each(#{ seen += it })                // non-escaping: writes `seen` in place
    assert_eq(seen, 10)
}

fn test_results_are_independent() {
    // `filter` returns a new Vec whose elements share the originals' buffers (views, §9.6);
    // writing one copies it first, so the original never changes (copy-on-write, §9.1)
    let users = [User { name: "ann", tags: ["a"] }, User { name: "bo", tags: [] }]
    var picked = users.filter(#{ u => u.tags.len() > 0 })
    picked[0].tags.push("b")
    assert_eq(users[0].tags.len(), 1)
    assert_eq(picked[0].tags.len(), 2)
    assert_eq(users.map(#{ u => u.name }).join(" "), "ann bo")      // views of the names, no copy
}

// ---- Map ------------------------------------------------------------------------------------------

fn test_map_keys_values() {
    var m = m{} as Map[str, int]
    m["a"] = 1
    m["b"] = 2
    assert_eq(m.keys().join(","), "a,b")
    assert_eq(m.values().sum(), 3)
    assert_true(!m.is_empty(), "is_empty")
}

// ---- strings --------------------------------------------------------------------------------------

fn test_string_search() {
    let s = "hello world"
    assert_true(s.contains("lo w") && !s.contains("xyz"), "contains")
    assert_true(s.starts_with("hell") && !s.starts_with("world"), "starts_with")
    assert_true(s.ends_with("world") && !s.ends_with("hello"), "ends_with")
    assert_eq(s.find("o", 5) ?? -1, 7)
    assert_true("".starts_with("") && "ab".ends_with(""), "the empty prefix")
}

fn test_string_trim_and_strip() {
    assert_eq("  \t hi there \n".trim(), "hi there")
    assert_eq("   ".trim(), "")
    assert_eq("file.enc".strip_suffix(".enc"), "file")
    assert_eq("file.txt".strip_suffix(".enc"), "file.txt")
    assert_eq("v1.2".strip_prefix("v"), "1.2")
    assert_true("abc".try_strip_prefix("x").is_none(), "try_strip_prefix")
    assert_eq("abc".try_strip_suffix("c") ?? "", "ab")
}

fn test_string_split_lines_replace() {
    assert_eq("a,b,,c".split(",").join("|"), "a|b||c")
    assert_eq(",a,".split(",").len(), 3)
    assert_eq("abc".split("").join("-"), "a-b-c")
    assert_eq("one\r\ntwo\nthree".lines().join("|"), "one|two|three")
    assert_eq("a-b-c".replace("-", "+"), "a+b+c")
    assert_eq("aaa".replace("a", "bb"), "bbbbbb")
}

fn test_string_to_int() {
    assert_eq("42".to_int().unwrap(), 42)
    assert_eq(" -17 ".to_int().unwrap(), -17)
    assert_eq("+5".to_int().unwrap(), 5)
    assert_eq("12a".to_int().unwrap_err(), "not an integer: \"12a\"")
    assert_true("".to_int().is_err() && "-".to_int().is_err(), "empty and sign-only")
    assert_eq("2.5".to_float().unwrap(), 2.5)
}

// ---- type witnesses (spec §15.3): generic code that needs its `T` at run time ------------------------

type Settings { level: int = 1, name: str = "default", tags: Vec[str], extra: int? }

fn fresh[T: Default]() -> T { T.default() }

fn total[T: Plus[T, T] & Default](xs: Vec[T]) -> T { xs.sum() }

fn decode[T](text: str) -> T? { json_like.[T](text) }

fn json_like[T](text: str) -> T? { json.parse.[T](text).ok() }

fn test_sum_of_each_number_type() {
    let big: Vec[i64] = [1, 2, 3]
    assert_eq(big.sum(), 6)
    assert_eq([0.5, 0.25].sum(), 0.75)
    assert_eq(total([4, 5]), 9)
    assert_eq(([] as Vec[int]).sum(), 0)
    assert_eq(["a", "b"].sum(), "ab")
}

fn test_default_through_a_witness() {
    assert_eq(fresh.[int](), 0)
    assert_eq(fresh.[str](), "")
    assert_eq(fresh.[Vec[int]]().len(), 0)
    let s = fresh.[Settings]()                  // auto-generated: field defaults, empty Vec, None
    assert_eq(s.to_str(), "prelude_test.Settings { level: 1, name: \"default\", tags: [], extra: None }")
}

fn test_shapes_pass_through_generic_functions() {
    // decode[T] → json_like[T] → json.parse.[T]: the witness travels two levels
    let s = decode.[Settings]("{\"level\": 3, \"tags\": [\"x\"]}") ?? fresh.[Settings]()
    assert_eq(s.level, 3)
    assert_eq(s.name, "default")
    assert_eq(s.to_str(), "prelude_test.Settings { level: 3, name: \"default\", tags: [\"x\"], extra: None }")
}

type Holder { items: Vec[Vec[int]] }

// v0.4: `drain` is now sugar for `moved := h.items; h.items = []` (a move plus a fresh Vec).
fn test_vec_drain() {
    var h = Holder { items: [[1, 2], [3]] }
    let moved = h.items.drain()
    assert_eq(moved.len(), 2)
    assert_eq(moved[1][0], 3)
    assert_true(h.items.is_empty(), "drained")
    h.items.push([4])
    assert_eq(moved.len(), 2)            // independent of the Vec it came from
    assert_eq(h.items.len(), 1)
}

type Index { by_name: Map[str, Vec[int]] }

fn test_map_drain() {
    var ix = Index { by_name: m{ "a": [1], "b": [2, 3] } }
    var moved = ix.by_name.drain()
    assert_eq(moved.len(), 2)
    assert_eq((moved.get("b") ?? []).len(), 2)
    assert_true(ix.by_name.is_empty(), "drained")
    ix.by_name["c"] = [4]
    moved["a"] = []                      // independent of the Map it came from
    assert_eq(ix.by_name.len(), 1)
    assert_eq(moved.keys().join(","), "a,b")
}
