package main

import "std.io"

pub fun calculateArea(width: f32, height: f32) -> f32 {
    return width * height
}

pub fun logMessage(msg: string) {  // returns void
    log.println("LOG: ${msg}")
}

pub type Counter = {
    value: int32,
}

impl Counter {
    pub fun new(initialValue: int32) -> Counter { // static no this
        return Counter { value: initialValue }
    }

    pub fun increment(mut this, amount: int32) -> int32 {
        return this.value + amount
    }

    pub fun printValue(this) {
        log.println("Current Counter Value: ${this.value}")
    }
}

// Mandatory parentheses `()` are required around parameter lists for parser simplicity.
async fun main() {
    let numbers = [10, 25, 40, 5, 90, 110]
    let scores = [85.5, 92.0, 78.5, 95.0]

    let doubledNumbers = numbers.map((n) => n * 2)
    let highNumbers = numbers.filter((n) => n > 50)
    let hasHonorRoll = scores.any((score) => score >= 90.0)
    let allPassing = scores.all((score) => score >= 50.0)

    let processedValues = numbers.map((n) => {
        let squared = n * n
        let offset = squared + 5
        return offset
    })

    log.println("Processed complex values: ${processedValues}")


    var myCounter = Counter.new(10) // var so .increment(mut) can be called
    myCounter.printValue()

    let newTotal = myCounter.increment(15)
    log.println("Incremented result: ${newTotal}")
}


package main

import "std.time"
import "std.log"
import "std.col.vec"
import "app.models"  //  app. refers to current src folder

// 1. Structural Unions & Sum Types
pub type Role = "Admin" | "Operator" | "Guest"

pub type Result<T, E> = 
    | Ok { value: T }
    | Err { error: E }

pub type PaymentMethod = 
    | CreditCard { number: string, exp: string }
    | MobileMoney { phone: string, provider: string }
    | Cash

pub type User = {
    pub id: string,
    pub name: string,
    pub email: string?, // Optional
    pub login_count: int,
    tags: List<string>,
}

impl User {
    pub fun new(id: string, name: string, email: string?) -> User {
        return User {
            id: id,
            name: name,
            email: email,
            tags: ["active"],
        }
    }

    pub fun new2(opts: r{id: string, name: string, email: string? })->User{
        // can use User.new2({id: "1233", name: "Ted" }) -email auto nil
        return User {...opts}
    }

    pub fun get_email(this) -> string {
        return this.email.or("no-email@minscript.dev")
    }
}

fun get_dimensions() -> (int, int) {
    return t(1920, 1080)
}

pub async fun process_payment(method: PaymentMethod) -> Result<string, string> {
    await time.sleep(10)
    match method {
        PaymentMethod.CreditCard { number, exp } => {
            return Result.Ok("Charged card ${number}")
        },
        PaymentMethod.MobileMoney { phone, provider } => {
            return Result.Ok("Charged ${provider} (${phone})")
        },
        PaymentMethod.Cash => {
            return Result.Err("Cash not supported")
        },
    }
}

async fun main() {
    let app_name = "MinScript"
    var count = 0
    count += 1

    let (width, height) = get_dimensions()

    let names = ["Alice", "Bob", "Teddy"] // Vec<string>
    roles := s{ "Admin", "Operator" } // Set<string>,   := is immutable by default
    let user_map = { "Alice": 1, "Bob": 2 } // Map<string,i32>

    // Inferred Tagged Records ('1)
    let kiosks = r{
        mg: '1{ id: 1, name: "Mega Moto" },
        nz: '1{ id: 2, name: "Moto Nzuri" },
    } // Record<"mg"|"nz", {id: i32, name: string} >

    let active_names = names
        .filter((n) => n != "Bob")
        .map((n) => "User: ${n}")

    // Unified For Loops (Vec, Array, Tuples, Sets, Maps)
    for name in names {
        log.println(name)
    }

    for name, idx in names {
        log.println("${idx}: ${name}")
    }

    for role in roles {
        log.println("Role: ${role}")
    }

    for key, val in user_map {
        log.println("${key} => ${val}")
    }

    // Range Loops with break / continue
    for i in 0..10 {
        if i == 2 {
            continue
        }
        if i == 5 {
            break
        }
        log.println("Index: ${i}")
    }

    // functions to allow anonymous to ignore params
    vec.from(0,10).forEach((n,idx)=>{ // passes n, idx, user can ignore idx
        lo.print("No:",n," idx:",idx, "\n")
    })

    squares := (0..5).vec().map((n)=>n*n)

    // Conditionals (Optional Parentheses)
    if count > 0 {
        log.println("Count is positive")
    } else {
        log.println("Zero or negative")
    }

    // Null Helpers (.or static and closure)
    let raw_email: string? = nil
    let fallback_1 = raw_email.or("guest@minscript.dev")
    let fallback_2 = raw_email.or(() => "computed@minscript.dev")

    // Result & let...else Guard
    payment := PaymentMethod.MobileMoney {
        phone: "+254700000000",
        provider: "M-Pesa",
    }

    res := await process_payment(payment)

    let Result.Ok(receipt) = res else {
        log.println("Payment failed")
        return
    }

    log.println("Receipt: ${receipt}")
}

