//! Pure functions translating app-server JSON into `SessionEvent`s and vibecode
//! settings into app-server parameters. No I/O here so everything is unit-testable.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use serde_json::{json, Value};

use crate::types::{AgentQuestion, Effort, ModelInfo, PermissionDecision, PermissionKind, PermissionPreset, PlanStep, Provider, QuestionAnswer, QuestionOption, SessionEvent, Usage};

use super::rpc::id_key;

// ---------------------------------------------------------------------------
// Settings → protocol
// ---------------------------------------------------------------------------

/// Approval + sandbox settings derived from a permission preset.
#[derive(Debug, Clone, PartialEq)]
pub struct Policies {
    /// `AskForApproval`: "untrusted" | "on-request" | "never"
    pub approval_policy: &'static str,
    /// `SandboxMode` (thread/start): "read-only" | "workspace-write" | "danger-full-access"
    pub sandbox_mode: &'static str,
    /// `SandboxPolicy` object (turn/start override).
    pub sandbox_policy: Value,
}

/// - ReadOnly: nothing may be written; escalations are denied without asking.
/// - AskEverything: workspace-write sandbox, every non-trivial command prompts (`untrusted`).
///   Codex applies in-workspace file edits without a prompt; there is no policy that prompts for them.
/// - AutoEdit: workspace-write sandbox, prompts only when the agent asks to escalate (`on-request`).
/// - FullAuto: no sandbox, never prompts.
pub fn policies_for(preset: PermissionPreset, writable_root: &str) -> Policies {
    match preset {
        PermissionPreset::ReadOnly => Policies {
            approval_policy: "never",
            sandbox_mode: "read-only",
            sandbox_policy: json!({ "type": "readOnly", "networkAccess": false }),
        },
        PermissionPreset::AskEverything => Policies {
            approval_policy: "untrusted",
            sandbox_mode: "workspace-write",
            sandbox_policy: workspace_write(writable_root),
        },
        PermissionPreset::AutoEdit => Policies {
            approval_policy: "on-request",
            sandbox_mode: "workspace-write",
            sandbox_policy: workspace_write(writable_root),
        },
        PermissionPreset::FullAuto => Policies {
            approval_policy: "never",
            sandbox_mode: "danger-full-access",
            sandbox_policy: json!({ "type": "dangerFullAccess" }),
        },
    }
}

fn workspace_write(root: &str) -> Value {
    json!({
        "type": "workspaceWrite",
        "writableRoots": [root],
        "networkAccess": true,
        "excludeTmpdirEnvVar": false,
        "excludeSlashTmp": false
    })
}

/// Codex `ReasoningEffort` string → unified scale. "ultra" (delegating mode) maps to Max.
pub fn effort_from_codex(s: &str) -> Option<Effort> {
    match s {
        "minimal" | "none" => Some(Effort::Minimal),
        "low" => Some(Effort::Low),
        "medium" => Some(Effort::Medium),
        "high" => Some(Effort::High),
        "xhigh" => Some(Effort::XHigh),
        "max" | "ultra" => Some(Effort::Max),
        _ => None,
    }
}

/// Map a `Model` object from `model/list`.
pub fn model_from_json(v: &Value) -> Option<ModelInfo> {
    let id = v.get("model").or_else(|| v.get("id"))?.as_str()?.to_string();
    let label = v.get("displayName").and_then(|d| d.as_str()).unwrap_or(&id).to_string();
    let mut efforts: Vec<Effort> = v
        .get("supportedReasoningEfforts")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|o| o.get("reasoningEffort").and_then(|e| e.as_str()).and_then(effort_from_codex)).collect())
        .unwrap_or_default();
    efforts.sort_by_key(|e| *e as u8);
    efforts.dedup();
    Some(ModelInfo { provider: Provider::Codex, id, label, efforts, is_default: v.get("isDefault").and_then(|b| b.as_bool()).unwrap_or(false) })
}

/// Map a `model/list` result (`{data:[..]}`), skipping hidden models.
pub fn models_from_list(v: &Value) -> Vec<ModelInfo> {
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|a| a.iter().filter(|m| !m.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false)).filter_map(model_from_json).collect())
        .unwrap_or_default()
}

