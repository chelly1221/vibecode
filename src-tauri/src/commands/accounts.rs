use tauri::State;
use vibecode_core::{accounts, types::{AccountKind, AccountProfile, ProjectAccounts}};
use crate::state::{err, AppState};

#[tauri::command]
pub async fn accounts_list(state: State<'_, AppState>) -> Result<Vec<AccountProfile>, String> { accounts::list(&state.ctx.db).map_err(err) }
#[tauri::command]
pub async fn accounts_create(state: State<'_, AppState>, name: String, kind: AccountKind) -> Result<AccountProfile, String> { accounts::create(&state.ctx, name, kind).map_err(err) }
#[tauri::command]
pub async fn accounts_remove(state: State<'_, AppState>, id: String) -> Result<(), String> { accounts::remove(&state.ctx, &id).await.map_err(err) }
#[tauri::command]
pub async fn accounts_project_get(state: State<'_, AppState>, project_id: String) -> Result<ProjectAccounts, String> { accounts::project(&state.ctx.db, &project_id).map_err(err) }
#[tauri::command]
pub async fn accounts_project_set(state: State<'_, AppState>, project_id: String, selected: ProjectAccounts) -> Result<ProjectAccounts, String> { let _changes = state.ctx.account_changes.lock().await; accounts::set_project(&state.ctx.db, &project_id, &selected).map_err(err) }
#[tauri::command]
pub async fn accounts_session_get(state: State<'_, AppState>, session_id: String) -> Result<ProjectAccounts, String> { accounts::session(&state.ctx.db, &session_id).map_err(err) }