impl User {
    pub fun record_login(mut this) {
        this.login_count = this.login_count + 1
    }
}

// Note: Non-string custom types automatically get a `.clone()` method generated 
// by the compiler on-demand if no custom clone implementation is provided.

    // Exclusive borrow is active only during method execution, releasing automatically.
    user.record_login()
    log.println("Login count: ${user.login_count}")

    // Strings are first-class immutable value types (Go/JS style, no .clone() needed)
    let username: string = user.name

// Implicit structural interfaces (Go-style duck typing)
pub type Reader = {
    fun read(mut this, buffer: List<byte>) -> Result<int, string>
}

pub type Writer = {
    fun write(mut this, data: List<byte>) -> Result<int, string>
}

// Composition using `&` (Intersection of interface requirements)
pub type ReadWriter = Reader & Writer

    // Async execution from non-async context via `.then()` or `.ignore()`
    process_payment(payment).then(fun(res) {
        // `let ... else` guard for early return pattern matching on tuple variants
        let Result.Ok(receipt) = res else {
            log.println("Payment failed")
            return
        }
        log.println("Receipt: ${receipt}")
    })

    process_payment(payment).ignore() // Fire-and-forget background task

// in std.log
pub inter Stringer = {
    pub fun to_string() -> string
}

impl log{
    pub print(args: Vec<Stringer>...){}
}

// error propagation
TODO

// helpers for record, maps to avoid unncessary copies eg update .set
TODO

// we need heap helpers like Box<T>, or compiler intrinsics?

// ==========================================
// 1. PRELUDE TYPES (Built-in Everywhere)
// ==========================================
// Result<T, E>  -> Ok(T) | Err(E)
// Option<T>     -> T? (Shorthand for optional values)
// Ref<T>        -> Reference-counted heap handle with interior mutability
// Box<T>        -> heap data
pub type Config = {
    pub host: string,
    pub port: int,
}

