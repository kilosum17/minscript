// ==========================================
// MINSCRIPT COMPILER MAGIC & ERROR HANDLING REFERENCE
// ==========================================

// 1. PRELUDE SHORTHANDS (Direct access without namespace prefix)
// Result<T, E> -> Ok(T) | Err(E)
// Option<T>     -> Some(T) | None

pub type Config = {
    pub host: string,
    pub port: int32,
}

// 2. KEYWORD `or` (Control Flow & Early Return)
// Intercepts `Err` or `None`, exposing the payload via implicit `it`, 
// and immediately returns the right-hand side expression from the function.
pub async fun load_config(path: string) -> Result<Config, string> {
    // Result handling with keyword `or`
    let bytes = await std.fs.read_file(path) or Err("IO Failed: ${it}")

    // Option handling with keyword `or`
    let env_prefix = get_env_prefix() or return Err("Environment prefix missing")

    // Parsing with keyword `or` and error string coercion
    let config = std.json.parse<Config>(bytes) or Err(it.to_string())

    return Ok(config)
}

// 3. METHOD `.or()` (Data Fallbacks: Literal or Lazy Closure)
fun get_fallback_values() {
    let timeout: int? = None

    // A. Literal fallback value
    let default_timeout = timeout.or(30)

    // B. Lazy closure fallback for computed defaults
    let computed_timeout = timeout.or(() => compute_expensive_default())
}

// 4. COMPILER MAGIC: `_get_info()` & `std.json.parse<T>` implementation
namespace std.json {
    pub fun parse<T>(data: Bytes) -> Result<T, string> {
        // `_get_info()` is a compiler intrinsic executed statically at compile-time 
        // on type `T` via monomorphization. It returns metadata (name, fields, visibility).
        let type_info = T._get_info()

        if type_info.kind != "struct" {
            return Err("Target type must be a struct")
        }

        // The compiler uses `type_info.fields` to auto-generate direct, zero-allocation 
        // field assignment code specifically optimized for type `T`.
        return internal_fast_deserialize<T>(data, type_info)
    }
}
