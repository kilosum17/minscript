package main

import "http"

async fun main() {
    let server = http.listen("0.0.0.0", 8080) or {
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
    let body = res ?? "500 internal error"
    await req.respond(body) or e => log.warn("respond failed: ${e}")
}

fun route(req: http.Request) -> string {
    match req.path {
        "/" => "hello from MinScript"
        "/health" => "ok"
        _ => "404 not found"
    }
}
