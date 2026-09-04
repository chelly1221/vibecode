//! Owns live sessions: starts adapters, persists transcripts, fans events out.
//!
//! Persisted `MessageRecord.payload` shapes (contract with the chat UI):
//! - user:       `{ "text" }`
//! - assistant:  `{ "text" }` (one per `SessionEvent::Text`)
//! - tool:       `{ "id", "name", "input", "output", "is_error", "subagent"?: [...] }` (written on ToolEnd;
//!               `subagent` holds the spawned subagent's transcript as `{kind:"user"|"text", text}` /
//!               `{kind:"tool", id, name, input, output, is_error, subagent?}` items, capped)
//! - permission: `{ "request_id", "kind", "title", "detail", "decision" }` (on PermissionResolved)
//! - system:     `{ "subtype": "turn_end", "cost_usd", "usage", "duration_ms", "stop_reason" }`,
//!               `{ "subtype": "error", "message" }`, `{ "subtype": "init", "model", "external_ref" }`

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use serde_json::{json, Value};
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::sync::RwLock;

use super::{AgentSession, StartArgs};
use crate::context::AppContext;
use crate::error::{CoreError, Result};
use crate::types::{MessageKind, PermissionReply, Provider, QuestionAnswer, SessionConfig, SessionConfigPatch, SessionEvent, SessionRecord};

pub const DEFAULT_TITLE: &str = "새 세션";

#[derive(Default)]
pub struct SessionManager {
    live: RwLock<HashMap<String, Arc<dyn AgentSession>>>,
    /// Adapter-side event senders, so manager-originated events (checkpoints) flow through
    /// the same persist/forward pipeline as adapter events.
    senders: RwLock<HashMap<String, super::EventSender>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start (or resume, when `config.resume_ref` is set) a session. Returns the
    /// persisted record and the event stream the UI should consume. Events are
    /// also written to the messages table before being forwarded.
    pub async fn start(&self, ctx: Arc<AppContext>, config: SessionConfig) -> Result<(SessionRecord, UnboundedReceiver<SessionEvent>)> {
        let project = ctx.db.get_project(&config.project_id)?;
        let backend = ctx.backend().await;
        let bin = ctx.bin_override(config.provider).await;

        // Resuming a known provider session continues its record; forks get a fresh one.
        let existing = match (&config.resume_ref, config.fork) {
            (Some(r), false) => ctx.db.list_sessions(&project.id)?.into_iter().find(|s| s.external_ref.as_deref() == Some(r.as_str())),
            _ => None,
        };
        let now = Utc::now();
        let mut record = match existing {
            Some(mut rec) => {
                rec.model = config.model.clone().or(rec.model);
                rec.effort = config.effort.or(rec.effort);
                rec.permission = config.permission;
                rec.last_used_at = now;
                rec
            }
            None => SessionRecord {
                id: uuid::Uuid::new_v4().to_string(),
                project_id: project.id.clone(),
                provider: config.provider,
                external_ref: if config.fork { None } else { config.resume_ref.clone() },
                title: DEFAULT_TITLE.to_string(),
                model: config.model.clone(),
                effort: config.effort,
                permission: config.permission,
                total_cost_usd: 0.0,
                archived: false,
                created_at: now,
                last_used_at: now,
            },
        };
        if self.is_live(&record.id).await {
            return Err(CoreError::msg("이 세션은 이미 실행 중입니다"));
        }
        ctx.db.upsert_session(&record)?;
        ctx.db.touch_project(&project.id).ok();

        let (adapter_tx, adapter_rx) = mpsc::unbounded_channel::<SessionEvent>();
        let (ui_tx, ui_rx) = mpsc::unbounded_channel::<SessionEvent>();
        let mcp_servers = ctx.settings().await.mcp_servers.clone();
        let args = StartArgs {
            session_id: record.id.clone(),
            config: config.clone(),
            cwd: PathBuf::from(&project.path),
            backend: backend.clone(),
            bin: bin.clone(),
            events: adapter_tx,
            mcp_servers,
        };
        let session: Arc<dyn AgentSession> = match config.provider {
            Provider::Claude => {
                let broker = ctx.permission_broker().await?;
                super::claude::ClaudeSession::start(args, broker).await?
            }
            Provider::Codex => {
                ctx.codex.ensure_started(backend.clone(), bin.clone()).await?;
                ctx.codex.start_session(args).await?
            }
        };
        self.live.write().await.insert(record.id.clone(), session);
        record.last_used_at = Utc::now();

        let ctx2 = ctx.clone();
        let rec2 = record.clone();
        tokio::spawn(async move { persist_and_forward(ctx2, rec2, adapter_rx, ui_tx).await });
        Ok((record, ui_rx))
    }

