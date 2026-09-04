//! Permission prompt routing for Claude Code sessions.
//!
//! Two transports feed the same broker:
//! 1. **stdio** (default, what the official SDKs use): the CLI emits
//!    `control_request {subtype:"can_use_tool"}` on stdout; the adapter calls
//!    [`PermissionBroker::ask`] and writes the JSON result back as a `control_response`.
//! 2. **HTTP MCP** (fallback, `VIBECODE_CLAUDE_PERMISSION_TRANSPORT=mcp-http`): this
//!    module also serves a minimal MCP streamable-HTTP server on 127.0.0.1 exposing an
//!    `approve` tool, wired via `--permission-prompt-tool mcp__vibecode__approve` and
//!    `--mcp-config` pointing at `http://127.0.0.1:<port>/mcp/<session_id>`.
//!
//! Either way a prompt becomes `SessionEvent::PermissionRequest`; the UI answers through
//! [`PermissionBroker::resolve`] and the decision is returned to Claude as
//! `{"behavior":"allow","updatedInput":...}` or `{"behavior":"deny","message":...}`.

mod http;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::agents::EventSender;
use crate::error::{CoreError, Result};
use crate::types::{AgentQuestion, PermissionDecision, PermissionKind, PermissionReply, QuestionAnswer, QuestionOption, SessionEvent};

pub const SERVER_NAME: &str = "vibecode";
pub const TOOL_NAME: &str = "approve";
/// How long a prompt may stay unanswered before it is denied (the user may be away).
pub const ASK_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);

/// What Claude wants to do.
#[derive(Debug, Clone)]
pub struct PermissionAsk {
    pub session_id: String,
    pub tool_name: String,
    pub input: Value,
    pub tool_use_id: Option<String>,
    /// `permission_suggestions` from the CLI (PermissionUpdate objects).
    pub suggestions: Vec<Value>,
    pub blocked_path: Option<String>,
    pub description: Option<String>,
}

impl PermissionAsk {
    /// Build from a `can_use_tool` control request or the MCP tool arguments (same field names).
    pub fn from_request(session_id: &str, req: &Value) -> Self {
        PermissionAsk {
            session_id: session_id.to_string(),
            tool_name: req.get("tool_name").and_then(Value::as_str).unwrap_or("tool").to_string(),
            input: req.get("input").cloned().unwrap_or(Value::Null),
            tool_use_id: req.get("tool_use_id").and_then(Value::as_str).map(String::from),
            suggestions: req.get("permission_suggestions").and_then(Value::as_array).cloned().unwrap_or_default(),
            blocked_path: req.get("blocked_path").and_then(Value::as_str).map(String::from),
            description: req.get("description").and_then(Value::as_str).map(String::from),
        }
    }
}

/// The answer, plus the JSON Claude expects.
#[derive(Debug, Clone)]
pub struct PermissionOutcome {
    pub decision: PermissionDecision,
    pub result: Value,
}

struct Pending {
    session_id: String,
    tx: oneshot::Sender<PermissionReply>,
}

struct PendingQuestion {
    session_id: String,
    tx: oneshot::Sender<Vec<QuestionAnswer>>,
}

#[derive(Default)]
struct Inner {
    senders: Mutex<HashMap<String, EventSender>>,
    pending: Mutex<HashMap<String, Pending>>,
    /// AskUserQuestion prompts waiting for `resolve_question`.
    pending_questions: Mutex<HashMap<String, PendingQuestion>>,
    /// Per-session "allow for the rest of the session" keys.
    session_allow: Mutex<HashMap<String, HashSet<String>>>,
}

pub struct PermissionBroker {
    port: u16,
    inner: Arc<Inner>,
}

impl PermissionBroker {
    /// Bind an ephemeral port on 127.0.0.1 and start the MCP HTTP server.
    pub async fn start() -> Result<Arc<PermissionBroker>> {
        let inner = Arc::new(Inner::default());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let broker = Arc::new(PermissionBroker { port, inner });
        http::serve(listener, broker.clone());
        tracing::info!("permission MCP server listening on 127.0.0.1:{port}");
        Ok(broker)
    }

