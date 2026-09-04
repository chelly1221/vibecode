//! Claude Code adapter: `claude -p --input-format stream-json --output-format stream-json`.
//! See docs/PLAN.md 3.1 for the verified flag set (CLI 2.1.260).

use std::sync::Arc;

use async_trait::async_trait;

use super::{AgentSession, StartArgs};
use crate::backend::ExecBackend;
use crate::error::{CoreError, Result};
use crate::permission::PermissionBroker;
use crate::types::{PermissionReply, Provider, SessionConfigPatch};

pub struct ClaudeSession {}

impl ClaudeSession {
    pub async fn start(args: StartArgs, broker: Arc<PermissionBroker>) -> Result<Arc<dyn AgentSession>> {
        let _ = (args, broker);
        Err(CoreError::NotImplemented("claude::start"))
    }
}

#[async_trait]
impl AgentSession for ClaudeSession {
    fn provider(&self) -> Provider {
        Provider::Claude
    }
    fn external_ref(&self) -> Option<String> {
        None
    }
    async fn send(&self, _text: String) -> Result<()> {
        Err(CoreError::NotImplemented("claude::send"))
    }
    async fn interrupt(&self) -> Result<()> {
        Err(CoreError::NotImplemented("claude::interrupt"))
    }
    async fn reply_permission(&self, _reply: PermissionReply) -> Result<()> {
        Err(CoreError::NotImplemented("claude::reply_permission"))
    }
    async fn update_config(&self, _patch: SessionConfigPatch) -> Result<()> {
        Err(CoreError::NotImplemented("claude::update_config"))
    }
    async fn close(&self) -> Result<()> {
        Err(CoreError::NotImplemented("claude::close"))
    }
}

/// One-shot commit message generation (no session). See `agents::oneshot`.
pub async fn oneshot_commit_message(backend: Arc<dyn ExecBackend>, bin: Option<String>, repo: &std::path::Path, diff: &str) -> Result<String> {
    let _ = (backend, bin, repo, diff);
    Err(CoreError::NotImplemented("claude::oneshot_commit_message"))
}
