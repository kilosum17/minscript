// std.net.ws on the JS back end: a server that echoes text in upper case, and one client.
package main

import "std.net.ws"

async fn echo(conn: ws.Connection) {
    let t(var reader, writer) = conn.split()
    for {
        let msg = await reader.receive() or break
        match msg {
            Text(s) => await writer.send(Text(s.to_upper())) or break
            Binary(b) => await writer.send(Binary(b)) or break
            Close => break
        }
    }
}

async fn main() {
    var server = await ws.listen("127.0.0.1", 0) or e => {
        log.error("listen failed: ${e}")
        return
    }
    port := server.port()

    let conn = await ws.connect("ws://127.0.0.1:${port}/") or e => {
        log.error("connect failed: ${e}")
        return
    }
    let client = await server.accept() or return
    echo(client).ignore()

    let t(var reader, writer) = conn.split()
    for word in ["hello", "minscript", "bye"] {
        await writer.send(Text(word)) or return
        let reply = await reader.receive() or return
        if let Text(s) = reply { log.println("echo: ${s}") }
    }
    let bytes: Vec[u8] = [1, 2, 3]
    await writer.send(Binary(bytes)) or return
    if let Ok(Binary(b)) = await reader.receive() { log.println("binary: ${b.len()} bytes") }

    await writer.send(Close) or return
    server.close()
    log.println("done")
}
