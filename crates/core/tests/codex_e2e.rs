//! Smoke test against the real `codex app-server`. Ignored by default; run with
//! `VIBECODE_E2E=1 cargo.exe test -p vibecode-core --test codex_e2e -- --ignored --nocapture`.
//! On Windows it runs through WSL (`VIBECODE_WSL_DISTRO`, default "Ubuntu").

use std::sync::Arc;

use vibecode_core::agents::codex::CodexHost;
use vibecode_core::backend::ExecBackend;

fn backend() -> Arc<dyn ExecBackend> {
    #[cfg(windows)]
    {
        let distro = std::env::var("VIBECODE_WSL_DISTRO").unwrap_or_else(|_| "Ubuntu".into());
        Arc::new(vibecode_core::backend::wsl::WslBackend::new(distro))
    }
    #[cfg(not(windows))]
    {
        Arc::new(vibecode_core::backend::native::NativeBackend::new())
    }
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
    let cwd = b.to_backend_path(&std::env::temp_dir());
    let params = serde_json::json!({ "cwd": cwd, "approvalPolicy": "never", "sandbox": "read-only", "serviceName": "vibecode", "ephemeral": true, "config": serde_json::Value::Object(overrides) });
    let v = rpc.request("thread/start", params).await.expect("thread/start with mcp config overrides");
    let thread_id = v["thread"]["id"].as_str().expect("thread id").to_string();
    eprintln!("thread/start ok with mcp override: thread {thread_id}");
    let _ = rpc.request("thread/unsubscribe", serde_json::json!({ "threadId": thread_id })).await;
    host.shutdown().await;
}
