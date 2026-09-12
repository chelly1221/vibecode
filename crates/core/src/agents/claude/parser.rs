//! Translates Claude Code's stream-json NDJSON lines into provider-agnostic
//! `SessionEvent`s plus the control-protocol messages the adapter itself needs.
//! Shapes verified against CLI 2.1.260 fixtures in `tests/fixtures/claude_*.jsonl`.

use std::collections::HashMap;

use serde_json::Value;

use crate::types::{PlanStep, Provider, RateLimitWindow, SessionEvent, Usage};

/// Anything the parser extracts from one stdout line.
#[derive(Debug, Clone)]
pub enum Parsed {
    Event(SessionEvent),
    /// `system/init`: session id, model, tools, capabilities.
    Init { session_id: String, model: String, tools: Vec<String>, capabilities: Vec<String>, permission_mode: Option<String> },
    /// Inbound `control_request` from the CLI (e.g. `can_use_tool`).
    ControlRequest { request_id: String, request: Value },
    /// Reply to one of our `control_request`s.
    ControlResponse { request_id: String, success: bool, response: Value, error: Option<String> },
    /// Line was valid but carries nothing the UI needs (rate limits, replayed user text, ...).
    Ignore,
    /// Not JSON (stderr noise piped into stdout, banners, ...).
    NotJson(String),
}

/// Incremental state: which content blocks are open, so `assistant` messages
/// (complete blocks) can be paired with the deltas that preceded them.
#[derive(Default, Debug)]
pub struct Parser {
    /// Tool-use ids we already emitted ToolStart for.
    started_tools: HashMap<String, String>,
    /// Text we streamed for the current open text block (per content index).
    streamed_text: HashMap<i64, String>,
    /// Whether the current message had any text deltas (to avoid duplicating Text after deltas).
    pub saw_text_delta: bool,
}

