package crypto

/// Encrypts with AES-256-GCM; the key is derived from the password. The result holds the salt and nonce.
pub fun encrypt_aes_gcm(data: &Slice[u8], password: &str) -> Vec[u8] { _builtin() }

/// Decrypts what `encrypt_aes_gcm` produced; fails on a wrong password or corrupted data.
pub fun decrypt_aes_gcm(data: &Slice[u8], password: &str) -> Result[Vec[u8], string] { _builtin() }

/// The SHA-256 digest of the data, as lowercase hex.
pub fun sha256(data: &Slice[u8]) -> string { _builtin() }

/// `n` cryptographically random bytes.
pub fun random_bytes(n: int) -> Vec[u8] { _builtin() }
