package http

// HTTP/1.1: a server and a client (spec §10.4). Bodies are text for now; `json.[T]()` decodes a body
// with the same rules as `json.parse`.

import "std.json"

pub type Error = {
    pub message: string

    pub fun to_str(&this) -> string { this.message }
}

/// A request the server received. Header names are lowercase.
pub type Request = {
    pub method: string
    /// Without the query string: `/users/1`.
    pub path: string
    pub query: Map[string, string] = m{}
    pub headers: Map[string, string] = m{}
    pub body: string = ""

    /// A header, by name (any case).
    pub fun header(&this, name: string) -> string? {
        this.headers.get(name.to_lower())
    }

    /// The body decoded as JSON.
    pub fun json[T](&this) -> Result[T, json.Error] { _builtin() }

    /// Answers with status 200 and a text body.
    pub async fun respond(&this, body: string) -> Result[void, Error] {
        await this.respond_with(Response { body })
    }

    /// Answers with a full response. A request can be answered once.
    pub async fun respond_with(&this, res: Response) -> Result[void, Error] { _builtin() }
}

/// A response: built by a handler (`Response { status: 404, body: "not found" }`), or received by the
/// client. Header names are lowercase.
pub type Response = {
    pub status: int = 200
    pub headers: Map[string, string] = m{}
    pub body: string = ""

    pub fun ok(&this) -> bool { this.status >= 200 && this.status < 300 }

    pub fun header(&this, name: string) -> string? {
        this.headers.get(name.to_lower())
    }

    /// The body decoded as JSON.
    pub fun json[T](&this) -> Result[T, json.Error] { _builtin() }
}

/// A JSON response (`content-type: application/json`).
pub fun json_response[T](status: int, value: &T) -> Response {
    var headers = m{} as Map[string, string]
    headers["content-type"] = "application/json"
    Response { status, headers, body: json.stringify(value) }
}

pub type Server = {
    /// Waits for the next request. Cancel-safe.
    pub async fun accept(&mut this) -> Result[Request, Error] { _builtin() }
    /// Stops accepting requests.
    pub fun close(&this) { _builtin() }
    /// The port it listens on (useful after `listen(host, 0)`, which picks a free one).
    pub fun port(&this) -> u16 { _builtin() }
}

/// Listens on `host:port` (resolves once the port is bound).
pub async fun listen(host: &str, port: u16) -> Result[Server, Error] { _builtin() }

// ---- client -------------------------------------------------------------------------------------

/// A request the client sends.
pub type Outgoing = {
    pub method: string = "GET"
    pub url: string
    pub headers: Map[string, string] = m{}
    pub body: string = ""
}

/// Sends a request and waits for the whole response. An HTTP error status is still `Ok`: check
/// `res.ok()` or `res.status`; `Err` means no response (connection refused, bad URL…).
pub async fun send(req: Outgoing) -> Result[Response, Error] { _builtin() }

pub async fun get(url: string) -> Result[Response, Error] {
    await send(Outgoing { url })
}

pub async fun post(url: string, body: string) -> Result[Response, Error] {
    await send(Outgoing { method: "POST", url, body })
}
