use tauri::ipc::Channel;
use tauri::State;
use vibecode_core::types::{AuthStatus, LoginEvent, ModelInfo, Provider, ToolInstallEvent, ToolStatus};

use crate::state::{err, AppState};

/// Detect tools on the host, honouring the claude/codex/git binaries set in settings.
#[tauri::command]
pub async fn tools_detect(state: State<'_, AppState>) -> Result<Vec<ToolStatus>, String> {
    let b = state.ctx.backend().await;
    let overrides = [
        ("claude", state.ctx.bin_override(Provider::Claude).await),
        ("codex", state.ctx.bin_override(Provider::Codex).await),
        ("git", state.ctx.git_bin().await),
    ];
    Ok(vibecode_core::tools::detect_all_with(b, &overrides).await)
}

/// Auth status of a provider's CLI (honouring the binary override from settings).
#[tauri::command]
pub async fn tools_auth_status(state: State<'_, AppState>, provider: Provider) -> Result<AuthStatus, String> {
    let b = state.ctx.backend().await;
    let bin = state.ctx.bin_override(provider).await;
    vibecode_core::tools::auth_status(b, provider, bin.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn models_list(state: State<'_, AppState>, provider: Provider) -> Result<Vec<ModelInfo>, String> {
    let b = state.ctx.backend().await;
    let bin = state.ctx.bin_override(provider).await;
    match provider {
        Provider::Codex => {
            state.ctx.codex.ensure_started(b.clone(), bin.clone()).await.map_err(err)?;
            state.ctx.codex.list_models().await.map_err(err)
        }
        Provider::Claude => vibecode_core::tools::list_models(b, provider, bin.as_deref()).await.map_err(err),
    }
}

/// Install a known tool with its install hint in the background, streaming log lines; resolves when the
/// installer exited (the final event carries the re-detected status).
#[tauri::command]
pub async fn tools_install(state: State<'_, AppState>, name: String, on_event: Channel<ToolInstallEvent>) -> Result<ToolStatus, String> {
    let backend = state.ctx.backend().await;
    let Some(hint) = vibecode_core::tools::install_hint(&name).filter(|h| vibecode_core::tools::runnable_hint(h)) else {
        return Err(format!("{name}: 자동 설치 방법이 없습니다"));
    };
    let ev = on_event.clone();
    let code = vibecode_core::tools::install(&backend, &hint, move |line, is_err| {
        let _ = ev.send(ToolInstallEvent::Log { line, is_err });
    })
    .await
    .map_err(err)?;
    let status = vibecode_core::tools::detect(backend, &name, None).await;
    let ok = status.found || matches!(code, Some(0) | Some(3010));
    let message = if status.found {
        status.version.clone().unwrap_or_else(|| "설치됨".into())
    } else if ok {
        "설치됨 (경로는 앱을 다시 시작하면 반영됩니다)".into()
    } else {
        format!("설치 실패 (종료 코드 {})", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()))
    };
    let _ = on_event.send(ToolInstallEvent::Finished { ok, message, status: status.clone() });
    Ok(status)
}

/// Start a GUI login for `provider`: the CLI runs in a hidden PTY and its URL / code prompt / exit are
/// streamed as LoginEvents. Resolves with the login id used by `tools_login_code` / `tools_login_cancel`.
#[tauri::command]
pub async fn tools_login_start(state: State<'_, AppState>, provider: Provider, on_event: Channel<LoginEvent>) -> Result<String, String> {
    let flow = vibecode_core::tools::login::start(state.ctx.clone(), provider, Box::new(move |e| {
        let _ = on_event.send(e);
    }))
    .await
    .map_err(err)?;
    Ok(flow.pty_id)
}

#[tauri::command]
pub async fn tools_login_code(state: State<'_, AppState>, login_id: String, code: String) -> Result<(), String> {
    vibecode_core::tools::login::submit_code(&state.ctx, &login_id, &code).map_err(err)
}

#[tauri::command]
pub async fn tools_login_cancel(state: State<'_, AppState>, login_id: String) -> Result<(), String> {
    vibecode_core::tools::login::cancel(&state.ctx, &login_id).map_err(err)
}
