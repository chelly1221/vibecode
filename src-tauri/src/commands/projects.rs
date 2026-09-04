use tauri::ipc::Channel;
use tauri::State;
use vibecode_core::projects::{catalog, scaffold};
use vibecode_core::types::{CreateProjectRequest, ProjectRecord, ProjectType, ScaffoldEvent, StackInfo, StackRecommendRequest, StackRecommendation, TargetOs};

use crate::state::{err, AppState};

#[tauri::command]
pub async fn projects_list(state: State<'_, AppState>) -> Result<Vec<ProjectRecord>, String> {
    state.ctx.db.list_projects().map_err(err)
}

#[tauri::command]
pub async fn projects_get(state: State<'_, AppState>, id: String) -> Result<ProjectRecord, String> {
    state.ctx.db.get_project(&id).map_err(err)
}

/// Streams `ScaffoldEvent`s over `on_event`; resolves with the created project.
#[tauri::command]
pub async fn projects_create(state: State<'_, AppState>, req: CreateProjectRequest, on_event: Channel<ScaffoldEvent>) -> Result<ProjectRecord, String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ScaffoldEvent>();
    let forward = tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let _ = on_event.send(ev);
        }
    });
    let res = scaffold::create_project(state.ctx.clone(), req, tx).await.map_err(err);
    let _ = forward.await;
    res
}

#[tauri::command]
pub async fn projects_open(state: State<'_, AppState>, path: String) -> Result<ProjectRecord, String> {
    scaffold::open_existing(state.ctx.clone(), &path).await.map_err(err)
}

#[tauri::command]
pub async fn projects_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.ctx.db.delete_project(&id).map_err(err)
}

#[tauri::command]
pub async fn stacks_list() -> Result<Vec<StackInfo>, String> {
    catalog::load().map_err(err)
}

#[tauri::command]
pub async fn stacks_recommend(target_os: TargetOs, project_type: ProjectType) -> Result<Vec<StackInfo>, String> {
    catalog::recommend(target_os, project_type).map_err(err)
}

/// One-shot agent call ranking catalog stacks for a free-text description.
#[tauri::command]
pub async fn stacks_ai_recommend(state: State<'_, AppState>, req: StackRecommendRequest) -> Result<Vec<StackRecommendation>, String> {
    let backend = state.ctx.backend().await;
    let bin = state.ctx.bin_override(req.provider).await;
    vibecode_core::projects::ai_recommend::recommend(backend, bin, req).await.map_err(err)
}
