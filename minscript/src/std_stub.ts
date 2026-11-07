// A stand-in for the real standard library, used by the resolver until std is written in MinScript.
// It lists the prelude (spec §10.1, §10.2) and the std packages that exist, so that
// `import "std.io.println"` can be told apart from `import "std.io"`. Package members are not
// listed: `json.parse` is never reported by the resolver; the type checker will validate members.

/** Primitive types (spec §7.2). */
export const BUILTIN_TYPES: readonly string[] = [
    "bool", "char", "byte", "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "isize", "usize",
    "int", "f32", "f64", "void", "never", "string", "str",
]

/** Prelude types and interfaces (spec §10.1, §10.2, §9.10, §7.5). */
export const PRELUDE_TYPES: readonly string[] = [
    // core
    "Option", "Result", "Promise", "Resolver", "Ref", "Box", "Weak", "Vec", "Map", "Set", "Array", "Slice",
    "Panic", "PanicKind", "Ordering", "Timeout",
    // inter-task communication
    "Topic", "Queue", "Signal", "Sub", "Watcher", "TopicOptions", "QueueOptions", "PublishError",
    // core interfaces
    "Copy", "Clone", "Drop", "Default", "Stringer", "PartialEq", "PartialOrd", "Hash", "Handle",
    "Add", "Mul", "Div", "Rem", "AddAssign", "SubAssign", "MulAssign", "DivAssign", "RemAssign",
    "Index", "IndexMut", "Iterator", "AsyncIterator", "Iterable",
    // type-level forms
    "KeyOf", "ElementOf", "IndexOf", "Partial", "Omit", "Pick",
]

/** Prelude values: variants of prelude unions, functions, and the `log` package. */
export const PRELUDE_VALUES: Readonly<Record<string, "variant" | "fun" | "package">> = {
    Some: "variant", None: "variant", Ok: "variant", Err: "variant",
    Less: "variant", Equal: "variant", Greater: "variant",
    assert: "fun", panic: "fun",
    log: "package",
}

/** Known std packages (dotted paths). An import of `pkg.item` where `pkg` is listed binds an item. */
export const STD_PACKAGES: ReadonlySet<string> = new Set([
    "std", "std.io", "std.log", "std.fs", "std.json", "std.time", "std.runtime", "std.env", "std.math",
    "std.crypto", "std.collections", "std.net", "std.net.ws", "std.net.http", "std.process", "std.test",
])
