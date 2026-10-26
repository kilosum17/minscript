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
    pub fun to_string(this) -> string // passing this means it will only work on structs
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

    
// iterators are compiler magic eg stuct just need to implemet a next<T>()->Option<T> method to qualify as an iterator
// Due to generic which makes searching alot of type a slow operation, interface must be explicitly implemented



// Interface Definition
pub inter Reader = {
    pub fun read(mut this, buffer: List<u8>) -> Result<int, string>
}

pub inter Writer = {
    pub fun write(mut this, buffer: List<u8>) -> Result<int, string>
}

// Composition using `&`
pub inter ReadWriter = Reader & Writer

// Explicit Implementation
impl Reader for FileStream {
    pub fun read(mut this, buffer: List<u8>) -> Result<int, string> {
        // Implementation
    }
}

// 2. Records: Structural merging & patching
let base_opts = r{ host: "localhost", port: 8080, debug: false }
let dev_opts = r{ ...base_opts, port: 3000, debug: true } // do we allow this to add new fields?

// In-place record update for mutable (`var`) records
var session = r{ id: "s1", active: true }
session.patch({ active: false }) // we need a Partial<T>, Omit<T> etc?

// Recursive types MUST use Box<T> to give the type a known pointer size
pub type Node<T> = {
    pub value: T,
    pub next: Box<Node<T>>?, // Optional recursive boxed pointer
}
    let boxed_val = Box(100) 
    let new_owner = boxed_val 

pub type BinaryNode<T> = {
    pub value: T,
    pub left: Box<BinaryNode<T>>?,  // Boxed pointer for recursive types
    pub right: Box<BinaryNode<T>>?,
}

    scores["bob"] += 10
    let base_config = r{ host: "127.0.0.1", port: 8080 }
    // we need a way to mark can addd new fields or not, so it doesn't introduce errors
    let override_config = r{ ...base_config, port: 9090 } // r{ host: "127.0.0.1", port: 9090 } 

// 2. KEYWORD `or` (Control Flow & Early Return)
// Intercepts `Err` or `None`, exposing the payload via implicit `it`, 
// and immediately returns the right-hand side expression from the function.
pub async fun load_config(path: string) -> Result<Config, string> { // Should this be Result<Config,Err>?
    let bytes = await std.fs.read_file(path) or Err("IO Failed: ${it}") //Result
    let env_prefix = get_env_prefix() or return Err("Environment prefix missing") // Option, using return is optional
    let config = std.json.parse<Config>(bytes) or Err(it.to_string())
    // to prevent confusing or and .or we may need to force use of .or() value or assign them to _
    return Ok(config)
}

// 3. METHOD `.or()` (Data Fallbacks: Literal or Lazy Closure)
fun get_fallback_values() {
    let timeout: int? = None
    let default_timeout = timeout.or(30)
    let computed_timeout = timeout.or(() => compute_expensive_default())
}

// 4. COMPILER MAGIC: `_get_info()` & `std.json.parse<T>` implementation
// in package std.json 
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

// `Ok`, `Err`, `Some`, `None`, `Result`, and `Option` are built-in everywhere.
// Explicit `impl` blocks preserve O(1) typechecking and compiler speed.
// Generic Type Bounds (`<T: Interface>`)
pub fun read_all<T: Reader>(mut reader: T) -> Result<List<u8>, string> {
    let buf = List.new<u8>()
    reader.read(buf) or Err(it)
    return Ok(buf)
}
// 4. RESOURCE MANAGEMENT (`Drop` Interface)
// Replaces `defer` to eliminate borrow-checker conflicts; compiler auto-drops at scope exit.

pub inter Drop = {
    pub fun drop(mut this)
}

impl Drop for FileStream { // maybe allow impl Drop,Add,PartialEq for FileStream as these only have 1 methods each and redeclaring block for each?
    pub fun drop(mut this) {
        this.close()
    }
}

// 5. EXPRESSIONS & CONTROL FLOW
// `if`, `switch`, and `match` act as expressions. Last expression in a block wins.
let grade = if score >= 90 {
    let bonus = calc_bonus(score)
    "A"
} else if score >= 75 {
    "B"
} else {
    "C"
}

let tier = switch role {
    "Admin" => "Full Access",
    "Operator" => "Standard Access",
    _ => "Read Only",
}

let status = match result {
    Ok(val) => "Success: ${val}",
    Err(e) => "Error: ${e}",
}

// 6. COMPILE-TIME INTROSPECTION & JSON
// `_get_info()` runs statically on types (`T._get_info()`) and instances (`val._get_info()`).

pub fun serialize_generic<T>(val: T) -> string {
    let info = T._get_info() // Static metadata resolution
    if info.kind != "struct" {
        return "${val}"
    }
    return std.json.stringify(val)
}


// 1. VARIABLE BINDINGS

// Functions declare mutable parameters directly using `mut`
pub fun reset_point(mut x: int32, mut y: int32) {
    x = 0
    y = 0
}

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

// 3. LOW-LEVEL FFI, SYSCALLS & C INTEROP
// Direct OS interfacing and C library linkage require explicit `extern` and `unsafe` blocks.

extern "C" {
    pub fun malloc(size: usize) -> *mut u8
    pub fun free(ptr: *mut u8)
    pub fun open(path: *u8, flags: i32, mode: i32) -> i32
}

