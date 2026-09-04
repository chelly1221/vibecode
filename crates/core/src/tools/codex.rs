//! Codex-specific tool helpers: `codex login status`.

use std::sync::Arc;

use crate::backend::ExecBackend;
use crate::error::{CoreError, Result};
use crate::types::AuthStatus;

pub async fn auth_status(backend: Arc<dyn ExecBackend>, bin: Option<&str>) -> Result<AuthStatus> {
    let _ = (backend, bin);
    Err(CoreError::NotImplemented("tools::codex::auth_status"))
}
