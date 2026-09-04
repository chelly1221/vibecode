use std::path::PathBuf;

use tauri::State;
use vibecode_core::types::{FsEntry, FsFile};

use crate::state::{err, AppState};

#[tauri::command]
pub async fn fs_list(state: State<'_, AppState>, project_id: String, rel_path: Option<String>) -> Result<Vec<FsEntry>, String> {
    let project = state.ctx.db.get_project(&project_id).map_err(err)?;
    vibecode_core::fs::list_dir(&PathBuf::from(project.path), rel_path.as_deref().unwrap_or("")).map_err(err)
}

#[tauri::command]
pub async fn fs_read(state: State<'_, AppState>, project_id: String, rel_path: String) -> Result<FsFile, String> {
    let project = state.ctx.db.get_project(&project_id).map_err(err)?;
    vibecode_core::fs::read_file(&PathBuf::from(project.path), &rel_path).map_err(err)
}
