// Chat hub: every client that connects joins a shared room (a Topic), and each message it
// sends is broadcast to all other clients. A Signal tracks how many are online.
// Extends docs/history/samples/ws.rs; uses spec §4.9 (select), §11.3 (Topic / Signal),
// §7.7 (variants inferred from the expected type). v0.4: handles no longer "clone implicitly";
// Topic / Signal are std types over `shared` cells (spec §11.3), and sockets, `Sub`, `Watcher`
// and `Resolver` are `Unique` (§9.2).
//
// `LIMITATION` marks what is still missing.
//
// Assumed std.net.ws API:
//   pub union Message { Text(str)  Binary(Vec[u8])  Close }
//   ws.listen(host: str, port: u16) async -> Result[Server, ws.Error]   // resolves once bound
//   ws.connect(url: str) async -> Result[Connection, ws.Error]
//   Server.accept(*this) async -> Result[Connection, ws.Error]
//   Connection.split(this) -> t(Reader, Writer)    // #[effects(consumes: [this])] (spec §9.2, §9.5)
//   Reader.receive(*this) async -> Result[Message, ws.Error]          // cancel-safe (std.net rule)
//   Writer.send(this, msg: Message) async -> Result[void, ws.Error]
//
// LIMITATION: `split()` into owned halves is still needed. v0.4's disjoint-path concurrency (§11.2)
// splits fields, but a socket is an extern value, which is one opaque path (§9.5 conservative cases).
package main

import "std.net.ws"
import "std.time"

type ClientId = u64

type Chat = r{ from: ClientId, msg: ws.Message }

async fn handle_client(conn: ws.Connection, room: Topic[Chat], online: Signal[int], id: ClientId) {
    let t(var reader, writer) = conn.split()
    var sub = room.subscribe()                       // unsubscribed automatically when dropped
    // `subscribe(this)` and `publish(this)` write the Topic's shared state through a read-only
    // receiver, which `shared` fields allow (spec §10.1).

    online.update(#{ n => n += 1 })                  // `n` is `*int`: `(*T) -> R` (spec §9.4)

    // `Text` resolves through the expected type: the `msg` field is a ws.Message (spec §7.7)
    room.publish(r{ from: id, msg: Text("client ${id} joined") })

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
    room.publish(r{ from: id, msg: Text("client ${id} left") })
}

async fn report(online: Signal[int]) {
    var watch = online.watch()
    for await n in watch {                           // only the latest count; rapid changes coalesce
        log.println("${n} online")
    }
}

async fn run_hub(port: u16, ready: Resolver[Result[void, str]]) {
    room := Topic.with.[Chat](_{ buffer: 256 })
    online := Signal(0)

    // Passing a Topic or Signal copies the value, and the copy aliases the same shared state.
    // Copies alias `shared` fields (spec §10.1).
    report(online).ignore()

    var server = await ws.listen("127.0.0.1", port) or e => {
        ready.resolve(Err("failed to bind port ${port}: ${e}"))
        return
    }
    ready.resolve(Ok())
    log.println("hub listening on ws://127.0.0.1:${port}")

    next_id :== 1 as ClientId
    for {
        conn := await server.accept() or continue
        handle_client(conn, room, online, next_id).ignore()
        next_id += 1
    }
}

async fn run_bot(name: str, port: u16) {
    conn := await ws.connect("ws://127.0.0.1:${port}") or {
        log.error("${name}: could not connect")
        return
    }
    let t(var reader, writer) = conn.split()

    await writer.send(Text("hi from ${name}")) or e => log.warn("${name}: send failed: ${e}")

    var received = 0
    for received < 3 {
        let msg = await reader.receive() or break
        if let Text(text) = msg {
            log.println("${name} got: ${text}")
            received += 1
        }
    }

    await writer.send(Close) or return
}

async fn main() {
    port := 8080 as u16

    let t(ready, resolver) = Promise.new.[Result[void, str]]()
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