pub fun open_file_descriptor(path: string) -> Result<i32, string> {
    // Strings expose `.as_ptr()` for C-compatible null-terminated raw byte buffers
    let fd = unsafe { open(path.as_ptr(), 0, 0) }
    if fd < 0 {
        return Err("Failed to open file descriptor: ${fd}")
    }
    return Ok(fd)
}

// Low-level system calls using architectural compiler intrinsics
//inside std.sys 
    pub fun write(fd: i32, buf: *u8, count: usize) -> isize {
        return unsafe { intrinsic_syscall3(1, fd as int64, buf as int64, count as int64) as isize }
    }

// 4. RESOURCE MANAGEMENT (`Drop` Interface)
pub inter Drop = {
    pub fun drop(var this)
}

impl Drop for FileStream {
    pub fun drop(var this) {
        unsafe { close(this.fd) }
    }
}




// 5. UNRECOVERABLE ERRORS & PANICS
// Panics immediately abort process execution (fast abort), outputting source line numbers and messages.
// No unwinding, exceptions, or `recover()` mechanisms.

pub fun process_array_element(items: List<i32>, index: i32) -> i32 {
    // Runtime assertions
    assert(index >= 0, "Index must be non-negative")
    
    if index >= items.len() {
        // Direct process abort
        panic("Index out of bounds: length ${items.len()}, got ${index}")
    }
    
    return items[index]
}

// Low-level system calls using architectural compiler intrinsics
namespace std.sys {
    pub fun write(fd: int32, buf: *u8, count: usize) -> isize {
        return unsafe { intrinsic_syscall3(1, fd as int64, buf as int64, count as int64) as isize }
    }
}

// ==========================================
// 9. EXPLICIT INTERFACES & COMPILE-TIME INTROSPECTION
// ==========================================

// literal type syntax for quick 1 time use like for json returns instead of declaring 1 time use type for each response type?
// at the top of file, this ensures co-existance of code
res := await net.fetch<r{name:string,age:i32}>("https://example.com/json") // return Result<r{name:string,age:i32}>

fun returnEarly(){
    res := await getData() or return 
    res := await getData2() or return 0
}

    var routes = [
        '1{ name: "TRM, Thika Road", lat: -1.2194756, lon: 36.8879763, volume: 80 },
        '1{ name: "Kasarani, Thika Road", lat: -1.22889, lon: 36.90444, volume: 100 },
        '1{ name: "Kasarani-Mwiki Road", lat: -1.225805, lon: 36.915674, volume: 120 },
    ]

    // maybe we need more helpers like Ref and Type, Type() only usable when declaration is in scope to avoid slow searches
    pub type TRoutes = Type(routes) // can be exported

    total_volume := (routes: Type(routes))=>{ 
        return routes.reduce(0,(r,cur)=>r+cur)
    }
    
    routes.push({name:'', lat : 0, lon: 0 })// missing keys get default values


// Allows reading from a collection via index (e.g., let x = list[0])
pub inter Index<Idx, Target> = {
    pub fun index(this, index: Idx) -> &Target
}

// Allows getting a mutable reference to a slot (used for assignment)
pub inter IndexMut<Idx, Target> = {
    pub fun index_mut(mut this, index: Idx) -> &mut Target
}

// Allows in-place addition assignment (+=)
pub inter AddAssign<RHS> = {
    pub fun add_assign(mut this, rhs: RHS)
}


pub inter SubAssign<RHS> = {
    pub fun sub_assign(mut this, rhs: RHS)
}

pub inter MulAssign<RHS> = {
    pub fun mul_assign(mut this, rhs: RHS)
}

pub inter DivAssign<RHS> = {
    pub fun div_assign(mut this, rhs: RHS)
}

pub inter RemAssign<RHS> = {
    pub fun rem_assign(mut this, rhs: RHS)
}

pub inter Add<RHS, Output> = {
    pub fun add(this, rhs: RHS) -> Output
}

pub inter Sub<RHS, Output> = {
    pub fun sub(this, rhs: RHS) -> Output
}

pub inter Mul<RHS, Output> = {
    pub fun mul(this, rhs: RHS) -> Output
}

pub inter Div<RHS, Output> = {
    pub fun div(this, rhs: RHS) -> Output
}


// Enables `==` and `!=`
pub inter PartialEq<T> = {
    pub fun eq(this, other: T) -> bool
}

// Enables `<`, `<=`, `>`, `>=`
pub inter PartialOrd<T> : PartialEq<T> = {
    pub fun partial_cmp(this, other: T) -> Option<Ordering>
}

// Maps and set need these
pub inter Hash<T> = {
    pub fun hash(this) -> string
}

pub inter Len = {
    pub fun len(this) -> usize
}

pub inter Iterator<Item> = {
    pub fun next(mut this) -> Option<Item>
}

pub inter Iterable<Item> = {
    pub fun iter(this) -> Iterator<Item>
}


user_scores["alice"] += 50
// Desugared execution:
(*user_scores.index_mut("alice")).add_assign(50)

var numbers = [1, 2, 3, 4]

// You write:
numbers[0] += 10

// Compiler desugars to:
(*numbers.index_mut(0)).add_assign(10)

// numbers is now [11, 2, 3, 4]



// records mayneed to not grow since then we can'  store them on stack? spread that growns should be annoted specially eg g{...base, newfield}?
let bytes = await std.fs.read_file(path)? // Automatically propagates Err up the call stack


