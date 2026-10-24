package main

import "std.io"

// Formal nominal type for regular usage
pub type ServerConfig = {
    host: string,
    port: u32,
}

pub fun start_server(cfg: ServerConfig) {
    println("Server running on ${cfg.host}:${cfg.port}")
}

async fun main() {
    // 1. Context-inferred nominal struct (No `r{}` needed)
    start_server({ host: "127.0.0.1", port: 8080 as u32 })

    // 2. Pure one-off anonymous record (`r{}`) with field-level type overrides using `as`
    let request_payload = r{
        endpoint: "/api/submit",
        timeout_ms: 500 as u16,        // Overriding default int32 literal to u16
        retry_count: 3 as u8,          // Overriding default int32 literal to u8
        weight: 1.5 as f32,            // Overriding default f64 literal to f32
    }

    println("Request to ${request_payload.endpoint} with timeout ${request_payload.timeout_ms}ms")
}