    /// Registry-only broker (no HTTP server); useful for tests and the stdio transport.
    pub fn without_server() -> Arc<PermissionBroker> {
        Arc::new(PermissionBroker { port: 0, inner: Arc::new(Inner::default()) })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// URL Claude should connect to for a given session (McpHttp transport).
    pub fn mcp_url(&self, session_id: &str) -> String {
        format!("http://127.0.0.1:{}/mcp/{}", self.port, session_id)
    }

    /// The `--permission-prompt-tool` argument value for the McpHttp transport.
    pub fn tool_ref() -> String {
        format!("mcp__{SERVER_NAME}__{TOOL_NAME}")
    }

    /// Route prompts for `session_id` to `events`.
    pub fn register(&self, session_id: &str, events: EventSender) {
        self.inner.senders.lock().unwrap().insert(session_id.to_string(), events);
    }

    /// Stop routing for a session; pending prompts are denied.
    pub fn unregister(&self, session_id: &str) {
        self.inner.senders.lock().unwrap().remove(session_id);
        self.inner.session_allow.lock().unwrap().remove(session_id);
        let drained: Vec<Pending> = {
            let mut pending = self.inner.pending.lock().unwrap();
            let ids: Vec<String> = pending.iter().filter(|(_, p)| p.session_id == session_id).map(|(k, _)| k.clone()).collect();
            ids.into_iter().filter_map(|id| pending.remove(&id)).collect()
        };
        for p in drained {
            let _ = p.tx.send(PermissionReply { request_id: String::new(), decision: PermissionDecision::Deny, message: Some("세션이 종료되었습니다".into()) });
        }
        let drained_q: Vec<PendingQuestion> = {
            let mut pending = self.inner.pending_questions.lock().unwrap();
            let ids: Vec<String> = pending.iter().filter(|(_, p)| p.session_id == session_id).map(|(k, _)| k.clone()).collect();
            ids.into_iter().filter_map(|id| pending.remove(&id)).collect()
        };
        drop(drained_q); // dropping the senders makes the waiting `ask` deny
    }

    pub fn has_session(&self, session_id: &str) -> bool {
        self.inner.senders.lock().unwrap().contains_key(session_id)
    }

    /// Deliver the user's decision for a pending request.
    pub fn resolve(&self, reply: PermissionReply) -> Result<()> {
        let pending = self.inner.pending.lock().unwrap().remove(&reply.request_id);
        match pending {
            Some(p) => {
                p.tx.send(reply).map_err(|_| CoreError::msg("permission request already resolved"))?;
                Ok(())
            }
            None => Err(CoreError::NotFound(format!("permission request {}", reply.request_id))),
        }
    }

    pub fn pending_count(&self) -> usize {
        self.inner.pending.lock().unwrap().len()
    }

    /// Deliver the user's answers for a pending `SessionEvent::Question`.
    pub fn resolve_question(&self, request_id: &str, answers: Vec<QuestionAnswer>) -> Result<()> {
        let pending = self.inner.pending_questions.lock().unwrap().remove(request_id);
        match pending {
            Some(p) => p.tx.send(answers).map_err(|_| CoreError::msg("question already resolved")),
            None => Err(CoreError::NotFound(format!("question {request_id}"))),
        }
    }

    pub fn pending_question_count(&self) -> usize {
        self.inner.pending_questions.lock().unwrap().len()
    }

    /// AskUserQuestion: show Claude's questions, wait for the answers, return them as
    /// `updatedInput {questions, answers: {<question text>: <label | "a, b" | free text>}}`
    /// (the shape documented for the Agent SDK's canUseTool).
    async fn ask_question(&self, ask: PermissionAsk) -> PermissionOutcome {
        let questions = parse_questions(&ask.input);
        if questions.is_empty() {
            return deny("AskUserQuestion 입력에 질문이 없습니다");
        }
        let Some(events) = self.inner.senders.lock().unwrap().get(&ask.session_id).cloned() else {
            return deny("세션이 등록되어 있지 않습니다");
        };
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.inner.pending_questions.lock().unwrap().insert(request_id.clone(), PendingQuestion { session_id: ask.session_id.clone(), tx });
        let _ = events.send(SessionEvent::Question { request_id: request_id.clone(), questions: questions.clone() });
        let answers = match tokio::time::timeout(ASK_TIMEOUT, rx).await {
            Ok(Ok(a)) => Some(a),
            _ => {
                self.inner.pending_questions.lock().unwrap().remove(&request_id);
                None
            }
        };
        let _ = events.send(SessionEvent::QuestionResolved { request_id });
        match answers {
            Some(a) => PermissionOutcome { decision: PermissionDecision::Allow, result: json!({ "behavior": "allow", "updatedInput": question_updated_input(&ask.input, &questions, &a) }) },
            None => deny("사용자가 질문에 답하지 않았습니다"),
        }
    }

    /// Ask the user. Emits `PermissionRequest`, waits for `resolve`, emits `PermissionResolved`.
    pub async fn ask(&self, ask: PermissionAsk) -> PermissionOutcome {
        if ask.tool_name == "AskUserQuestion" {
            return self.ask_question(ask).await;
        }
        let key = allow_key(&ask);
        if self.inner.session_allow.lock().unwrap().get(&ask.session_id).map(|s| s.contains(&key)).unwrap_or(false) {
            return allow(&ask, Vec::new());
        }
        let Some(events) = self.inner.senders.lock().unwrap().get(&ask.session_id).cloned() else {
            return deny("세션이 등록되어 있지 않습니다");
        };
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().unwrap().insert(request_id.clone(), Pending { session_id: ask.session_id.clone(), tx });
        let _ = events.send(SessionEvent::PermissionRequest {
            request_id: request_id.clone(),
            kind: classify(&ask.tool_name),
            title: title_for(&ask),
            detail: json!({
                "tool_name": ask.tool_name,
                "input": ask.input,
                "tool_use_id": ask.tool_use_id,
                "suggestions": ask.suggestions,
                "blocked_path": ask.blocked_path,
                "description": ask.description,
            }),
        });
        let reply = match tokio::time::timeout(ASK_TIMEOUT, rx).await {
            Ok(Ok(reply)) => reply,
            _ => {
                self.inner.pending.lock().unwrap().remove(&request_id);
                PermissionReply { request_id: request_id.clone(), decision: PermissionDecision::Deny, message: Some("응답 시간이 초과되었습니다".into()) }
            }
        };
        let _ = events.send(SessionEvent::PermissionResolved { request_id, decision: reply.decision });
        match reply.decision {
            PermissionDecision::Allow => allow(&ask, Vec::new()),
            PermissionDecision::AllowSession => {
                self.inner.session_allow.lock().unwrap().entry(ask.session_id.clone()).or_default().insert(key);
                allow(&ask, session_rule_updates(&ask))
            }
            PermissionDecision::Deny => deny(reply.message.as_deref().filter(|m| !m.trim().is_empty()).unwrap_or("사용자가 이 작업을 거부했습니다")),
        }
    }
}

/// `questions[]` from the AskUserQuestion input → UI questions. The question text doubles as
/// the id because Claude keys answers by it.
pub fn parse_questions(input: &Value) -> Vec<AgentQuestion> {
    input
        .get("questions")
        .and_then(Value::as_array)
        .map(|qs| {
            qs.iter()
                .filter_map(|q| {
                    let question = q.get("question").and_then(Value::as_str)?.to_string();
                    let options = q
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|o| {
                            o.iter()
                                .filter_map(|opt| {
                                    Some(QuestionOption {
                                        label: opt.get("label").and_then(Value::as_str)?.to_string(),
                                        description: opt.get("description").and_then(Value::as_str).map(String::from),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(AgentQuestion {
                        id: question.clone(),
                        header: q.get("header").and_then(Value::as_str).unwrap_or("").to_string(),
                        question,
                        options,
                        multi_select: q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
                        allow_free_text: true,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Build `updatedInput` for AskUserQuestion: original questions + `answers` keyed by question text.
pub fn question_updated_input(input: &Value, questions: &[AgentQuestion], answers: &[QuestionAnswer]) -> Value {
    let mut map = serde_json::Map::new();
    for q in questions {
        let picked: Vec<String> = answers
            .iter()
            .filter(|a| a.question_id == q.id)
            .flat_map(|a| a.answers.iter().cloned())
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
            .collect();
        if picked.is_empty() {
            continue;
        }
        map.insert(q.question.clone(), Value::String(picked.join(", ")));
    }
    json!({ "questions": input.get("questions").cloned().unwrap_or(Value::Array(vec![])), "answers": Value::Object(map) })
}

fn allow(ask: &PermissionAsk, updated_permissions: Vec<Value>) -> PermissionOutcome {
    let mut result = json!({ "behavior": "allow", "updatedInput": ask.input });
    if !updated_permissions.is_empty() {
        result["updatedPermissions"] = Value::Array(updated_permissions);
    }
    PermissionOutcome { decision: if updated_permissions_len(&result) > 0 { PermissionDecision::AllowSession } else { PermissionDecision::Allow }, result }
}

fn updated_permissions_len(v: &Value) -> usize {
    v.get("updatedPermissions").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0)
}

fn deny(message: &str) -> PermissionOutcome {
    PermissionOutcome { decision: PermissionDecision::Deny, result: json!({ "behavior": "deny", "message": message }) }
}

/// Echo the CLI's own `addRules` suggestions back, scoped to this session only.
fn session_rule_updates(ask: &PermissionAsk) -> Vec<Value> {
    ask.suggestions
        .iter()
        .filter(|s| s.get("type").and_then(Value::as_str) == Some("addRules"))
        .map(|s| {
            let mut s = s.clone();
            s["destination"] = Value::String("session".into());
            s
        })
        .collect()
}

pub fn classify(tool_name: &str) -> PermissionKind {
    match tool_name {
        "Bash" | "PowerShell" => PermissionKind::Command,
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => PermissionKind::FileEdit,
        t if t.starts_with("mcp__") => PermissionKind::Tool,
        "Read" | "Glob" | "Grep" | "WebFetch" | "WebSearch" | "Task" | "Agent" => PermissionKind::Tool,
        _ => PermissionKind::Other,
    }
}

pub fn title_for(ask: &PermissionAsk) -> String {
    match ask.tool_name.as_str() {
        "Bash" | "PowerShell" => {
            let cmd = ask.input.get("command").and_then(Value::as_str).unwrap_or("");
            format!("명령 실행: {}", truncate(cmd, 120))
        }
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            let path = ask.input.get("file_path").or_else(|| ask.input.get("notebook_path")).and_then(Value::as_str).unwrap_or("");
            format!("파일 수정: {}", truncate(path, 120))
        }
        "WebFetch" => format!("웹 요청: {}", truncate(ask.input.get("url").and_then(Value::as_str).unwrap_or(""), 120)),
        t => match &ask.description {
            Some(d) if !d.is_empty() => format!("{t}: {}", truncate(d, 100)),
            _ => format!("도구 사용: {t}"),
        },
    }
}

/// Key used for "allow for the rest of the session".
fn allow_key(ask: &PermissionAsk) -> String {
    match ask.tool_name.as_str() {
        "Bash" | "PowerShell" => {
            let cmd = ask.input.get("command").and_then(Value::as_str).unwrap_or("").trim();
            let program = cmd.split_whitespace().next().unwrap_or("");
            format!("{}:{}", ask.tool_name, program)
        }
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            let path = ask.input.get("file_path").or_else(|| ask.input.get("notebook_path")).and_then(Value::as_str).unwrap_or("");
            let dir = std::path::Path::new(path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            format!("edit:{dir}")
        }
        t => t.to_string(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn ask(session: &str, tool: &str, input: Value) -> PermissionAsk {
        PermissionAsk { session_id: session.into(), tool_name: tool.into(), input, tool_use_id: None, suggestions: vec![json!({"type":"addRules","rules":[{"toolName":tool,"ruleContent":"x"}],"behavior":"allow","destination":"localSettings"})], blocked_path: None, description: None }
    }

    #[tokio::test]
    async fn allow_flow_and_session_memory() {
        let broker = PermissionBroker::without_server();
        let (tx, mut rx) = mpsc::unbounded_channel();
        broker.register("s1", tx);
        let b2 = broker.clone();
        let task = tokio::spawn(async move { b2.ask(ask("s1", "Bash", json!({"command": "npm test"}))).await });
        let ev = rx.recv().await.unwrap();
        let request_id = match ev {
            SessionEvent::PermissionRequest { request_id, kind, title, .. } => {
                assert_eq!(kind, PermissionKind::Command);
                assert!(title.contains("npm test"));
                request_id
            }
            other => panic!("{other:?}"),
        };
        assert_eq!(broker.pending_count(), 1);
        broker.resolve(PermissionReply { request_id: request_id.clone(), decision: PermissionDecision::AllowSession, message: None }).unwrap();
        let outcome = task.await.unwrap();
        assert_eq!(outcome.result["behavior"], "allow");
        assert_eq!(outcome.result["updatedInput"]["command"], "npm test");
        assert_eq!(outcome.result["updatedPermissions"][0]["destination"], "session");
        assert!(matches!(rx.recv().await.unwrap(), SessionEvent::PermissionResolved { decision: PermissionDecision::AllowSession, .. }));
        // same program again: auto-allowed without a prompt
        let outcome2 = broker.ask(ask("s1", "Bash", json!({"command": "npm run build"}))).await;
        assert_eq!(outcome2.result["behavior"], "allow");
        assert!(rx.try_recv().is_err());
        // different program prompts again
        let b3 = broker.clone();
        let task = tokio::spawn(async move { b3.ask(ask("s1", "Bash", json!({"command": "rm -rf x"}))).await });
        let id = match rx.recv().await.unwrap() { SessionEvent::PermissionRequest { request_id, .. } => request_id, o => panic!("{o:?}") };
        broker.resolve(PermissionReply { request_id: id, decision: PermissionDecision::Deny, message: Some("no".into()) }).unwrap();
        let o = task.await.unwrap();
        assert_eq!(o.result["behavior"], "deny");
        assert_eq!(o.result["message"], "no");
    }

    #[tokio::test]
    async fn unregistered_session_is_denied_and_unregister_drains() {
        let broker = PermissionBroker::without_server();
        let o = broker.ask(ask("nope", "Edit", json!({"file_path": "a.rs"}))).await;
        assert_eq!(o.result["behavior"], "deny");
        let (tx, mut rx) = mpsc::unbounded_channel();
        broker.register("s2", tx);
        let b = broker.clone();
        let task = tokio::spawn(async move { b.ask(ask("s2", "Write", json!({"file_path": "C:\\x\\a.rs"}))).await });
        let _ = rx.recv().await.unwrap();
        broker.unregister("s2");
        let o = task.await.unwrap();
        assert_eq!(o.result["behavior"], "deny");
        assert_eq!(broker.pending_count(), 0);
    }

    #[tokio::test]
    async fn ask_user_question_round_trip() {
        let broker = PermissionBroker::without_server();
        let (tx, mut rx) = mpsc::unbounded_channel();
        broker.register("q1", tx);
        let input = json!({"questions": [
            {"question": "Do you want to continue?", "header": "Continue", "options": [{"label": "Yes", "description": "go"}, {"label": "No", "description": "stop"}], "multiSelect": false},
            {"question": "Which sections?", "header": "Sections", "options": [{"label": "Intro"}, {"label": "Outro"}], "multiSelect": true}
        ]});
        let mut a = ask("q1", "AskUserQuestion", input.clone());
        a.suggestions.clear();
        let b2 = broker.clone();
        let task = tokio::spawn(async move { b2.ask(a).await });
        let request_id = match rx.recv().await.unwrap() {
            SessionEvent::Question { request_id, questions } => {
                assert_eq!(questions.len(), 2);
                assert_eq!(questions[0].header, "Continue");
                assert_eq!(questions[0].options[1].label, "No");
                assert!(questions[1].multi_select);
                assert!(questions[0].allow_free_text);
                request_id
            }
            other => panic!("{other:?}"),
        };
        assert_eq!(broker.pending_question_count(), 1);
        broker
            .resolve_question(
                &request_id,
                vec![
                    QuestionAnswer { question_id: "Do you want to continue?".into(), answers: vec!["Yes".into()] },
                    QuestionAnswer { question_id: "Which sections?".into(), answers: vec!["Intro".into(), "Outro".into()] },
                ],
            )
            .unwrap();
        let outcome = task.await.unwrap();
        assert_eq!(outcome.result["behavior"], "allow");
        assert_eq!(outcome.result["updatedInput"]["questions"], input["questions"]);
        assert_eq!(outcome.result["updatedInput"]["answers"]["Do you want to continue?"], "Yes");
        assert_eq!(outcome.result["updatedInput"]["answers"]["Which sections?"], "Intro, Outro");
        assert!(matches!(rx.recv().await.unwrap(), SessionEvent::QuestionResolved { .. }));
        assert_eq!(broker.pending_question_count(), 0);
        // unregister denies a pending question
        let b3 = broker.clone();
        let mut a2 = ask("q1", "AskUserQuestion", input);
        a2.suggestions.clear();
        let task = tokio::spawn(async move { b3.ask(a2).await });
        let _ = rx.recv().await.unwrap();
        broker.unregister("q1");
        assert_eq!(task.await.unwrap().result["behavior"], "deny");
    }

    #[test]
    fn classification_and_titles() {
        assert_eq!(classify("Bash"), PermissionKind::Command);
        assert_eq!(classify("Write"), PermissionKind::FileEdit);
        assert_eq!(classify("mcp__x__y"), PermissionKind::Tool);
        assert_eq!(classify("Weird"), PermissionKind::Other);
        let a = ask("s", "Edit", json!({"file_path": "/p/a.rs"}));
        assert_eq!(title_for(&a), "파일 수정: /p/a.rs");
        assert_eq!(allow_key(&a), "edit:/p");
    }
}
