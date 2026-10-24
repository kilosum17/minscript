package main

import "std.io"

// ==========================================
// 1. DATA TYPES WITH PUBLIC & PRIVATE FIELDS
// ==========================================
pub type User = {
    pub id: string,
    pub name: string,
    pub email: string,
    password_hash: string, // Private field: automatically excluded from external introspection
}

pub type SystemStatus = "Online" | "Degraded" | "Offline"


// ==========================================
// 2. METADATA TYPE DEFINITIONS (Prelude)
// ==========================================
// The compiler synthesizes these structures at compile-time when `_get_info()` is called.

pub type FieldInfo = {
    pub name: string,
    pub type_kind: string,  // "string", "int32", "bool", "struct", "list", "map", etc.
    pub is_pub: bool,
}

pub type TypeInfo = {
    pub name: string,
    pub kind: string,       // "struct", "union", "enum", "primitive"
    pub fields: List<FieldInfo>,
}

// ==========================================
// 3. ZERO-CONFIG SERIALIZER LIBRARY (`std.json`)
// ==========================================
// Generic function leveraging compile-time introspection
pub fun stringify<T>(val: T) -> string {
    // T._get_info() is a compiler intrinsic resolved entirely at compile-time.
    // Call-site visibility rules apply: external callers only see `pub` fields.
    const info = T._get_info()

    if info.kind != "struct" {
        return "${val}"
    }

    let fields_json: List<string> = []

    // Compile-time unrolled iteration over public fields
    for field in info.fields {
        // Safe compile-time field value access
        const field_val = val.get_field(field.name)
        fields_json.push("\"${field.name}\": \"${field_val}\"")
    }

    return "{ " + fields_json.join(", ") + " }"
}

// ==========================================
// 4. CUSTOM OVERRIDE IMPLEMENTATION
// ==========================================
// Implementing explicit custom logic overrides automated introspection
impl Serializable for User {
    pub fun serialize(this) -> string {
        // Explicitly omit sensitive fields like password_hash or email without struct tags
        return "{ \"id\": \"${this.id}\", \"name\": \"${this.name}\" }"
    }
}

// ==========================================
// 5. USAGE DEMO
// ==========================================
async fun main() {
    const user = User {
        id: "usr_101",
        name: "Teddy",
        email: "teddy@example.com",
        password_hash: "super_secret_hash_123",
    }

    // --- A. Direct Introspection ---
    // Inspected metadata is fully typed and available at compile-time
    const type_info = User._get_info()
    println("Type Name: ${type_info.name}")           // "User"
    println("Type Kind: ${type_info.kind}")           // "struct"
    println("Public Fields Size: ${type_info.fields.size()}") // 3 (password_hash is private and excluded)

    // Iterate through field definitions
    for field in type_info.fields {
        println(" - Field: ${field.name} (${field.type_kind})")
    }

    // --- B. Automatic Zero-Config Serialization ---
    // Automatically uses compiler-generated `_get_info()` metadata
    const auto_json = stringify(user)
    println("Auto JSON: ${auto_json}")
    // Output: { "id": "usr_101", "name": "Teddy", "email": "teddy@example.com" }

    // --- C. Explicit Custom Serialization ---
    // Uses explicit `impl Serializable` logic when fine-grained control is required
    const custom_json = user.serialize()
    println("Custom JSON: ${custom_json}")
    // Output: { "id": "usr_101", "name": "Teddy" }
}
