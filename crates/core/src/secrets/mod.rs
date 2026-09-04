//! OS keyring wrapper (Windows Credential Manager). Keys: "github_token", "openai_api_key", ...

use crate::error::{CoreError, Result};

pub const SERVICE: &str = "vibecode";

pub fn get(key: &str) -> Result<Option<String>> {
    let _ = key;
    Err(CoreError::NotImplemented("secrets::get"))
}

pub fn set(key: &str, value: &str) -> Result<()> {
    let _ = (key, value);
    Err(CoreError::NotImplemented("secrets::set"))
}

pub fn delete(key: &str) -> Result<()> {
    let _ = key;
    Err(CoreError::NotImplemented("secrets::delete"))
}
