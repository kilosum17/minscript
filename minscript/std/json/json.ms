package json

pub type Error = {
    pub message: string

    pub fun to_str(&this) -> string { this.message }
}

/// Any JSON value, for documents whose shape isn't known in advance.
pub union Value = {
    Null
    Bool(bool)
    Number(f64)
    Str(string)
    Array(Vec[Value])
    Object(Map[string, Value])
}

/// Parses JSON text into a `T`: a struct (optional fields may be missing or null), a record, a Vec,
/// a primitive, or `Value`.
pub fun parse[T](text: &str) -> Result[T, Error] { _builtin() }

/// The JSON text of a value: structs and records become objects, Options become the value or null.
pub fun stringify[T](value: &T) -> string { _builtin() }