/// `turn/plan/updated` plan array → UI steps ("inProgress" → "in_progress").
pub fn plan_steps(plan: &Value) -> Vec<PlanStep> {
    plan.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let text = s.get("step").and_then(|t| t.as_str())?.to_string();
                    let status = match s.get("status").and_then(|t| t.as_str()).unwrap_or("pending") {
                        "inProgress" | "in_progress" => "in_progress",
                        "completed" => "completed",
                        _ => "pending",
                    }
                    .to_string();
                    Some(PlanStep { text, status })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `TokenUsageBreakdown` → `Usage`.
pub fn usage_from_breakdown(v: &Value) -> Usage {
    let n = |k: &str| v.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    Usage {
        input_tokens: n("inputTokens"),
        output_tokens: n("outputTokens"),
        cache_read_tokens: n("cachedInputTokens"),
        cache_write_tokens: n("cacheWriteInputTokens"),
    }
}

// ---------------------------------------------------------------------------
// Protocol → events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PendingApproval {
    pub rpc_id: Value,
    pub method: String,
    pub params: Value,
}

/// Per-thread buffers needed to turn the notification stream into events.
#[derive(Default)]
pub struct MapState {
    pub active_turn: Option<String>,
    pub turn_started: Option<Instant>,
    pub last_usage: Option<Usage>,
    pub output_buf: HashMap<String, String>,
    pub reasoning_buf: HashMap<String, String>,
    pub started_items: HashSet<String>,
    pub pending: HashMap<String, PendingApproval>,
    pub closed: bool,
}

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str())
}

fn item_id(item: &Value) -> String {
    s(item, "id").unwrap_or("").to_string()
}

/// `item/started` → optional ToolStart.
pub fn tool_start_for_item(item: &Value) -> Option<SessionEvent> {
    let id = item_id(item);
    let ev = match s(item, "type")? {
        "commandExecution" => SessionEvent::ToolStart {
            id,
            name: "Bash".into(),
            input: json!({ "command": item.get("command").cloned().unwrap_or(Value::Null), "cwd": item.get("cwd").cloned().unwrap_or(Value::Null) }),
        },
        "fileChange" => SessionEvent::ToolStart { id, name: "Edit".into(), input: json!({ "changes": item.get("changes").cloned().unwrap_or(json!([])) }) },
        "mcpToolCall" => SessionEvent::ToolStart {
            id,
            name: format!("mcp__{}__{}", s(item, "server").unwrap_or("mcp"), s(item, "tool").unwrap_or("tool")),
            input: item.get("arguments").cloned().unwrap_or(Value::Null),
        },
        "dynamicToolCall" => SessionEvent::ToolStart { id, name: s(item, "tool").unwrap_or("tool").to_string(), input: item.get("arguments").cloned().unwrap_or(Value::Null) },
        "webSearch" => SessionEvent::ToolStart { id, name: "WebSearch".into(), input: json!({ "query": item.get("query").cloned().unwrap_or(Value::Null) }) },
        "imageView" => SessionEvent::ToolStart { id, name: "Read".into(), input: json!({ "path": item.get("path").cloned().unwrap_or(Value::Null) }) },
        _ => return None,
    };
    Some(ev)
}

fn format_changes(changes: &Value) -> String {
    let mut out = String::new();
    if let Some(arr) = changes.as_array() {
        for c in arr {
            let path = s(c, "path").unwrap_or("?");
            let kind = c.get("kind").and_then(|k| s(k, "type")).unwrap_or("update");
            out.push_str(&format!("{kind}: {path}\n"));
            if let Some(d) = s(c, "diff") {
                out.push_str(d);
                if !d.ends_with('\n') {
                    out.push('\n');
                }
            }
        }
    }
    out
}

