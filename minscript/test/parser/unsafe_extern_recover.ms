package parser_unsafe_extern_recover

extern "C" {
    pub fun malloc(size: usize) -> *mut u8
    pub fun free(ptr: *mut u8)
    pub fun open(path: *u8, flags: i32, mode: i32) -> i32
    fun getpid() -> i32
}

pub fun open_fd(path: string) -> Result[i32, string] {
    let fd = unsafe { open(path.as_ptr(), 0, 0) }
    if fd < 0 {
        return Err("Failed to open file descriptor: ${fd}")
    }
    Ok(fd)
}

pub fun write(fd: i32, buf: *u8, count: usize) -> isize {
    unsafe { intrinsic_syscall3(1, fd as i64, buf as i64, count as i64) as isize }
}

fun raw_memory() {
    unsafe {
        let p = malloc(16)
        *p = 42                                  // deref only inside unsafe
        let v = *p
        free(p)
    }
}

fun element(items: &Vec[i32], index: int) -> i32 {
    assert(index >= 0, "Index must be non-negative")
    if index >= items.len() {
        panic("Index out of bounds: length ${items.len()}, got ${index}")
    }
    items[index]
}

fun recovering() {
    let res = recover {
        let items = [1, 3, 5, 7, 11]
        element(items, 10)                       // panics
    }
    let Err(p) = res else { return }
    log.println(p.message, p.file, p.line)

    r2 := recover { risky() }
    if r2 { log.println("no panic") }
}
