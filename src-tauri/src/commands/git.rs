use std::path::PathBuf;

use tauri::State;
use vibecode_core::git::Git;
use vibecode_core::types::{GitBranch, GitCommit, GitStatus, Provider};

use crate::state::{err, AppState};

async fn git_for(state: &State<'_, AppState>, project_id: &str) -> Result<(Git, PathBuf), String> {
    vibecode_core::git::for_project(&state.ctx, project_id).await.map_err(err)
}

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>, project_id: String) -> Result<GitStatus, String> {
    let (git, repo) = git_for(&state, &project_id).await?;
    git.status(&repo).await.map_err(err)
}

/// `git init -b main` in the project folder (GUI replacement for running git init by hand).
#[tauri::command]
pub async fn git_init(state: State<'_, AppState>, project_id: String) -> Result<(), String> {
    let (git, repo) = git_for(&state, &project_id).await?;
    git.init(&repo, "main").await.map_err(err)
}

#[tauri::command]
pub async fn git_diff(state: State<'_, AppState>, project_id: String, path: Option<String>, staged: bool) -> Result<String, String> {
    let (git, repo) = git_for(&state, &project_id).await?;
    git.diff(&repo, path.as_deref(), staged).await.map_err(err)
}

#[tauri::command]
pub async fn git_stage(state: State<'_, AppState>, project_id: String, paths: Vec<String>) -> Result<(), String> {
    let (git, repo) = git_for(&state, &project_id).await?;
    git.stage(&repo, &paths).await.map_err(err)
}

#[tauri::command]
pub async fn git_unstage(state: State<'_, AppState>, project_id: String, paths: Vec<String>) -> Result<(), String> {
    let (git, repo) = git_for(&state, &project_id).await?;
    git.unstage(&repo, &paths).await.map_err(err)
}

#[tauri::command]
pub async fn git_commit(state: State<'_, AppState>, project_id: String, message: String) -> Result<String, String> {
    let (git, repo) = git_for(&state, &project_id).await?;
    git.commit(&repo, &message).await.map_err(err)
}

#[tauri::command]
pub async fn git_push(state: State<'_, AppState>, project_id: String) -> Result<String, String> {
    let (git, repo) = git_for(&state, &project_id).await?;
    git.push(&repo, true).await.map_err(err)
}

#[tauri::command]
pub async fn git_pull(state: State<'_, AppState>, project_id: String) -> Result<String, String> {
    let (git, repo) = git_for(&state, &project_id).await?;
    git.pull(&repo).await.map_err(err)
}

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>, project_id: String) -> Result<String, String> {
    let (git, repo) = git_for(&state, &project_id).await?;
    git.fetch(&repo).await.map_err(err)
}

#[tauri::command]
pub async fn git_branches(state: State<'_, AppState>, project_id: String) -> Result<Vec<GitBranch>, String> {
    let (git, repo) = git_for(&state, &project_id).await?;
    git.branches(&repo).await.map_err(err)
}

#[tauri::command]
pub async fn git_checkout(state: State<'_, AppState>, project_id: String, branch: String, create: bool) -> Result<(), String> {
    let (git, repo) = git_for(&state, &project_id).await?;
    git.checkout(&repo, &branch, create).await.map_err(err)
}

#[tauri::command]
pub async fn git_log(state: State<'_, AppState>, project_id: String, limit: Option<usize>) -> Result<Vec<GitCommit>, String> {
    let (git, repo) = git_for(&state, &project_id).await?;
    git.log(&repo, limit.unwrap_or(50)).await.map_err(err)
}

/// Ask an agent (one-shot, no session) for a conventional commit message.
#[tauri::command]
pub async fn git_generate_commit_message(state: State<'_, AppState>, project_id: String, provider: Provider) -> Result<String, String> {
    if vibecode_core::accounts::project(&state.ctx.db, &project_id).map_err(err)?.agent(provider).is_none() { return Err("프로젝트에서 사용할 AI 계정을 먼저 선택하세요".into()); }
    let (git, repo) = git_for(&state, &project_id).await?;
    let diff = git.diff_for_commit_message(&repo).await.map_err(err)?;
    let backend = vibecode_core::accounts::project_backend(&state.ctx, &project_id).await.map_err(err)?;
    let bin = state.ctx.bin_override(provider).await;
    vibecode_core::agents::oneshot::commit_message(backend, provider, bin, &repo, &diff).await.map_err(err)
}
