//! End-to-end test against the real Claude Code CLI running inside WSL.
//! Run from WSL with: VIBECODE_E2E=1 WSLENV=VIBECODE_E2E cargo.exe test -p vibecode-core --test claude_wsl -- --ignored --nocapture
//! (WSLENV is required so the variable reaches the Windows test process.)

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use vibecode_core::agents::claude::ClaudeSession;
use vibecode_core::agents::StartArgs;
use vibecode_core::backend::wsl::WslBackend;
use vibecode_core::backend::ExecBackend;
use vibecode_core::permission::PermissionBroker;
use vibecode_core::types::{Effort, PermissionDecision, PermissionPreset, PermissionReply, Provider, SessionConfig, SessionEvent};

fn e2e_enabled() -> bool {
    std::env::var("VIBECODE_E2E").map(|v| v == "1").unwrap_or(false)
}

async fn wsl_backend_with_claude() -> Option<Arc<dyn ExecBackend>> {
    if which::which("wsl.exe").is_err() {
        eprintln!("skip: wsl.exe not found");
        return None;
    }
    let distros = vibecode_core::backend::wsl::list_distros().await;
    let distro = distros.iter().find(|d| d == &"Ubuntu").cloned().or_else(|| distros.first().cloned())?;
    let b: Arc<dyn ExecBackend> = Arc::new(WslBackend::new(distro));
    if b.which("claude").await.is_none() {
        eprintln!("skip: claude not found in WSL");
        return None;
    }
    Some(b)
}

async fn next_event(rx: &mut mpsc::UnboundedReceiver<SessionEvent>, secs: u64) -> SessionEvent {
    tokio::time::timeout(Duration::from_secs(secs), rx.recv()).await.expect("timed out waiting for event").expect("event channel closed")
}

/// Drain until predicate matches; returns all events seen (inclusive).
async fn wait_for(rx: &mut mpsc::UnboundedReceiver<SessionEvent>, secs: u64, pred: impl Fn(&SessionEvent) -> bool) -> Vec<SessionEvent> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    let mut seen = vec![];
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let ev = tokio::time::timeout(remaining, rx.recv()).await.unwrap_or_else(|_| panic!("timed out; seen so far: {seen:#?}")).expect("channel closed");
        let done = pred(&ev);
        eprintln!("  event: {}", summarize(&ev));
        seen.push(ev);
        if done {
            return seen;
        }
    }
}

fn summarize(ev: &SessionEvent) -> String {
    match ev {
        SessionEvent::TextDelta { text } => format!("TextDelta({text:?})"),
        SessionEvent::Text { text } => format!("Text({:?})", text.chars().take(60).collect::<String>()),
        SessionEvent::ToolEnd { output, is_error, .. } => format!("ToolEnd(err={is_error}, {:?})", output.chars().take(60).collect::<String>()),
        other => format!("{other:?}").chars().take(160).collect(),
    }
}

