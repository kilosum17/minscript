package json

// JSON (spec §14.4): typed parsing and printing, derived from the types (§13.4). A struct is an
// object (a missing field takes its default, an optional one may be missing or null), `Option` is
// the value or null, `Vec` an array, `Map[str, V]` an object, a variant `"Name"` or
// `{ "Name": [payload…] }`, `i64` / `u64` numbers.

pub type Error {
    pub message: str

    pub fn to_str(this) -> str { this.message }
}

/// Any JSON value, for documents whose shape isn't known in advance.
pub union Value {
    Null
    Bool(bool)
    Number(f64)
    Str(str)
    Array(Vec[Value])
    Object(Map[str, Value])
}

/// Parses JSON text into a `T`: a struct, a record, a Vec, a Map, a primitive, or `Value`.
pub fn parse[T](text: str) -> Result[T, Error] { _builtin() }

/// The JSON text of a value.
pub fn stringify[T](value: T) -> str { _builtin() }

/// A value as a JSON tree (what `stringify` would write, without the text).
pub fn to_value[T](value: T) -> Value { _builtin() }

/// A JSON tree as a `T` (the same rules as `parse`).
pub fn from_value[T](value: Value) -> Result[T, Error] { _builtin() }
