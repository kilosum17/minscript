package main

import "std.io"
import "std.log"
import "std.net.ws"

// 1. WEBSOCKET STANDARD LIBRARY MODEL (std.net.ws)
pub type WebSocketMessage = 
    | Text(string)
    | Binary(Vec<u8>) // Dynamic heap vector for streaming video/large payloads
    | Close

async fun run_ws_client() {
    log.println("--- Starting WebSocket Client ---")

    // Connect asynchronously to a remote WebSocket server
    let conn_res = await ws.connect("ws://127.0.0.1:8080/stream")
    
    let Result.Ok(client) = conn_res else {
        log.println("Client failed to connect to server")
        return
    }

    // Send a plain text message
    client.send_text("Hello MinScript Server!").or((err) =>{
        log.println("Failed to send text: ${err}")
    })

    // Send a dynamic binary frame (e.g., streaming video chunk)
    var video_frame = [0x00, 0xFF, 0xD8, 0xFF, 0xE0]
    client.send_binary(video_frame).or((err) =>{
        log.println("Failed to send binary frame: ${err}")
    })

    // Listen loop: `receive()` blocks/yields until 1 complete WS frame is reassembled
    while true {
        let msg_res = await client.receive()
        
        let Result.Ok(msg) = msg_res else {
            log.println("Server connection closed unexpectedly")
            break
        }

        // Pattern match against tag byte
        match msg {
            ws.WebSocketMessage.Text(text) => {
                log.println("Client received text: ${text}")
            },
            ws.WebSocketMessage.Binary(data) => {
                log.println("Client received binary packet: ${data.size()} bytes")
            },
            ws.WebSocketMessage.Close => {
                log.println("Server sent close frame")
                break
            }
        }
    }
}

// 3. WEBSOCKET SERVER EXAMPLE
async fun handle_client_connection(client: ws.ClientConnection) {
    log.println("New client session established!")

    while true {
        let msg_res = await client.receive()

        let Result.Ok(msg) = msg_res else {
            log.println("Client disconnected")
            break
        }

        match msg {
            ws.WebSocketMessage.Text(text) => {
                log.println("Server received: ${text}")
                
                // Echo text back to client
                client.send_text("Echo: ${text}").or(fun(err) {
                    log.println("Failed to echo text: ${err}")
                })
            },
            ws.WebSocketMessage.Binary(bytes) => {
                log.println("Server processing ${bytes.size()} byte stream...")

                // Respond with confirmation
                client.send_text("Received ${bytes.size()} binary bytes").or(fun(err) {
                    log.println("Failed to reply: ${err}")
                })
            },
            ws.WebSocketMessage.Close => {
                log.println("Client requested graceful shutdown")
                break
            }
        }
    }
}

async fun run_ws_server() {
    log.println("--- Starting WebSocket Server ---")

    let server_res = ws.listen("127.0.0.1", 8080)
    
    let Result.Ok(server) = server_res else {
        log.println("Failed to bind WebSocket server to port 8080")
        return
    }

    log.println("WebSocket Server listening on ws://127.0.0.1:8080")

    // Accept loop: Spawns independent async handlers per connection
    while true {
        let conn_res = await server.accept()
        
        let Result.Ok(client_conn) = conn_res else {
            log.println("Error accepting incoming socket connection")
            continue
        }

        // Spawn async task onto work-stealing thread pool
        handle_client_connection(client_conn).ignore()
    }
}

// 4. MAIN ENTRY POINT
async fun main() {
    // Launch server in background
    server_promise := run_ws_server()

    // Give server time to bind
    await runtime.yield()

    // Run client connection simulation
    await run_ws_client()
    await server_promise
}

