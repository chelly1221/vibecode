//! Provider adapters behind a single `AgentSession` trait, plus the
//! `SessionManager` that owns live sessions and persists their transcripts.

pub mod claude;
pub mod codex;
pub mod export;
pub mod manager;
pub mod oneshot;

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc::UnboundedSender;

use crate::backend::ExecBackend;
use crate::error::Result;
use crate::types::{McpServerConfig, PermissionReply, Provider, QuestionAnswer, SessionConfig, SessionConfigPatch, SessionEvent};

pub use manager::SessionManager;

pub type EventSender = UnboundedSender<SessionEvent>;

/// Everything an adapter needs to start.
pub struct StartArgs {
    /// Our session id (uuid string). Also used to route permission prompts.
    pub session_id: String,
    pub config: SessionConfig,
    /// Project directory (host path).
    pub cwd: PathBuf,
    pub backend: Arc<dyn ExecBackend>,
    /// Binary override from settings (None = "claude" / "codex").
    pub bin: Option<String>,
    pub events: EventSender,
    /// User-configured MCP servers (from settings); adapters filter by `providers`.
    pub mcp_servers: Vec<McpServerConfig>,
}

#[async_trait]
pub trait AgentSession: Send + Sync {
    fn provider(&self) -> Provider;
    /// Provider-side id for resume once known (Claude session_id / Codex thread id).
    fn external_ref(&self) -> Option<String>;
    /// Submit a user message; starts a turn. Must emit `SessionEvent::UserMessage`.
    async fn send(&self, text: String) -> Result<()>;
    /// Stop the current turn but keep the session alive.
    async fn interrupt(&self) -> Result<()>;
    /// Answer a pending permission request.
    async fn reply_permission(&self, reply: PermissionReply) -> Result<()>;
    /// Answer a pending `SessionEvent::Question`. Default: unsupported.
    async fn answer_question(&self, request_id: String, answers: Vec<QuestionAnswer>) -> Result<()> {
        let _ = (request_id, answers);
        Err(crate::error::CoreError::NotImplemented("answer_question"))
    }
    /// Change model/effort/permission for subsequent turns.
    async fn update_config(&self, patch: SessionConfigPatch) -> Result<()>;
    /// Terminate the provider process/thread.
    async fn close(&self) -> Result<()>;
}
