//! One-shot, sessionless agent calls (e.g. commit message generation).
//! Provider implementations live in `claude::oneshot_commit_message` / `codex::oneshot_commit_message`.

use std::path::Path;
use std::sync::Arc;

use crate::backend::ExecBackend;
use crate::error::Result;
use crate::types::Provider;

pub const COMMIT_PROMPT: &str = "Write a concise git commit message (Conventional Commits style: type(scope): summary, then an optional short body) for the following diff. Output only the commit message, no code fences, no commentary.";

/// Returns a commit message for `diff`. Runs in `repo` so project instructions apply.
pub async fn commit_message(backend: Arc<dyn ExecBackend>, provider: Provider, bin: Option<String>, repo: &Path, diff: &str) -> Result<String> {
    match provider {
        Provider::Claude => super::claude::oneshot_commit_message(backend, bin, repo, diff).await,
        Provider::Codex => super::codex::oneshot_commit_message(backend, bin, repo, diff).await,
    }
}
