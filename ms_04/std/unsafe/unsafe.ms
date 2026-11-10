package unsafe

// Raw pointers, usable only inside `unsafe { }` (spec §8.6). The JS back end has no raw memory:
// every operation panics there.

pub type Ptr[T] {
    pub fn is_null(this) -> bool { _builtin() }
}