impl Parser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn parse_line(&mut self, line: &str) -> Vec<Parsed> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return vec![];
        }
        let v: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => return vec![Parsed::NotJson(trimmed.to_string())],
        };
        self.parse_value(&v)
    }

    pub fn parse_value(&mut self, v: &Value) -> Vec<Parsed> {
        let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
        // Subagent traffic (--forward-subagent-text): same shapes, tagged with the spawning
        // tool call's id. Parse it like the main transcript and wrap every event.
        if let Some(parent) = v.get("parent_tool_use_id").and_then(Value::as_str).filter(|p| !p.is_empty()) {
            let parent = parent.to_string();
            let inner = match ty {
                "stream_event" => self.parse_stream_event(v),
                "assistant" => self.parse_assistant(v),
                "user" => self.parse_user_inner(v, true),
                _ => vec![Parsed::Ignore],
            };
            return inner
                .into_iter()
                .map(|p| match p {
                    Parsed::Event(ev) => Parsed::Event(SessionEvent::Subagent { parent_tool_use_id: parent.clone(), event: Box::new(ev) }),
                    other => other,
                })
                .collect();
        }
        match ty {
            "system" => self.parse_system(v),
            "stream_event" => self.parse_stream_event(v),
            "assistant" => self.parse_assistant(v),
            "user" => self.parse_user_inner(v, false),
            "result" => self.parse_result(v),
            "control_request" => {
                let request_id = v.get("request_id").and_then(Value::as_str).unwrap_or("").to_string();
                vec![Parsed::ControlRequest { request_id, request: v.get("request").cloned().unwrap_or(Value::Null) }]
            }
            "control_response" => {
                let r = v.get("response").cloned().unwrap_or(Value::Null);
                let request_id = r.get("request_id").and_then(Value::as_str).unwrap_or("").to_string();
                let success = r.get("subtype").and_then(Value::as_str) == Some("success");
                let error = r.get("error").and_then(Value::as_str).map(|s| s.to_string());
                vec![Parsed::ControlResponse { request_id, success, response: r.get("response").cloned().unwrap_or(Value::Null), error }]
            }
            "rate_limit_event" => {
                let windows = v.get("rate_limit_info").map(rate_limit_windows).unwrap_or_default();
                if windows.is_empty() {
                    vec![Parsed::Ignore]
                } else {
                    vec![Parsed::Event(SessionEvent::RateLimits { provider: Provider::Claude, account_id: None, windows, observed_at: chrono::Utc::now().timestamp() })]
                }
            }
            "control_cancel_request" | "keep_alive" => vec![Parsed::Ignore],
            "error" => vec![Parsed::Event(SessionEvent::Error {
                message: v.get("message").or_else(|| v.get("error")).map(value_to_string).unwrap_or_else(|| "unknown error".into()),
                fatal: false,
            })],
            _ => vec![Parsed::Ignore],
        }
    }

    fn parse_system(&mut self, v: &Value) -> Vec<Parsed> {
        let subtype = v.get("subtype").and_then(Value::as_str).unwrap_or("");
        match subtype {
            "init" => {
                let session_id = str_field(v, "session_id");
                let model = str_field(v, "model");
                let tools = v.get("tools").and_then(Value::as_array).map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect()).unwrap_or_default();
                let capabilities = v.get("capabilities").and_then(Value::as_array).map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect()).unwrap_or_default();
                let permission_mode = v.get("permissionMode").and_then(Value::as_str).map(String::from);
                vec![Parsed::Init { session_id, model, tools, capabilities, permission_mode }]
            }
            "api_retry" => {
                let attempt = v.get("attempt").and_then(Value::as_i64).unwrap_or(0);
                let max = v.get("max_retries").and_then(Value::as_i64).unwrap_or(0);
                let err = v.get("error").and_then(Value::as_str).unwrap_or("unknown");
                vec![Parsed::Event(SessionEvent::Status { message: format!("API 재시도 {attempt}/{max} ({err})") })]
            }
            "permission_denied" => {
                let tool = v.get("tool_name").and_then(Value::as_str).unwrap_or("tool");
                vec![Parsed::Event(SessionEvent::Status { message: format!("권한 거부됨: {tool}") })]
            }
            "compact_boundary" => vec![Parsed::Event(SessionEvent::Status { message: "컨텍스트가 압축되었습니다".into() })],
            "status" => {
                // {"status":"requesting"} while waiting for the API; mode changes carry permissionMode.
                if let Some(mode) = v.get("permissionMode").and_then(Value::as_str) {
                    return vec![Parsed::Event(SessionEvent::Status { message: format!("권한 모드: {mode}") })];
                }
                vec![Parsed::Ignore]
            }
            _ => vec![Parsed::Ignore],
        }
    }

    fn parse_stream_event(&mut self, v: &Value) -> Vec<Parsed> {
        let Some(ev) = v.get("event") else { return vec![Parsed::Ignore] };
        let ety = ev.get("type").and_then(Value::as_str).unwrap_or("");
        match ety {
            "message_start" => {
                self.streamed_text.clear();
                self.saw_text_delta = false;
                vec![Parsed::Ignore]
            }
            "content_block_start" => {
                let idx = ev.get("index").and_then(Value::as_i64).unwrap_or(0);
                if let Some(block) = ev.get("content_block") {
                    if block.get("type").and_then(Value::as_str) == Some("text") {
                        self.streamed_text.insert(idx, String::new());
                    }
                }
                vec![Parsed::Ignore]
            }
            "content_block_delta" => {
                let idx = ev.get("index").and_then(Value::as_i64).unwrap_or(0);
                let Some(delta) = ev.get("delta") else { return vec![Parsed::Ignore] };
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        let text = delta.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                        if text.is_empty() {
                            return vec![Parsed::Ignore];
                        }
                        self.saw_text_delta = true;
                        self.streamed_text.entry(idx).or_default().push_str(&text);
                        vec![Parsed::Event(SessionEvent::TextDelta { text })]
                    }
                    Some("thinking_delta") => {
                        let text = delta.get("thinking").and_then(Value::as_str).unwrap_or("").to_string();
                        if text.is_empty() { vec![Parsed::Ignore] } else { vec![Parsed::Event(SessionEvent::Thinking { text })] }
                    }
                    _ => vec![Parsed::Ignore],
                }
            }
            _ => vec![Parsed::Ignore],
        }
    }

    fn parse_assistant(&mut self, v: &Value) -> Vec<Parsed> {
        let mut out = vec![];
        let blocks = v.pointer("/message/content").and_then(Value::as_array).cloned().unwrap_or_default();
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = block.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                    if !text.is_empty() {
                        out.push(Parsed::Event(SessionEvent::Text { text }));
                    }
                }
                Some("thinking") => {
                    // Only meaningful when the CLI streams visible thinking; usually empty (display omitted).
                    let text = block.get("thinking").and_then(Value::as_str).unwrap_or("");
                    if !text.trim().is_empty() && !self.saw_text_delta {
                        out.push(Parsed::Event(SessionEvent::Thinking { text: text.to_string() }));
                    }
                }
                Some("tool_use") => {
                    let id = str_field(&block, "id");
                    let name = str_field(&block, "name");
                    if !self.started_tools.contains_key(&id) {
                        self.started_tools.insert(id.clone(), name.clone());
                        let input = block.get("input").cloned().unwrap_or(Value::Null);
                        if name == "TodoWrite" || name == "TaskCreate" || name == "TaskUpdate" {
                            if let Some(steps) = plan_from_todo(&input) {
                                out.push(Parsed::Event(SessionEvent::Plan { steps }));
                            }
                        }
                        out.push(Parsed::Event(SessionEvent::ToolStart { id, name, input }));
                    }
                }
                _ => {}
            }
        }
        if out.is_empty() { vec![Parsed::Ignore] } else { out }
    }

    /// `subagent`: the message belongs to a subagent transcript, where the initial user text is
    /// the prompt the parent gave it (worth showing); at top level user text is our own replay.
    fn parse_user_inner(&mut self, v: &Value, subagent: bool) -> Vec<Parsed> {
        let mut out = vec![];
        // Prefer tool_use_result (rich) over the plain tool_result content when present.
        let content = v.pointer("/message/content").cloned().unwrap_or(Value::Null);
        let blocks = match &content {
            Value::Array(a) => a.clone(),
            Value::String(text) => vec![serde_json::json!({ "type": "text", "text": text })],
            _ => vec![],
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("tool_result") => {
                    let id = str_field(&block, "tool_use_id");
                    let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                    let output = tool_result_text(block.get("content"));
                    self.started_tools.remove(&id);
                    out.push(Parsed::Event(SessionEvent::ToolEnd { id, output, is_error }));
                }
                Some("text") if subagent => {
                    let text = block.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                    if !text.trim().is_empty() {
                        out.push(Parsed::Event(SessionEvent::UserMessage { text }));
                    }
                }
                _ => {}
            }
        }
        // Replayed user text (from --replay-user-messages) is ignored: we emit UserMessage on send.
        if out.is_empty() { vec![Parsed::Ignore] } else { out }
    }

    fn parse_result(&mut self, v: &Value) -> Vec<Parsed> {
        let subtype = v.get("subtype").and_then(Value::as_str).unwrap_or("");
        let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false) || subtype.starts_with("error");
        let usage = v.get("usage").map(parse_usage).unwrap_or_default();
        let cost_usd = v.get("total_cost_usd").and_then(Value::as_f64);
        let duration_ms = v.get("duration_ms").and_then(Value::as_i64).unwrap_or(0);
        let stop_reason = v
            .get("stop_reason")
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| if subtype.is_empty() { None } else { Some(subtype.to_string()) });
        let mut out = vec![];
        if is_error {
            // Interrupts surface as error_during_execution/aborted_streaming; not an error for the user.
            let terminal = v.get("terminal_reason").and_then(Value::as_str).unwrap_or("");
            if terminal == "aborted_streaming" || terminal == "aborted" {
                out.push(Parsed::Event(SessionEvent::Status { message: "중단됨".into() }));
            } else {
                let msg = v
                    .get("result")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .unwrap_or_else(|| format!("turn ended with {subtype}"));
                out.push(Parsed::Event(SessionEvent::Error { message: msg, fatal: false }));
            }
        }
        self.started_tools.clear();
        out.push(Parsed::Event(SessionEvent::TurnEnd {
            cost_usd,
            usage,
            duration_ms,
            stop_reason: if is_error { Some(subtype.to_string()) } else { stop_reason },
        }));
        out
    }
}

