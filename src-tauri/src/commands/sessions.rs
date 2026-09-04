use tauri::ipc::Channel;
use tauri::State;
use vibecode_core::types::{MessageRecord, PermissionReply, QuestionAnswer, SessionConfig, SessionConfigPatch, SessionEvent, SessionRecord};

use crate::state::{err, AppState};

/// Start or resume a session. Events stream over `on_event` until `Exited`.
#[tauri::command]
pub async fn session_start(state: State<'_, AppState>, config: SessionConfig, on_event: Channel<SessionEvent>) -> Result<SessionRecord, String> {
    let (record, mut rx) = state.ctx.sessions.start(state.ctx.clone(), config).await.map_err(err)?;
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if on_event.send(ev).is_err() {
                break;
            }
        }
    });
    Ok(record)
}

#[tauri::command]
pub async fn session_send(state: State<'_, AppState>, session_id: String, text: String) -> Result<(), String> {
    state.ctx.sessions.send(state.ctx.clone(), &session_id, text).await.map_err(err)
}

#[tauri::command]
pub async fn session_interrupt(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.ctx.sessions.interrupt(&session_id).await.map_err(err)
}

#[tauri::command]
pub async fn session_permission_reply(state: State<'_, AppState>, session_id: String, reply: PermissionReply) -> Result<(), String> {
    state.ctx.sessions.reply_permission(&session_id, reply).await.map_err(err)
}

#[tauri::command]
pub async fn session_update_config(state: State<'_, AppState>, session_id: String, patch: SessionConfigPatch) -> Result<(), String> {
    state.ctx.sessions.update_config(&session_id, patch).await.map_err(err)
}

#[tauri::command]
pub async fn session_close(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.ctx.sessions.close(&session_id).await.map_err(err)
}

#[tauri::command]
pub async fn sessions_list(state: State<'_, AppState>, project_id: String) -> Result<Vec<SessionRecord>, String> {
    state.ctx.db.list_sessions(&project_id).map_err(err)
}

#[tauri::command]
pub async fn session_messages(state: State<'_, AppState>, session_id: String) -> Result<Vec<MessageRecord>, String> {
    state.ctx.db.list_messages(&session_id).map_err(err)
}

#[tauri::command]
pub async fn session_delete(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let _ = state.ctx.sessions.close(&session_id).await;
    state.ctx.db.delete_session(&session_id).map_err(err)
}

#[tauri::command]
pub async fn session_answer_question(state: State<'_, AppState>, session_id: String, request_id: String, answers: Vec<QuestionAnswer>) -> Result<(), String> {
    state.ctx.sessions.answer_question(&session_id, request_id, answers).await.map_err(err)
}

#[tauri::command]
pub async fn session_rename(state: State<'_, AppState>, session_id: String, title: String) -> Result<(), String> {
    state.ctx.db.rename_session(&session_id, title.trim()).map_err(err)
}

#[tauri::command]
pub async fn session_set_archived(state: State<'_, AppState>, session_id: String, archived: bool) -> Result<(), String> {
    state.ctx.db.set_session_archived(&session_id, archived).map_err(err)
}

/// Render the transcript as Markdown (implemented in core by the sessions fork).
#[tauri::command]
pub async fn session_export_markdown(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    vibecode_core::agents::export::session_markdown(&state.ctx, &session_id).await.map_err(err)
}

/// Write the Markdown export to `path` (host path chosen with the save dialog).
#[tauri::command]
pub async fn session_export_to_file(state: State<'_, AppState>, session_id: String, path: String) -> Result<(), String> {
    let md = vibecode_core::agents::export::session_markdown(&state.ctx, &session_id).await.map_err(err)?;
    std::fs::write(&path, md).map_err(err)
}
