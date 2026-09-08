//! Smoke test against the real `codex app-server`. Ignored by default; run with
//! `VIBECODE_E2E=1 cargo.exe test -p vibecode-core --test codex_e2e -- --ignored --nocapture`.

use std::sync::Arc;

use vibecode_core::agents::codex::CodexHost;
use vibecode_core::backend::ExecBackend;

fn backend() -> Arc<ExecBackend> {
    Arc::new(ExecBackend::new())
}

/// Verify a paid, authenticated model turn through the same adapter used by the UI.
#[tokio::test]
#[ignore]
async fn e2e_authenticated_text_roundtrip() {
    assert_eq!(std::env::var("VIBECODE_E2E").ok().as_deref(), Some("1"), "set VIBECODE_E2E=1 to authorize live AI calls");
    use vibecode_core::agents::StartArgs;
    use vibecode_core::types::{Effort, PermissionPreset, Provider, SessionConfig, SessionEvent};

    let host = CodexHost::new();
    let b = backend();
    host.ensure_started(b.clone(), None).await.expect("start app-server");
    if !host.account_logged_in().await.expect("account/read") {
        host.shutdown().await;
        panic!("Sign in to Codex in the Windows app before running live AI tests");
    }
    let dir = tempfile::tempdir().unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let session = host.start_session(StartArgs {
        session_id: uuid::Uuid::new_v4().to_string(),
        config: SessionConfig {
            project_id: "live-test".into(), provider: Provider::Codex,
            model: None, effort: Some(Effort::Low), permission: PermissionPreset::AskEverything,
            append_system_prompt: None, resume_ref: None, fork: false,
        },
        cwd: dir.path().to_path_buf(), backend: b, bin: None, events: tx, mcp_servers: vec![],
    }).await.expect("start session");
    let result = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        session.send("Reply with exactly VIBECODE_LIVE_OK. Do not use tools.".into()).await.map_err(|e| e.to_string())?;
        let mut text = String::new();
        let mut initialized = false;
        let mut streamed = false;
        while let Some(event) = rx.recv().await {
            match event {
                SessionEvent::Init { provider: Provider::Codex, .. } => initialized = true,
                SessionEvent::TextDelta { .. } => streamed = true,
                SessionEvent::Text { text: block } => text.push_str(&block),
                SessionEvent::Error { message, .. } => return Err(message),
                SessionEvent::Exited { .. } => return Err("process exited before turn completed".into()),
                SessionEvent::TurnEnd { usage, .. } => {
                    if !initialized || !streamed || !text.contains("VIBECODE_LIVE_OK") || usage.output_tokens == 0 {
                        return Err(format!("incomplete live response: init={initialized}, stream={streamed}, text={text:?}, usage={usage:?}"));
                    }
                    return Ok(());
                }
                _ => {}
            }
        }
        Err("event channel closed before turn completed".into())
    }).await;
    let _ = session.close().await;
    host.shutdown().await;
    result.expect("live model turn timed out").expect("live model turn failed");
}

#[tokio::test]
#[ignore]
async fn e2e_app_server_handshake_and_models() {
    if std::env::var("VIBECODE_E2E").ok().as_deref() != Some("1") {
        eprintln!("VIBECODE_E2E != 1; skipping");
        return;
    }
    let b = backend();
    eprintln!("backend: {}", b.label());
    let host = CodexHost::new();
    host.ensure_started(b.clone(), None).await.expect("ensure_started");
    eprintln!("app-server started and initialized");

    let models = host.list_models().await.expect("model/list");
    eprintln!("models ({}):", models.len());
    for m in &models {
        eprintln!("  {} [{}] default={} efforts={:?}", m.id, m.label, m.is_default, m.efforts);
    }
    assert!(!models.is_empty());

    let logged_in = host.account_logged_in().await.expect("account/read");
    eprintln!("codex logged in: {logged_in}");

    // ensure_started is idempotent for the same environment
    host.ensure_started(b.clone(), None).await.expect("idempotent");
    assert!(host.is_running().await);

    let status = vibecode_core::tools::codex::auth_status(b.clone(), None).await.expect("login status");
    eprintln!("codex login status: logged_in={} method={:?} detail={:?}", status.logged_in, status.method, status.detail);
    assert_eq!(status.logged_in, logged_in);

    host.shutdown().await;
    assert!(!host.is_running().await);
}

/// `thread/start` must accept our MCP `config` overrides (dotted `mcp_servers.<name>` keys).
#[tokio::test]
#[ignore]
async fn e2e_thread_start_accepts_mcp_config_overrides() {
    if std::env::var("VIBECODE_E2E").ok().as_deref() != Some("1") {
        eprintln!("VIBECODE_E2E != 1; skipping");
        return;
    }
    let b = backend();
    let host = CodexHost::new();
    host.ensure_started(b.clone(), None).await.expect("ensure_started");
    let rpc = host.rpc().await.expect("rpc");
    let servers = vec![vibecode_core::types::McpServerConfig {
        id: "t".into(),
        name: "vibetest".into(),
        transport: vibecode_core::types::McpTransport::Http,
        command: None,
        args: vec![],
        env: vec![],
        url: Some("http://127.0.0.1:9/mcp".into()),
        enabled: true,
        providers: vec![],
    }];
    let overrides = vibecode_core::agents::codex::mapping::mcp_config_overrides(&servers);
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let params = serde_json::json!({ "cwd": cwd, "approvalPolicy": "never", "sandbox": "read-only", "serviceName": "vibecode", "ephemeral": true, "config": serde_json::Value::Object(overrides) });
    let v = rpc.request("thread/start", params).await.expect("thread/start with mcp config overrides");
    let thread_id = v["thread"]["id"].as_str().expect("thread id").to_string();
    eprintln!("thread/start ok with mcp override: thread {thread_id}");
    let _ = rpc.request("thread/unsubscribe", serde_json::json!({ "threadId": thread_id })).await;
    host.shutdown().await;
}
