package ws

// WebSockets (RFC 6455): a server and a client. A connection splits into a Reader and a Writer, so one
// task can wait for frames while others send.

pub type Error {
    pub message: str

    pub fn to_str(this) -> str { this.message }
}

pub union Message {
    Text(str)
    Binary(Vec[u8])
    Close
}

pub type Server {
    /// Waits for the next client.
    pub async fn accept(*this) -> Result[Connection, Error] { _builtin() }
    /// Stops accepting clients.
    pub fn close(this) { _builtin() }
    /// The port it listens on (useful after `listen(host, 0)`, which picks a free one).
    pub fn port(this) -> u16 { _builtin() }
}

/// An open connection: one owner, split once into its two halves.
pub type Connection: Unique {
    /// The two halves of the connection (consumes it).
    #[effects(consumes: [this])]
    pub fn split(this) -> t(Reader, Writer) { _builtin() }
}

pub type Reader {
    /// Waits for the next message. Cancel-safe: a `select` that loses doesn't drop a frame.
    pub async fn receive(*this) -> Result[Message, Error] { _builtin() }
}

/// The sending half. Copies share the connection.
pub type Writer {
    pub async fn send(this, msg: Message) -> Result[void, Error] { _builtin() }
}

/// Listens for WebSocket connections on `host:port` (resolves once the port is bound).
pub async fn listen(host: str, port: u16) -> Result[Server, Error] { _builtin() }

/// Connects to a WebSocket server (`ws://host:port/path`).
pub async fn connect(url: str) -> Result[Connection, Error] { _builtin() }
