//! UI preview: a child webview (label "preview") placed over the main window at bounds the
//! React `PreviewPane` reports. Runs the project's dev server URL. `unstable` Tauri feature.
use serde::{Deserialize, Serialize};
use tauri::webview::WebviewBuilder;
use tauri::ipc::Channel;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, WebviewUrl};
use vibecode_core::types::{PreviewEvent, PreviewStatus};

use crate::state::{err, AppState};

pub const PREVIEW_LABEL: &str = "preview";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

const INIT_SCRIPT: &str = include_str!("../../preview-init.js");

/// Create (or navigate) the preview webview at `bounds`.
#[tauri::command]
pub async fn preview_open(app: AppHandle, url: String, bounds: Bounds) -> Result<(), String> {
    let parsed: url::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    if let Some(existing) = app.get_webview(PREVIEW_LABEL) {
        existing.navigate(parsed).map_err(|e| e.to_string())?;
        existing.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| e.to_string())?;
        existing.set_size(LogicalSize::new(bounds.width, bounds.height)).map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = app.get_window("main").ok_or("main window missing")?;
    let builder = WebviewBuilder::new(PREVIEW_LABEL, WebviewUrl::External(parsed))
        .initialization_script(INIT_SCRIPT)
        // Fallback: (re)inject after every navigation in case document-start injection is skipped for remote pages.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.eval(INIT_SCRIPT);
            }
        })
        .zoom_hotkeys_enabled(true);
    window
        .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn preview_set_bounds(app: AppHandle, bounds: Bounds) -> Result<(), String> {
    if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
        wv.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(bounds.width, bounds.height)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn preview_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
        if visible { wv.show() } else { wv.hide() }.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn preview_close(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn preview_reload(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
        wv.reload().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Run JS inside the preview (used to toggle the element picker).
#[tauri::command]
pub async fn preview_eval(app: AppHandle, js: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
        wv.eval(js).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Start the project's dev server; streams PreviewEvents (url detection included).
#[tauri::command]
pub async fn preview_server_start(state: State<'_, AppState>, project_id: String, command: String, on_event: Channel<PreviewEvent>) -> Result<(), String> {
    let project = state.ctx.db.get_project(&project_id).map_err(err)?;
    let backend = state.ctx.backend().await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PreviewEvent>();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if on_event.send(ev).is_err() {
                break;
            }
        }
    });
    state.ctx.preview.start(backend, &project_id, std::path::PathBuf::from(project.path), &command, tx).await.map_err(err)
}

#[tauri::command]
pub async fn preview_server_stop(state: State<'_, AppState>, project_id: String) -> Result<(), String> {
    state.ctx.preview.stop(&project_id).await.map_err(err)
}

#[tauri::command]
pub async fn preview_server_status(state: State<'_, AppState>, project_id: String) -> Result<PreviewStatus, String> {
    Ok(state.ctx.preview.status(&project_id).await)
}
