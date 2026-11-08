package ws

// WebSockets (RFC 6455): a server and a client. A connection splits into a Reader and a Writer, so one
// task can wait for frames while others send (see test/programs/websocket.ms).

pub type Error = {
    pub message: string

    pub fun to_str(&this) -> string { this.message }
}

pub union Message = {
    Text(string)
    Binary(Vec[u8])
    Close
}

pub type Server = {
    /// Waits for the next client.
    pub async fun accept(&mut this) -> Result[Connection, Error] { _builtin() }
    /// Stops accepting clients.
    pub fun close(&this) { _builtin() }
    /// The port it listens on (useful after `listen(host, 0)`, which picks a free one).
    pub fun port(&this) -> u16 { _builtin() }
}

pub type Connection = {
    /// The two halves of the connection (consumes it).
    pub fun split(this) -> t(Reader, Writer) { _builtin() }
}

pub type Reader = {
    /// Waits for the next message. Cancel-safe: a `select` that loses doesn't drop a frame.
    pub async fun receive(&mut this) -> Result[Message, Error] { _builtin() }
}

/// The sending half. It is a handle: copies share the connection (spec §9.1).
pub type Writer: Handle = {
    pub async fun send(&this, msg: Message) -> Result[void, Error] { _builtin() }
}

/// Listens for WebSocket connections on `host:port` (resolves once the port is bound).
pub async fun listen(host: &str, port: u16) -> Result[Server, Error] { _builtin() }

/// Connects to a WebSocket server (`ws://host:port/path`).
pub async fun connect(url: &str) -> Result[Connection, Error] { _builtin() }
