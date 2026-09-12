//! Native local Git + SQLite integration. No credentials or network are used.
use std::{path::Path, sync::Arc};
use vibecode_core::{accounts, backend::CommandSpec, git::Git, projects::{scaffold::open_existing_named, settings}, types::{AccountKind, Effort, PermissionPreset, ProjectAccounts, ProjectRecord, ProjectSettingsUpdate, Provider}, AppContext};

async fn context() -> (tempfile::TempDir, Arc<AppContext>) {
    let data = tempfile::tempdir().unwrap();
    let ctx = AppContext::init(data.path().to_path_buf()).await.unwrap();
    let mut config = ctx.settings().await;
    if which::which("git").is_err() {
        config.git_bin = Some(r"C:\Program Files\Git\cmd\git.exe".into());
    }
    ctx.update_settings(config).await.unwrap();
    (data, ctx)
}

async fn git(ctx: &AppContext, path: &Path, args: &[&str]) -> String {
    ctx.backend().await.run(&CommandSpec::new(ctx.git_bin().await.unwrap_or("git".into()))
        .args(args.iter().copied()).cwd(path)).await.unwrap().into_result().unwrap().stdout.trim().into()
}

fn request(project: &ProjectRecord, accounts: ProjectAccounts) -> ProjectSettingsUpdate {
    ProjectSettingsUpdate {
        auto_git: None,
        name: project.name.clone(), accounts, default_provider: Provider::Codex,
        default_model: Some("test-codex-model".into()), default_effort: Some(Effort::High),
        default_permission: PermissionPreset::AutoEdit, update_remote: true,
        remote_url: Some("git@github.com:example/new-repo.git".into()),
    }
}