/// `item/completed` → events (ToolEnd / Text / Thinking / Status).
pub fn events_for_completed_item(state: &mut MapState, item: &Value) -> Vec<SessionEvent> {
    let id = item_id(item);
    let status = s(item, "status").unwrap_or("completed");
    let failed = matches!(status, "failed" | "declined");
    let mut out = Vec::new();
    let ty = s(item, "type").unwrap_or("");
    // Emit a synthetic ToolStart if the start notification was missed.
    if matches!(ty, "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" | "webSearch" | "imageView") && !state.started_items.contains(&id) {
        if let Some(ev) = tool_start_for_item(item) {
            out.push(ev);
        }
    }
    state.started_items.remove(&id);
    match ty {
        "agentMessage" => out.push(SessionEvent::Text { text: s(item, "text").unwrap_or("").to_string() }),
        "plan" => out.push(SessionEvent::Text { text: s(item, "text").unwrap_or("").to_string() }),
        "reasoning" => {
            let join = |k: &str| {
                item.get(k)
                    .and_then(|a| a.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\n\n"))
                    .unwrap_or_default()
            };
            let mut text = join("summary");
            if text.trim().is_empty() {
                text = join("content");
            }
            if text.trim().is_empty() {
                text = state.reasoning_buf.remove(&id).unwrap_or_default();
            } else {
                state.reasoning_buf.remove(&id);
            }
            if !text.trim().is_empty() {
                out.push(SessionEvent::Thinking { text });
            }
        }
        "commandExecution" => {
            let mut output = s(item, "aggregatedOutput").map(|x| x.to_string()).unwrap_or_default();
            if output.is_empty() {
                output = state.output_buf.remove(&id).unwrap_or_default();
            } else {
                state.output_buf.remove(&id);
            }
            let exit = item.get("exitCode").and_then(|x| x.as_i64());
            let is_error = failed || matches!(exit, Some(c) if c != 0);
            if let Some(c) = exit {
                if c != 0 {
                    output.push_str(&format!("\n[exit code {c}]"));
                }
            }
            if failed {
                output.push_str(&format!("\n[{status}]"));
            }
            out.push(SessionEvent::ToolEnd { id, output, is_error });
        }
        "fileChange" => {
            let mut output = format_changes(item.get("changes").unwrap_or(&Value::Null));
            if failed {
                output.push_str(&format!("[{status}]\n"));
            }
            out.push(SessionEvent::ToolEnd { id, output, is_error: failed });
        }
        "mcpToolCall" => {
            let err = item.get("error").filter(|e| !e.is_null());
            let output = match err {
                Some(e) => s(e, "message").unwrap_or("mcp tool error").to_string(),
                None => item.get("result").filter(|r| !r.is_null()).map(|r| serde_json::to_string_pretty(r).unwrap_or_default()).unwrap_or_default(),
            };
            out.push(SessionEvent::ToolEnd { id, output, is_error: failed || err.is_some() });
        }
        "dynamicToolCall" => {
            let output = item.get("contentItems").filter(|r| !r.is_null()).map(|r| serde_json::to_string_pretty(r).unwrap_or_default()).unwrap_or_default();
            let is_error = failed || item.get("success").and_then(|b| b.as_bool()) == Some(false);
            out.push(SessionEvent::ToolEnd { id, output, is_error });
        }
        "webSearch" => {
            let output = item.get("results").filter(|r| !r.is_null()).map(|r| serde_json::to_string_pretty(r).unwrap_or_default()).unwrap_or_default();
            out.push(SessionEvent::ToolEnd { id, output, is_error: false });
        }
        "imageView" => out.push(SessionEvent::ToolEnd { id, output: String::new(), is_error: false }),
        "contextCompaction" => out.push(SessionEvent::Status { message: "Context compacted".into() }),
        "enteredReviewMode" => out.push(SessionEvent::Status { message: format!("Entered review mode: {}", s(item, "review").unwrap_or("")) }),
        "exitedReviewMode" => out.push(SessionEvent::Status { message: "Exited review mode".into() }),
        _ => {}
    }
    out
}

/// Translate one server notification into zero or more events.
pub fn map_notification(state: &mut MapState, method: &str, params: &Value) -> Vec<SessionEvent> {
    let mut out = Vec::new();
    match method {
        "turn/started" => {
            if let Some(id) = params.get("turn").and_then(|t| s(t, "id")) {
                state.active_turn = Some(id.to_string());
            }
            if state.turn_started.is_none() {
                state.turn_started = Some(Instant::now());
            }
        }
        "turn/completed" => {
            let turn = params.get("turn").cloned().unwrap_or(Value::Null);
            let status = s(&turn, "status").unwrap_or("completed").to_string();
            if let Some(err) = turn.get("error").filter(|e| !e.is_null()) {
                out.push(SessionEvent::Error { message: error_message(err), fatal: false });
            }
            // Any approval still pending is void once the turn is over.
            for (rid, _) in state.pending.drain() {
                out.push(SessionEvent::PermissionResolved { request_id: rid, decision: PermissionDecision::Deny });
            }
            let duration_ms = turn
                .get("durationMs")
                .and_then(|d| d.as_i64())
                .or_else(|| state.turn_started.map(|t| t.elapsed().as_millis() as i64))
                .unwrap_or(0);
            out.push(SessionEvent::TurnEnd { cost_usd: None, usage: state.last_usage.take().unwrap_or_default(), duration_ms, stop_reason: Some(status) });
            state.active_turn = None;
            state.turn_started = None;
        }
        "item/started" => {
            if let Some(item) = params.get("item") {
                if let Some(ev) = tool_start_for_item(item) {
                    state.started_items.insert(item_id(item));
                    out.push(ev);
                }
            }
        }
        "item/completed" => {
            if let Some(item) = params.get("item") {
                out.extend(events_for_completed_item(state, item));
            }
        }
        "item/agentMessage/delta" => {
            if let Some(d) = s(params, "delta") {
                out.push(SessionEvent::TextDelta { text: d.to_string() });
            }
        }
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
            if let (Some(id), Some(d)) = (s(params, "itemId"), s(params, "delta")) {
                state.reasoning_buf.entry(id.to_string()).or_default().push_str(d);
            }
        }
        "item/commandExecution/outputDelta" => {
            if let (Some(id), Some(d)) = (s(params, "itemId"), s(params, "delta")) {
                state.output_buf.entry(id.to_string()).or_default().push_str(d);
            }
        }
        "turn/plan/updated" => out.push(SessionEvent::Plan { steps: plan_steps(params.get("plan").unwrap_or(&Value::Null)) }),
        "thread/tokenUsage/updated" => {
            if let Some(last) = params.get("tokenUsage").and_then(|u| u.get("last")) {
                state.last_usage = Some(usage_from_breakdown(last));
            }
        }
        "error" => {
            let msg = params.get("error").map(error_message).unwrap_or_else(|| "unknown error".into());
            if params.get("willRetry").and_then(|b| b.as_bool()).unwrap_or(false) {
                out.push(SessionEvent::Status { message: format!("Retrying: {msg}") });
            } else {
                out.push(SessionEvent::Error { message: msg, fatal: false });
            }
        }
        "warning" | "guardianWarning" | "configWarning" => {
            let msg = s(params, "message").or_else(|| s(params, "summary")).unwrap_or("");
            if !msg.is_empty() {
                out.push(SessionEvent::Status { message: msg.to_string() });
            }
        }
        "model/rerouted" => {
            let to = s(params, "toModel").or_else(|| s(params, "model")).unwrap_or("another model");
            out.push(SessionEvent::Status { message: format!("Model rerouted to {to}") });
        }
        "serverRequest/resolved" => {
            if let Some(rid) = params.get("requestId") {
                let key = id_key(rid);
                if state.pending.remove(&key).is_some() {
                    out.push(SessionEvent::PermissionResolved { request_id: key, decision: PermissionDecision::Deny });
                }
            }
        }
        "thread/closed" => {
            state.closed = true;
            out.push(SessionEvent::Exited { code: None });
        }
        _ => {}
    }
    out
}

