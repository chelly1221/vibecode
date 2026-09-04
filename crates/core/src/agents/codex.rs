//! Codex adapter: one shared `codex app-server` process (JSON-RPC 2.0 over stdio),
//! one thread per session. See docs/PLAN.md 3.2.

use std::sync::Arc;

use async_trait::async_trait;

use super::{AgentSession, StartArgs};
use crate::backend::ExecBackend;
use crate::error::{CoreError, Result};
use crate::types::{ModelInfo, PermissionReply, Provider, SessionConfigPatch};

/// Owns the app-server process; created lazily by `AppContext`.
#[derive(Default)]
pub struct CodexHost {}

impl CodexHost {
    pub fn new() -> Self {
        CodexHost {}
    }

    /// Ensure the app-server is running on `backend` (restart if backend changed).
    pub async fn ensure_started(&self, backend: Arc<dyn ExecBackend>, bin: Option<String>) -> Result<()> {
        let _ = (backend, bin);
        Err(CoreError::NotImplemented("codex::ensure_started"))
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        Err(CoreError::NotImplemented("codex::list_models"))
    }

    pub async fn start_session(&self, args: StartArgs) -> Result<Arc<dyn AgentSession>> {
        let _ = args;
        Err(CoreError::NotImplemented("codex::start_session"))
    }

    pub async fn shutdown(&self) {}
}

pub struct CodexSession {}

#[async_trait]
impl AgentSession for CodexSession {
    fn provider(&self) -> Provider {
        Provider::Codex
    }
    fn external_ref(&self) -> Option<String> {
        None
    }
    async fn send(&self, _text: String) -> Result<()> {
        Err(CoreError::NotImplemented("codex::send"))
    }
    async fn interrupt(&self) -> Result<()> {
        Err(CoreError::NotImplemented("codex::interrupt"))
    }
    async fn reply_permission(&self, _reply: PermissionReply) -> Result<()> {
        Err(CoreError::NotImplemented("codex::reply_permission"))
    }
    async fn update_config(&self, _patch: SessionConfigPatch) -> Result<()> {
        Err(CoreError::NotImplemented("codex::update_config"))
    }
    async fn close(&self) -> Result<()> {
        Err(CoreError::NotImplemented("codex::close"))
    }
}

/// One-shot commit message generation (no session). See `agents::oneshot`.
pub async fn oneshot_commit_message(backend: Arc<dyn ExecBackend>, bin: Option<String>, repo: &std::path::Path, diff: &str) -> Result<String> {
    let _ = (backend, bin, repo, diff);
    Err(CoreError::NotImplemented("codex::oneshot_commit_message"))
}
