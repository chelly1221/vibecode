//! Drives `CodexHost`/`CodexSession` against an in-process fake app-server speaking
//! NDJSON JSON-RPC over `tokio::io::duplex`. Covers initialize, model/list, thread/start,
//! turn/start with deltas, an approval round-trip, turn/completed, update_config, close
//! and server death.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::mpsc;
use vibecode_core::agents::codex::{host_key, CodexHost};
use vibecode_core::agents::StartArgs;
use vibecode_core::backend::ExecBackend;
use vibecode_core::types::{Effort, PermissionDecision, PermissionKind, PermissionPreset, PermissionReply, Provider, SessionConfig, SessionConfigPatch, SessionEvent};

const MODEL_LIST: &str = include_str!("fixtures/codex/model_list.json");

fn model_list() -> Value {
    serde_json::from_str(MODEL_LIST).unwrap()
}

/// Records every client request so tests can assert on parameters.
type Recorded = Arc<Mutex<Vec<Value>>>;

async fn fake_server(stream: DuplexStream, recorded: Recorded) {
    let (r, mut w) = tokio::io::split(stream);
    let mut lines = BufReader::new(r).lines();
    let mut turns = 0u32;
    let mut awaiting_approval = false;
    while let Ok(Some(line)) = lines.next_line().await {
        let v: Value = serde_json::from_str(&line).expect("client sent json");
        recorded.lock().unwrap().push(v.clone());
        let method = v.get("method").and_then(|m| m.as_str()).map(|s| s.to_string());
        let id = v.get("id").cloned().unwrap_or(Value::Null);
        let params = v.get("params").cloned().unwrap_or(Value::Null);
        let mut out: Vec<Value> = Vec::new();
        match method.as_deref() {
            Some("initialize") => out.push(json!({ "id": id, "result": { "userAgent": "fake", "codexHome": "/tmp", "platformFamily": "unix", "platformOs": "linux" } })),
            Some("initialized") => {}
            Some("model/list") => out.push(json!({ "id": id, "result": model_list() })),
            Some("thread/start") | Some("thread/resume") | Some("thread/fork") => {
                let tid = if method.as_deref() == Some("thread/start") { "thr_1" } else { "thr_2" };
                let thread = json!({ "id": tid, "sessionId": tid, "forkedFromId": null, "parentThreadId": null, "preview": "", "ephemeral": false, "status": { "type": "idle" }, "cwd": params["cwd"], "turns": [] });
                out.push(json!({ "id": id, "result": { "thread": thread, "model": params.get("model").cloned().unwrap_or(json!("gpt-default")), "modelProvider": "openai", "cwd": params["cwd"], "approvalPolicy": params["approvalPolicy"], "sandbox": { "type": "workspaceWrite" }, "reasoningEffort": null } }));
                out.push(json!({ "method": "thread/started", "params": { "thread": thread }, "emittedAtMs": 1 }));
            }
            Some("turn/start") => {
                turns += 1;
                let tid = params["threadId"].as_str().unwrap().to_string();
                let turn_id = format!("turn_{turns}");
                let text = params["input"][0]["text"].as_str().unwrap().to_string();
                out.push(json!({ "id": id, "result": { "turn": { "id": turn_id, "items": [], "itemsView": "full", "status": "inProgress", "error": null, "startedAt": 1, "completedAt": null, "durationMs": null } } }));
                out.push(json!({ "method": "turn/started", "params": { "threadId": tid, "turn": { "id": turn_id, "items": [], "itemsView": "full", "status": "inProgress", "error": null } } }));
                out.push(json!({ "method": "item/started", "params": { "threadId": tid, "turnId": turn_id, "startedAtMs": 1, "item": { "type": "agentMessage", "id": "msg_1", "text": "", "phase": null, "memoryCitation": null, "delivery": null, "questions": null } } }));
                out.push(json!({ "method": "item/agentMessage/delta", "params": { "threadId": tid, "turnId": turn_id, "itemId": "msg_1", "delta": "Echo: " } }));
                out.push(json!({ "method": "item/agentMessage/delta", "params": { "threadId": tid, "turnId": turn_id, "itemId": "msg_1", "delta": text } }));
                out.push(json!({ "method": "item/completed", "params": { "threadId": tid, "turnId": turn_id, "completedAtMs": 2, "item": { "type": "agentMessage", "id": "msg_1", "text": format!("Echo: {text}"), "phase": null, "memoryCitation": null, "delivery": null, "questions": null } } }));
                if turns == 1 {
                    out.push(json!({ "method": "item/started", "params": { "threadId": tid, "turnId": turn_id, "startedAtMs": 3, "item": { "type": "commandExecution", "id": "cmd_1", "command": "npm test", "cwd": "/proj", "status": "inProgress", "commandActions": [], "aggregatedOutput": null, "exitCode": null, "durationMs": null, "pluginId": null, "scriptPath": null, "processId": null, "source": "agent" } } }));
                    out.push(json!({ "id": 100, "method": "item/commandExecution/requestApproval", "params": { "kind": "command", "threadId": tid, "turnId": turn_id, "itemId": "cmd_1", "startedAtMs": 3, "approvalId": null, "environmentId": null, "reason": "needs approval", "command": "npm test", "cwd": "/proj", "commandActions": [] } }));
                    awaiting_approval = true;
                } else {
                    out.push(json!({ "method": "thread/tokenUsage/updated", "params": { "threadId": tid, "turnId": turn_id, "tokenUsage": { "total": { "totalTokens": 20, "inputTokens": 15, "cachedInputTokens": 0, "cacheWriteInputTokens": 0, "outputTokens": 5, "reasoningOutputTokens": 0 }, "last": { "totalTokens": 20, "inputTokens": 15, "cachedInputTokens": 0, "cacheWriteInputTokens": 0, "outputTokens": 5, "reasoningOutputTokens": 0 }, "modelContextWindow": 1000 } } }));
                    out.push(json!({ "method": "turn/completed", "params": { "threadId": tid, "turn": { "id": turn_id, "items": [], "itemsView": "summary", "status": "completed", "error": null, "durationMs": 10 } } }));
                }
            }
            Some("turn/interrupt") => {
                out.push(json!({ "id": id, "result": {} }));
                out.push(json!({ "method": "turn/completed", "params": { "threadId": params["threadId"], "turn": { "id": params["turnId"], "items": [], "itemsView": "summary", "status": "interrupted", "error": null, "durationMs": 5 } } }));
            }
            Some("thread/unsubscribe") => out.push(json!({ "id": id, "result": { "status": "unsubscribed" } })),
            None => {
                // Client response to our server request.
                if awaiting_approval && id == json!(100) {
                    awaiting_approval = false;
                    assert_eq!(v["result"]["decision"], "accept", "client must accept: {v}");
                    out.push(json!({ "method": "serverRequest/resolved", "params": { "threadId": "thr_1", "requestId": 100 } }));
                    out.push(json!({ "method": "item/commandExecution/outputDelta", "params": { "threadId": "thr_1", "turnId": "turn_1", "itemId": "cmd_1", "delta": "1 passing\n" } }));
                    out.push(json!({ "method": "item/completed", "params": { "threadId": "thr_1", "turnId": "turn_1", "completedAtMs": 9, "item": { "type": "commandExecution", "id": "cmd_1", "command": "npm test", "cwd": "/proj", "status": "completed", "commandActions": [], "aggregatedOutput": "1 passing\n", "exitCode": 0, "durationMs": 40, "pluginId": null, "scriptPath": null, "processId": null, "source": "agent" } } }));
                    out.push(json!({ "method": "thread/tokenUsage/updated", "params": { "threadId": "thr_1", "turnId": "turn_1", "tokenUsage": { "total": { "totalTokens": 1245, "inputTokens": 1200, "cachedInputTokens": 800, "cacheWriteInputTokens": 0, "outputTokens": 45, "reasoningOutputTokens": 10 }, "last": { "totalTokens": 1245, "inputTokens": 1200, "cachedInputTokens": 800, "cacheWriteInputTokens": 0, "outputTokens": 45, "reasoningOutputTokens": 10 }, "modelContextWindow": 272000 } } }));
                    out.push(json!({ "method": "turn/completed", "params": { "threadId": "thr_1", "turn": { "id": "turn_1", "items": [], "itemsView": "summary", "status": "completed", "error": null, "durationMs": 4321 } } }));
                }
            }
            Some(other) => out.push(json!({ "id": id, "error": { "code": -32601, "message": format!("fake server: unknown method {other}") } })),
        }
        for o in out {
            let mut s = o.to_string();
            s.push('\n');
            if w.write_all(s.as_bytes()).await.is_err() {
                return;
            }
        }
    }
}

