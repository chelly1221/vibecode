//! Watch what the real login CLIs print inside the hidden PTY (opens the browser; complete or ignore it).
//! VIBECODE_E2E=1 WSLENV=VIBECODE_E2E cargo.exe test -p vibecode-core --test login_e2e -- --ignored --nocapture
use std::sync::Arc;
use std::time::Duration;

use vibecode_core::tools::login;
use vibecode_core::types::{LoginEvent, Provider};
use vibecode_core::AppContext;

async fn watch(provider: Provider, secs: u64) {
    let data = tempfile::tempdir().unwrap();
    let ctx = AppContext::init(data.path().to_path_buf()).await.expect("ctx");
    let mut settings = ctx.settings().await;
    if let Ok(bin) = std::env::var("VIBECODE_CLAUDE_BIN") {
        settings.claude_bin = Some(bin);
    }
    ctx.update_settings(settings).await.unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<LoginEvent>();
    let flow = login::start(ctx.clone(), provider, Box::new(move |e| {
        let _ = tx.send(e);
    }))
    .await
    .expect("start login");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(ev)) => {
                eprintln!("[{provider:?}] {ev:?}");
                if matches!(ev, LoginEvent::Finished { .. }) {
                    break;
                }
            }
            _ => {
                eprintln!("[{provider:?}] timeout; cancelling");
                let _ = login::cancel(&ctx, &flow.pty_id);
                break;
            }
        }
    }
    let _ = Arc::strong_count(&ctx);
}

#[tokio::test]
#[ignore]
async fn claude_login_output() {
    if std::env::var("VIBECODE_E2E").ok().as_deref() != Some("1") {
        return;
    }
    watch(Provider::Claude, 90).await;
}

#[tokio::test]
#[ignore]
async fn codex_login_output() {
    if std::env::var("VIBECODE_E2E").ok().as_deref() != Some("1") {
        return;
    }
    watch(Provider::Codex, 45).await;
}
