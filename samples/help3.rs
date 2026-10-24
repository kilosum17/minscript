// ==========================================
// 1. PRELUDE & SHORTHANDS
// ==========================================
// `Ok`, `Err`, `Some`, `None`, `Result`, and `Option` are built-in everywhere.

pub type User = {
    pub id: string,
    pub email: string?,
}

// ==========================================
// 2. ERROR HANDLING & FALLBACKS
// ==========================================

// A. Keyword `or` (Control Flow & Early Return)
// Intercepts `Err`/`None`, exposes payload via implicit `it`, desugars to `let...else`
pub async fun load_user(path: string) -> Result<User, string> {
    let bytes = await std.fs.read_file(path) or Err("Failed to read: ${it}")
    let user = std.json.parse<User>(bytes) or Err("Invalid JSON: ${it}")
    return Ok(user)
}

// B. Method `.or()` (Data Fallback for Option/Result)
fun get_defaults() {
    let raw_email: string? = None
    let fallback_1 = raw_email.or("guest@minscript.dev")               // Literal value
    let fallback_2 = raw_email.or(() => compute_expensive_fallback()) // Lazy closure
}

// ==========================================
// 3. EXPLICIT INTERFACES & GENERIC BOUNDS
// ==========================================
// Explicit `impl` blocks preserve O(1) typechecking and compiler speed.

pub inter Reader = {
    pub fun read(mut this, buffer: List<u8>) -> Result<int, string>
}

impl Reader for FileStream {
    pub fun read(mut this, buffer: List<u8>) -> Result<int, string> {
        // Implementation
    }
}

// Generic Type Bounds (`<T: Interface>`)
pub fun read_all<T: Reader>(mut reader: T) -> Result<List<u8>, string> {
    let buf = List.new<u8>()
    reader.read(buf) or Err(it)
    return Ok(buf)
}

// ==========================================
// 4. RESOURCE MANAGEMENT (`Drop` Interface)
// ==========================================
// Replaces `defer` to eliminate borrow-checker conflicts; compiler auto-drops at scope exit.

pub inter Drop = {
    pub fun drop(mut this)
}

impl Drop for FileStream {
    pub fun drop(mut this) {
        this.close()
    }
}

// ==========================================
// 5. EXPRESSIONS & CONTROL FLOW
// ==========================================
// `if`, `switch`, and `match` act as expressions. Last expression in a block wins.

// A. Block-based `if` expression
let grade = if score >= 90 {
    let bonus = calc_bonus(score)
    "A"
} else if score >= 75 {
    "B"
} else {
    "C"
}

// B. `switch` expression (discrete values / string unions)
let tier = switch role {
    "Admin" => "Full Access",
    "Operator" => "Standard Access",
    _ => "Read Only",
}

// C. `match` expression (algebraic destructuring only)
let status = match result {
    Ok(val) => "Success: ${val}",
    Err(e) => "Error: ${e}",
}

// ==========================================
// 6. COMPILE-TIME INTROSPECTION & JSON
// ==========================================
// `_get_info()` runs statically on types (`T._get_info()`) and instances (`val._get_info()`).

pub fun serialize_generic<T>(val: T) -> string {
    let info = T._get_info() // Static metadata resolution
    if info.kind != "struct" {
        return "${val}"
    }
    return std.json.stringify(val)
}
