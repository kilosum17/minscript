package crypto

/// Encrypts with AES-256-GCM; the key is derived from the password. The result holds the salt and nonce.
pub fn encrypt_aes_gcm(data: Slice[u8], password: str) -> Vec[u8] { _builtin() }

/// Decrypts what `encrypt_aes_gcm` produced; fails on a wrong password or corrupted data.
pub fn decrypt_aes_gcm(data: Slice[u8], password: str) -> Result[Vec[u8], str] { _builtin() }

/// The SHA-256 digest of the data, as lowercase hex.
pub fn sha256(data: Slice[u8]) -> str { _builtin() }

/// `n` cryptographically random bytes.
pub fn random_bytes(n: int) -> Vec[u8] { _builtin() }
