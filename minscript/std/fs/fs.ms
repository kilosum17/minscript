package fs

// The file system. Every operation is async; failures are a `Result` with an `Error`.

pub type Error = {
    pub path: string
    pub message: string

    pub fun to_str(&this) -> string { "${this.path}: ${this.message}" }
}

pub type Stat = {
    pub size: i64
    pub dir: bool
    /// Last modification, in milliseconds since the Unix epoch.
    pub modified: i64

    pub fun is_dir(&this) -> bool { this.dir }
    pub fun is_file(&this) -> bool { !this.dir }
}

pub async fun read_file(path: &str) -> Result[Vec[u8], Error] { _builtin() }
pub async fun read_text(path: &str) -> Result[string, Error] { _builtin() }
pub async fun write_file(path: &str, data: &Slice[u8]) -> Result[void, Error] { _builtin() }
pub async fun write_text(path: &str, text: &str) -> Result[void, Error] { _builtin() }
pub async fun stat(path: &str) -> Result[Stat, Error] { _builtin() }
pub async fun exists(path: &str) -> bool { _builtin() }
/// The names of the entries of a directory.
pub async fun list_dir(path: &str) -> Result[Vec[string], Error] { _builtin() }
/// The paths of every file under a directory, recursively.
pub async fun walk_dir(path: &str) -> Result[Vec[string], Error] { _builtin() }
pub async fun create_dir(path: &str) -> Result[void, Error] { _builtin() }
pub async fun remove(path: &str) -> Result[void, Error] { _builtin() }
