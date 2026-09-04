//! SSH key helpers on the active backend (ed25519 key for GitHub pushes).

use std::sync::Arc;

use crate::backend::ExecBackend;
use crate::error::{CoreError, Result};
use crate::types::SshKeyInfo;

/// Look for ~/.ssh/id_ed25519.pub or id_rsa.pub on the backend and whether github.com is a known host.
pub async fn key_info(backend: Arc<dyn ExecBackend>) -> Result<SshKeyInfo> {
    let _ = backend;
    Err(CoreError::NotImplemented("ssh::key_info"))
}

/// Generate ~/.ssh/id_ed25519 (no passphrase, comment "vibecoder") if missing, add github.com to known_hosts, return the public key.
pub async fn generate_key(backend: Arc<dyn ExecBackend>) -> Result<SshKeyInfo> {
    let _ = backend;
    Err(CoreError::NotImplemented("ssh::generate_key"))
}

/// `ssh -T git@github.com` → Ok(username) when the key is registered on GitHub.
pub async fn test_github(backend: Arc<dyn ExecBackend>) -> Result<String> {
    let _ = backend;
    Err(CoreError::NotImplemented("ssh::test_github"))
}
