// std.net.http's tests: a server on a free port, called by the client.
package http

import "std.testing.*"

type Point = { x: int, y: int }

/// Answers `n` requests, then stops.
async fun serve(server: Server, n: int) {
    var s = server
    var left = n
    for left > 0 {
        let req = await s.accept() or return
        left -= 1
        let res = match req.path {
            "/hello" => Response { body: "hello ${req.query.get("name") ?? "nobody"}" }
            "/echo" => {
                let p = req.json.[Point]() or e => {
                    await req.respond_with(Response { status: 400, body: e.message }) or return
                    continue
                }
                json_response(200, Point { x: p.y, y: p.x })
            }
            "/agent" => Response { body: req.header("User-Agent") ?? "none" }
            _ => Response { status: 404, body: "no ${req.method} ${req.path}" }
        }
        await req.respond_with(res) or return
    }
    s.close()
}

async fun test_server_and_client() {
    var server = assert_ok(await listen("127.0.0.1", 0))
    port := server.port()
    let base = "http://127.0.0.1:${port}"
    let serving = serve(server, 5)

    let hello = assert_ok(await get("${base}/hello?name=ann"))
    assert_eq(hello.status, 200)
    assert_eq(hello.body, "hello ann")
    assert_eq(hello.header("Content-Type") ?? "", "text/plain; charset=utf-8")

    let echo = assert_ok(await post("${base}/echo", "{\"x\": 1, \"y\": 2}"))
    assert_true(echo.ok(), "echo succeeds")
    assert_eq(echo.header("content-type") ?? "", "application/json")
    let swapped = assert_ok(echo.json.[Point]())
    assert_eq(swapped.x, 2)
    assert_eq(swapped.y, 1)

    let bad = assert_ok(await post("${base}/echo", "{\"x\": 1}"))
    assert_eq(bad.status, 400)
    assert_eq(bad.body, "missing field at `y`")

    var headers = m{} as Map[string, string]
    headers["user-agent"] = "minscript-test"
    let agent = assert_ok(await send(Outgoing { url: "${base}/agent", headers }))
    assert_eq(agent.body, "minscript-test")

    let missing = assert_ok(await get("${base}/nope"))
    assert_eq(missing.status, 404)
    assert_true(!missing.ok(), "404 isn't ok")
    assert_eq(missing.body, "no GET /nope")

    await serving
}

async fun test_connection_refused_is_an_err() {
    var server = assert_ok(await listen("127.0.0.1", 0))
    port := server.port()
    server.close()
    let e = assert_err(await get("http://127.0.0.1:${port}/"))
    assert_true(e.message.len() > 0, "the error says why")
}