async fun main() {
    // Allocated on the heap with reference counter = 1
    let app_config = Ref(Config { host: "127.0.0.1", port: 8080 })

    // Assigning/cloning passes a shared handle; counter increments automatically
    let worker_config = app_config

    // In-place interior mutability using closure updates
    app_config.update((cfg) => {
        cfg.port = 9090 // Mutates the underlying shared heap value directly
    })

    // Reflected automatically in worker_config without copying or lifetime annotations
    log.println("Worker Port: ${worker_config.get().port}") // 9090
    // When both `app_config` and `worker_config` go out of scope, counter hits 0 and frees memory.

    var metrics = r{ "app1": '1{ no: 100 }, "app2": '1{ no: 20} } // Record<'app1'|'app2',{no:i32}>

    // `.update(key, closure)` mutates values in-place without releasing references
    metrics.update("app1", (val) => { //typechecked to be app1 or app2
        val.no += 1
    })

    scores := m{"ted":20, "shem":30}
    if scores.has("ted") {
        log.println("Requests: ${scores.get("ted").or(0)}") // 101
    }

    let ports = [8080, 8081, 8082]
    ports.update_at(0, (p) => { // no mut p, mutability is determined by the update_at
        p = 9000
    })
    let port_1 = ports[0] // index check and will panic
    let port_2 = ports.get(1).or(8080) // returns Option

    log.println("Port 0: ${ports[0].or(0)}") // 9000

    text := "MinScript"
    tags := s{ "fast", "safe" } //Set<string>

    log.println("Text size: ${text.size()}")   // 9
    log.println("Set size: ${tags.size()}")     // 2

    if tags.has("fast") {
        tags.add("concise")
    }

    // Built-in .toString() auto-called by .join()
    let tag_list = tags.values().join(", ") // needs inter  Stringer
    log.println("Tags: ${tag_list}")
}
 
    let title = "  MinScript Systems Language  "

    log.println("Size: ${title.size()}")                 // 30
    log.println("Trimmed: ${title.trim()}")             // "MinScript Systems Language"
    log.println("Lower: ${title.trim().to_lower()}")    // "minscript systems language"
    
    if title.has("Systems") {                       // `has()` checks substring existence
        let clean = title.trim().strip_suffix(" Language").or(title)
        log.println(clean)                              // "MinScript Systems"
    }

    let words = title.trim().split(" ")           // ["MinScript", "Systems", "Language"]
    let sub = title.substring(2, 11)              // "MinScript"

    let numbers = [10, 20, 30]
    log.println("List size: ${numbers.size()}")          // 3
    numbers.push(40)                                // Appends to list
    let popped: int? = numbers.pop()              // Removes and returns last item (40)

    // In-place update by index
    numbers.update_at(0,(n,idx)=> { // closures don't captures
        n.set(idx, 99) // could have used set directly
    })

    log.println("Index 0 after update: ${numbers[0].or(0)}") // 99

    let permissions: Set<string> = s{ "read", "write" }
    log.println("Set size: ${permissions.size()}")        // 2
    permissions.add("execute")

    if permissions.has("write") {                   // `has()` checks set membership
        permissions.remove("write")
    }

    let default_perms: Set<string> = s{ "read", "execute" }
    let shared_perms = permissions.intersection(default_perms)

    let user_roles: Map<string, string> = {
        "alice": "admin",
        "bob": "developer",
    }
    log.println("Map size: ${user_roles.size()}")         // 2
    user_roles.set("charlie", "tester")

    if user_roles.has("alice") {                    // `has()` checks key presence
        let role: string? = user_roles.get("alice")
        log.println("Alice role: ${role.or("guest")}")
    }

    // In-place value update for a specific key
    user_roles.update("alice", (role) => {
        return "super_admin"
    })

    user_roles.remove("bob")

    // Extracting keys and values as lists
    let keys: List<string> = user_roles.keys()
    let values: List<string> = user_roles.values()
    let entries:List<Tuple<string,string>> = user_roles.entries()



import "std.json"
import "std.runtime"

pub type Status = "Active" | "Inactive"

impl ServerConfig {
    pub fun toString(this) -> string {
        return "${this.host}:${this.port}"
    }
}

    // Tuple<T1, T2, ...>: Heterogeneous Stack Record (using `t[...]` prefix)
    let user_record = t(777, "Teddy", true)
    let uid = user_record.0
    let uname = user_record.1

    // Array<T, N>: Fixed-Size Stack Buffer (using `a[...]` prefix)
    let fixed_buffer = a[100, 200, 300, 400]
    let first_val = fixed_buffer[0]

    // ------------------------------------------
    // F. COMPILE-TIME INTROSPECTION & JSON
    // ------------------------------------------
    let server_cfg = ServerConfig { host: "localhost", port: 443 }
    let type_info = ServerConfig._get_info()
    
    println("Intpected Type: ${type_info.name}")
    let auto_json = json.stringify(server_cfg)
    println("Serialized JSON: ${auto_json}")

    // ------------------------------------------
    // G. COOPERATIVE PREEMPTION YIELD
    // ------------------------------------------
    var counter = 0
    while counter < 50_000 {
        counter += 1
        if counter % 10_000 == 0 {
            await runtime.yield()
        }
    }
    println("Task loop finished successfully.")

pub type ServerConfig = {
    pub host: string,
    pub port: int32,
    secret_key: string, // Private field: restricted from external package access & introspection
}

pub type Box<T> = {
    pub value: T,
}

