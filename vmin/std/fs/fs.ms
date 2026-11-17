package fs

// The file system. Every operation is async; failures are a `Result` with an `Error`.

pub type Error {
    pub path: str
    /// the system's error code (`ENOENT`) or message
    pub message: str

    pub fn to_str(this) -> str { "${this.path}: ${this.message}" }
}

pub type Stat {
    pub size: i64
    pub dir: bool
    /// Last modification, in milliseconds since the Unix epoch.
    pub modified: i64

    pub fn is_dir(this) -> bool { this.dir }
    pub fn is_file(this) -> bool { !this.dir }
}

pub async fn read_file(path: str) -> Result[Vec[u8], Error] { _builtin() }
pub async fn read_text(path: str) -> Result[str, Error] { _builtin() }
pub async fn write_file(path: str, data: Slice[u8]) -> Result[void, Error] { _builtin() }
pub async fn write_text(path: str, text: str) -> Result[void, Error] { _builtin() }
pub async fn stat(path: str) -> Result[Stat, Error] { _builtin() }
pub async fn exists(path: str) -> bool { _builtin() }
/// The names of the entries of a directory, sorted.
pub async fn list_dir(path: str) -> Result[Vec[str], Error] { _builtin() }
/// The paths of every file under a directory, recursively, sorted.
pub async fn walk_dir(path: str) -> Result[Vec[str], Error] { _builtin() }
/// Creates a directory and its missing parents.
pub async fn create_dir(path: str) -> Result[void, Error] { _builtin() }
/// Removes a file, or a directory and everything in it.
pub async fn remove(path: str) -> Result[void, Error] { _builtin() }
