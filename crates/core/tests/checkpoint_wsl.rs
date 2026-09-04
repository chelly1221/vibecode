//! Checkpoint create/restore/diff through a real AppContext on the WSL backend, for a git
//! project (in-place refs) and a plain directory (hidden repository). Skips without WSL.

use std::path::Path;

use vibecode_core::backend::wsl::list_distros;
use vibecode_core::checkpoint;
use vibecode_core::types::{BackendConfig, BackendKind, ProjectRecord};
use vibecode_core::AppContext;

async fn ctx_on_wsl() -> Option<(std::sync::Arc<AppContext>, tempfile::TempDir)> {
    if !cfg!(windows) {
        return None;
    }
    let distros = list_distros().await;
    let distro = distros.iter().find(|d| d.as_str() == "Ubuntu").cloned().or_else(|| distros.first().cloned())?;
    let data = tempfile::tempdir().unwrap();
    let ctx = AppContext::init(data.path().to_path_buf()).await.expect("ctx");
    let mut settings = ctx.settings().await;
    settings.backend = BackendConfig { kind: BackendKind::Wsl, wsl_distro: Some(distro) };
    ctx.update_settings(settings).await.expect("switch backend");
    Some((ctx, data))
}

fn register(ctx: &AppContext, id: &str, path: &Path) {
    let now = chrono::Utc::now();
    ctx.db
        .upsert_project(&ProjectRecord {
            id: id.into(),
            name: id.into(),
            path: path.to_string_lossy().into_owned(),
            target_os: None,
            project_type: None,
            stack_id: None,
            github_url: None,
            default_provider: None,
            default_model: None,
            default_effort: None,
            default_permission: None,
            created_at: now,
            last_opened_at: now,
        })
        .unwrap();
}

async fn exercise(ctx: std::sync::Arc<AppContext>, project_id: &str, root: &Path) {
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join("node_modules").join("dep")).unwrap();
    std::fs::write(root.join("node_modules").join("dep").join("index.js"), "ignored").unwrap();
    std::fs::write(root.join("src").join("main.rs"), "v1\n").unwrap();
    std::fs::write(root.join("한글.txt"), "하나\n").unwrap();

    let cp1 = checkpoint::create(ctx.clone(), project_id, Some("s1"), "첫 스냅샷").await.expect("create").expect("first checkpoint");
    assert_eq!(cp1.seq, 1);
    // Nothing changed → None.
    assert!(checkpoint::create(ctx.clone(), project_id, Some("s1"), "again").await.unwrap().is_none());

    // Modify, add, delete.
    std::fs::write(root.join("src").join("main.rs"), "v2\n").unwrap();
    std::fs::write(root.join("new.txt"), "extra\n").unwrap();
    std::fs::remove_file(root.join("한글.txt")).unwrap();
    std::fs::write(root.join("node_modules").join("dep").join("index.js"), "still ignored").unwrap();

    let d = checkpoint::diff(ctx.clone(), &cp1.id).await.expect("diff");
    assert!(d.contains("-v1") && d.contains("+v2"), "diff: {d}");
    assert!(d.contains("new.txt"));
    assert!(!d.contains("node_modules"));

    let cp2 = checkpoint::create(ctx.clone(), project_id, Some("s1"), "둘째 \"quoted\" $HOME `tick`").await.unwrap().expect("second");
    assert_eq!(cp2.seq, 2);
    assert_eq!(cp2.label, "둘째 'quoted' ＄HOME 'tick'");

    // Restore to the first snapshot: safety checkpoint created (nothing changed since cp2 → returns newest = cp2).
    let safety = checkpoint::restore(ctx.clone(), &cp1.id).await.expect("restore");
    assert_eq!(safety.id, cp2.id);
    assert_eq!(std::fs::read_to_string(root.join("src").join("main.rs")).unwrap(), "v1\n");
    assert_eq!(std::fs::read_to_string(root.join("한글.txt")).unwrap(), "하나\n");
    assert!(!root.join("new.txt").exists(), "file added after the snapshot must be removed");
    assert_eq!(std::fs::read_to_string(root.join("node_modules").join("dep").join("index.js")).unwrap(), "still ignored");

    // Change again and restore: now a real safety checkpoint is created first.
    std::fs::write(root.join("src").join("main.rs"), "v3\n").unwrap();
    let safety2 = checkpoint::restore(ctx.clone(), &cp2.id).await.expect("restore 2");
    assert_eq!(safety2.label, checkpoint::SAFETY_LABEL);
    assert_eq!(std::fs::read_to_string(root.join("src").join("main.rs")).unwrap(), "v2\n");
    assert_eq!(std::fs::read_to_string(root.join("new.txt")).unwrap(), "extra\n");

    let all = checkpoint::list(ctx.clone(), project_id, None).await.unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].id, safety2.id);
    assert_eq!(checkpoint::list(ctx.clone(), project_id, Some("nope")).await.unwrap().len(), 0);
    assert!(checkpoint::diff(ctx.clone(), &safety2.id).await.unwrap().is_empty() || checkpoint::diff(ctx.clone(), &cp2.id).await.unwrap().is_empty());
}

#[tokio::test]
async fn checkpoints_in_git_project_via_wsl() {
    let Some((ctx, _data)) = ctx_on_wsl().await else {
        eprintln!("skipping: no WSL");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = vibecode_core::git::Git::new(ctx.backend().await, None);
    git.init(root, "main").await.expect("git init");
    std::fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
    register(&ctx, "gitproj", root);
    exercise(ctx.clone(), "gitproj", root).await;
    // In-place refs, HEAD/index untouched.
    let st = git.status(root).await.unwrap();
    assert!(st.is_repo);
    assert!(!root.join(".git").join("index").exists() || st.files.iter().all(|f| !f.staged), "project index must not be staged by checkpoints");
    let refs = ctx.backend().await.run(&vibecode_core::backend::CommandSpec::new("git").args(["for-each-ref", "refs/vibecoder/"]).cwd(root)).await.unwrap();
    assert!(refs.stdout.lines().count() >= 3, "refs: {}", refs.stdout);
}

#[tokio::test]
async fn checkpoints_in_plain_dir_via_wsl() {
    let Some((ctx, data)) = ctx_on_wsl().await else {
        eprintln!("skipping: no WSL");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    register(&ctx, "plain", root);
    exercise(ctx.clone(), "plain", root).await;
    assert!(!root.join(".git").exists(), "hidden repo must not appear inside the project");
    assert!(data.path().join("checkpoints").join("plain").join(".git").join("HEAD").exists());
}
