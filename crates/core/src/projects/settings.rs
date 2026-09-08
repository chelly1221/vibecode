//! Project defaults, named accounts and the local GitHub repository connection.
use std::{path::PathBuf, sync::Arc};
use crate::{accounts, error::{CoreError, Result}, git::Git, types::{ProjectRecord, ProjectRemoteStatus, ProjectSettingsUpdate}, AppContext};
use super::scaffold::valid_display_name;

/// Accept repository URLs only, without embedded credentials, query strings or command transports.
pub fn github_repository_url(value: &str) -> Result<String> {
    let value = value.trim().trim_end_matches('/');
    let path = value.strip_prefix("https://github.com/")
        .or_else(|| value.strip_prefix("git@github.com:"))
        .or_else(|| value.strip_prefix("ssh://git@github.com/"))
        .ok_or_else(|| CoreError::msg("GitHub 저장소 주소를 입력하세요. 예: https://github.com/owner/repository"))?;
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))) {
        return Err(CoreError::msg("GitHub 저장소 주소의 소유자와 저장소 이름을 확인하세요."));
    }
    let name = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
    if [parts[0], name].iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return Err(CoreError::msg("GitHub 저장소 이름을 확인하세요."));
    }
    Ok(format!("https://github.com/{}/{name}", parts[0]))
}

pub async fn remote_status(ctx: Arc<AppContext>, id: String) -> Result<ProjectRemoteStatus> {
    let read_ctx = ctx.clone();
    let project = tokio::task::spawn_blocking(move || read_ctx.db.get_project(&id)).await.map_err(|e| CoreError::msg(e.to_string()))??;
    let git = Git::new(ctx.backend().await, ctx.git_bin().await);
    let dir = PathBuf::from(project.path);
    let is_repo = git.is_repository(&dir).await?;
    let url = if is_repo { git.remote_url(&dir, "origin").await? } else { None };
    Ok(ProjectRemoteStatus { is_repo, url })
}

pub async fn update(ctx: Arc<AppContext>, id: String, mut req: ProjectSettingsUpdate) -> Result<ProjectRecord> {
    let _changes = ctx.account_changes.lock().await;
    req.name = req.name.trim().to_string();
    if !valid_display_name(&req.name) { return Err(CoreError::msg("프로젝트 이름을 확인하세요.")); }
    req.default_model = req.default_model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    if req.default_model.as_ref().is_some_and(|m| m.len() > 200 || m.chars().any(char::is_control)) {
        return Err(CoreError::msg("모델 이름을 확인하세요."));
    }
    let read_ctx = ctx.clone();
    let read_id = id.clone();
    let selected = req.accounts.clone();
    let project = tokio::task::spawn_blocking(move || {
        accounts::validate(&read_ctx.db, &selected)?;
        read_ctx.db.get_project(&read_id)
    }).await.map_err(|e| CoreError::msg(e.to_string()))??;
    let github_url = if req.update_remote {
        req.remote_url.as_deref().map(str::trim).filter(|u| !u.is_empty()).map(github_repository_url).transpose()?
    } else { None };
    if github_url.is_some() && req.accounts.github.is_none() {
        return Err(CoreError::msg("저장소에 사용할 GitHub 계정을 선택하세요."));
    }

    let git = Git::new(ctx.backend().await, ctx.git_bin().await);
    let dir = PathBuf::from(project.path);
    let previous_origin = if req.update_remote {
        if !git.is_repository(&dir).await? { return Err(CoreError::msg("이 폴더에서 변경 기록을 먼저 시작하세요.")); }
        Some(git.configure_origin(&dir, github_url.as_deref()).await?)
    } else { None };

    let save_ctx = ctx.clone();
    let saved = tokio::task::spawn_blocking(move || save_ctx.db.update_project_settings(&id, &req, github_url.as_deref()))
        .await.map_err(|e| CoreError::msg(e.to_string())).and_then(|r| r);
    if saved.is_err() {
        if let Some(previous) = previous_origin {
            if let Err(restore) = git.restore_origin(&dir, &previous).await {
                return Err(CoreError::msg(format!("프로젝트 저장 실패: {}. 이전 저장소 연결 복구 실패: {restore}", saved.unwrap_err())));
            }
        }
    }
    saved
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_urls_reject_credentials_and_non_repository_addresses() {
        for url in ["https://github.com/team/repo.git", "git@github.com:team/repo.git", "ssh://git@github.com/team/repo"] {
            assert_eq!(github_repository_url(url).unwrap(), "https://github.com/team/repo");
        }
        for url in ["https://token@github.com/team/repo", "https://example.com/team/repo", "-u", "file:///tmp/repo", "https://github.com/team/repo?token=secret", "https://github.com/team/repo/tree/main", "https://github.com/team/..", "https://github.com/team/.git"] {
            assert!(github_repository_url(url).is_err(), "{url}");
        }
    }
}
