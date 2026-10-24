
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

// 1. Maps: In-place key mutation or insertion
var user_scores = m{ "alice": 100, "bob": 200 }

// `.update()` passes a mutable reference to the value if key exists
user_scores.update("alice", (score) => {
    score += 50
})

// `.upsert()` handles missing keys cleanly without double lookup
user_scores.upsert("charlie", 150, (existing) => {
    existing += 10
})


// 2. Records: Structural merging & patching
let base_opts = r{ host: "localhost", port: 8080, debug: false }

// Record spread / patch operator `r{ ...original, updates }`
let dev_opts = r{ ...base_opts, port: 3000, debug: true }

// In-place record update for mutable (`var`) records
var session = r{ id: "s1", active: true }
session.patch(r{ active: false })


// Recursive types MUST use Box<T> to give the type a known pointer size
pub type Node<T> = {
    pub value: T,
    pub next: Box<Node<T>>?, // Optional recursive boxed pointer
}

async fun main() {
    // Explicit heap allocation
    let boxed_val = Box(100) 
    
    // Moves heap ownership cleanly
    let new_owner = boxed_val 
}


// ==========================================
// ERROR PROPAGATION & HEAP MANAGEMENT
// ==========================================

// 1. Error Propagation (`?`)
pub async fun load_user_profile(path: string) -> Result<User, string> {
    let file_bytes = (await std.fs.read_file(path))? // Unwraps Ok or early-returns Err
    let user_data = (await std.json.parse<User>(file_bytes))?
    return Result.Ok(user_data)
}

// 2. Recursive Types & Heap Allocation (`Box<T>`)
pub type BinaryNode<T> = {
    pub value: T,
    pub left: Box<BinaryNode<T>>?,  // Boxed pointer for recursive types
    pub right: Box<BinaryNode<T>>?,
}

// 3. Map & Record In-Place Mutations
async fun Demonstration() {
    var scores = m{ "alice": 100 }
    
    // Upsert: Key, Default, Mutator
    scores.upsert("bob", 50, (val) => { val += 10 })

    // Record Merging / Patching
    let base_config = r{ host: "127.0.0.1", port: 8080 }
    let override_config = r{ ...base_config, port: 9090 } // r{ host: "127.0.0.1", port: 9090 }
}
