// ==========================================
// 1. VARIABLE BINDINGS
// ==========================================
// `let` produces immutable bindings; `var` produces mutable bindings.
// No `let mut` keyword combinations exist in the grammar.

let max_connections = 100
var active_connections = 0
active_connections = active_connections + 1

// Functions declare mutable parameters directly using `mut`
pub fun reset_point(mut x: int32, mut y: int32) {
    x = 0
    y = 0
}

// ==========================================
// 2. ERGONOMIC INDEXING (`Index` & `IndexMut`)
// ==========================================
// Indexing syntax desugars via interfaces. References (`&` / `&mut`) are compiler-managed
// restricted primitives used strictly for indexing and internal reference passing.

pub inter Index<Idx, Target> = {
    pub fun index(this, index: Idx) -> &Target
}

pub inter IndexMut<Idx, Target> = {
    pub fun index_mut(var this, index: Idx) -> &mut Target
}

// Usage requires no explicit pointer dereferencing (`*`):
var numbers = [10, 20, 30]
numbers[0] = 120 // Desugars into: (*numbers.index_mut(0)) = 120

// ==========================================
// 3. LOW-LEVEL FFI, SYSCALLS & C INTEROP
// ==========================================
// Direct OS interfacing and C library linkage require explicit `extern` and `unsafe` blocks.

extern "C" {
    pub fun malloc(size: usize) -> *mut u8
    pub fun free(ptr: *mut u8)
    pub fun open(path: *u8, flags: int32, mode: int32) -> int32
}

pub fun open_file_descriptor(path: string) -> Result<int32, string> {
    // Strings expose `.as_ptr()` for C-compatible null-terminated raw byte buffers
    let fd = unsafe { open(path.as_ptr(), 0, 0) }
    if fd < 0 {
        return Err("Failed to open file descriptor: ${fd}")
    }
    return Ok(fd)
}

// Low-level system calls using architectural compiler intrinsics
namespace std.sys {
    pub fun write(fd: int32, buf: *u8, count: usize) -> isize {
        return unsafe { intrinsic_syscall3(1, fd as int64, buf as int64, count as int64) as isize }
    }
}

// ==========================================
// 4. RESOURCE MANAGEMENT (`Drop` Interface)
// ==========================================
// Automatic scope cleanup without manual `defer` statements or borrow-checker conflicts.

pub inter Drop = {
    pub fun drop(var this)
}

impl Drop for FileStream {
    pub fun drop(var this) {
        unsafe { close(this.fd) }
    }
}

// ==========================================
// 5. CONTROL FLOW EXPRESSIONS & ERROR HANDLING
// ==========================================
// Prelude built-ins: `Ok`, `Err`, `Some`, `None`, `Result`, `Option`.

// A. Keyword `or` (Control flow early-return desugared to let-else)
pub async fun load_config(path: string) -> Result<Config, string> {
    let bytes = await std.fs.read_file(path) or Err("IO Error: ${it}")
    let config = std.json.parse<Config>(bytes) or Err("Parse Error: ${it}")
    return Ok(config)
}

// B. Method `.or()` (Data fallbacks)
let port = config_port.or(8080)

// C. `if`, `switch`, and `match` as expressions (last expression without trailing semicolon wins)
let tier = switch role {
    "Admin" => "Full Access",
    _ => "Read Only",
}

let status = match result {
    Ok(val) => "Success: ${val}",
    Err(e) => "Error: ${e}",
}

// ==========================================
// 6. EXPLICIT INTERFACES & COMPILE-TIME INTROSPECTION
// ==========================================

pub inter Reader = {
    pub fun read(var this, buffer: List<u8>) -> Result<int32, string>
}

// Generic Type Bounds
pub fun read_all<T: Reader>(var reader: T) -> Result<List<u8>, string> {
    var buf = List.new<u8>()
    reader.read(buf) or Err(it)
    return Ok(buf)
}

// Zero-overhead compile-time reflection
pub fun serialize_type<T>() {
    let info = T._get_info() // Evaluated statically at compile time
}