/// Subscription windows from a `rate_limit_event`'s `rate_limit_info`. The CLI reports
/// `unifiedWindows.{five_hour,seven_day,seven_day_overage_included}` as `{utilization: 0..1, resetsAt}`
/// (what `/usage` shows); without it the top-level `utilization` + `rateLimitType` is used.
pub fn rate_limit_windows(info: &Value) -> Vec<RateLimitWindow> {
    const KNOWN: [(&str, &str, i64); 3] = [("five_hour", "5시간", 300), ("seven_day", "1주일", 10_080), ("seven_day_overage_included", "1주일 (추가 사용 포함)", 10_080)];
    let mut out = Vec::new();
    if let Some(uw) = info.get("unifiedWindows").and_then(Value::as_object) {
        for (id, label, minutes) in KNOWN {
            let Some(w) = uw.get(id) else { continue };
            let Some(u) = w.get("utilization").and_then(Value::as_f64) else { continue };
            out.push(RateLimitWindow {
                id: id.into(),
                label: label.into(),
                used_percent: fraction_to_percent(u),
                resets_at: w.get("resetsAt").or_else(|| w.get("resets_at")).and_then(Value::as_i64),
                window_minutes: Some(minutes),
            });
        }
    }
    if out.is_empty() {
        if let (Some(u), Some(t)) = (info.get("utilization").and_then(Value::as_f64), info.get("rateLimitType").and_then(Value::as_str)) {
            let (label, minutes) = KNOWN.iter().find(|k| k.0 == t).map(|k| (k.1, Some(k.2))).unwrap_or((t, None));
            out.push(RateLimitWindow { id: t.into(), label: label.into(), used_percent: fraction_to_percent(u), resets_at: info.get("resetsAt").and_then(Value::as_i64), window_minutes: minutes });
        }
    }
    out
}