impl<T> Box<T> {
    pub fun get(this) -> T {
        return this.value
    }
}

    let explicit_cfg = ServerConfig { 
        host: "127.0.0.1", 
        port: 8080, 
        secret_key: "abc_123" 
    }

    // 2. Positional initialization (matches field declaration order)
    let positional_cfg = ServerConfig("0.0.0.0", 3000, "xyz_789")

    // 3. Context-Inferred Shorthand (infers type from target expression)
    let host = "localhost"
    let port = 9000
    let secret_key = "default_secret"
    
    configure_server({ host, port, secret_key })

    let int_box = Box { value: 42 }
    println("Box value: ${int_box.get()}")

    // Rule: Closures are pure and non-capturing. All external dependencies 
    // must be passed explicitly as arguments (no hidden captures or heap bloat).

    let compute_sum = (a: i32, b: i32) -> i32 {
        let total = a + b
        return total
    }
    println("Sum via block closure: ${compute_sum(15, 25)}")
    let multiply = (a: i32, b: i32) => a * b
    println("Product via shorthand closure: ${multiply(6, 7)}")

    // A. ANONYMOUS RECORDS (`r{...}`)
    let user_profile = r{
        name: "Kilo",
        age: 32 as i64,
        active: true,
        skills: t("running", "football"), // Using tuple prefix inside record
    }

    // Fully typed dot-notation access (resolved statically at compile-time)
    println("User Profile Name: ${user_profile.name}")
    println("User Profile Age: ${user_profile.age}")

// DESIGN CHOICES SUMMARY:
// 1. NO LIFETIME ANNOTATIONS: Closures cannot capture environment variables, eliminating 
//    hidden references and lifetime tracking overhead. All closure inputs must be passed explicitly.
// 2. MEMORY SAFETY: Heap types (Vec, String, anonymous records `r{}`) enforce exclusive ownership 
//    and move semantics. Stack types (Array `a[...]`, Tuple `t[...]`, primitives) are copied by value.
// 3. THREAD SAFETY & GLOBALS: Raw mutable global variables are banned at compile-time to prevent 
//    data races. Globals are strictly either immutable constants (`let`) or thread-safe atomic 
//    reference-counted handles (`Ref<T>`). No thread-local storage is used.
// 4. EXPLICIT MUTABILITY: Variables use `let` (immutable) or `var` (mutable). Parameters and 
//    receivers modifying data must explicitly declare `mut`.
// ==========================================

// Global Constants (Thread-safe read-only sharing)
pub let MAX_CONNECTIONS: int32 = 10_000
pub let SYSTEM_NAME: string = "MinScript-Engine"

// Global Mutable State (Strictly forced to use Ref<T> for thread safety)
pub let active_sessions: Ref<Map<string, int32>> = Ref(m{})

// Tagged Union (Algebraic Data Type with zero-cost discriminant jump tables)
pub type NetworkResponse = 
    | Success(string)
    | Error(int32)

    let raw_buffer: Array<u8, 4> = a[0x00, 0xFF, 0x10, 0x20]
    let first_byte = raw_buffer[0]

    active_sessions.update((sessions) => {
        sessions.set("admin_session", 1)
    })

pub fun calculateTotalValue(baseAmount: f32, multiplier: i32) -> f32 {
    // Implicit numeric promotion: `multiplier` (int32) is automatically 
    // promoted to f32 to match `baseAmount`, avoiding any manual casting boilerplate.
    return baseAmount * multiplier
}

    let request_payload = r{
        endpoint: "/api/submit",
        timeout_ms: 500 as u16,        // Overriding default int32 literal to u16
        retry_count: 3 as u8,          // Overriding default int32 literal to u8
        weight: 1.5 as f32,            // Overriding default f64 literal to f32
    }

    println("Request to ${request_payload.endpoint} with timeout ${request_payload.timeout_ms}ms")


pub type SystemStatus = "Online" | "Degraded" | "Offline"

// 2. METADATA TYPE DEFINITIONS (Prelude)
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

// 3. ZERO-CONFIG SERIALIZER LIBRARY (`std.json`)
pub fun stringify<T>(val: T) -> string {
    // T._get_info() is a compiler intrinsic resolved entirely at compile-time.
    // Call-site visibility rules apply: external callers only see `pub` fields.
    let info = T._get_info() // TODO is this on type or value?

    if info.kind != "struct" {
        return "${val}"
    }

    let fields_json: List<string> = []

    // Compile-time unrolled iteration over public fields
    for field in info.fields {
        // Safe compile-time field value access
        let field_val = val.get_field(field.name)
        fields_json.push("\"${field.name}\": \"${field_val}\"")
    }

    return "{ " + fields_json.join(", ") + " }"
}

