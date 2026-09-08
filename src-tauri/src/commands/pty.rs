use tauri::ipc::Channel;
use tauri::State;
use vibecode_core::types::{PtyEvent, PtySpec};

use crate::state::{err, AppState};

#[tauri::command]
pub async fn pty_open(state: State<'_, AppState>, spec: PtySpec, project_id: Option<String>, on_event: Channel<PtyEvent>) -> Result<String, String> {
    let backend = if let Some(id) = project_id { vibecode_core::accounts::project_backend(&state.ctx, &id).await.map_err(err)? } else { state.ctx.backend().await };
    state
        .ctx
        .pty
        .open_with_backend(spec, &backend, Box::new(move |ev| {
            let _ = on_event.send(ev);
        }))
        .map_err(err)
}

#[tauri::command]
pub async fn pty_write(state: State<'_, AppState>, pty_id: String, data: String) -> Result<(), String> {
    state.ctx.pty.write(&pty_id, &data).map_err(err)
}

#[tauri::command]
pub async fn pty_resize(state: State<'_, AppState>, pty_id: String, cols: u16, rows: u16) -> Result<(), String> {
    state.ctx.pty.resize(&pty_id, cols, rows).map_err(err)
}

#[tauri::command]
pub async fn pty_close(state: State<'_, AppState>, pty_id: String) -> Result<(), String> {
    state.ctx.pty.close(&pty_id).map_err(err)
}
