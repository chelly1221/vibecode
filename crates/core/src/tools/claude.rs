//! Claude-specific tool helpers: `claude auth status` and the model list.

use std::sync::Arc;

use crate::backend::ExecBackend;
use crate::error::{CoreError, Result};
use crate::types::{AuthStatus, ModelInfo};

pub async fn auth_status(backend: Arc<dyn ExecBackend>, bin: Option<&str>) -> Result<AuthStatus> {
    let _ = (backend, bin);
    Err(CoreError::NotImplemented("tools::claude::auth_status"))
}

/// Static list (aliases + verified ids) — Claude has no CLI model listing.
pub fn list_models() -> Vec<ModelInfo> {
    vec![]
}
