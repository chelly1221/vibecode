//! End-to-end git flow through the WSL backend. `git` is not installed on Windows on
//! the dev machine, so this uses the Ubuntu distro. Skips when wsl.exe is unavailable.

use std::path::Path;
use std::sync::Arc;

use vibecode_core::backend::wsl::{list_distros, WslBackend};
use vibecode_core::backend::ExecBackend;
use vibecode_core::git::Git;

async fn wsl_backend() -> Option<Arc<dyn ExecBackend>> {
    if !cfg!(windows) {
        return None;
    }
    let distros = list_distros().await;
    let distro = distros.iter().find(|d| d.as_str() == "Ubuntu").cloned().or_else(|| distros.first().cloned())?;
    Some(Arc::new(WslBackend::new(distro)))
}

#[tokio::test]
async fn init_status_stage_commit_log_via_wsl() {
    let Some(backend) = wsl_backend().await else {
        eprintln!("skipping: wsl.exe not available");
        return;
    };
    let git = Git::new(backend.clone(), None);
    if git.version().await.is_err() {
        eprintln!("skipping: git not available in WSL");
        return;
    }

    let dir = tempfile::tempdir().expect("temp dir");
    let repo: &Path = dir.path();

    // Not a repo yet.
    let st = git.status(repo).await.expect("status on non-repo");
    assert!(!st.is_repo);

    git.init(repo, "main").await.expect("init");
    std::fs::write(repo.join("hello.txt"), "hi\n").unwrap();
    std::fs::write(repo.join("한글 파일.txt"), "unicode\n").unwrap();

    let st = git.status(repo).await.expect("status");
    assert!(st.is_repo);
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert_eq!(st.files.iter().filter(|f| f.untracked).count(), 2);

    // Untracked diff shows the content.
    let d = git.diff(repo, Some("hello.txt"), false).await.expect("untracked diff");
    assert!(d.contains("+hi"), "diff was: {d}");

    git.stage(repo, &["hello.txt".to_string()]).await.expect("stage one");
    let st = git.status(repo).await.unwrap();
    let hello = st.files.iter().find(|f| f.path == "hello.txt").unwrap();
    assert!(hello.staged && !hello.untracked);

    git.unstage(repo, &["hello.txt".to_string()]).await.expect("unstage without HEAD");
    assert!(git.status(repo).await.unwrap().files.iter().find(|f| f.path == "hello.txt").unwrap().untracked);

    git.stage(repo, &[]).await.expect("stage all");
    let staged = git.diff(repo, None, true).await.expect("staged diff");
    assert!(staged.contains("hello.txt"));

    // Commit with an explicit identity so the test does not depend on global config.
    let ident_git = Git { backend: backend.clone(), bin: None, identity: None };
    let _ = ident_git;
    let cfg = |k: &str, v: &str| {
        let spec = vibecode_core::backend::CommandSpec::new("git").args(["config", k, v]).cwd(repo);
        let b = backend.clone();
        async move { b.run(&spec).await.unwrap().into_result().unwrap() }
    };
    cfg("user.name", "vibecode test").await;
    cfg("user.email", "test@example.com").await;

    let hash = git.commit(repo, "feat: initial").await.expect("commit");
    assert!(hash.len() >= 7);

    let log = git.log(repo, 10).await.expect("log");
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].subject, "feat: initial");
    assert_eq!(log[0].short_hash, hash);

    let branches = git.branches(repo).await.expect("branches");
    assert!(branches.iter().any(|b| b.name == "main" && b.current));

    git.checkout(repo, "feature", true).await.expect("create branch");
    assert!(git.branches(repo).await.unwrap().iter().any(|b| b.name == "feature" && b.current));

    std::fs::write(repo.join("hello.txt"), "hi\nthere\n").unwrap();
    let msg_input = git.diff_for_commit_message(repo).await.expect("commit diff");
    assert!(msg_input.contains("+there"));
    assert!(msg_input.contains("git status --short"));

    assert_eq!(git.remote_url(repo, "origin").await.unwrap(), None);
    git.add_remote(repo, "origin", "git@github.com:example/x.git").await.expect("add remote");
    assert_eq!(git.remote_url(repo, "origin").await.unwrap().as_deref(), Some("git@github.com:example/x.git"));
    git.add_remote(repo, "origin", "git@github.com:example/y.git").await.expect("set-url");
    assert_eq!(git.remote_url(repo, "origin").await.unwrap().as_deref(), Some("git@github.com:example/y.git"));
}
