use tauri::ipc::Channel;
use tauri::State;
use vibecode_core::projects::{catalog, scaffold};
use vibecode_core::types::{AgentDocsStatus, CreateProjectRequest, ExportEvent, ProjectPlan, ProjectPlanRequest, ProjectRecord, ProjectRemoteStatus, ProjectSettingsUpdate, ProjectType, ScaffoldEvent, StackInfo, StackRecommendRequest, StackRecommendation, TargetOs};

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
pub async fn projects_open(state: State<'_, AppState>, path: String, name: Option<String>) -> Result<ProjectRecord, String> {
    scaffold::open_existing_named(state.ctx.clone(), &path, name.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn projects_rename(state: State<'_, AppState>, id: String, name: String) -> Result<ProjectRecord, String> {
    scaffold::rename_project(state.ctx.clone(), &id, &name).await.map_err(err)
}

#[tauri::command]
pub async fn projects_update(state: State<'_, AppState>, id: String, req: ProjectSettingsUpdate) -> Result<ProjectRecord, String> {
    vibecode_core::projects::settings::update(state.ctx.clone(), id, req).await.map_err(err)
}

#[tauri::command]
pub async fn projects_remote_status(state: State<'_, AppState>, id: String) -> Result<ProjectRemoteStatus, String> {
    vibecode_core::projects::settings::remote_status(state.ctx.clone(), id).await.map_err(err)
}

#[tauri::command]
pub async fn projects_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Ok(p) = state.ctx.db.get_project(&id) {
        state.ctx.docs_sync.unwatch(std::path::Path::new(&p.path));
    }
    state.ctx.db.delete_project(&id).map_err(err)
}

/// Make CLAUDE.md / AGENTS.md identical (clone the missing one, newest content wins). Returns the file written, if any.
#[tauri::command]
pub async fn projects_sync_agent_docs(state: State<'_, AppState>, id: String) -> Result<Vec<String>, String> {
    scaffold::sync_agent_docs(&state.ctx, &id).map_err(err)
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
    if req.account_id.is_none() { return Err("추천을 받을 AI 계정을 먼저 선택하세요".into()); }
    let backend = vibecode_core::accounts::agent_backend(&state.ctx, req.provider, req.account_id.as_deref()).map_err(err)?;
    let bin = state.ctx.bin_override(req.provider).await;
    vibecode_core::projects::ai_recommend::recommend(backend, bin, req).await.map_err(err)
}

#[tauri::command]
pub async fn projects_agent_docs_status(state: State<'_, AppState>, id: String) -> Result<AgentDocsStatus, String> {
    let project = state.ctx.db.get_project(&id).map_err(err)?;
    Ok(scaffold::agent_docs_status(std::path::Path::new(&project.path)))
}

/// Create CLAUDE.md / AGENTS.md for an externally created project (existing files are kept). Returns written file names.
#[tauri::command]
pub async fn projects_generate_agent_docs(state: State<'_, AppState>, id: String, description: Option<String>) -> Result<Vec<String>, String> {
    scaffold::generate_agent_docs_if_missing(state.ctx.clone(), &id, description.as_deref().unwrap_or("")).await.map_err(err)
}

/// "Describe it in one line": the agent picks name, folder, target, type and stack (validated against the catalog).
#[tauri::command]
pub async fn projects_ai_plan(state: State<'_, AppState>, req: ProjectPlanRequest) -> Result<ProjectPlan, String> {
    vibecode_core::projects::ai_plan::plan(state.ctx.clone(), req).await.map_err(err)
}

/// Suggested file name for the export save dialog (None = the stack has no export recipe).
#[tauri::command]
pub async fn projects_export_name(state: State<'_, AppState>, id: String) -> Result<Option<String>, String> {
    let project = state.ctx.db.get_project(&id).map_err(err)?;
    let stack = project.stack_id.as_deref().map(catalog::get).transpose().map_err(err)?.flatten();
    let Some(cfg) = stack.and_then(|s| s.export) else { return Ok(None) };
    let dir_name = std::path::Path::new(&project.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Some(vibecode_core::projects::export::suggested_file_name(&project.name, &dir_name, &cfg)))
}

/// Build the project with its stack's export recipe and package the result at `dest`.
/// Streams `ExportEvent`s; resolves with the written path.
#[tauri::command]
pub async fn projects_export(state: State<'_, AppState>, id: String, dest: String, on_event: Channel<ExportEvent>) -> Result<String, String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ExportEvent>();
    let forward = tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let _ = on_event.send(ev);
        }
    });
    let res = vibecode_core::projects::export::run(state.ctx.clone(), &id, &dest, tx).await.map_err(err);
    let _ = forward.await;
    res
}