// serialize is in Serializer inter-face
impl User {
    pub fun serialize(this) -> string {
        // Explicitly omit sensitive fields like password_hash or email without struct tags
        return "{ \"id\": \"${this.id}\", \"name\": \"${this.name}\" }"
    }
}

    let user = User {
        id: "usr_101",
        name: "Teddy",
        email: "teddy@example.com",
        password_hash: "super_secret_hash_123",
    }

    // --- A. Direct Introspection ---
    let type_info = User._get_info()
    println("Type Name: ${type_info.name}")           // "User"
    println("Type Kind: ${type_info.kind}")           // "struct"
    println("Public Fields Size: ${type_info.fields.size()}") // 3 (password_hash is private and excluded)

    // Iterate through field definitions
    for field in type_info.fields {
        println(" - Field: ${field.name} (${field.type_kind})")
    }

    // --- B. Automatic Zero-Config Serialization ---
    let auto_json = stringify(user)
    println("Auto JSON: ${auto_json}")
    // Output: { "id": "usr_101", "name": "Teddy", "email": "teddy@example.com" }

    // --- C. Explicit Custom Serialization ---
    let custom_json = user.serialize()
    println("Custom JSON: ${custom_json}")
    // Output: { "id": "usr_101", "name": "Teddy" }


import "std.fs"
import "std.io"
import "std.crypto"

pub type Mode = "encrypt" | "decrypt"
pub type CryptoResult = 
    | Ok(Bytes)
    | Err(string)

async fun process_file(path: string, password: string, mode: Mode) -> Result<nil, string> {
    let file_bytes_res = await std.fs.read_file(path)
    let Result.Ok(data) = file_bytes_res else {
        return Result.Err("Failed to read file: ${path}")
    }

    match mode {
        "encrypt" => {
            let encrypted = std.crypto.encrypt_aes_gcm(data, password)
            let out_path = "${path}.enc"
            await std.fs.write_file(out_path, encrypted)
            println("Encrypted: ${path} -> ${out_path}")
        },
        "decrypt" => {
            let decrypted_res = std.crypto.decrypt_aes_gcm(data, password)
            let CryptoResult.Ok(decrypted) = decrypted_res else {
                return Result.Err("Decryption failed (incorrect password or corrupted file): ${path}")
            }
            
            // strip_suffix returns string?, so we safely unwrap or fallback using .or()
            let out_path = path.strip_suffix(".enc").or(path)
            await std.fs.write_file(out_path, decrypted)
            println("Decrypted: ${path} -> ${out_path}")
        },
    }

    return Result.Ok(nil)
}

// AUTO implemented .clone, to_string, _get_info, _get_value, _get_field() when needed 

    print("Enter mode (encrypt / decrypt): ")
    let mode_input = (await std.io.read_line()).trim()

    let stat_res = await std.fs.stat(target_path)
    let Result.Ok(info) = stat_res else {
        println("Path does not exist or cannot be accessed: ${target_path}")
        return
    }

    if info.is_dir() {
        let files_res = std.fs.walk_dir(target_path)
        let Result.Ok(files) = files_res else {
            println("Failed to read directory contents.")
            return
        }

        // Standard .map() works natively because async functions return a Promise<T> value
        // TODO we may need an .iter() or .into_iter() so all collection types share the same implementation 
        let promises = files
            .filter(fun(file_path) {
                if mode_input == "encrypt" and file_path.ends_with(".enc") { return false }
                if mode_input == "decrypt" and not file_path.ends_with(".enc") { return false }
                return true
            })
            .map(fun(file_path) {
                return process_file(file_path, password, mode_input)
            })

        // Await all concurrent operations in a single go using Promise.all
        let results = await Promise.all(promises)

        // Handle any errors reported across the batch
        for res in results {
            let Result.Err(err_msg) = res else {
                continue
            }
            println("Warning: ${err_msg}")
        }
    } else {
        // Handle single file path
        let res = await process_file(target_path, password, mode_input)
        let Result.Err(err_msg) = res else {
            println("Operation completed successfully.")
            return
        }
        println("Error: ${err_msg}")
    }

    println("All operations completed.")

    