    pub async fn get(&self, session_id: &str) -> Result<Arc<dyn AgentSession>> {
        self.live.read().await.get(session_id).cloned().ok_or_else(|| CoreError::NotFound(format!("session {session_id} is not running")))
    }

    /// Submit a user message. When checkpoints are enabled, the project's working tree is
    /// snapshotted first (`SessionEvent::Checkpoint` + a persisted `checkpoint` system message);
    /// snapshot failures are logged and never block the turn.
    pub async fn send(&self, ctx: Arc<AppContext>, session_id: &str, text: String) -> Result<()> {
        let session = self.get(session_id).await?;
        if ctx.settings().await.checkpoints_enabled {
            if let Ok(rec) = ctx.db.get_session(session_id) {
                let label = crate::checkpoint::label_for(&text);
                match crate::checkpoint::create(ctx.clone(), &rec.project_id, Some(session_id), &label).await {
                    Ok(Some(cp)) => {
                        if let Some(tx) = self.senders.read().await.get(session_id) {
                            let _ = tx.send(SessionEvent::Checkpoint { checkpoint_id: cp.id.clone(), label: cp.label.clone() });
                        }
                        log(&ctx.db, session_id, MessageKind::System, json!({ "subtype": "checkpoint", "checkpoint_id": cp.id, "label": cp.label }));
                    }
                    Ok(None) => {}
                    Err(e) => tracing::warn!("checkpoint before turn failed for {session_id}: {e}"),
                }
            }
        }
        session.send(text).await
    }

    pub async fn interrupt(&self, session_id: &str) -> Result<()> {
        self.get(session_id).await?.interrupt().await
    }

    pub async fn reply_permission(&self, session_id: &str, reply: PermissionReply) -> Result<()> {
        self.get(session_id).await?.reply_permission(reply).await
    }

    pub async fn answer_question(&self, session_id: &str, request_id: String, answers: Vec<QuestionAnswer>) -> Result<()> {
        self.get(session_id).await?.answer_question(request_id, answers).await
    }

    pub async fn update_config(&self, session_id: &str, patch: SessionConfigPatch) -> Result<()> {
        self.get(session_id).await?.update_config(patch).await
    }

