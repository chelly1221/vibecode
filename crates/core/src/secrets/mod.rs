//! OS keyring wrapper (Windows Credential Manager via keyring v4 default store).
//! Keys: "github_token", ... Values are stored as the "password" of (SERVICE, key).

use crate::error::{CoreError, Result};

pub const SERVICE: &str = "vibecode";

fn entry(key: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, key).map_err(|e| CoreError::Keyring(e.to_string()))
}

pub fn get(key: &str) -> Result<Option<String>> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CoreError::Keyring(e.to_string())),
    }
}

pub fn set(key: &str, value: &str) -> Result<()> {
    entry(key)?.set_password(value).map_err(|e| CoreError::Keyring(e.to_string()))
}

pub fn delete(key: &str) -> Result<()> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(CoreError::Keyring(e.to_string())),
    }
}
