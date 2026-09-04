//! In-app MCP server (streamable HTTP on 127.0.0.1) exposing an `approve` tool.
//! Claude Code is started with `--permission-prompt-tool mcp__vibecode__approve`
//! and an `--mcp-config` pointing at `http://127.0.0.1:<port>/mcp/<session_id>`.
//! Each tool call becomes a `SessionEvent::PermissionRequest`; the UI's answer
//! is returned as the tool result (`{"behavior":"allow"|"deny", ...}`).

use crate::agents::EventSender;
use crate::error::{CoreError, Result};
use crate::types::PermissionReply;

pub const SERVER_NAME: &str = "vibecode";
pub const TOOL_NAME: &str = "approve";

pub struct PermissionBroker {
    port: u16,
}

impl PermissionBroker {
    /// Bind an ephemeral port and start serving.
    pub async fn start() -> Result<std::sync::Arc<PermissionBroker>> {
        Err(CoreError::NotImplemented("permission::start"))
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// URL Claude should connect to for a given session.
    pub fn mcp_url(&self, session_id: &str) -> String {
        format!("http://127.0.0.1:{}/mcp/{}", self.port, session_id)
    }

    /// The `--permission-prompt-tool` argument value.
    pub fn tool_ref() -> String {
        format!("mcp__{SERVER_NAME}__{TOOL_NAME}")
    }

    /// Route requests for `session_id` to `events`.
    pub fn register(&self, session_id: &str, events: EventSender) {
        let _ = (session_id, events);
    }

    pub fn unregister(&self, session_id: &str) {
        let _ = session_id;
    }

    /// Deliver the user's decision for a pending request.
    pub fn resolve(&self, reply: PermissionReply) -> Result<()> {
        let _ = reply;
        Err(CoreError::NotImplemented("permission::resolve"))
    }
}