    pub async fn close(&self, session_id: &str) -> Result<()> {
        let removed = self.live.write().await.remove(session_id);
        if let Some(s) = removed {
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

    pub async fn live_ids(&self) -> Vec<String> {
        self.live.read().await.keys().cloned().collect()
    }

    pub(crate) async fn remove_live(&self, session_id: &str) {
        self.live.write().await.remove(session_id);
    }
}

struct PendingTool {
    name: String,
    input: Value,
}

struct PendingPermission {
    kind: Value,
    title: String,
    detail: Value,
}

/// Tee task: persist what the UI needs to reconstruct the transcript, then forward.
async fn persist_and_forward(ctx: Arc<AppContext>, mut record: SessionRecord, mut rx: UnboundedReceiver<SessionEvent>, ui: mpsc::UnboundedSender<SessionEvent>) {
    let sid = record.id.clone();
    let mut tools: HashMap<String, PendingTool> = HashMap::new();
    let mut perms: HashMap<String, PendingPermission> = HashMap::new();
    // Subagent transcripts keyed by the spawning tool call id (nested subagents key by their own parent).
    let mut subagents: HashMap<String, Vec<Value>> = HashMap::new();
    let mut sub_tools: HashMap<String, PendingTool> = HashMap::new();
    let mut init_logged = false;
    let db = &ctx.db;
    while let Some(ev) = rx.recv().await {
        let mut dirty = false;
        match &ev {
            SessionEvent::Subagent { parent_tool_use_id, event } => {
                match event.as_ref() {
                    SessionEvent::Text { text } => push_sub(&mut subagents, parent_tool_use_id, json!({ "kind": "text", "text": text })),
                    SessionEvent::UserMessage { text } => push_sub(&mut subagents, parent_tool_use_id, json!({ "kind": "user", "text": text })),
                    SessionEvent::ToolStart { id, name, input } => {
                        sub_tools.insert(id.clone(), PendingTool { name: name.clone(), input: input.clone() });
                    }
                    SessionEvent::ToolEnd { id, output, is_error } => {
                        let PendingTool { name, input } = sub_tools.remove(id).unwrap_or(PendingTool { name: "unknown".into(), input: Value::Null });
                        let mut item = json!({ "kind": "tool", "id": id, "name": name, "input": input, "output": output, "is_error": is_error });
                        if let Some(nested) = subagents.remove(id) {
                            item["subagent"] = Value::Array(nested);
                        }
                        push_sub(&mut subagents, parent_tool_use_id, item);
                    }
                    _ => {}
                }
            }
            SessionEvent::Init { model, external_ref, .. } => {
                record.external_ref = Some(external_ref.clone());
                record.model = Some(model.clone());
                dirty = true;
                if !init_logged {
                    init_logged = true;
                    log(db, &sid, MessageKind::System, json!({ "subtype": "init", "model": model, "external_ref": external_ref }));
                }
            }
            SessionEvent::UserMessage { text } => {
                if record.title == DEFAULT_TITLE {
                    record.title = make_title(text);
                    dirty = true;
                }
                log(db, &sid, MessageKind::User, json!({ "text": text }));
            }
            SessionEvent::Text { text } => log(db, &sid, MessageKind::Assistant, json!({ "text": text })),
            SessionEvent::ToolStart { id, name, input } => {
                tools.insert(id.clone(), PendingTool { name: name.clone(), input: input.clone() });
            }
            SessionEvent::ToolEnd { id, output, is_error } => {
                let PendingTool { name, input } = tools.remove(id).unwrap_or(PendingTool { name: "unknown".into(), input: Value::Null });
                let mut payload = json!({ "id": id, "name": name, "input": input, "output": output, "is_error": is_error });
                if let Some(sub) = subagents.remove(id) {
                    payload["subagent"] = Value::Array(sub);
                }
                log(db, &sid, MessageKind::Tool, payload);
            }
            SessionEvent::PermissionRequest { request_id, kind, title, detail } => {
                perms.insert(request_id.clone(), PendingPermission { kind: serde_json::to_value(kind).unwrap_or(Value::Null), title: title.clone(), detail: detail.clone() });
            }
            SessionEvent::PermissionResolved { request_id, decision } => {
                let p = perms.remove(request_id).unwrap_or(PendingPermission { kind: Value::Null, title: String::new(), detail: Value::Null });
                log(db, &sid, MessageKind::Permission, json!({ "request_id": request_id, "kind": p.kind, "title": p.title, "detail": p.detail, "decision": decision }));
            }
            SessionEvent::TurnEnd { cost_usd, usage, duration_ms, stop_reason } => {
                if let Some(c) = cost_usd {
                    // Claude reports cumulative session cost per result; keep the max, add for others.
                    if record.provider == Provider::Claude {
                        if *c > record.total_cost_usd {
                            record.total_cost_usd = *c;
                        }
                    } else {
                        record.total_cost_usd += c;
                    }
                }
                dirty = true;
                log(db, &sid, MessageKind::System, json!({ "subtype": "turn_end", "cost_usd": cost_usd, "usage": usage, "duration_ms": duration_ms, "stop_reason": stop_reason }));
            }
            SessionEvent::Error { message, .. } => log(db, &sid, MessageKind::System, json!({ "subtype": "error", "message": message })),
            _ => {}
        }
        if dirty {
            record.last_used_at = Utc::now();
            if let Err(e) = db.upsert_session(&record) {
                tracing::warn!("failed to persist session {sid}: {e}");
            }
        }
        let exited = matches!(ev, SessionEvent::Exited { .. });
        if ui.send(ev).is_err() {
            // UI channel gone (window closed): keep persisting until the adapter ends.
        }
        if exited {
            break;
        }
    }
    ctx.sessions.remove_live(&sid).await;
}

/// Items kept per subagent transcript; beyond this a single marker item is appended once.
const SUBAGENT_ITEM_CAP: usize = 300;

fn push_sub(map: &mut HashMap<String, Vec<Value>>, parent: &str, item: Value) {
    let list = map.entry(parent.to_string()).or_default();
    if list.len() < SUBAGENT_ITEM_CAP {
        list.push(item);
    } else if list.len() == SUBAGENT_ITEM_CAP {
        list.push(json!({ "kind": "text", "text": "… (subagent transcript truncated)" }));
    }
}

fn log(db: &crate::db::Db, session_id: &str, kind: MessageKind, payload: Value) {
    if let Err(e) = db.append_message(session_id, kind, payload) {
        tracing::warn!("failed to persist message for {session_id}: {e}");
    }
}

fn make_title(text: &str) -> String {
    let one_line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let t: String = one_line.chars().take(60).collect();
    if t.trim().is_empty() { DEFAULT_TITLE.to_string() } else { t }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_trimming() {
        assert_eq!(make_title("  hello\n  world  "), "hello world");
        assert_eq!(make_title("   "), DEFAULT_TITLE);
        assert_eq!(make_title(&"가".repeat(100)).chars().count(), 60);
    }
}
