use vibecode_core::github::{GitHubClient, TOKEN_KEY};
use vibecode_core::types::{GitHubRepo, GitHubUser};

use crate::state::err;

#[tauri::command]
pub async fn github_set_token(token: String) -> Result<GitHubUser, String> {
    let client = GitHubClient { token: token.trim().to_string() };
    let user = client.whoami().await.map_err(err)?;
    vibecode_core::secrets::set(TOKEN_KEY, &client.token).map_err(err)?;
    Ok(user)
}

#[tauri::command]
pub async fn github_clear_token() -> Result<(), String> {
    vibecode_core::secrets::delete(TOKEN_KEY).map_err(err)
}

/// None when no token is stored.
#[tauri::command]
pub async fn github_whoami() -> Result<Option<GitHubUser>, String> {
    match GitHubClient::from_keyring().map_err(err)? {
        Some(c) => c.whoami().await.map(Some).map_err(err),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn github_create_repo(name: String, private: bool, description: Option<String>) -> Result<GitHubRepo, String> {
    let client = GitHubClient::from_keyring().map_err(err)?.ok_or_else(|| "GitHub token not configured".to_string())?;
    client.create_repo(&name, private, description.as_deref().unwrap_or("")).await.map_err(err)
}
