//! Owns live sessions: starts adapters, persists transcripts, fans events out.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::RwLock;

use super::AgentSession;
use crate::context::AppContext;
use crate::error::{CoreError, Result};
use crate::types::{PermissionReply, SessionConfig, SessionConfigPatch, SessionEvent, SessionRecord};

#[derive(Default)]
pub struct SessionManager {
    live: RwLock<HashMap<String, Arc<dyn AgentSession>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start (or resume, when `config.resume_ref` is set) a session. Returns the
    /// persisted record and the event stream the UI should consume. Events are
    /// also written to the messages table before being forwarded.
    pub async fn start(&self, ctx: Arc<AppContext>, config: SessionConfig) -> Result<(SessionRecord, UnboundedReceiver<SessionEvent>)> {
        let _ = (ctx, config);
        Err(CoreError::NotImplemented("manager::start"))
    }

    pub async fn get(&self, session_id: &str) -> Result<Arc<dyn AgentSession>> {
        self.live.read().await.get(session_id).cloned().ok_or_else(|| CoreError::NotFound(format!("session {session_id}")))
    }

    pub async fn send(&self, session_id: &str, text: String) -> Result<()> {
        self.get(session_id).await?.send(text).await
    }

    pub async fn interrupt(&self, session_id: &str) -> Result<()> {
        self.get(session_id).await?.interrupt().await
    }

    pub async fn reply_permission(&self, session_id: &str, reply: PermissionReply) -> Result<()> {
        self.get(session_id).await?.reply_permission(reply).await
    }

    pub async fn update_config(&self, session_id: &str, patch: SessionConfigPatch) -> Result<()> {
        self.get(session_id).await?.update_config(patch).await
    }

    pub async fn close(&self, session_id: &str) -> Result<()> {
        if let Some(s) = self.live.write().await.remove(session_id) {
            s.close().await?;
        }
        Ok(())
    }

    pub async fn close_all(&self) {
        let all: Vec<_> = self.live.write().await.drain().map(|(_, s)| s).collect();
        for s in all {
            let _ = s.close().await;
        }
    }

    pub async fn is_live(&self, session_id: &str) -> bool {
        self.live.read().await.contains_key(session_id)
    }
}
