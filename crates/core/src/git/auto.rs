//! Automatic commit (and push) after every agent turn, per project setting (`AutoGit`).
//!
//! Runs off the session pipeline: `SessionManager` spawns `after_turn` when a turn ends and the
//! outcome comes back as `SessionEvent::AutoGit` through `SessionManager::emit`, so it is persisted
//! and shown in the transcript like any other event. Nothing here ever fails the turn: every error
//! becomes an `AutoGit { ok: false }` event.

use std::sync::Arc;

use crate::context::AppContext;
use crate::error::Result;
use crate::types::{AutoGit, SessionEvent};

/// Subject line length limit (git convention, a bit generous for Korean text).
const SUBJECT_CHARS: usize = 72;
const FALLBACK_SUBJECT: &str = "AI 작업 결과 자동 저장";

/// Interrupted / aborted turns leave half-done edits behind: those are not committed.
pub fn should_run(stop_reason: Option<&str>) -> bool {
    match stop_reason {
        Some(r) => {
            let r = r.to_ascii_lowercase();
            !(r.contains("interrupt") || r.contains("abort"))
        }
        None => true,
    }
}

/// Commit message from the user's request: first non-empty line as the subject, plus a trailer.
pub fn commit_message(prompt: &str) -> String {
    let first = prompt.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let one_line: String = first.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut subject: String = crate::checkpoint::sanitize_label(&one_line).chars().take(SUBJECT_CHARS).collect();
    if one_line.chars().count() > SUBJECT_CHARS {
        subject.push('…');
    }
    if subject.trim().is_empty() {
        subject = FALLBACK_SUBJECT.to_string();
    }
    format!("{subject}\n\nVibecoder가 AI 작업이 끝난 뒤 자동으로 저장한 버전입니다.")
}

/// Effective mode for a project (project override, else the global default).
pub async fn mode_for(ctx: &AppContext, project_id: &str) -> Result<AutoGit> {
    let project = ctx.db.get_project(project_id)?;
    Ok(project.auto_git.unwrap_or(ctx.settings().await.auto_git))
}

/// Commit (and push) the project's working tree if the turn changed anything. Emits one
/// `SessionEvent::AutoGit` into `session_id` unless there was nothing to do.
pub async fn after_turn(ctx: Arc<AppContext>, project_id: &str, session_id: &str, prompt: &str) {
    let mode = match mode_for(&ctx, project_id).await {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("auto git: cannot read project {project_id}: {e}");
            return;
        }
    };
    if mode == AutoGit::Off {
        return;
    }
    // One run per project at a time: two sessions ending together must not race `git add`/`commit`.
    let lock = ctx.auto_git_lock(project_id).await;
    let _guard = lock.lock().await;
    let outcome = run(&ctx, project_id, prompt, mode).await;
    let ev = match outcome {
        Ok(Some(o)) => SessionEvent::AutoGit { ok: o.ok, message: o.message, commit: o.commit, pushed: o.pushed },
        Ok(None) => return,
        Err(e) => SessionEvent::AutoGit { ok: false, message: format!("자동 저장 실패: {e}"), commit: None, pushed: false },
    };
    if !ctx.sessions.emit(session_id, ev).await {
        tracing::debug!("auto git: session {session_id} is gone; outcome dropped");
    }
}

struct Outcome {
    ok: bool,
    message: String,
    commit: Option<String>,
    pushed: bool,
}

async fn run(ctx: &AppContext, project_id: &str, prompt: &str, mode: AutoGit) -> Result<Option<Outcome>> {
    let (git, repo) = crate::git::for_project(ctx, project_id).await?;
    if !git.is_repository(&repo).await? {
        tracing::debug!("auto git: {project_id} is not a repository; skipped");
        return Ok(None);
    }
    let status = git.status(&repo).await?;
    if status.files.is_empty() {
        return Ok(None);
    }
    git.stage(&repo, &[]).await?;
    let hash = git.commit(&repo, &commit_message(prompt)).await?;
    let changed = status.files.len();
    if mode != AutoGit::CommitPush {
        return Ok(Some(Outcome { ok: true, message: format!("변경 {changed}개를 자동으로 저장했습니다"), commit: Some(hash), pushed: false }));
    }
    if git.remote_url(&repo, "origin").await?.is_none() {
        return Ok(Some(Outcome { ok: true, message: format!("변경 {changed}개를 자동으로 저장했습니다 (연결된 GitHub 저장소가 없어 업로드는 건너뜀)"), commit: Some(hash), pushed: false }));
    }
    match git.push(&repo, true).await {
        Ok(_) => Ok(Some(Outcome { ok: true, message: format!("변경 {changed}개를 자동으로 저장하고 GitHub에 올렸습니다"), commit: Some(hash), pushed: true })),
        Err(e) => Ok(Some(Outcome { ok: false, message: format!("변경 {changed}개를 저장했지만 GitHub 업로드에 실패했습니다: {e}"), commit: Some(hash), pushed: false })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subject_from_prompt() {
        let m = commit_message("  \n예약 버튼을 첫 화면에   추가해 줘\n자세한 설명...");
        assert!(m.starts_with("예약 버튼을 첫 화면에 추가해 줘\n\n"));
        assert!(m.contains("자동으로 저장"));
        let long = commit_message(&"가".repeat(100));
        assert_eq!(long.lines().next().unwrap().chars().count(), SUBJECT_CHARS + 1);
        assert!(long.starts_with(&"가".repeat(SUBJECT_CHARS)));
        assert!(commit_message("   ").starts_with(FALLBACK_SUBJECT));
        assert!(!commit_message("say \"hi\" `now`").contains('"'));
    }

    #[test]
    fn skips_interrupted_turns() {
        assert!(should_run(None));
        assert!(should_run(Some("end_turn")));
        assert!(should_run(Some("completed")));
        assert!(!should_run(Some("interrupted")));
        assert!(!should_run(Some("aborted_streaming")));
    }
}