async fn next(rx: &mut mpsc::UnboundedReceiver<SessionEvent>) -> SessionEvent {
    tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("event within 5s").expect("channel open")
}

fn kind(e: &SessionEvent) -> &'static str {
    match e {
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
        SessionEvent::RateLimits { .. } => "rate_limits",
        SessionEvent::AutoGit { .. } => "auto_git",
    }
}

async fn collect_until(rx: &mut mpsc::UnboundedReceiver<SessionEvent>, stop: &str) -> Vec<SessionEvent> {
    let mut out = Vec::new();
    loop {
        let e = next(rx).await;
        let k = kind(&e);
        out.push(e);
        if k == stop {
            return out;
        }
    }
}

fn config(permission: PermissionPreset) -> SessionConfig {
    SessionConfig {
        project_id: "p1".into(),
        provider: Provider::Codex,
        model: Some("gpt-test".into()),
        effort: Some(Effort::High),
        permission,
        append_system_prompt: Some("Be terse.".into()),
        resume_ref: None,
        fork: false,
    }
}

async fn connected_host(recorded: Recorded) -> (CodexHost, Arc<ExecBackend>) {
    let (client, server) = tokio::io::duplex(1 << 16);
    tokio::spawn(fake_server(server, recorded));
    let (cr, cw) = tokio::io::split(client);
    let host = CodexHost::new();
    let backend: Arc<ExecBackend> = Arc::new(ExecBackend::new());
    host.connect(cr, cw, host_key(backend.as_ref(), None)).await.expect("handshake");
    (host, backend)
}

