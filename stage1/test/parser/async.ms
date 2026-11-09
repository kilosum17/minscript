package parser_async

import "std.runtime"
import "std.time"

async fun fetch_record(id: i32) -> string {
    let raw = await database_query(id)
    raw.to_upper()
}

async fun process_all(ids: Vec[i32]) -> Vec[string] {
    let promises = ids.map(#{ fetch_record(it) })     // each call schedules a task immediately
    await Promise.all(promises)
}

async fun main() {
    let p1 = fetch_record(42)                         // Promise[string], already scheduled
    let p2 = fetch_record(99)
    let r1 = await p1
    let r2 = await p2

    fetch_record(7)
        .then(#{ log.println("got ${it}") })
        .catch(#{ log.println("failed: ${it.message}") })

    fetch_record(8).ignore()                          // fire and forget

    var counter = 0
    for counter < 50_000 {
        counter += 1
        if counter % 10_000 == 0 {
            await runtime.yield()
        }
    }

    await time.sleep(10)
    let name = (await fetch_name()).trim()
    let user = await get_user()?
    let len = await get_list()?.len()
    let all = await Promise.all([fetch_record(1), fetch_record(2)])
}

fun not_async_main() {
    // `main`-like code in a non-async function uses .then / .ignore
    fetch_record(1).then(#{ log.println(it) })
}
