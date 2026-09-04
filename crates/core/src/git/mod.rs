//! git operations executed through the backend (`git` on the host or in WSL).
//! `repo` is always a host (Windows) path.

use std::path::Path;
use std::sync::Arc;

use crate::backend::ExecBackend;
use crate::error::{CoreError, Result};
use crate::types::{GitBranch, GitCommit, GitStatus};

pub struct Git {
    pub backend: Arc<dyn ExecBackend>,
    /// Override for the git binary name/path (None = "git").
    pub bin: Option<String>,
}

impl Git {
    pub fn new(backend: Arc<dyn ExecBackend>, bin: Option<String>) -> Self {
        Git { backend, bin }
    }

    pub async fn version(&self) -> Result<String> {
        Err(CoreError::NotImplemented("git::version"))
    }
    pub async fn init(&self, repo: &Path, initial_branch: &str) -> Result<()> {
        let _ = (repo, initial_branch);
        Err(CoreError::NotImplemented("git::init"))
    }
    pub async fn status(&self, repo: &Path) -> Result<GitStatus> {
        let _ = repo;
        Err(CoreError::NotImplemented("git::status"))
    }
    pub async fn diff(&self, repo: &Path, path: Option<&str>, staged: bool) -> Result<String> {
        let _ = (repo, path, staged);
        Err(CoreError::NotImplemented("git::diff"))
    }
    pub async fn stage(&self, repo: &Path, paths: &[String]) -> Result<()> {
        let _ = (repo, paths);
        Err(CoreError::NotImplemented("git::stage"))
    }
    pub async fn unstage(&self, repo: &Path, paths: &[String]) -> Result<()> {
        let _ = (repo, paths);
        Err(CoreError::NotImplemented("git::unstage"))
    }
    pub async fn commit(&self, repo: &Path, message: &str) -> Result<String> {
        let _ = (repo, message);
        Err(CoreError::NotImplemented("git::commit"))
    }
    pub async fn push(&self, repo: &Path, set_upstream: bool) -> Result<String> {
        let _ = (repo, set_upstream);
        Err(CoreError::NotImplemented("git::push"))
    }
    pub async fn pull(&self, repo: &Path) -> Result<String> {
        let _ = repo;
        Err(CoreError::NotImplemented("git::pull"))
    }
    pub async fn fetch(&self, repo: &Path) -> Result<String> {
        let _ = repo;
        Err(CoreError::NotImplemented("git::fetch"))
    }
    pub async fn branches(&self, repo: &Path) -> Result<Vec<GitBranch>> {
        let _ = repo;
        Err(CoreError::NotImplemented("git::branches"))
    }
    pub async fn checkout(&self, repo: &Path, branch: &str, create: bool) -> Result<()> {
        let _ = (repo, branch, create);
        Err(CoreError::NotImplemented("git::checkout"))
    }
    pub async fn log(&self, repo: &Path, limit: usize) -> Result<Vec<GitCommit>> {
        let _ = (repo, limit);
        Err(CoreError::NotImplemented("git::log"))
    }
    pub async fn remote_url(&self, repo: &Path, name: &str) -> Result<Option<String>> {
        let _ = (repo, name);
        Err(CoreError::NotImplemented("git::remote_url"))
    }
    pub async fn add_remote(&self, repo: &Path, name: &str, url: &str) -> Result<()> {
        let _ = (repo, name, url);
        Err(CoreError::NotImplemented("git::add_remote"))
    }
    /// Full diff of staged changes (or working tree if nothing staged) used for AI commit messages.
    pub async fn diff_for_commit_message(&self, repo: &Path) -> Result<String> {
        let _ = repo;
        Err(CoreError::NotImplemented("git::diff_for_commit_message"))
    }
}