fn find<'a>(recorded: &'a [Value], method: &str) -> Vec<&'a Value> {
    recorded.iter().filter(|v| v.get("method").and_then(|m| m.as_str()) == Some(method)).collect()
}

#[tokio::test]
async fn full_turn_with_approval_roundtrip() {
    let recorded: Recorded = Arc::default();
    let (host, backend) = connected_host(recorded.clone()).await;

    let models = host.list_models().await.expect("model/list");
    assert_eq!(models.len(), 2);
    assert!(models[0].is_default);

    let (tx, mut rx) = mpsc::unbounded_channel();
    let args = StartArgs { session_id: "s1".into(), config: config(PermissionPreset::AutoEdit), cwd: PathBuf::from("C:\\proj"), backend: backend.clone(), bin: None, events: tx , mcp_servers: vec![]};
    let session = host.start_session(args).await.expect("thread/start");
    assert_eq!(session.provider(), Provider::Codex);
    assert_eq!(session.external_ref().as_deref(), Some("thr_1"));

    match next(&mut rx).await {
        SessionEvent::Init { provider, model, external_ref, .. } => {
            assert_eq!(provider, Provider::Codex);
            assert_eq!(model, "gpt-test");
            assert_eq!(external_ref, "thr_1");
        }
        other => panic!("expected init, got {other:?}"),
    }

    session.send("hello".into()).await.expect("turn/start");
    let evs = collect_until(&mut rx, "permission_request").await;
    let kinds: Vec<_> = evs.iter().map(kind).collect();
    assert_eq!(kinds, vec!["user_message", "text_delta", "text_delta", "text", "tool_start", "permission_request"]);
    match &evs[3] {
        SessionEvent::Text { text } => assert_eq!(text, "Echo: hello"),
        _ => unreachable!(),
    }
    let request_id = match &evs[5] {
        SessionEvent::PermissionRequest { request_id, kind, title, detail } => {
            assert_eq!(*kind, PermissionKind::Command);
            assert_eq!(title, "npm test");
            assert_eq!(detail["reason"], "needs approval");
            request_id.clone()
        }
        _ => unreachable!(),
    };
    assert_eq!(request_id, "100");

    session.reply_permission(PermissionReply { request_id: request_id.clone(), decision: PermissionDecision::Allow, message: None }).await.expect("reply");
    let evs = collect_until(&mut rx, "turn_end").await;
    let kinds: Vec<_> = evs.iter().map(kind).collect();
    assert_eq!(kinds, vec!["permission_resolved", "tool_end", "turn_end"]);
    match &evs[1] {
        SessionEvent::ToolEnd { id, output, is_error } => {
            assert_eq!(id, "cmd_1");
            assert!(output.contains("1 passing"));
            assert!(!is_error);
        }
        _ => unreachable!(),
    }
    match &evs[2] {
        SessionEvent::TurnEnd { usage, duration_ms, stop_reason, cost_usd } => {
            assert_eq!(usage.input_tokens, 1200);
            assert_eq!(usage.cache_read_tokens, 800);
            assert_eq!(usage.output_tokens, 45);
            assert_eq!(*duration_ms, 4321);
            assert_eq!(stop_reason.as_deref(), Some("completed"));
            assert!(cost_usd.is_none());
        }
        _ => unreachable!(),
    }

    // Replying twice is an error (request no longer pending).
    assert!(session.reply_permission(PermissionReply { request_id, decision: PermissionDecision::Deny, message: None }).await.is_err());
    // Interrupt with no active turn is a no-op.
    session.interrupt().await.expect("interrupt no-op");

    // Second turn after changing model/effort/permission → overrides appear on turn/start.
    session.update_config(SessionConfigPatch { model: Some("gpt-other".into()), effort: Some(Effort::Low), permission: Some(PermissionPreset::FullAuto) }).await.unwrap();
    session.send("again".into()).await.expect("second turn");
    let evs = collect_until(&mut rx, "turn_end").await;
    let kinds: Vec<_> = evs.iter().map(kind).collect();
    assert_eq!(kinds, vec!["user_message", "text_delta", "text_delta", "text", "turn_end"]);

    session.close().await.expect("close");
    assert!(matches!(next(&mut rx).await, SessionEvent::Exited { .. }));

    let rec = recorded.lock().unwrap().clone();
    let init = &find(&rec, "initialize")[0]["params"];
    assert_eq!(init["clientInfo"]["name"], "vibecode");
    assert_eq!(find(&rec, "initialized").len(), 1);
    let ts = &find(&rec, "thread/start")[0]["params"];
    assert_eq!(ts["cwd"], "C:\\proj");
    assert_eq!(ts["model"], "gpt-test");
    assert_eq!(ts["approvalPolicy"], "on-request");
    assert_eq!(ts["sandbox"], "workspace-write");
    assert_eq!(ts["config"]["model_reasoning_effort"], "high");
    assert_eq!(ts["developerInstructions"], "Be terse.");
    let turns = find(&rec, "turn/start");
    assert_eq!(turns.len(), 2);
    let t1 = &turns[0]["params"];
    assert_eq!(t1["threadId"], "thr_1");
    assert_eq!(t1["input"][0]["type"], "text");
    assert_eq!(t1["input"][0]["text"], "hello");
    assert_eq!(t1["model"], "gpt-test");
    assert_eq!(t1["effort"], "high");
    assert_eq!(t1["approvalPolicy"], "on-request");
    assert_eq!(t1["sandboxPolicy"]["type"], "workspaceWrite");
    assert_eq!(t1["sandboxPolicy"]["writableRoots"][0], "C:\\proj");
    let t2 = &turns[1]["params"];
    assert_eq!(t2["model"], "gpt-other");
    assert_eq!(t2["effort"], "low");
    assert_eq!(t2["approvalPolicy"], "never");
    assert_eq!(t2["sandboxPolicy"]["type"], "dangerFullAccess");
    assert_eq!(find(&rec, "thread/unsubscribe").len(), 1);
}