fn error_message(err: &Value) -> String {
    let mut msg = s(err, "message").unwrap_or("unknown error").to_string();
    if let Some(info) = err.get("codexErrorInfo").filter(|i| !i.is_null()) {
        let code = match info {
            Value::String(c) => c.clone(),
            Value::Object(o) => o.keys().next().cloned().unwrap_or_default(),
            _ => String::new(),
        };
        if !code.is_empty() && !msg.contains(&code) {
            msg = format!("{msg} ({code})");
        }
        if code == "unauthorized" || msg.contains("401") {
            msg.push_str(" — run `codex login` in the backend");
        }
    }
    msg
}

/// Translate a server-initiated request into a PermissionRequest (registering it as
/// pending). `None` means the request is unsupported and should get an error response.
pub fn map_server_request(state: &mut MapState, id: &Value, method: &str, params: &Value) -> Option<SessionEvent> {
    if method == "item/tool/requestUserInput" {
        // Structured questions: `questions[{id, header, question, isOther, isSecret, options[{label, description}] | null}]`.
        let questions = codex_questions(params);
        if !questions.is_empty() {
            let key = id_key(id);
            state.pending.insert(key.clone(), PendingApproval { rpc_id: id.clone(), method: method.to_string(), params: params.clone() });
            return Some(SessionEvent::Question { request_id: key, questions });
        }
    }
    let (kind, title) = match method {
        "item/commandExecution/requestApproval" => {
            let cmd = s(params, "command").map(|c| c.to_string()).unwrap_or_else(|| "Run command".into());
            (PermissionKind::Command, cmd)
        }
        "execCommandApproval" => {
            let cmd = params
                .get("command")
                .and_then(|c| c.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" "))
                .unwrap_or_else(|| "Run command".into());
            (PermissionKind::Command, cmd)
        }
        "item/fileChange/requestApproval" | "applyPatchApproval" => (PermissionKind::FileEdit, s(params, "reason").unwrap_or("Apply file changes").to_string()),
        "item/permissions/requestApproval" => (PermissionKind::Other, s(params, "reason").unwrap_or("Grant additional permissions").to_string()),
        "item/tool/requestUserInput" => {
            let q = params
                .get("questions")
                .and_then(|a| a.as_array())
                .and_then(|a| a.first())
                .and_then(|q| s(q, "question"))
                .unwrap_or("The agent is asking for input");
            (PermissionKind::Other, q.to_string())
        }
        "mcpServer/elicitation/request" => (PermissionKind::Other, s(params, "message").unwrap_or("MCP server request").to_string()),
        _ => return None,
    };
    let key = id_key(id);
    state.pending.insert(key.clone(), PendingApproval { rpc_id: id.clone(), method: method.to_string(), params: params.clone() });
    Some(SessionEvent::PermissionRequest { request_id: key, kind, title, detail: params.clone() })
}

