use tauri::State;
use vibecode_core::types::{AuthStatus, BackendConfig, ModelInfo, Provider, ToolStatus};

use crate::state::{err, AppState};

/// Detect tools on the active backend, or on `backend` if given (onboarding preview).
#[tauri::command]
pub async fn tools_detect(state: State<'_, AppState>, backend: Option<BackendConfig>) -> Result<Vec<ToolStatus>, String> {
    let b = match backend {
        Some(cfg) => vibecode_core::backend::create_backend(&cfg).await.map_err(err)?,
        None => state.ctx.backend().await,
    };
    Ok(vibecode_core::tools::detect_all(b).await)
}

#[tauri::command]
pub async fn tools_auth_status(state: State<'_, AppState>, provider: Provider) -> Result<AuthStatus, String> {
    let b = state.ctx.backend().await;
    let bin = state.ctx.bin_override(provider).await;
    vibecode_core::tools::auth_status(b, provider, bin.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn tools_list_wsl_distros() -> Result<Vec<String>, String> {
    Ok(vibecode_core::backend::wsl::list_distros().await)
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
