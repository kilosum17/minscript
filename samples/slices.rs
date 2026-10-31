// ============================================================================
// MINSCRIPT SLICE & MEMORY LAYOUT ARCHITECTURE: REFERENCE CHEATSHEET
// ============================================================================
// 
// DESIGN GOALS:
// 1. Zero Runtime Overhead: Slices and coercion are entirely compile-time illusions.
// 2. Zero Code Duplication: Shared read-only methods live on Slice<T>, 
//    while allocation/mutation methods live on owned types (String, List<T>).
// 3. Built-in Only Coercion: Hardcoded layout compatibility for lightning-fast 
//    typechecking without complex trait-resolution engines.
// ============================================================================

// ----------------------------------------------------------------------------
// 1. MEMORY LAYOUT & CORE DEFINITIONS
// ----------------------------------------------------------------------------

// A generic contiguous slice view (&T slice). 
// Consists strictly of a raw pointer and a length (no extra start/end fields).
// Slicing shifts the pointer and reduces length: ptr = ptr + start, len = end - start.
struct Slice<T> {
    ptr: *T,
    len: usize,
}

// Owned String type managing a heap buffer, length, and capacity.
// Layout prefix matches `Slice<u8>` (ptr + len at offset 0 and 8).
struct String {
    ptr: *u8,
    len: usize,
    cap: usize,
}

// Owned List type managing a heap-allocated generic buffer.
// Layout prefix matches `Slice<T>` (ptr + len).
struct List<T> {
    ptr: *T,
    len: usize,
    cap: usize,
}


// ----------------------------------------------------------------------------
// 2. METHODS ON OWNED TYPES (Mutation, Allocation, Resizing)
// ----------------------------------------------------------------------------
// These methods require explicit ownership / mutability (`mut self`) because 
// they alter buffer size, capacity, or mutate heap memory.

impl String {
    // Appends a slice to an owned string, reallocating the heap buffer if necessary.
    inline fun push_str(mut self, other: &str) {
        // [BEHIND THE SCENES]: Check capacity, grow buffer if needed, copy bytes.
    }

    // Resets length to 0 without freeing the underlying heap allocation.
    inline fun clear(mut self) {
        self.len = 0
    }
}

impl<T> List<T> {
    // Appends an item to the end of the list, growing capacity if needed.
    inline fun push(mut self, item: T) {
        if self.len >= self.cap {
            self.grow()
        }
        // [BEHIND THE SCENES]: Write item at self.ptr + self.len, increment len.
    }

    // Removes and returns the last element.
    inline fun pop(mut self): Option<T> {
        if self.len == 0 { return none }
        self.len -= 1
        return some(self.ptr[self.len])
    }
}


// ----------------------------------------------------------------------------
// 3. METHODS ON SLICES (Shared, Read-Only, Zero-Copy Views)
// ----------------------------------------------------------------------------
// Implemented once on `Slice<u8>` (&str) and `Slice<T>` (&[T]). 
// Because owned types coerce to slices automatically, both owned and borrowed 
// instances share these methods seamlessly without code duplication.

impl Slice<u8> { // Equivalent to &str
    inline fun len(self): usize {
        return self.len
    }

    inline fun is_empty(self): bool {
        return self.len == 0
    }

    // Zero-copy view creation. Returns a new stack slice pointing into 
    // the existing memory buffer with zero heap allocation.
    inline fun substring(self, start: usize, end: usize): &str {
        if end > self.len {
            panic("Index out of bounds")
        }
        return Slice<u8> {
            ptr: self.ptr + start,
            len: end - start,
        }
    }

    // Python/Go style: returns original slice view if suffix does not match.
    inline fun remove_suffix(self, suffix: &str): &str {
        if self.ends_with(suffix) {
            return Slice<u8> {
                ptr: self.ptr,
                len: self.len - suffix.len,
            }
        }
        return self // Return original slice view unchanged if not found
    }
}

impl<T> Slice<T> { // Equivalent to &[T]
    inline fun len(self): usize {
        return self.len
    }

    // Create a sub-slice view of a list or array range
    inline fun slice(self, start: usize, end: usize): &Slice<T> {
        if end > self.len {
            panic("Slice index out of bounds")
        }
        return Slice<T> {
            ptr: self.ptr + start,
            len: end - start,
        }
    }
}


// ----------------------------------------------------------------------------
// 4. COMPILER COERCION & C EMITTER LOWERING
// ----------------------------------------------------------------------------
// 
// TYPECHECKER RULE (TypeScript Frontend):
//   - If expected type is `Slice<T>` and actual type is `String` or `List<T>`,
//     the typechecker automatically injects an implicit view cast because 
//     their memory layouts are identical at offsets 0 (ptr) and 8 (len).
//   - Skips slow trait-resolution engines entirely for max compiler speed.
//
// C EMITTER OUTPUT (Zero-Cost Native Code):
//   - Passing an owned `String` to a function expecting `&str` compiles down 
//     to a direct pointer cast passing the first two fields, with zero runtime cost:
//
//     // Generated C:
//     typedef struct { uint8_t* ptr; size_t len; size_t cap; } MinString;
//     typedef struct { uint8_t* ptr; size_t len; } MinStrSlice;
//
//     void print_slice(MinStrSlice s) { ... }
//
//     int main() {
//         MinString msg = create_string("Hello");
//         print_slice(*(MinStrSlice*)&msg); // Coercion emitted as direct view cast
//     }
// ============================================================================
