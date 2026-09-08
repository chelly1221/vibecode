//! SSH key helpers (host ~/.ssh).
use tauri::State;
use vibecode_core::types::SshKeyInfo;

use crate::state::{err, AppState};

#[tauri::command]
pub async fn env_ssh_key_info(state: State<'_, AppState>) -> Result<SshKeyInfo, String> {
    vibecode_core::git::ssh::key_info(state.ctx.backend().await).await.map_err(err)
}

#[tauri::command]
pub async fn env_ssh_generate_key(state: State<'_, AppState>) -> Result<SshKeyInfo, String> {
    vibecode_core::git::ssh::generate_key(state.ctx.backend().await).await.map_err(err)
}

/// `ssh -T git@github.com`; resolves with the GitHub username when the key is registered.
#[tauri::command]
pub async fn env_ssh_test_github(state: State<'_, AppState>) -> Result<String, String> {
    vibecode_core::git::ssh::test_github(state.ctx.backend().await).await.map_err(err)
}
