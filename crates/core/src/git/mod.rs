//! git operations executed through the backend (`git` on the host or in WSL).
//! `repo` is always a host (Windows) path.

pub mod ssh;

pub mod parse;

use std::path::Path;
use std::sync::Arc;

use base64::Engine;

use crate::backend::{CommandOutput, CommandSpec, ExecBackend};
use crate::error::{CoreError, Result};
use crate::types::{GitBranch, GitCommit, GitStatus};

/// Maximum diff size (chars) handed to an agent for commit-message generation.
const MAX_COMMIT_DIFF_CHARS: usize = 60_000;

pub struct Git {
    pub backend: Arc<dyn ExecBackend>,
    /// Override for the git binary name/path (None = "git").
    pub bin: Option<String>,
    /// Commit author (name, email) applied with `-c` so a fresh environment can commit without global config.
    pub identity: Option<(String, String)>,
}

impl Git {
    pub fn new(backend: Arc<dyn ExecBackend>, bin: Option<String>) -> Self {
        Git { backend, bin, identity: None }
    }

    pub fn with_identity(mut self, name: Option<String>, email: Option<String>) -> Self {
        let name = name.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let email = email.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        self.identity = match (name, email) {
            (Some(n), Some(e)) => Some((n, e)),
            _ => None,
        };
        self
    }

    fn bin(&self) -> &str {
        self.bin.as_deref().filter(|b| !b.trim().is_empty()).unwrap_or("git")
    }

    fn spec(&self, repo: Option<&Path>, args: &[&str]) -> CommandSpec {
        let mut spec = CommandSpec::new(self.bin())
            .args(args.iter().map(|s| s.to_string()))
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new");
        if let Some(r) = repo {
            spec = spec.cwd(r);
        }
        spec
    }

    /// Run git, returning the raw output (no exit-code check).
    async fn run_raw(&self, repo: Option<&Path>, args: &[&str]) -> Result<CommandOutput> {
        self.backend.run(&self.spec(repo, args)).await
    }

    /// Run git and fail on non-zero exit. Returns stdout.
    async fn run(&self, repo: &Path, args: &[&str]) -> Result<String> {
        Ok(self.run_raw(Some(repo), args).await?.into_result()?.stdout)
    }

    /// Run git and return stdout+stderr combined (for push/pull/fetch which report on stderr).
    async fn run_combined(&self, repo: &Path, args: &[&str]) -> Result<String> {
        let out = self.run_raw(Some(repo), args).await?;
        let text = combine(&out);
        if out.success() {
            Ok(text)
        } else {
            Err(CoreError::Process { code: out.code, stderr: text })
        }
    }

    fn owned(args: &[String]) -> Vec<&str> {
        args.iter().map(String::as_str).collect()
    }

    pub async fn version(&self) -> Result<String> {
        let out = self.run_raw(None, &["--version"]).await?.into_result()?;
        Ok(out.stdout.trim().to_string())
    }

    pub async fn init(&self, repo: &Path, initial_branch: &str) -> Result<()> {
        let out = self.run_raw(Some(repo), &["init", "-b", initial_branch]).await?;
        if out.success() {
            return Ok(());
        }
        // Older git without `-b`: init then point HEAD at the wanted branch.
        self.run(repo, &["init"]).await?;
        let head = format!("refs/heads/{initial_branch}");
        self.run(repo, &["symbolic-ref", "HEAD", &head]).await?;
        Ok(())
    }

    pub async fn status(&self, repo: &Path) -> Result<GitStatus> {
        let out = self.run_raw(Some(repo), &["status", "--porcelain=v2", "--branch", "--untracked-files=all"]).await?;
        if !out.success() {
            if out.stderr.contains("not a git repository") || out.code == Some(128) {
                return Ok(GitStatus { is_repo: false, branch: None, upstream: None, ahead: 0, behind: 0, files: vec![] });
            }
            return Err(CoreError::Process { code: out.code, stderr: out.stderr });
        }
        Ok(parse::porcelain_v2(&out.stdout))
    }

