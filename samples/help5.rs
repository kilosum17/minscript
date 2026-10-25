// ==========================================
// 1. VARIABLE BINDINGS
// ==========================================
// `let` produces immutable bindings; `var` produces mutable bindings.
// No `let mut` keyword combinations exist in the grammar.

let max_connections = 100
var active_connections = 0
active_connections = active_connections + 1

// Functions declare mutable parameters directly using `var`
pub fun reset_point(mut x: int32, mut y: int32) {
    x = 0
    y = 0
}

// ==========================================
// 2. PACKAGE & MODULE SYSTEM
// ==========================================
// Folder-based package system (Go-style). Files in the same folder share namespace implicitly.
// Declarations are private by default; `pub` exposes items outside the package.
// Imports target full directory paths without circular dependency cycles.

import std.fs
import std.json
import app.net

// ==========================================
// 3. ERGONOMIC INDEXING (`Index` & `IndexMut`)
// ==========================================
// Indexing syntax desugars via interfaces. References (`&` / `&mut`) are compiler-managed,
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
// 5. UNRECOVERABLE ERRORS & PANICS
// ==========================================
// Panics immediately abort process execution (fast abort), outputting source line numbers and messages.
// No unwinding, exceptions, or `recover()` mechanisms.

pub fun process_array_element(items: List<int32>, index: int32) -> int32 {
    // Runtime assertions
    assert(index >= 0, "Index must be non-negative")
    
    if index >= items.len() {
        // Direct process abort
        panic("Index out of bounds: length ${items.len()}, got ${index}")
    }
    
    return items[index]
}

// ==========================================
// 6. LOW-LEVEL FFI, SYSCALLS & C INTEROP
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
// 7. RESOURCE MANAGEMENT (`Drop` Interface)
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
// 8. CONTROL FLOW EXPRESSIONS & ERROR HANDLING
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
// 9. EXPLICIT INTERFACES & COMPILE-TIME INTROSPECTION
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

// literal type syntax for quick 1 time use like for json returns instead of declaring 1 time use type for each response type?
// at the top of file, this ensures co-existance of code
res := await net.fetch<t{name:string,age:i32}>("https://example.com/json") // return Result<t{name:string,age:i32}>

fun returnEarly(){
    res := await getData() or return 
    res := await getData2() or return 0

}

    var routes = [
        '1{ name: "TRM, Thika Road", lat: -1.2194756, lon: 36.8879763, volume: 80 },
        '1{ name: "Kasarani, Thika Road", lat: -1.22889, lon: 36.90444, volume: 100 },
        '1{ name: "Kasarani-Mwiki Road", lat: -1.225805, lon: 36.915674, volume: 120 },
    ]

    // maybe we need more helpers like Ref and Type, type only usable when declaration is in scope to avoid slow searches
    total_volume := (routes: Type(routes))=>{ 
        return routes.reduce(0,(r,cur)=>r+cur)
    }
    
    routes.push({name:'', lat : 0, lon: 0 })// missing keys get default values

