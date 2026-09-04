use tauri::State;
use vibecode_core::types::AppSettings;

use crate::state::{err, AppState};

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(state.ctx.settings().await)
}

#[tauri::command]
pub async fn settings_set(state: State<'_, AppState>, settings: AppSettings) -> Result<AppSettings, String> {
    state.ctx.update_settings(settings).await.map_err(err)
}
