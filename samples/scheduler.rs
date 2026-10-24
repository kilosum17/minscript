import "std.runtime"

async fun heavy_computation() {
    let mut i = 0
    while i < 1_000_000 {
        // Do heavy work...
        i += 1

        // Voluntarily yield every 10,000 iterations to keep the event loop responsive
        if i % 10_000 == 0 {
            await runtime.yield()
        }
    }
}
