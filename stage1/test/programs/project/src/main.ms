package main

// `ms run test/programs/project`, then `curl localhost:8080/health`.
// (mod.ms lists a registry package "http"; registry dependencies aren't fetched yet, so this uses
// std's HTTP package.)
import "std.net.http"

async fun main() {
    var server = await http.listen("0.0.0.0", 8080) or {
        log.error("could not bind port 8080")
        return
    }
    log.println("listening on :8080")

    for {
        let req = await server.accept() or continue
        handle(req).ignore()
    }
}

async fun handle(req: http.Request) {
    let res = recover {                       // a panic in one request doesn't take down the server
        route(req)
    }
    let reply = res ?? http.Response { status: 500, body: "500 internal error" }
    await req.respond_with(reply) or e => log.warn("respond failed: ${e}")
}

fun route(req: &http.Request) -> http.Response {
    match req.path {
        "/" => http.Response { body: "hello from MinScript" }
        "/health" => http.Response { body: "ok" }
        "/crash" => panic("boom")             // shows the recover above: answers 500
        _ => http.Response { status: 404, body: "404 not found" }
    }
}