#[tokio::test]
#[ignore]
async fn claude_session_roundtrip_via_wsl() {
    if !e2e_enabled() {
        eprintln!("skip: set VIBECODE_E2E=1");
        return;
    }
    let Some(backend) = wsl_backend_with_claude().await else { return };
    let dir = std::env::temp_dir().join(format!("vibecode-e2e-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("README.md"), "# e2e\n").unwrap();

    let broker = PermissionBroker::start().await.unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let config = SessionConfig {
        project_id: "test".into(),
        provider: Provider::Claude,
        model: Some("sonnet".into()),
        effort: Some(Effort::Low),
        permission: PermissionPreset::AskEverything,
        max_budget_usd: Some(1.0),
        append_system_prompt: None,
        resume_ref: None,
        fork: false,
    };
    let session = ClaudeSession::start(
        StartArgs { session_id: "e2e-session".into(), config, cwd: PathBuf::from(&dir), backend: backend.clone(), bin: None, events: tx },
        broker.clone(),
    )
    .await
    .expect("start");

    // --- turn 1: plain text ---
    session.send("Reply with exactly: pong".into()).await.unwrap();
    assert!(matches!(next_event(&mut rx, 5).await, SessionEvent::UserMessage { .. }));
    let seen = wait_for(&mut rx, 150, |e| matches!(e, SessionEvent::TurnEnd { .. })).await;
    let init = seen.iter().find(|e| matches!(e, SessionEvent::Init { .. })).expect("Init event");
    if let SessionEvent::Init { provider, model, external_ref, tools } = init {
        assert_eq!(*provider, Provider::Claude);
        assert!(model.contains("sonnet"), "model {model}");
        assert_eq!(external_ref.len(), 36, "session id should be a uuid");
        assert!(tools.iter().any(|t| t == "Bash"));
    }
    assert!(seen.iter().any(|e| matches!(e, SessionEvent::Text { text } if text.to_lowercase().contains("pong"))), "no pong text: {seen:#?}");
    assert!(seen.iter().any(|e| matches!(e, SessionEvent::TextDelta { .. })), "expected streaming deltas");
    if let Some(SessionEvent::TurnEnd { cost_usd, usage, .. }) = seen.last() {
        assert!(cost_usd.unwrap_or(0.0) > 0.0);
        assert!(usage.output_tokens > 0);
    }
    assert!(session.external_ref().is_some());

    // --- turn 2: a write command must prompt; we allow it via the broker ---
    session.send("Using the Bash tool, run exactly `mkdir e2e_dir` then reply with one word: created".into()).await.unwrap();
    let seen = wait_for(&mut rx, 60, |e| matches!(e, SessionEvent::PermissionRequest { .. })).await;
    let (request_id, kind) = match seen.last().unwrap() {
        SessionEvent::PermissionRequest { request_id, kind, title, .. } => {
            assert!(title.contains("mkdir"), "title {title}");
            (request_id.clone(), *kind)
        }
        _ => unreachable!(),
    };
    assert_eq!(kind, vibecode_core::types::PermissionKind::Command);
    session.reply_permission(PermissionReply { request_id: request_id.clone(), decision: PermissionDecision::Allow, message: None }).await.unwrap();
    let seen = wait_for(&mut rx, 120, |e| matches!(e, SessionEvent::TurnEnd { .. })).await;
    assert!(seen.iter().any(|e| matches!(e, SessionEvent::PermissionResolved { decision: PermissionDecision::Allow, .. })));
    assert!(seen.iter().any(|e| matches!(e, SessionEvent::ToolEnd { is_error: false, .. })), "tool should have run: {seen:#?}");
    assert!(dir.join("e2e_dir").is_dir(), "mkdir should have created the directory on the host-visible path");

    // --- turn 3: deny ---
    session.send("Using the Bash tool, run exactly `mkdir e2e_denied` and then say whether it worked.".into()).await.unwrap();
    let seen = wait_for(&mut rx, 60, |e| matches!(e, SessionEvent::PermissionRequest { .. })).await;
    let request_id = match seen.last().unwrap() { SessionEvent::PermissionRequest { request_id, .. } => request_id.clone(), _ => unreachable!() };
    session.reply_permission(PermissionReply { request_id, decision: PermissionDecision::Deny, message: Some("테스트에서 거부".into()) }).await.unwrap();
    let seen = wait_for(&mut rx, 120, |e| matches!(e, SessionEvent::TurnEnd { .. })).await;
    assert!(seen.iter().any(|e| matches!(e, SessionEvent::ToolEnd { is_error: true, .. })), "denied tool should report an error result: {seen:#?}");
    assert!(!dir.join("e2e_denied").exists());

    // --- turn 4: interrupt a long generation ---
    session.send("Write a 1500-word essay about the history of typography. Do not use tools.".into()).await.unwrap();
    let _ = wait_for(&mut rx, 60, |e| matches!(e, SessionEvent::TextDelta { .. })).await;
    session.interrupt().await.unwrap();
    let seen = wait_for(&mut rx, 30, |e| matches!(e, SessionEvent::TurnEnd { .. })).await;
    assert!(seen.iter().any(|e| matches!(e, SessionEvent::Status { message } if message.contains("중단"))), "expected interrupted status: {seen:#?}");

    // --- config change mid-session: permission preset via set_permission_mode ---
    session.update_config(vibecode_core::types::SessionConfigPatch { model: None, effort: None, permission: Some(PermissionPreset::AutoEdit) }).await.unwrap();
    let _ = wait_for(&mut rx, 10, |e| matches!(e, SessionEvent::Status { message } if message.contains("acceptEdits"))).await;

    // --- close ---
    session.close().await.unwrap();
    let seen = wait_for(&mut rx, 20, |e| matches!(e, SessionEvent::Exited { .. })).await;
    assert!(matches!(seen.last().unwrap(), SessionEvent::Exited { .. }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
#[ignore]
async fn claude_auth_status_and_commit_message_via_wsl() {
    if !e2e_enabled() {
        return;
    }
    let Some(backend) = wsl_backend_with_claude().await else { return };
    let status = vibecode_core::tools::claude::auth_status(backend.clone(), None).await.unwrap();
    eprintln!("auth: {status:?}");
    assert!(status.logged_in, "expected a logged-in claude in WSL");

    let dir = std::env::temp_dir().join(format!("vibecode-e2e-cm-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let diff = "diff --git a/src/main.rs b/src/main.rs\n--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1,3 +1,4 @@\n fn main() {\n-    println!(\"hello\");\n+    println!(\"hello, world\");\n+    println!(\"added greeting\");\n }\n";
    let msg = vibecode_core::agents::claude::oneshot_commit_message(backend, None, &dir, diff).await.unwrap();
    eprintln!("commit message: {msg}");
    assert!(!msg.trim().is_empty());
    assert!(!msg.contains("```"));
    let _ = std::fs::remove_dir_all(&dir);
}