#[tokio::test]
async fn resume_and_interrupt_and_server_death() {
    let recorded: Recorded = Arc::default();
    let (host, backend) = connected_host(recorded.clone()).await;

    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut cfg = config(PermissionPreset::ReadOnly);
    cfg.resume_ref = Some("thr_old".into());
    let args = StartArgs { session_id: "s2".into(), config: cfg, cwd: PathBuf::from("C:\\proj"), backend: backend.clone(), bin: None, events: tx , mcp_servers: vec![]};
    let session = host.start_session(args).await.expect("thread/resume");
    assert_eq!(session.external_ref().as_deref(), Some("thr_2"));
    assert!(matches!(next(&mut rx).await, SessionEvent::Init { .. }));

    // Start a turn (the fake never completes turn 1 by itself: it waits for approval) then interrupt.
    session.send("work".into()).await.unwrap();
    let evs = collect_until(&mut rx, "permission_request").await;
    assert_eq!(kind(evs.last().unwrap()), "permission_request");
    session.interrupt().await.expect("turn/interrupt");
    let evs = collect_until(&mut rx, "turn_end").await;
    let kinds: Vec<_> = evs.iter().map(kind).collect();
    // pending approval is voided, then the interrupted turn ends
    assert_eq!(kinds, vec!["permission_resolved", "turn_end"]);
    match &evs[1] {
        SessionEvent::TurnEnd { stop_reason, .. } => assert_eq!(stop_reason.as_deref(), Some("interrupted")),
        _ => unreachable!(),
    }

    let rec = recorded.lock().unwrap().clone();
    let rs = &find(&rec, "thread/resume")[0]["params"];
    assert_eq!(rs["threadId"], "thr_old");
    assert_eq!(rs["excludeTurns"], true);
    assert_eq!(rs["approvalPolicy"], "never");
    assert_eq!(rs["sandbox"], "read-only");
    assert_eq!(find(&rec, "turn/interrupt")[0]["params"]["turnId"], "turn_1");

    // Killing the server → live session gets Exited and the host reports not running.
    host.shutdown().await;
    assert!(matches!(next(&mut rx).await, SessionEvent::Exited { .. }));
    assert!(!host.is_running().await);
    assert!(session.send("x".into()).await.is_err());
}
