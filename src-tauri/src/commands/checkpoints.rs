use tauri::State;
use vibecode_core::checkpoint;
use vibecode_core::types::CheckpointRecord;

use crate::state::{err, AppState};

#[tauri::command]
pub async fn checkpoints_list(state: State<'_, AppState>, project_id: String, session_id: Option<String>) -> Result<Vec<CheckpointRecord>, String> {
    checkpoint::list(state.ctx.clone(), &project_id, session_id.as_deref()).await.map_err(err)
}

/// Manual checkpoint ("지금 상태 저장"). Returns None when nothing changed.
#[tauri::command]
pub async fn checkpoint_create(state: State<'_, AppState>, project_id: String, session_id: Option<String>, label: Option<String>) -> Result<Option<CheckpointRecord>, String> {
    checkpoint::create(state.ctx.clone(), &project_id, session_id.as_deref(), label.as_deref().unwrap_or("수동 저장")).await.map_err(err)
}

/// Restore the working tree; resolves with the safety checkpoint taken right before restoring.
#[tauri::command]
pub async fn checkpoint_restore(state: State<'_, AppState>, checkpoint_id: String) -> Result<CheckpointRecord, String> {
    checkpoint::restore(state.ctx.clone(), &checkpoint_id).await.map_err(err)
}

#[tauri::command]
pub async fn checkpoint_diff(state: State<'_, AppState>, checkpoint_id: String) -> Result<String, String> {
    checkpoint::diff(state.ctx.clone(), &checkpoint_id).await.map_err(err)
}
