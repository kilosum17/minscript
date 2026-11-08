package runtime

/// Lets other tasks run (spec §9.6).
pub async fun yield() { _builtin() }
