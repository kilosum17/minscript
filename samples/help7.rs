User.new never sets login_count, and the “missing keys get default values” rule has no Default mechanism behind it.


Closures. Non-capturing closures make filter((n) => n > threshold) impossible, which is the most common closure use. You can fix this without lifetimes. Allow non-escaping closures (passed as arguments, called during the call) to borrow their environment, and require explicit move/capture lists ([host, port](x) => ...) for closures that are stored or returned.

Parameter passing rules (move, copy, or implicit borrow)
Slices/views (&[T], string slices) so you don’t copy on every substring

Whether iterators borrow the collection, and what happens if you mutate it mid-loop

Error handling. Still a TODO, and it’s central. You need ? semantics, error type conversion (From), error context/wrapping, and a decision on whether Err is a plain type or an interface.

Cycle handling (Weak<T>) for Ref

Panic = abort. Fine for CLIs, but a server running thousands of tasks dies on one bad index. Consider task-level isolation or at least a documented stance.



