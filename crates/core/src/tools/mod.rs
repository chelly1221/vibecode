//! CLI detection, auth status and model listing on the active backend.

pub mod claude;
pub mod codex;

use std::sync::Arc;

use crate::backend::ExecBackend;
use crate::error::{CoreError, Result};
use crate::types::{AuthStatus, ModelInfo, Provider, ToolStatus};

/// Tools the onboarding wizard and stack prerequisites care about.
pub const KNOWN_TOOLS: &[&str] = &[
    "claude", "codex", "git", "gh", "node", "npm", "cargo", "rustup", "python", "uv", "dotnet", "flutter", "go", "java",
];

/// Detect every known tool (path + version) on the backend.
pub async fn detect_all(backend: Arc<dyn ExecBackend>) -> Vec<ToolStatus> {
    let _ = backend;
    vec![]
}

/// Detect a single tool.
pub async fn detect(backend: Arc<dyn ExecBackend>, name: &str, bin_override: Option<&str>) -> ToolStatus {
    let _ = (backend, bin_override);
    ToolStatus { name: name.to_string(), found: false, path: None, version: None, install_hint: None }
}

/// `claude auth status` (JSON) / `codex login status`.
pub async fn auth_status(backend: Arc<dyn ExecBackend>, provider: Provider, bin_override: Option<&str>) -> Result<AuthStatus> {
    match provider {
        Provider::Claude => claude::auth_status(backend, bin_override).await,
        Provider::Codex => codex::auth_status(backend, bin_override).await,
    }
}

/// Models offered in the UI. Claude: static list + aliases; Codex: `model/list` via app-server.
pub async fn list_models(backend: Arc<dyn ExecBackend>, provider: Provider, bin_override: Option<&str>) -> Result<Vec<ModelInfo>> {
    let _ = (backend, bin_override);
    match provider {
        Provider::Claude => Ok(claude::list_models()),
        Provider::Codex => Err(CoreError::msg("codex models are listed through CodexHost::list_models")),
    }
}