    pub async fn diff(&self, repo: &Path, path: Option<&str>, staged: bool) -> Result<String> {
        let mut args: Vec<&str> = vec!["diff", "--no-color"];
        if staged {
            args.push("--cached");
        }
        if let Some(p) = path {
            args.push("--");
            args.push(p);
        }
        let out = self.run_raw(Some(repo), &args).await?.into_result()?;
        if !out.stdout.trim().is_empty() || staged || path.is_none() {
            return Ok(out.stdout);
        }
        // Empty unstaged diff for a single path: it may be untracked. Diff against nothing.
        let p = path.unwrap_or_default();
        let tracked = self.run_raw(Some(repo), &["ls-files", "--error-unmatch", "--", p]).await?;
        if tracked.success() {
            return Ok(out.stdout);
        }
        let untracked = self.run_raw(Some(repo), &["diff", "--no-color", "--no-index", "--", "/dev/null", p]).await?;
        // --no-index exits 1 when the files differ, which is the expected case.
        match untracked.code {
            Some(0) | Some(1) => Ok(untracked.stdout),
            _ => Err(CoreError::Process { code: untracked.code, stderr: untracked.stderr }),
        }
    }

    pub async fn stage(&self, repo: &Path, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            self.run(repo, &["add", "-A", "--"]).await?;
        } else {
            let mut args = vec!["add", "-A", "--"];
            args.extend(Self::owned(paths));
            self.run(repo, &args).await?;
        }
        Ok(())
    }

    pub async fn unstage(&self, repo: &Path, paths: &[String]) -> Result<()> {
        let mut args = vec!["restore", "--staged", "--"];
        let owned = Self::owned(paths);
        if owned.is_empty() {
            args.push(".");
        } else {
            args.extend(owned.iter().copied());
        }
        if self.run_raw(Some(repo), &args).await?.success() {
            return Ok(());
        }
        // Old git or no HEAD yet.
        let mut reset = vec!["reset", "-q", "HEAD", "--"];
        if owned.is_empty() { reset.push(".") } else { reset.extend(owned.iter().copied()) }
        if self.run_raw(Some(repo), &reset).await?.success() {
            return Ok(());
        }
        let mut rm = vec!["rm", "--cached", "-r", "--quiet", "--"];
        if owned.is_empty() { rm.push(".") } else { rm.extend(owned.iter().copied()) }
        self.run(repo, &rm).await.map(|_| ())
    }

    pub async fn commit(&self, repo: &Path, message: &str) -> Result<String> {
        let mut args: Vec<String> = Vec::new();
        if let Some((name, email)) = &self.identity {
            args.extend(["-c".into(), format!("user.name={name}"), "-c".into(), format!("user.email={email}")]);
        }
        args.extend(["commit".into(), "-m".into(), message.into()]);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run_combined(repo, &refs).await?;
        let hash = self.run(repo, &["rev-parse", "--short", "HEAD"]).await?;
        Ok(hash.trim().to_string())
    }

    async fn current_branch(&self, repo: &Path) -> Result<Option<String>> {
        let out = self.run_raw(Some(repo), &["symbolic-ref", "--short", "-q", "HEAD"]).await?;
        Ok(if out.success() { Some(out.stdout.trim().to_string()).filter(|s| !s.is_empty()) } else { None })
    }

    async fn has_upstream(&self, repo: &Path) -> Result<bool> {
        let out = self.run_raw(Some(repo), &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await?;
        Ok(out.success())
    }

    /// `-c http.extraheader=…` when `origin` is an HTTPS GitHub remote and a token is stored,
    /// so pushes work without SSH keys or a credential helper. The token is never logged.
    async fn auth_args(&self, repo: &Path) -> Vec<String> {
        let Ok(Some(url)) = self.remote_url(repo, "origin").await else { return vec![] };
        if !url.starts_with("https://github.com/") {
            return vec![];
        }
        match crate::github::GitHubClient::from_keyring() {
            Ok(Some(client)) => {
                let b64 = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{}", client.token));
                vec!["-c".into(), format!("http.extraheader=AUTHORIZATION: basic {b64}")]
            }
            _ => vec![],
        }
    }

    async fn run_remote(&self, repo: &Path, args: &[&str]) -> Result<String> {
        let mut all: Vec<String> = self.auth_args(repo).await;
        all.extend(args.iter().map(|s| s.to_string()));
        let refs: Vec<&str> = all.iter().map(String::as_str).collect();
        self.run_combined(repo, &refs).await
    }

    pub async fn push(&self, repo: &Path, set_upstream: bool) -> Result<String> {
        if set_upstream && !self.has_upstream(repo).await? {
            let branch = self.current_branch(repo).await?.ok_or_else(|| CoreError::msg("현재 브랜치를 확인할 수 없습니다 (detached HEAD)"))?;
            return self.run_remote(repo, &["push", "-u", "origin", &branch]).await;
        }
        self.run_remote(repo, &["push"]).await
    }

    pub async fn pull(&self, repo: &Path) -> Result<String> {
        self.run_remote(repo, &["pull"]).await
    }

    pub async fn fetch(&self, repo: &Path) -> Result<String> {
        self.run_remote(repo, &["fetch", "--all", "--prune"]).await
    }

    pub async fn branches(&self, repo: &Path) -> Result<Vec<GitBranch>> {
        let out = self.run(repo, &["branch", "-a", "--format=%(refname:short)%09%(HEAD)%09%(refname)"]).await?;
        Ok(parse::branches(&out))
    }

    pub async fn checkout(&self, repo: &Path, branch: &str, create: bool) -> Result<()> {
        let args: Vec<&str> = if create { vec!["switch", "-c", branch] } else { vec!["switch", branch] };
        if self.run_raw(Some(repo), &args).await?.success() {
            return Ok(());
        }
        let args: Vec<&str> = if create { vec!["checkout", "-b", branch] } else { vec!["checkout", branch] };
        self.run_combined(repo, &args).await.map(|_| ())
    }

    pub async fn log(&self, repo: &Path, limit: usize) -> Result<Vec<GitCommit>> {
        let n = limit.max(1).to_string();
        let out = self.run_raw(Some(repo), &["log", "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s", "--date=short", "-n", &n]).await?;
        if !out.success() {
            // No commits yet → empty log rather than an error.
            if out.stderr.contains("does not have any commits") || out.stderr.contains("bad default revision") {
                return Ok(vec![]);
            }
            return Err(CoreError::Process { code: out.code, stderr: out.stderr });
        }
        Ok(parse::log(&out.stdout))
    }

    pub async fn remote_url(&self, repo: &Path, name: &str) -> Result<Option<String>> {
        let out = self.run_raw(Some(repo), &["remote", "get-url", name]).await?;
        Ok(if out.success() { Some(out.stdout.trim().to_string()).filter(|s| !s.is_empty()) } else { None })
    }

    pub async fn add_remote(&self, repo: &Path, name: &str, url: &str) -> Result<()> {
        if self.remote_url(repo, name).await?.is_some() {
            self.run(repo, &["remote", "set-url", name, url]).await?;
        } else {
            self.run(repo, &["remote", "add", name, url]).await?;
        }
        Ok(())
    }

    /// Full diff of staged changes (or working tree if nothing staged) plus a short status,
    /// truncated to a size an agent can digest.
    pub async fn diff_for_commit_message(&self, repo: &Path) -> Result<String> {
        let status = self.run(repo, &["status", "--short"]).await?;
        let mut diff = self.run(repo, &["diff", "--cached", "--no-color"]).await?;
        if diff.trim().is_empty() {
            diff = self.run(repo, &["diff", "--no-color"]).await?;
        }
        let mut text = format!("# git status --short\n{status}\n# diff\n{diff}");
        if text.chars().count() > MAX_COMMIT_DIFF_CHARS {
            text = text.chars().take(MAX_COMMIT_DIFF_CHARS).collect::<String>() + "\n... (truncated)\n";
        }
        Ok(text)
    }
}

fn combine(out: &CommandOutput) -> String {
    let mut s = String::new();
    if !out.stdout.trim().is_empty() {
        s.push_str(out.stdout.trim_end());
    }
    if !out.stderr.trim().is_empty() {
        if !s.is_empty() {
            s.push('\n');
        }
        s.push_str(out.stderr.trim_end());
    }
    s
}