fn fraction_to_percent(u: f64) -> f64 {
    ((u * 100.0).clamp(0.0, 100.0) * 10.0).round() / 10.0
}

pub fn parse_usage(u: &Value) -> Usage {
    Usage {
        input_tokens: u.get("input_tokens").and_then(Value::as_i64).unwrap_or(0),
        output_tokens: u.get("output_tokens").and_then(Value::as_i64).unwrap_or(0),
        cache_read_tokens: u.get("cache_read_input_tokens").and_then(Value::as_i64).unwrap_or(0),
        cache_write_tokens: u.get("cache_creation_input_tokens").and_then(Value::as_i64).unwrap_or(0),
    }
}

fn plan_from_todo(input: &Value) -> Option<Vec<PlanStep>> {
    let todos = input.get("todos")?.as_array()?;
    Some(
        todos
            .iter()
            .map(|t| PlanStep {
                text: t.get("content").or_else(|| t.get("subject")).and_then(Value::as_str).unwrap_or("").to_string(),
                status: t.get("status").and_then(Value::as_str).unwrap_or("pending").to_string(),
            })
            .collect(),
    )
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// tool_result `content` is either a string or an array of {type:"text",text} blocks.
pub fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|b| match b.get("type").and_then(Value::as_str) {
                Some("text") => b.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                Some("image") => "[image]".to_string(),
                _ => b.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(fixture: &str) -> (Vec<Parsed>, Vec<SessionEvent>) {
        let mut p = Parser::new();
        let mut all = vec![];
        for line in fixture.lines() {
            all.extend(p.parse_line(line));
        }
        let events = all.iter().filter_map(|p| if let Parsed::Event(e) = p { Some(e.clone()) } else { None }).collect();
        (all, events)
    }

    #[test]
    fn pong_fixture() {
        let (all, events) = run(include_str!("../../../tests/fixtures/claude_pong.jsonl"));
        let init = all.iter().find(|p| matches!(p, Parsed::Init { .. })).expect("init");
        if let Parsed::Init { session_id, model, tools, capabilities, .. } = init {
            assert_eq!(session_id, "6eef051e-5bf7-4c14-b981-2307176dc78c");
            assert_eq!(model, "claude-sonnet-5");
            assert!(tools.contains(&"Bash".to_string()));
            assert!(capabilities.iter().any(|c| c.starts_with("interrupt_")));
        }
        let deltas: String = events.iter().filter_map(|e| if let SessionEvent::TextDelta { text } = e { Some(text.as_str()) } else { None }).collect();
        assert_eq!(deltas, "pong");
        assert!(events.iter().any(|e| matches!(e, SessionEvent::Text { text } if text == "pong")));
        let end = events.last().unwrap();
        match end {
            SessionEvent::TurnEnd { cost_usd, usage, duration_ms, stop_reason } => {
                assert!(cost_usd.unwrap() > 0.0);
                assert_eq!(usage.output_tokens, 4);
                assert!(*duration_ms > 0);
                assert_eq!(stop_reason.as_deref(), Some("end_turn"));
            }
            other => panic!("expected TurnEnd, got {other:?}"),
        }
    }

    #[test]
    fn read_tool_fixture() {
        let (_, events) = run(include_str!("../../../tests/fixtures/claude_read_tool.jsonl"));
        let start = events.iter().find_map(|e| if let SessionEvent::ToolStart { id, name, input } = e { Some((id.clone(), name.clone(), input.clone())) } else { None }).expect("tool start");
        assert_eq!(start.1, "Read");
        assert!(start.2.get("file_path").unwrap().as_str().unwrap().ends_with("README.md"));
        let end = events.iter().find_map(|e| if let SessionEvent::ToolEnd { id, output, is_error } = e { Some((id.clone(), output.clone(), *is_error)) } else { None }).expect("tool end");
        assert_eq!(start.0, end.0);
        assert!(end.1.contains("hello vibecode fixture"));
        assert!(!end.2);
        // exactly one ToolStart for the tool (deltas must not duplicate it)
        assert_eq!(events.iter().filter(|e| matches!(e, SessionEvent::ToolStart { .. })).count(), 1);
        assert!(matches!(events.last().unwrap(), SessionEvent::TurnEnd { .. }));
    }

    #[test]
    fn denied_fixture_without_partial_messages() {
        let (_, events) = run(include_str!("../../../tests/fixtures/claude_denied.jsonl"));
        assert!(events.iter().any(|e| matches!(e, SessionEvent::ToolStart { name, .. } if name == "Bash")));
        assert!(events.iter().any(|e| matches!(e, SessionEvent::ToolEnd { output, .. } if output == "hi")));
        assert!(events.iter().any(|e| matches!(e, SessionEvent::Text { text } if text.contains("hi"))));
        assert!(!events.iter().any(|e| matches!(e, SessionEvent::TextDelta { .. })));
    }

    #[test]
    fn subagent_fixture_wraps_events_by_parent() {
        let (_, events) = run(include_str!("../../../tests/fixtures/claude_subagent.jsonl"));
        // The Agent tool call itself is top-level.
        let (parent_id, _) = events
            .iter()
            .find_map(|e| if let SessionEvent::ToolStart { id, name, .. } = e { if name == "Agent" { Some((id.clone(), name.clone())) } else { None } } else { None })
            .expect("top-level Agent tool start");
        let subs: Vec<&SessionEvent> = events
            .iter()
            .filter_map(|e| if let SessionEvent::Subagent { parent_tool_use_id, event } = e { assert_eq!(parent_tool_use_id, &parent_id); Some(event.as_ref()) } else { None })
            .collect();
        assert!(subs.len() >= 4, "subagent events: {}", subs.len());
        assert!(matches!(subs[0], SessionEvent::UserMessage { text } if text.contains("README.md")));
        assert!(subs.iter().any(|e| matches!(e, SessionEvent::ToolStart { name, .. } if name == "Read")));
        assert!(subs.iter().any(|e| matches!(e, SessionEvent::ToolEnd { output, .. } if output.contains("Vibecoder"))));
        assert!(subs.iter().any(|e| matches!(e, SessionEvent::Text { text } if text.contains("Vibecoder"))));
        // Nothing from the subagent leaked into the top-level transcript.
        assert!(!events.iter().any(|e| matches!(e, SessionEvent::ToolStart { name, .. } if name == "Read")));
        // The parent tool result closes at top level and the turn ends normally.
        assert!(events.iter().any(|e| matches!(e, SessionEvent::ToolEnd { id, .. } if id == &parent_id)));
        assert!(matches!(events.last().unwrap(), SessionEvent::TurnEnd { .. }));
    }

    #[test]
    fn control_messages() {
        let mut p = Parser::new();
        let req = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf x"}}}"#;
        match &p.parse_line(req)[0] {
            Parsed::ControlRequest { request_id, request } => {
                assert_eq!(request_id, "r1");
                assert_eq!(request["subtype"], "can_use_tool");
            }
            other => panic!("{other:?}"),
        }
        let resp = r#"{"type":"control_response","response":{"subtype":"success","request_id":"req_1","response":{"mode":"acceptEdits"}}}"#;
        match &p.parse_line(resp)[0] {
            Parsed::ControlResponse { request_id, success, response, .. } => {
                assert_eq!(request_id, "req_1");
                assert!(success);
                assert_eq!(response["mode"], "acceptEdits");
            }
            other => panic!("{other:?}"),
        }
        let err = r#"{"type":"control_response","response":{"subtype":"error","request_id":"req_2","error":"nope"}}"#;
        match &p.parse_line(err)[0] {
            Parsed::ControlResponse { success, error, .. } => {
                assert!(!success);
                assert_eq!(error.as_deref(), Some("nope"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn error_result_emits_error_then_turn_end() {
        let mut p = Parser::new();
        let line = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"duration_ms":10,"result":"","usage":{"input_tokens":1,"output_tokens":2}}"#;
        let out = p.parse_line(line);
        assert_eq!(out.len(), 2);
        assert!(matches!(&out[0], Parsed::Event(SessionEvent::Error { message, .. }) if message.contains("error_max_turns")));
        assert!(matches!(&out[1], Parsed::Event(SessionEvent::TurnEnd { stop_reason: Some(s), .. }) if s == "error_max_turns"));
    }

    #[test]
    fn rate_limit_event_becomes_windows() {
        let mut p = Parser::new();
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1800000000,"rateLimitType":"five_hour","utilization":0.37,"unifiedWindows":{"five_hour":{"utilization":0.37,"resetsAt":1800000000},"seven_day":{"utilization":0.121,"resetsAt":1800400000}}},"uuid":"u","session_id":"s"}"#;
        let out = p.parse_line(line);
        let Parsed::Event(SessionEvent::RateLimits { provider, account_id, windows, .. }) = &out[0] else { panic!("{out:?}") };
        assert_eq!(*provider, Provider::Claude);
        assert!(account_id.is_none());
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].id, "five_hour");
        assert_eq!(windows[0].used_percent, 37.0);
        assert_eq!(windows[0].resets_at, Some(1_800_000_000));
        assert_eq!(windows[1].id, "seven_day");
        assert_eq!(windows[1].used_percent, 12.1);
        // Fallback without unifiedWindows.
        let only_top = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"seven_day","utilization":0.9}}"#;
        let out = p.parse_line(only_top);
        let Parsed::Event(SessionEvent::RateLimits { windows, .. }) = &out[0] else { panic!("{out:?}") };
        assert_eq!(windows[0].id, "seven_day");
        assert_eq!(windows[0].used_percent, 90.0);
        // Nothing usable → ignored.
        assert!(matches!(&p.parse_line(r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}"#)[0], Parsed::Ignore));
    }

    #[test]
    fn non_json_and_replayed_user_text() {
        let mut p = Parser::new();
        assert!(matches!(&p.parse_line("Warning: something")[0], Parsed::NotJson(_)));
        let replay = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]},"parent_tool_use_id":null}"#;
        assert!(matches!(&p.parse_line(replay)[0], Parsed::Ignore));
    }
}