#[tokio::test]
async fn project_settings_persist_defaults_accounts_and_remote_without_changing_existing_sessions() {
    let (_data, ctx) = context().await;
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path();
    git(&ctx, path, &["init", "-b", "main"]).await;
    git(&ctx, path, &["-c", "user.name=Old Author", "-c", "user.email=old@example.com", "commit", "--allow-empty", "-m", "initial"]).await;
    git(&ctx, path, &["remote", "add", "origin", "https://github.com/example/old-repo"]).await;
    git(&ctx, path, &["remote", "set-url", "--push", "origin", "https://github.com/example/old-push"]).await;
    git(&ctx, path, &["remote", "add", "backup", "https://github.com/example/backup"]).await;
    git(&ctx, path, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
    git(&ctx, path, &["config", "branch.main.remote", "origin"]).await;
    let project = open_existing_named(ctx.clone(), &path.to_string_lossy(), Some("원래 이름")).await.unwrap();
    let old_ai = accounts::create(&ctx, "Old Claude".into(), AccountKind::Claude).unwrap();
    let new_ai = accounts::create(&ctx, "New Codex".into(), AccountKind::Codex).unwrap();
    let github = accounts::create(&ctx, "GitHub".into(), AccountKind::Github).unwrap();
    let old_accounts = ProjectAccounts { claude: Some(old_ai.id), ..Default::default() };
    accounts::set_project(&ctx.db, &project.id, &old_accounts).unwrap();
    ctx.db.with_conn(|c| {
        c.execute("INSERT INTO sessions(id,project_id,provider,title,permission,total_cost_usd,archived,created_at,last_used_at) VALUES('old-session',?1,'claude','기존 대화','auto_edit',0,0,?2,?2)",
            rusqlite::params![project.id, project.created_at.to_rfc3339()])?;
        Ok(())
    }).unwrap();
    accounts::save_session(&ctx.db, "old-session", &old_accounts).unwrap();
    let old_session = serde_json::to_value(ctx.db.get_session("old-session").unwrap()).unwrap();
    let mut req = request(&project, ProjectAccounts {
        codex: Some(new_ai.id), github: Some(github.id),
        git_user_name: Some("새 작성자".into()), git_user_email: Some("new@example.com".into()),
        ..Default::default()
    });
    req.name = "  새 프로젝트  ".into();
    let updated = settings::update(ctx.clone(), project.id.clone(), req.clone()).await.unwrap();
    assert_eq!(updated.name, "새 프로젝트");
    assert_eq!(updated.default_provider, Some(Provider::Codex));
    assert_eq!(updated.default_model.as_deref(), Some("test-codex-model"));
    assert_eq!(updated.default_effort, Some(Effort::High));
    assert_eq!(updated.default_permission, Some(PermissionPreset::AutoEdit));
    assert_eq!(updated.path, project.path);
    assert_eq!(updated.created_at, project.created_at);
    assert_eq!(updated.last_opened_at, project.last_opened_at);
    assert_eq!(updated.github_url.as_deref(), Some("https://github.com/example/new-repo"));
    let selected = accounts::project(&ctx.db, &project.id).unwrap();
    assert_eq!(serde_json::to_value(&selected).unwrap(), serde_json::to_value(&req.accounts).unwrap());
    assert_eq!(serde_json::to_value(accounts::session(&ctx.db, "old-session").unwrap()).unwrap(), serde_json::to_value(old_accounts).unwrap());
    assert_eq!(serde_json::to_value(ctx.db.get_session("old-session").unwrap()).unwrap(), old_session);
    assert_eq!(settings::remote_status(ctx.clone(), project.id.clone()).await.unwrap().url, updated.github_url);
    assert_eq!(git(&ctx, path, &["remote", "get-url", "--push", "origin"]).await, "https://github.com/example/new-repo");

    // The saved author is also used by real local commits.
    std::fs::write(path.join("author.txt"), "test").unwrap();
    let writer = Git::new(ctx.backend().await, ctx.git_bin().await).with_identity(selected.git_user_name, selected.git_user_email);
    writer.stage(path, &["author.txt".into()]).await.unwrap();
    writer.commit(path, "author check").await.unwrap();
    assert_eq!(git(&ctx, path, &["log", "-1", "--format=%an <%ae>"]).await, "새 작성자 <new@example.com>");

    req.remote_url = None;
    let disconnected = settings::update(ctx.clone(), project.id.clone(), req).await.unwrap();
    assert!(disconnected.github_url.is_none());
    assert!(settings::remote_status(ctx.clone(), project.id.clone()).await.unwrap().url.is_none());
    assert_eq!(git(&ctx, path, &["remote", "get-url", "backup"]).await, "https://github.com/example/backup");
    assert_eq!(git(&ctx, path, &["config", "branch.main.remote"]).await, "origin");
    assert!(!git(&ctx, path, &["rev-parse", "refs/remotes/origin/main"]).await.is_empty());
}

#[tokio::test]
async fn failed_database_save_restores_origin_and_project_settings() {
    let (_data, ctx) = context().await;
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path();
    git(&ctx, path, &["init", "-b", "main"]).await;
    git(&ctx, path, &["remote", "add", "origin", "https://github.com/example/old"]).await;
    git(&ctx, path, &["config", "--add", "remote.origin.pushurl", "https://github.com/example/push-one"]).await;
    git(&ctx, path, &["config", "--add", "remote.origin.pushurl", "https://github.com/example/push-two"]).await;
    let project = open_existing_named(ctx.clone(), &path.to_string_lossy(), Some("원래 이름")).await.unwrap();
    let github = accounts::create(&ctx, "GitHub".into(), AccountKind::Github).unwrap();
    let old_accounts = ProjectAccounts { github: Some(github.id), ..Default::default() };
    accounts::set_project(&ctx.db, &project.id, &old_accounts).unwrap();
    let mut req = request(&project, old_accounts.clone());
    req.name = "새 이름".into();
    let before = git(&ctx, path, &["config", "--local", "--get-regexp", r"^remote\.origin\."]).await;
    ctx.db.with_conn(|c| {
        c.execute_batch("CREATE TRIGGER fail_settings BEFORE INSERT ON project_accounts BEGIN SELECT RAISE(ABORT, 'test save failure'); END")?;
        Ok(())
    }).unwrap();
    assert!(settings::update(ctx.clone(), project.id.clone(), req).await.unwrap_err().to_string().contains("test save failure"));
    assert_eq!(git(&ctx, path, &["config", "--local", "--get-regexp", r"^remote\.origin\."]).await, before);
    assert_eq!(serde_json::to_value(ctx.db.get_project(&project.id).unwrap()).unwrap(), serde_json::to_value(project.clone()).unwrap());
    assert_eq!(serde_json::to_value(accounts::project(&ctx.db, &project.id).unwrap()).unwrap(), serde_json::to_value(old_accounts).unwrap());
}

#[tokio::test]
async fn invalid_changes_are_rejected_and_non_git_folders_can_save_other_settings() {
    let (_data, ctx) = context().await;
    let folder = tempfile::tempdir().unwrap();
    let project = open_existing_named(ctx.clone(), &folder.path().to_string_lossy(), Some("프로젝트")).await.unwrap();
    assert!(!settings::remote_status(ctx.clone(), project.id.clone()).await.unwrap().is_repo);
    let github = accounts::create(&ctx, "GitHub".into(), AccountKind::Github).unwrap();
    let selected = ProjectAccounts { github: Some(github.id.clone()), ..Default::default() };
    let req = request(&project, selected);
    assert!(settings::update(ctx.clone(), project.id.clone(), req.clone()).await.is_err());
    assert!(!folder.path().join(".git").exists());
    for invalid in [
        ProjectSettingsUpdate { name: "bad/name".into(), ..req.clone() },
        ProjectSettingsUpdate { accounts: ProjectAccounts { codex: Some(github.id), ..Default::default() }, ..req.clone() },
        ProjectSettingsUpdate { remote_url: Some("https://github.com/team/repo/tree/main".into()), ..req.clone() },
        ProjectSettingsUpdate { accounts: Default::default(), ..req.clone() },
        ProjectSettingsUpdate { accounts: ProjectAccounts { git_user_name: Some("only name".into()), ..Default::default() }, ..req.clone() },
    ] {
        assert!(settings::update(ctx.clone(), project.id.clone(), invalid).await.is_err());
        assert_eq!(ctx.db.get_project(&project.id).unwrap().name, project.name);
        assert!(accounts::project(&ctx.db, &project.id).unwrap().github.is_none());
    }
    let mut config = ctx.settings().await;
    config.git_bin = Some(r"C:\missing-git-for-test.exe".into());
    ctx.update_settings(config).await.unwrap();
    let saved = settings::update(ctx.clone(), project.id.clone(), ProjectSettingsUpdate { update_remote: false, name: "AI 설정 변경".into(), ..req }).await.unwrap();
    assert_eq!(saved.name, "AI 설정 변경");
    assert_eq!(saved.default_provider, Some(Provider::Codex));
    assert!(saved.github_url.is_none());
}
