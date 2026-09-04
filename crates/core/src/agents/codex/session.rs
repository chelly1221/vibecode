//! A single Codex thread bound to a vibecode session.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::RwLock;

use super::mapping::{self, MapState};
use super::rpc::{Incoming, RpcClient};
use crate::agents::{AgentSession, EventSender};
use crate::error::{CoreError, Result};
use crate::types::{Effort, PermissionDecision, PermissionPreset, PermissionReply, Provider, SessionConfigPatch, SessionEvent};

/// Settings applied on every `turn/start` (override "this turn and subsequent turns").
#[derive(Debug, Clone)]
pub(crate) struct TurnConfig {
    pub model: Option<String>,
    pub effort: Option<Effort>,
    pub permission: PermissionPreset,
}

pub(crate) struct SessionInner {
    pub thread_id: String,
    pub rpc: Arc<RpcClient>,
    pub events: EventSender,
    /// Project directory as the backend sees it (writable root for the sandbox).
    pub cwd_backend: String,
    pub cfg: Mutex<TurnConfig>,
    pub map: Mutex<MapState>,
    pub closed: AtomicBool,
}

impl SessionInner {
    pub fn emit(&self, ev: SessionEvent) {
        let _ = self.events.send(ev);
    }

    /// Route one server message for this thread.
    pub async fn handle(&self, inc: Incoming) {
        match inc {
            Incoming::Notification { method, params } => {
                let evs = match self.map.lock() {
                    Ok(mut m) => mapping::map_notification(&mut m, &method, &params),
                    Err(_) => Vec::new(),
                };
                for ev in evs {
                    if matches!(ev, SessionEvent::Exited { .. }) {
                        self.closed.store(true, Ordering::SeqCst);
                    }
                    self.emit(ev);
                }
            }
            Incoming::Request { id, method, params } => {
                let ev = match self.map.lock() {
                    Ok(mut m) => mapping::map_server_request(&mut m, &id, &method, &params),
                    Err(_) => None,
                };
                match ev {
                    Some(ev) => self.emit(ev),
                    None => {
                        tracing::debug!("codex: unsupported server request {method}");
                        let _ = self.rpc.respond_error(id, -32601, &format!("vibecode does not support {method}")).await;
                    }
                }
            }
            Incoming::Closed => {
                self.closed.store(true, Ordering::SeqCst);
                self.emit(SessionEvent::Exited { code: None });
            }
        }
    }

    fn turn_params(&self, text: &str) -> Value {
        let cfg = self.cfg.lock().map(|c| c.clone()).unwrap_or(TurnConfig { model: None, effort: None, permission: PermissionPreset::AskEverything });
        let pol = mapping::policies_for(cfg.permission, &self.cwd_backend);
        let mut p = json!({
            "threadId": self.thread_id,
            "input": [{ "type": "text", "text": text, "text_elements": [] }],
            "approvalPolicy": pol.approval_policy,
            "sandboxPolicy": pol.sandbox_policy,
        });
        if let Some(m) = cfg.model {
            p["model"] = Value::String(m);
        }
        if let Some(e) = cfg.effort {
            p["effort"] = Value::String(e.to_codex().to_string());
        }
        p
    }
}

pub struct CodexSession {
    pub(crate) inner: Arc<SessionInner>,
    pub(crate) registry: Arc<RwLock<HashMap<String, Arc<SessionInner>>>>,
}

#[async_trait]
impl AgentSession for CodexSession {
    fn provider(&self) -> Provider {
        Provider::Codex
    }

    fn external_ref(&self) -> Option<String> {
        Some(self.inner.thread_id.clone())
    }

    async fn send(&self, text: String) -> Result<()> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(CoreError::Agent("codex session is closed".into()));
        }
        self.inner.emit(SessionEvent::UserMessage { text: text.clone() });
        let active = self.inner.map.lock().ok().and_then(|m| m.active_turn.clone());
        let result = match active {
            // A turn is running: steer it instead of starting a new one.
            Some(turn_id) => {
                let params = json!({
                    "threadId": self.inner.thread_id,
                    "input": [{ "type": "text", "text": text, "text_elements": [] }],
                    "expectedTurnId": turn_id,
                });
                self.inner.rpc.request("turn/steer", params).await
            }
            None => {
                let params = self.inner.turn_params(&text);
                self.inner.rpc.request("turn/start", params).await
            }
        };
        match result {
            Ok(v) => {
                if let Some(id) = v.get("turn").and_then(|t| t.get("id")).and_then(|i| i.as_str()) {
                    if let Ok(mut m) = self.inner.map.lock() {
                        m.active_turn = Some(id.to_string());
                        m.turn_started.get_or_insert_with(Instant::now);
                    }
                }
                Ok(())
            }
            Err(e) => {
                self.inner.emit(SessionEvent::Error { message: e.to_string(), fatal: false });
                Err(e)
            }
        }
    }

    async fn interrupt(&self) -> Result<()> {
        let active = self.inner.map.lock().ok().and_then(|m| m.active_turn.clone());
        let Some(turn_id) = active else { return Ok(()) };
        self.inner.rpc.request("turn/interrupt", json!({ "threadId": self.inner.thread_id, "turnId": turn_id })).await?;
        Ok(())
    }

    async fn reply_permission(&self, reply: PermissionReply) -> Result<()> {
        let pending = self.inner.map.lock().ok().and_then(|mut m| m.pending.remove(&reply.request_id));
        let Some(pending) = pending else {
            return Err(CoreError::NotFound(format!("permission request {}", reply.request_id)));
        };
        let result = mapping::approval_response(&pending, reply.decision, reply.message.as_deref());
        self.inner.rpc.respond(pending.rpc_id.clone(), result).await?;
        self.inner.emit(SessionEvent::PermissionResolved { request_id: reply.request_id, decision: reply.decision });
        Ok(())
    }

    async fn update_config(&self, patch: SessionConfigPatch) -> Result<()> {
        if let Ok(mut c) = self.inner.cfg.lock() {
            if let Some(m) = patch.model {
                c.model = Some(m);
            }
            if let Some(e) = patch.effort {
                c.effort = Some(e);
            }
            if let Some(p) = patch.permission {
                c.permission = p;
            }
        }
        Ok(())
    }

    async fn close(&self) -> Result<()> {
        if !self.inner.closed.swap(true, Ordering::SeqCst) {
            // Void pending approvals so the server can move on.
            let pend: Vec<_> = self.inner.map.lock().map(|mut m| m.pending.drain().map(|(_, p)| p).collect()).unwrap_or_default();
            for p in pend {
                let _ = self.inner.rpc.respond(p.rpc_id.clone(), mapping::approval_response(&p, PermissionDecision::Deny, Some("session closed"))).await;
            }
            if self.inner.rpc.is_alive() {
                let _ = self.inner.rpc.request("thread/unsubscribe", json!({ "threadId": self.inner.thread_id })).await;
            }
            self.inner.emit(SessionEvent::Exited { code: None });
        }
        self.registry.write().await.remove(&self.inner.thread_id);
        Ok(())
    }
}