/// Config overrides for `thread/start|resume|fork` (`config: {<key path>: value}`) declaring the
/// user's MCP servers the way `~/.codex/config.toml` `[mcp_servers.<name>]` does:
/// stdio `{command, args, env}` / http `{url}`. Dotted keys merge per server, so user-defined
/// servers in config.toml are left untouched.
pub fn mcp_config_overrides(servers: &[crate::types::McpServerConfig]) -> serde_json::Map<String, Value> {
    use crate::types::McpTransport;
    let mut map = serde_json::Map::new();
    for srv in servers.iter().filter(|x| x.enabled && (x.providers.is_empty() || x.providers.contains(&Provider::Codex))) {
        let name = srv.name.trim();
        if name.is_empty() || name.contains('.') || name.contains('"') {
            continue;
        }
        let entry = match srv.transport {
            McpTransport::Stdio => {
                let Some(cmd) = srv.command.as_deref().map(str::trim).filter(|c| !c.is_empty()) else { continue };
                let env: serde_json::Map<String, Value> = srv.env.iter().filter(|e| !e.key.trim().is_empty()).map(|e| (e.key.trim().to_string(), Value::String(e.value.clone()))).collect();
                let mut v = json!({ "command": cmd, "args": srv.args });
                if !env.is_empty() {
                    v["env"] = Value::Object(env);
                }
                v
            }
            McpTransport::Http => {
                let Some(url) = srv.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) else { continue };
                json!({ "url": url })
            }
        };
        map.insert(format!("mcp_servers.{name}"), entry);
    }
    map
}

