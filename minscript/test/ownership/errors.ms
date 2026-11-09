package ownership_errors

// Ownership-pass diagnostics, one case per function (`//~ CODE` on the expected line).

type User = { name: string, tags: Vec[string] }
type Holder = { items: Vec[int] }

fun take(u: User) {}
fun take_vec(v: Vec[int]) {}
fun inspect(u: &User) {}
fun grow(v: &mut Vec[int]) { v.push(1) }
fun store(f: (int) -> int) {}
async fun upload(data: &Vec[int]) -> int { 0 }
async fun send_owned(data: Vec[int]) -> int { 0 }

// ---- mutability ------------------------------------------------------------------------------

fun assign_to_let() {
    let x = 1
    x = 2                                       //~ E_ASSIGN_IMMUTABLE
}

fun assign_to_short_decl() {
    n := 1
    n += 1                                      //~ E_ASSIGN_IMMUTABLE
}

fun assign_to_field_of_let() {
    let u = User { name: "a", tags: [] }
    u.name = "b"                                //~ E_ASSIGN_IMMUTABLE
}

fun assign_to_param(n: int) {
    n = 5                                       //~ E_ASSIGN_IMMUTABLE
}

fun mut_borrow_of_let() {
    let v = [1, 2]
    grow(v)                                     //~ E_MUT_BORROW_IMMUTABLE
}

fun mut_method_on_let() {
    let v = [1, 2]
    v.push(3)                                   //~ E_MUT_BORROW_IMMUTABLE
}

fun mut_capture_of_let() {
    let total = 0
    let f = #[&mut total]{ total += it }        //~ E_MUT_BORROW_IMMUTABLE
}

fun implicit_capture_is_read_only(items: Vec[int]) {
    var total = 0
    items.for_each(#{ total += it })            //~ E_ASSIGN_IMMUTABLE
}

type Counter = {
    n: int
    fun bump(&this) { this.n += 1 }             //~ E_ASSIGN_IMMUTABLE
}

// ---- moves -----------------------------------------------------------------------------------

fun use_after_move() {
    let u = User { name: "a", tags: [] }
    take(u)
    inspect(u)                                  //~ E_USE_AFTER_MOVE
}

fun move_twice() {
    let v = [1, 2]
    let a = v
    let b = v                                   //~ E_USE_AFTER_MOVE
}

fun maybe_moved(c: bool) {
    let v = [1]
    if c { take_vec(v) }
    log.println(v.len())                        //~ E_USE_AFTER_MOVE
}

fun moved_in_loop() {
    let v = [1]
    for i in 0..3 {
        take_vec(v)                             //~ E_USE_AFTER_MOVE
    }
}

fun moved_into_closure() {
    let v = [1]
    let f = #[v]{ v.len() }
    log.println(v.len())                        //~ E_USE_AFTER_MOVE
}

fun moved_in_recover() {
    let u = User { name: "a", tags: [] }
    let r = recover { take(u) }
    inspect(u)                                  //~ E_USE_AFTER_MOVE
}

async fun await_twice(p: Promise[int]) {
    let a = await p
    let b = await p                             //~ E_USE_AFTER_MOVE
}

fun move_out_of_borrowed_param(v: &Vec[int]) -> Vec[int] {
    v                                           //~ E_MOVE_OUT_OF_BORROW
}

type Bag = {
    items: Vec[int]
    fun steal(&this) -> Vec[int] { this.items } //~ E_MOVE_OUT_OF_BORROW
}

fun move_loop_item(users: Vec[User]) {
    var kept = [] as Vec[User]
    for u in users {
        kept.push(u)                            //~ E_MOVE_OUT_OF_BORROW
    }
}

// ---- scoped values ---------------------------------------------------------------------------

fun change_owner_while_borrowed() {
    var raw = " text "
    var words = raw.split(" ")
    raw = "other"                               //~ E_BORROW_CONFLICT
    log.println(words.len())
}

fun borrowed_value_used_twice() {
    var raw = " text "
    var words = raw.split(" ")
    raw = "other"                               //~ E_BORROW_CONFLICT
    log.println(words.len())
    log.println(words.len())
}

fun borrowed_across_loop_iterations() {
    var names = ["a", "b"]
    let view = names.iter()
    for i in 0..2 {
        log.println(view)
        names.push("c")                         //~ E_BORROW_CONFLICT
    }
}

fun read_while_borrowed_mutably() {
    var nums = [1, 2]
    var each = nums.iter_mut()
    log.println(nums.len())                     //~ E_BORROW_CONFLICT
    let _ = each.next()
}

fun inspect_sub(s: &Sub[int]) {}

async fun iterate_while_borrowed(t: Topic[int]) {
    var sub = t.subscribe()
    let peek = &sub
    for await m in sub {}                       //~ E_BORROW_CONFLICT
    inspect_sub(peek)
}

fun push_while_borrowed() {
    var names = ["a", "b"]
    let first = names.first()
    let view = names.iter()
    names.push("c")                             //~ E_BORROW_CONFLICT
    log.println(view)
}

fun return_borrow_of_local() -> &str {
    let s = "hello".to_str()
    s.trim()                                    //~ E_RETURN_LOCAL_BORROW
}

fun return_borrow_of_local_ref() -> &Vec[int] {
    let r = Ref([1, 2])
    r.get()                                     //~ E_RETURN_LOCAL_BORROW
}

fun reassign_ref_while_lent() {
    var r = Ref([1, 2])
    let view = r.get()
    r = Ref([3])                                //~ E_BORROW_CONFLICT
    log.println(view.len())
}

fun return_match_binding_of_local() -> &str {
    let slots = [Some("x".to_str())]
    match &slots[0] {                           //~ E_RETURN_LOCAL_BORROW
        Some(b) => b
        None => ""
    }
}

fun move_out_of_matched_borrow(slots: &Vec[Vec[int]?]) -> Vec[int] {
    match &slots[0] {
        Some(v) => v                            //~ E_MOVE_OUT_OF_BORROW
        None => []
    }
}

fun return_borrow_of_owned_param(s: string) -> &str {
    s.trim()                                    //~ E_RETURN_LOCAL_BORROW
}

type Parsed = {
    word: &str                                  //~ E_BORROW_IN_FIELD
}

fun closure_escapes_by_return(n: int) -> (int) -> int {
    #{ it + n }                                 //~ E_CLOSURE_ESCAPES_BORROW
}

fun closure_escapes_to_owned_param() {
    let k = 3
    store(#{ it * k })                          //~ E_CLOSURE_ESCAPES_BORROW
}

async fun borrow_across_spawn() {
    let data = [1, 2, 3]
    let p = upload(data)                        //~ E_BORROW_ACROSS_SPAWN
    await p
}
