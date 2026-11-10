package http

// HTTP/1.1: a server and a client (spec §14.4). Bodies are text; `json.[T]()` decodes a body with
// the same rules as `json.parse`.

import "std.json"

pub type Error {
    pub message: str

    pub fn to_str(this) -> str { this.message }
}

/// A request the server received. Header names are lowercase.
pub type Request {
    pub method: str
    /// Without the query string: `/users/1`.
    pub path: str
    pub query: Map[str, str] = m{}
    pub headers: Map[str, str] = m{}
    pub body: str = ""

    /// A header, by name (any case).
    pub fn header(this, name: str) -> str? {
        this.headers.get(name.to_lower())
    }

    /// The body decoded as JSON.
    pub fn json[T](this) -> Result[T, json.Error] { json.parse.[T](this.body) }

    /// Answers with status 200 and a text body.
    pub async fn respond(this, body: str) -> Result[void, Error] {
        await this.respond_with(Response { body })
    }

    /// Answers with a full response. A request can be answered once.
    pub async fn respond_with(this, res: Response) -> Result[void, Error] { _builtin() }
}

/// A response: built by a handler (`Response { status: 404, body: "not found" }`), or received by the
/// client. Header names are lowercase.
pub type Response {
    pub status: int = 200
    pub headers: Map[str, str] = m{}
    pub body: str = ""

    pub fn ok(this) -> bool { this.status >= 200 && this.status < 300 }

    pub fn header(this, name: str) -> str? {
        this.headers.get(name.to_lower())
    }

    /// The body decoded as JSON.
    pub fn json[T](this) -> Result[T, json.Error] { json.parse.[T](this.body) }
}

/// A JSON response (`content-type: application/json`).
pub fn json_response[T](status: int, value: T) -> Response {
    var headers = m{} as Map[str, str]
    headers["content-type"] = "application/json"
    Response { status, headers, body: json.stringify(value) }
}

pub type Server {
    /// Waits for the next request. Cancel-safe.
    pub async fn accept(*this) -> Result[Request, Error] { _builtin() }
    /// Stops accepting requests.
    pub fn close(this) { _builtin() }
    /// The port it listens on (useful after `listen(host, 0)`, which picks a free one).
    pub fn port(this) -> u16 { _builtin() }
}

/// Listens on `host:port` (resolves once the port is bound).
pub async fn listen(host: str, port: u16) -> Result[Server, Error] { _builtin() }

// ---- client -------------------------------------------------------------------------------------

/// A request the client sends.
pub type Outgoing {
    pub method: str = "GET"
    pub url: str
    pub headers: Map[str, str] = m{}
    pub body: str = ""
}

/// Sends a request and waits for the whole response. An HTTP error status is still `Ok`: check
/// `res.ok()` or `res.status`; `Err` means no response (connection refused, bad URL…).
pub async fn send(req: Outgoing) -> Result[Response, Error] { _builtin() }

pub async fn get(url: str) -> Result[Response, Error] {
    await send(Outgoing { url })
}

pub async fn post(url: str, body: str) -> Result[Response, Error] {
    await send(Outgoing { method: "POST", url, body })
}
