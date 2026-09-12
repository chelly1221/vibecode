use tauri::State;
use vibecode_core::types::{Provider, RateLimitWindow, UsageSample};

use crate::state::{err, AppState};

/// Stored usage samples of one account from the last `hours` hours (oldest first).
#[tauri::command]
pub async fn usage_history(state: State<'_, AppState>, provider: Provider, account_id: Option<String>, hours: Option<i64>) -> Result<Vec<UsageSample>, String> {
    vibecode_core::usage::history(&state.ctx, provider, account_id.as_deref(), hours.unwrap_or(24)).map_err(err)
}

/// Newest sample of every known (provider, account, window).
#[tauri::command]
pub async fn usage_latest(state: State<'_, AppState>) -> Result<Vec<UsageSample>, String> {
    vibecode_core::usage::latest(&state.ctx).map_err(err)
}

/// Ask the CLI for fresh values (Codex only; Claude reports during sessions).
#[tauri::command]
pub async fn usage_refresh(state: State<'_, AppState>, provider: Provider, account_id: Option<String>) -> Result<Vec<RateLimitWindow>, String> {
    vibecode_core::usage::refresh(state.ctx.clone(), provider, account_id.as_deref()).await.map_err(err)
}