/// `item/tool/requestUserInput` questions → UI questions (single-select; `isOther`/no options → free text).
pub fn codex_questions(params: &Value) -> Vec<AgentQuestion> {
    params
        .get("questions")
        .and_then(|a| a.as_array())
        .map(|qs| {
            qs.iter()
                .filter_map(|q| {
                    let id = s(q, "id")?.to_string();
                    let options: Vec<QuestionOption> = q
                        .get("options")
                        .and_then(|o| o.as_array())
                        .map(|o| {
                            o.iter()
                                .filter_map(|opt| Some(QuestionOption { label: s(opt, "label")?.to_string(), description: s(opt, "description").map(String::from) }))
                                .collect()
                        })
                        .unwrap_or_default();
                    let is_other = q.get("isOther").and_then(|b| b.as_bool()).unwrap_or(false);
                    Some(AgentQuestion {
                        id,
                        header: s(q, "header").unwrap_or("").to_string(),
                        question: s(q, "question").unwrap_or("").to_string(),
                        allow_free_text: is_other || options.is_empty(),
                        options,
                        multi_select: false,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// JSON-RPC `result` for `item/tool/requestUserInput`: `{answers: {<question id>: {answers: [..]}}}`.
pub fn question_response(answers: &[QuestionAnswer]) -> Value {
    let mut map = serde_json::Map::new();
    for a in answers {
        let list: Vec<Value> = a.answers.iter().map(|x| x.trim()).filter(|x| !x.is_empty()).map(|x| Value::String(x.to_string())).collect();
        map.insert(a.question_id.clone(), json!({ "answers": list }));
    }
    json!({ "answers": Value::Object(map) })
}

/// Build the JSON-RPC `result` answering a pending approval.
pub fn approval_response(pending: &PendingApproval, decision: PermissionDecision, message: Option<&str>) -> Value {
    match pending.method.as_str() {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let d = match decision {
                PermissionDecision::Allow => "accept",
                PermissionDecision::AllowSession => "acceptForSession",
                PermissionDecision::Deny => "decline",
            };
            json!({ "decision": d })
        }
        "execCommandApproval" | "applyPatchApproval" => match decision {
            PermissionDecision::Allow => json!({ "decision": "approved" }),
            PermissionDecision::AllowSession => json!({ "decision": "approved_for_session" }),
            PermissionDecision::Deny => json!({ "decision": { "denied": { "rejection": message.unwrap_or("Denied by user") } } }),
        },
        "item/permissions/requestApproval" => {
            let mut granted = serde_json::Map::new();
            if decision != PermissionDecision::Deny {
                if let Some(req) = pending.params.get("permissions").and_then(|p| p.as_object()) {
                    for (k, v) in req {
                        if !v.is_null() {
                            granted.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
            let scope = if decision == PermissionDecision::AllowSession { "session" } else { "turn" };
            json!({ "permissions": Value::Object(granted), "scope": scope })
        }
        "item/tool/requestUserInput" => json!({ "answers": {} }),
        "mcpServer/elicitation/request" => match decision {
            PermissionDecision::Deny => json!({ "action": "decline", "content": null, "_meta": null }),
            _ => json!({ "action": "accept", "content": {}, "_meta": null }),
        },
        _ => json!({}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TURN_BASIC: &str = include_str!("../../../tests/fixtures/codex/turn_basic.jsonl");
    const APPROVAL: &str = include_str!("../../../tests/fixtures/codex/approval_request.json");
    const MODEL_LIST: &str = include_str!("../../../tests/fixtures/codex/model_list.json");

    fn run_fixture(state: &mut MapState, jsonl: &str) -> Vec<SessionEvent> {
        let mut out = Vec::new();
        for line in jsonl.lines().filter(|l| !l.trim().is_empty()) {
            let v: Value = serde_json::from_str(line).expect("fixture json");
            let method = v["method"].as_str().unwrap();
            out.extend(map_notification(state, method, &v["params"]));
        }
        out
    }

    fn kinds(evs: &[SessionEvent]) -> Vec<&'static str> {
        evs.iter()
            .map(|e| match e {
                SessionEvent::Init { .. } => "init",
                SessionEvent::UserMessage { .. } => "user_message",
                SessionEvent::TextDelta { .. } => "text_delta",
                SessionEvent::Text { .. } => "text",
                SessionEvent::Thinking { .. } => "thinking",
                SessionEvent::ToolStart { .. } => "tool_start",
                SessionEvent::ToolEnd { .. } => "tool_end",
                SessionEvent::PermissionRequest { .. } => "permission_request",
                SessionEvent::PermissionResolved { .. } => "permission_resolved",
                SessionEvent::Plan { .. } => "plan",
                SessionEvent::Status { .. } => "status",
                SessionEvent::TurnEnd { .. } => "turn_end",
                SessionEvent::Error { .. } => "error",
                SessionEvent::Exited { .. } => "exited",
                SessionEvent::Question { .. } => "question",
                SessionEvent::QuestionResolved { .. } => "question_resolved",
                SessionEvent::Subagent { .. } => "subagent",
                SessionEvent::Checkpoint { .. } => "checkpoint",
            })
            .collect()
    }

    #[test]
    fn basic_turn_maps_to_events() {
        let mut st = MapState::default();
        let evs = run_fixture(&mut st, TURN_BASIC);
        assert_eq!(
            kinds(&evs),
            vec![
                "thinking", "text_delta", "text_delta", "text", "tool_start", "tool_end", "tool_start", "tool_end", "plan", "turn_end"
            ]
        );
        match &evs[0] {
            SessionEvent::Thinking { text } => assert_eq!(text, "Looking at the repo"),
            other => panic!("{other:?}"),
        }
        match &evs[3] {
            SessionEvent::Text { text } => assert_eq!(text, "Hello world"),
            other => panic!("{other:?}"),
        }
        match &evs[4] {
            SessionEvent::ToolStart { id, name, input } => {
                assert_eq!(id, "item_cmd");
                assert_eq!(name, "Bash");
                assert_eq!(input["command"], "ls -la");
            }
            other => panic!("{other:?}"),
        }
        match &evs[5] {
            SessionEvent::ToolEnd { output, is_error, .. } => {
                assert!(output.contains("total 0"), "{output}");
                assert!(!is_error);
            }
            other => panic!("{other:?}"),
        }
        match &evs[6] {
            SessionEvent::ToolStart { name, input, .. } => {
                assert_eq!(name, "Edit");
                assert_eq!(input["changes"][0]["path"], "src/main.rs");
            }
            other => panic!("{other:?}"),
        }
        match &evs[8] {
            SessionEvent::Plan { steps } => {
                assert_eq!(steps.len(), 2);
                assert_eq!(steps[0].status, "completed");
                assert_eq!(steps[1].status, "in_progress");
            }
            other => panic!("{other:?}"),
        }
        match &evs[9] {
            SessionEvent::TurnEnd { usage, stop_reason, duration_ms, .. } => {
                assert_eq!(usage.input_tokens, 1200);
                assert_eq!(usage.cache_read_tokens, 800);
                assert_eq!(usage.output_tokens, 45);
                assert_eq!(stop_reason.as_deref(), Some("completed"));
                assert_eq!(*duration_ms, 4321);
            }
            other => panic!("{other:?}"),
        }
        assert!(st.active_turn.is_none());
        assert!(st.last_usage.is_none());
    }

    #[test]
    fn failed_command_and_failed_turn() {
        let mut st = MapState::default();
        let item = json!({ "type": "commandExecution", "id": "c1", "command": "false", "cwd": "/x", "status": "completed", "exitCode": 1, "aggregatedOutput": "" });
        let evs = events_for_completed_item(&mut st, &item);
        // start was never seen → synthetic ToolStart first
        assert_eq!(kinds(&evs), vec!["tool_start", "tool_end"]);
        match &evs[1] {
            SessionEvent::ToolEnd { is_error, output, .. } => {
                assert!(is_error);
                assert!(output.contains("exit code 1"));
            }
            _ => unreachable!(),
        }
        let params = json!({ "threadId": "t", "turn": { "id": "u", "status": "failed", "items": [], "error": { "message": "boom", "codexErrorInfo": "unauthorized" } } });
        let evs = map_notification(&mut st, "turn/completed", &params);
        assert_eq!(kinds(&evs), vec!["error", "turn_end"]);
        match &evs[0] {
            SessionEvent::Error { message, fatal } => {
                assert!(message.contains("boom") && message.contains("codex login"), "{message}");
                assert!(!fatal);
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn error_notification_retry_vs_final() {
        let mut st = MapState::default();
        let retry = map_notification(&mut st, "error", &json!({ "error": { "message": "x" }, "willRetry": true, "threadId": "t", "turnId": "u" }));
        assert_eq!(kinds(&retry), vec!["status"]);
        let fin = map_notification(&mut st, "error", &json!({ "error": { "message": "x" }, "willRetry": false, "threadId": "t", "turnId": "u" }));
        assert_eq!(kinds(&fin), vec!["error"]);
    }

    #[test]
    fn approval_request_roundtrip() {
        let mut st = MapState::default();
        let req: Value = serde_json::from_str(APPROVAL).unwrap();
        let ev = map_server_request(&mut st, &req["id"], req["method"].as_str().unwrap(), &req["params"]).expect("mapped");
        let rid = match &ev {
            SessionEvent::PermissionRequest { request_id, kind, title, .. } => {
                assert_eq!(*kind, PermissionKind::Command);
                assert_eq!(title, "npm test");
                request_id.clone()
            }
            other => panic!("{other:?}"),
        };
        assert_eq!(rid, "42");
        let pending = st.pending.remove(&rid).unwrap();
        assert_eq!(approval_response(&pending, PermissionDecision::Allow, None), json!({ "decision": "accept" }));
        assert_eq!(approval_response(&pending, PermissionDecision::AllowSession, None), json!({ "decision": "acceptForSession" }));
        assert_eq!(approval_response(&pending, PermissionDecision::Deny, None), json!({ "decision": "decline" }));

        let legacy = PendingApproval { rpc_id: json!(7), method: "execCommandApproval".into(), params: json!({}) };
        assert_eq!(approval_response(&legacy, PermissionDecision::Deny, Some("no")), json!({ "decision": { "denied": { "rejection": "no" } } }));

        let perms = PendingApproval {
            rpc_id: json!(8),
            method: "item/permissions/requestApproval".into(),
            params: json!({ "permissions": { "network": { "hosts": ["a"] }, "fileSystem": null } }),
        };
        assert_eq!(
            approval_response(&perms, PermissionDecision::AllowSession, None),
            json!({ "permissions": { "network": { "hosts": ["a"] } }, "scope": "session" })
        );
        assert_eq!(approval_response(&perms, PermissionDecision::Deny, None), json!({ "permissions": {}, "scope": "turn" }));
    }

    #[test]
    fn pending_approvals_void_on_turn_end_and_server_resolution() {
        let mut st = MapState::default();
        map_server_request(&mut st, &json!(5), "item/fileChange/requestApproval", &json!({ "threadId": "t", "turnId": "u", "itemId": "i" })).unwrap();
        let evs = map_notification(&mut st, "serverRequest/resolved", &json!({ "threadId": "t", "requestId": 5 }));
        assert_eq!(kinds(&evs), vec!["permission_resolved"]);
        assert!(st.pending.is_empty());

        map_server_request(&mut st, &json!(6), "item/commandExecution/requestApproval", &json!({ "command": "rm -rf x" })).unwrap();
        let evs = map_notification(&mut st, "turn/completed", &json!({ "turn": { "id": "u", "status": "interrupted" } }));
        assert_eq!(kinds(&evs), vec!["permission_resolved", "turn_end"]);
    }

    #[test]
    fn mcp_overrides_use_dotted_keys_and_filter_providers() {
        use crate::types::{EnvVar, McpServerConfig, McpTransport};
        let servers = vec![
            McpServerConfig { id: "1".into(), name: "fs".into(), transport: McpTransport::Stdio, command: Some("npx".into()), args: vec!["-y".into(), "srv".into()], env: vec![EnvVar { key: "K".into(), value: "v".into() }], url: None, enabled: true, providers: vec![] },
            McpServerConfig { id: "2".into(), name: "web".into(), transport: McpTransport::Http, command: None, args: vec![], env: vec![], url: Some("https://h/mcp".into()), enabled: true, providers: vec![Provider::Codex] },
            McpServerConfig { id: "3".into(), name: "claude-only".into(), transport: McpTransport::Http, command: None, args: vec![], env: vec![], url: Some("https://c".into()), enabled: true, providers: vec![Provider::Claude] },
        ];
        let o = mcp_config_overrides(&servers);
        assert_eq!(o.len(), 2);
        assert_eq!(o["mcp_servers.fs"]["command"], "npx");
        assert_eq!(o["mcp_servers.fs"]["env"]["K"], "v");
        assert_eq!(o["mcp_servers.web"]["url"], "https://h/mcp");
        assert!(o.get("mcp_servers.claude-only").is_none());
    }

    #[test]
    fn request_user_input_becomes_question() {
        let mut st = MapState::default();
        let params = json!({
            "threadId": "t", "turnId": "u", "itemId": "i", "isBlocking": true, "autoResolutionMs": null,
            "questions": [
                {"id": "q1", "header": "Framework", "question": "Which framework?", "isOther": true, "isSecret": false, "options": [{"label": "React", "description": "ui"}, {"label": "Vue", "description": "ui"}]},
                {"id": "q2", "header": "Name", "question": "Project name?", "isOther": false, "isSecret": false, "options": null}
            ]
        });
        let ev = map_server_request(&mut st, &json!(42), "item/tool/requestUserInput", &params).expect("mapped");
        let (rid, qs) = match ev { SessionEvent::Question { request_id, questions } => (request_id, questions), o => panic!("{o:?}") };
        assert_eq!(qs.len(), 2);
        assert_eq!(qs[0].id, "q1");
        assert_eq!(qs[0].options[1].label, "Vue");
        assert!(qs[0].allow_free_text);
        assert!(!qs[0].multi_select);
        assert!(qs[1].options.is_empty() && qs[1].allow_free_text);
        assert!(st.pending.contains_key(&rid));
        let resp = question_response(&[QuestionAnswer { question_id: "q1".into(), answers: vec!["React".into()] }, QuestionAnswer { question_id: "q2".into(), answers: vec!["demo".into()] }]);
        assert_eq!(resp["answers"]["q1"]["answers"][0], "React");
        assert_eq!(resp["answers"]["q2"]["answers"][0], "demo");
        // closing voids it with an empty answer set
        let p = st.pending.remove(&rid).unwrap();
        assert_eq!(approval_response(&p, PermissionDecision::Deny, None)["answers"], json!({}));
    }

    #[test]
    fn unsupported_server_request_is_none() {
        let mut st = MapState::default();
        assert!(map_server_request(&mut st, &json!(1), "account/chatgptAuthTokens/refresh", &json!({})).is_none());
        assert!(st.pending.is_empty());
    }

    #[test]
    fn model_list_mapping() {
        let v: Value = serde_json::from_str(MODEL_LIST).unwrap();
        let models = models_from_list(&v);
        assert_eq!(models.len(), 2, "hidden model skipped");
        let sol = &models[0];
        assert_eq!(sol.id, "gpt-5.6-sol");
        assert_eq!(sol.label, "GPT-5.6-Sol");
        assert!(sol.is_default);
        assert_eq!(sol.efforts, vec![Effort::Low, Effort::Medium, Effort::High, Effort::XHigh, Effort::Max]);
        assert_eq!(models[1].efforts, vec![Effort::Minimal, Effort::Low, Effort::Medium]);
    }

    #[test]
    fn policies() {
        let p = policies_for(PermissionPreset::ReadOnly, "/w");
        assert_eq!((p.approval_policy, p.sandbox_mode), ("never", "read-only"));
        let p = policies_for(PermissionPreset::AskEverything, "/w");
        assert_eq!((p.approval_policy, p.sandbox_mode), ("untrusted", "workspace-write"));
        assert_eq!(p.sandbox_policy["writableRoots"][0], "/w");
        let p = policies_for(PermissionPreset::AutoEdit, "/w");
        assert_eq!((p.approval_policy, p.sandbox_mode), ("on-request", "workspace-write"));
        let p = policies_for(PermissionPreset::FullAuto, "/w");
        assert_eq!((p.approval_policy, p.sandbox_mode), ("never", "danger-full-access"));
        assert_eq!(p.sandbox_policy["type"], "dangerFullAccess");
    }

    #[test]
    fn thread_closed_emits_exited() {
        let mut st = MapState::default();
        let evs = map_notification(&mut st, "thread/closed", &json!({ "threadId": "t" }));
        assert_eq!(kinds(&evs), vec!["exited"]);
        assert!(st.closed);
    }
}
