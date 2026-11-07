// Port of docs/history/samples/ws.rs to v0.2 syntax.
//
// Provided by std.net.ws:
//   pub union Message = {
//       Text(string)
//       Binary(Vec[u8])
//       Close
//   }
package main

import "std.net.ws"
import "std.runtime"

async fun run_ws_client() {
    log.println("--- Starting WebSocket Client ---")

    var client = await ws.connect("ws://127.0.0.1:8080/stream") or {
        log.println("Client failed to connect to server")
        return
    }

    if let Err(err) = await client.send_text("Hello MinScript Server!") {
        log.println("Failed to send text: ${err}")
    }

    let video_frame: Vec[u8] = [0x00, 0xFF, 0xD8, 0xFF, 0xE0]
    await client.send_binary(video_frame) or e => log.println("Failed to send binary frame: ${e}")

    // receive() yields until one complete frame has been reassembled
    for {
        let msg = await client.receive() or {
            log.println("Server connection closed unexpectedly")
            break
        }

        match msg {                                    // variants resolved through the scrutinee's type
            Text(text) => log.println("Client received text: ${text}")
            Binary(data) => log.println("Client received binary packet: ${data.len()} bytes")
            Close => {
                log.println("Server sent close frame")
                break
            }
        }
    }
}

async fun handle_client(mut client: ws.ClientConnection) {
    log.println("New client session established!")

    for {
        let msg = await client.receive() or {
            log.println("Client disconnected")
            break
        }

        match msg {
            ws.Message.Text(text) => {
                log.println("Server received: ${text}")
                await client.send_text("Echo: ${text}") or e => log.println("Failed to echo text: ${e}")
            }
            ws.Message.Binary(bytes) => {
                log.println("Server processing ${bytes.len()} byte stream...")
                await client.send_text("Received ${bytes.len()} binary bytes")
                    or e => log.println("Failed to reply: ${e}")
            }
            ws.Message.Close => {
                log.println("Client requested graceful shutdown")
                break
            }
        }
    }
}

async fun run_ws_server() {
    log.println("--- Starting WebSocket Server ---")

    var server = ws.listen("127.0.0.1", 8080) or {
        log.println("Failed to bind WebSocket server to port 8080")
        return
    }

    log.println("WebSocket Server listening on ws://127.0.0.1:8080")

    for {
        let conn = await server.accept() or {
            log.println("Error accepting incoming socket connection")
            continue
        }

        // owned argument, so the task may outlive this iteration
        handle_client(conn).ignore()
    }
}

async fun main() {
    server := run_ws_server()          // scheduled immediately, runs in the background

    await runtime.yield()              // give the server time to bind

    await run_ws_client()
    await server
}
