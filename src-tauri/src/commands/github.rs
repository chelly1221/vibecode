use tauri::State;
use vibecode_core::{accounts, github::GitHubClient, types::{AccountKind, GitHubRepo, GitHubUser}};
use crate::state::{err, AppState};

fn validate(state: &State<'_, AppState>, id: Option<&str>) -> Result<(),String> {
    let id = id.ok_or("GitHub 계정을 먼저 선택하세요")?;
    { accounts::get(&state.ctx.db,id,AccountKind::Github).map_err(err)?; }
    Ok(())
}
#[tauri::command]
pub async fn github_set_token(state: State<'_, AppState>, token: String, account_id: Option<String>) -> Result<GitHubUser, String> {
    validate(&state,account_id.as_deref())?;
    let client = GitHubClient { token: token.trim().to_string() };
    let user = client.whoami().await.map_err(err)?;
    let key = accounts::token_key(account_id.as_deref());
    tokio::task::spawn_blocking(move || vibecode_core::secrets::set(&key, &client.token)).await.map_err(err)?.map_err(err)?;
    Ok(user)
}
#[tauri::command]
pub async fn github_clear_token(state: State<'_, AppState>, account_id: Option<String>) -> Result<(), String> {
    validate(&state,account_id.as_deref())?;
    let key = accounts::token_key(account_id.as_deref());
    tokio::task::spawn_blocking(move || vibecode_core::secrets::delete(&key)).await.map_err(err)?.map_err(err)
}
#[tauri::command]
pub async fn github_whoami(state: State<'_, AppState>, account_id: Option<String>) -> Result<Option<GitHubUser>, String> {
    if account_id.is_none() { return Ok(None); }
    validate(&state,account_id.as_deref())?;
    match accounts::github_client(account_id.as_deref()).await.map_err(err)? {
        Some(c) => c.whoami().await.map(Some).map_err(err), None => Ok(None),
    }
}
#[tauri::command]
pub async fn github_create_repo(state: State<'_, AppState>, name: String, private: bool, description: Option<String>, account_id: Option<String>) -> Result<GitHubRepo, String> {
    validate(&state,account_id.as_deref())?;
    let client = accounts::github_client(account_id.as_deref()).await.map_err(err)?.ok_or_else(|| "선택한 GitHub 계정을 먼저 연결하세요".to_string())?;
    client.create_repo(&name, private, description.as_deref().unwrap_or("")).await.map_err(err)
}
