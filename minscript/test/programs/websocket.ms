// Chat hub: every client that connects joins a shared room (a Topic), and each message it
// sends is broadcast to all other clients. A Signal tracks how many are online.
// Extends docs/history/samples/ws.rs; uses spec §4.9 (select) and §9.10 (Topic / Signal).
//
// `LIMITATION(n)` comments mark what's still missing in v0.2. This file must still parse cleanly.
//
// Assumed std.net.ws API:
//   pub union Message = { Text(string)  Binary(Vec[u8])  Close }          // Clone (auto-derived)
//   ws.listen(host: string, port: u16) -> Result[Server, ws.Error]
//   ws.connect(url: string) async -> Result[Connection, ws.Error]
//   Server.accept(&mut this) async -> Result[Connection, ws.Error]
//   Connection.split(this) -> t(Reader, Writer)                           // consumes the connection
//   Reader.receive(&mut this) async -> Result[Message, ws.Error]          // cancel-safe (std.net rule)
//   Writer.send(&this, msg: Message) async -> Result[void, ws.Error]
//
// LIMITATION(1): `split()` into owned halves is a std design choice. The language has no
// "split borrow", so reading and writing the same connection concurrently needs separate owned handles.
package main

import "std.net.ws"
import "std.time"

type ClientId = u64

type Chat = r{ from: ClientId, msg: ws.Message }

async fun handle_client(conn: ws.Connection, room: Topic[Chat], online: Signal[int], id: ClientId) {
    let t(mut reader, writer) = conn.split()
    var sub = room.subscribe()                       // unsubscribed automatically when dropped

    online.update(#{ n => n += 1 })

    // LIMITATION(2): outside a pattern, variants must be qualified (`ws.Message.Text`). They could
    // resolve through the expected type (`msg: ws.Message`), as patterns do (spec §18 #11).
    room.publish(r{ from: id, msg: ws.Message.Text("client ${id} joined") })

    // One task per client: wait for whichever comes first, a frame from the socket or an event
    // from the room. If both are ready, select picks one at random, so neither side starves.
    for {
        select {
            frame = reader.receive() => {
                let Ok(msg) = frame else { break }       // socket error → leave
                match msg {
                    Close => break
                    _ => room.publish(r{ from: id, msg })
                }
            }
            Some(ev) = sub.next() => {
                if ev.from != id {
                    await writer.send(ev.msg) or break   // a slow client only slows itself down
                }
            }
        }

        lost := sub.missed()
        if lost > 0 {
            log.warn("client ${id} is too slow, missed ${lost} messages")
        }
    }

    online.update(#{ n => n -= 1 })
    room.publish(r{ from: id, msg: ws.Message.Text("client ${id} left") })
}

async fun report(online: Signal[int]) {
    var watch = online.watch()
    for await n in watch {                           // only the latest count; rapid changes coalesce
        log.println("${n} online")
    }
}

async fun run_hub(port: u16, ready: Resolver[Result[void, string]]) {
    let room = Topic.with.[Chat](_{ buffer: 256 })
    online := Signal(0)

    // LIMITATION(3): passing a handle (Topic, Signal) to an owned parameter MOVES it, hence `.clone()`
    // at every call. Handle types could be cloned implicitly, like Copy (spec §18 #8).
    report(online.clone()).ignore()

    var server = ws.listen("127.0.0.1", port) or e => {
        ready.resolve(Err("failed to bind port ${port}: ${e}"))
        return
    }
    ready.resolve(Ok())
    log.println("hub listening on ws://127.0.0.1:${port}")

    next_id :== 1 as ClientId
    for {
        conn := await server.accept() or continue
        handle_client(conn, room.clone(), online.clone(), next_id).ignore()
        next_id += 1
    }
}

async fun run_bot(name: string, port: u16) {
    conn := await ws.connect("ws://127.0.0.1:${port}") or {
        log.error("${name}: could not connect")
        return
    }
    let t(mut reader, writer) = conn.split()

    await writer.send(ws.Message.Text("hi from ${name}")) or e => log.warn("${name}: send failed: ${e}")

    var received = 0
    for received < 3 {
        let msg = await reader.receive() or break
        if let Text(text) = msg {
            log.println("${name} got: ${text}")
            received += 1
        }
    }

    await writer.send(ws.Message.Close) or return
}

async fun main() {
    port := 8080 as u16

    let t(ready, resolver) = Promise.new.[Result[void, string]]()
    hub := run_hub(port, resolver)                   // keep the handle so we can cancel it

    await ready or e => {                            // no more guessing with sleep()
        log.error("hub failed to start: ${e}")
        return
    }

    let bots = [run_bot("alice", port), run_bot("bob", port), run_bot("carol", port)]

    select {
        _ = Promise.all(bots) => log.println("all bots finished")
        time.after(10_000) => log.warn("bots timed out")
    }

    hub.cancel()                                     // stops at its next await (the accept loop)
}
