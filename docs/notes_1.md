
## struct 
- declared using the type keyword
    ```rust 
    pub type User ={
       name :string    
       age  :int    // int is i32/i64 base on system
    }```
- methods:
    ```rust
    imp User{
        pub fun get_age()->int{

        }      
    }```
- 

## Methods/Functions
- Methods and functions use mut for mutable params, not var
  `pub fun add_counter(mut this){this.count+=1}`
- mut this methods can't be called with immutable bindings ie let
- functions arg types
    - n:T = moved/copied for stack variable
    - n:&T = immutable borrow
    - n:&mut T = mutable borrow
- compiler restricted borrows so eg u can't return them etc, they are scoped to the call, thus no lifetimes
- n:T are moved eg for structs but cheap copies for things like stack variables i32
- the call site, or closure, don't specify the type, LSP will provide hints to the ide, on how to display them, configurable to users, eg the closures justs says:
    ` takes_closure(12,#{n => n += 10 })`// if take closure supplied n as &mut T then its updated in place 

## global scope
- all exprionsion and statements live in functions/methods
- only allows:
    package dec ``
    imports `import std.log`
    immutables `let PI = 3.1456` // allows inference
    Ref<T> `let connections = Ref(m{"admin":0,"users":0})`//Arc<Mutex> // we need a better name, above is Ref<Map<string,int>>

## Closures
- closures can capture-scoped variable and globals but in readonly mode, eg
    `nums.filter(#{ it < local_no })`
- compiler only allows this for scope bounded closures,eg those not escaping eg through returns etc
- TODO: are there cases where they need to capture mutable
- non escaping closures capture the environment
- escaping or assigned closures have explicit move/capture list
    ```rust
    local_no = 20
    let adder = [local_val](a:i32)=>local_val + a 
    // local val is moved/copied to adder 
    // calling or returning adder_uses its copy
    ```        

## borrow checker rules:
- No mutliple mutable borrows at the same time
- Many immutable borrows are allowed
- No immutable borrows while mutable borrow exist// eg using immutable borrow once mutable borrows to same data exists
-  

## Async concurrency&parrarellism
- minscipt will work on a work stilling threads
- uses set-number of threads all threads on the computer
- use `await runtime.yield()` to hand control to sheduler
- No special syntax to call async method, eg no colloring
- just call as normal functions, they return values wrapped as promises,
- Use Promise.all([]) which waits for all returning vec
- Promise methods:
    - all(promises:Vec<Promise<T>>)
    - then()
    - ignore
- MS aims to avoid the interfaces like Send/Sync etc and enforce thread safety using its borrow-checker rules
- the main itself is asycn in ms and any funciton can call an async call

## interfaces
- Implicit implementation NOT go-style interfaces
    `impl Add for MyInt{...}` 
    `impl Add,Sub for MyInt{...}` 
- Supports generics



## inbuilt type 
- int, i32, i64, i16 i8, u32, u64, u16, u8, isize, usize  // int is platform depended
- f32, f64


## auto casting
- calculations auto promote to larger values using c like rules,
- demotions need manual casting eg .to_int() etc
- 

## packages
- a folder is a package and all files inside it must use the same name
- `import pub "./log"` // if inside package std then std.log is public and can be accessed from std usig `import std.log`
- allow as `import "std.log" as log2`
- we use a json stucture inspired by nodejs. eg ms.json at the root with sections for name,version, and dependencies, scripts etc
- we will target an HIR and compiler that to js/wasm/native/tiny-c/llvm
- everything is private by default use pub to expose them

## tooling
- TODO: linter/tester/LSP/doc-comments/debugger
- 

## STD
- ### string  
    - immutable string type 
    - TODO: concept of a sting slice // to avoid copies on each operation
    `let name = "Ted"`

- ### vec
    - growable list of values
    `let nums = [1, 3, 5, 7]`

- ### array
    - fixed size list of values
    `let scores = a[40,50,60,60]` Array<i32>

- ### tuple
    - hetorogenious list of values
    `let vals = t("Ted", 32, 2.23)`

- ### map
    - key-value store, not dy
    - `ages := m{"bob":32, "alice":12} `
    - methods:
        - get(key:K)->Option<V>
        
- ### anon records
    - fully typed on demade struct
    ```rust 
    conf :=  r{  // does := use let/var?
        bob:    `1{age:20, hobby:"driving"},
        alice:  `1{age:22, hobby:"swimming"},
    } // Vec<{age:i32, hobby:string}>
    pub type Config = Type(conf)
    conf.push({age:32, hobby:"biking"})
    pub printConfig(c: Config){log.println(c)}
    ```
    - supports spread operations and parsing to functions with inffered type
    - 


- ### std.log 
    - log.println(...t: any[])  
    - 

- ### std.runtime
    - methods
        yield():Promise<T>, return control to scheduler

- ### std.json 
    - types can be inline 
    `user = std.json.parse<r{user:string,age:i32}>(user_str).or(User.new({})) `
    - uses compiler intrinsice `._get_info()` to serialize data instead of tags
    - `.get_info()` runs on both types and values

- ### Ref<T>
    - It is Arc<Mutex> so atomic-ref-counted and has a mutex, so both thread safe and memory-safe
    - This uses RwLock so many readr but 1 writer lock

    -methods:
        -clone():T
        -weak();T // Weak<T> week ref to break cycles?
        .get():T
        .update(cbk:(v:&mut T)->void)


- ### Box<T>
    - It is an heap allocation for cyclic object
    - methods:
        get():T

## Keywords
- ### or
    - ## Error Propagation
        - when used as a keywork eg 'or' NOT '.or()' 
            `bytes := await read_file() or Err("Reading failed") `
        - or returns the value to caller

    - ## Default method on STD prelude Result/Option
        - Provides the Err as it, it is void in option 
        - Any struct can define it normally
            `user := get_id_with_option().or("")`
            `user := get_id_with_error().or("")`
        

- ### '?' 
    - used to propagate errors if the returns already matches 
    - these two are similar:
        `user := get_id_with_error() or it`
        `user := get_id_with_error()?`

    - can also be used for optional chaining of Result/Option
        `user_name := (get_user_by_id("123")?.name).or("")`

