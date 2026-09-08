//! End-to-end project creation through a real AppContext on the Windows host. Uses a stack
//! without a scaffold command so the test needs no network. Needs git (Git for Windows).

use vibecode_core::projects::scaffold::{create_project, open_existing};
use vibecode_core::types::{CreateProjectRequest, Effort, PermissionPreset, ProjectType, Provider, ScaffoldEvent, TargetOs};
use vibecode_core::AppContext;

/// `git` from PATH, else the default Git for Windows install (the test process may predate a PATH change).
fn git_bin() -> Option<String> {
    if which::which("git").is_ok() {
        return None;
    }
    let p = std::path::Path::new("C:\\Program Files\\Git\\cmd\\git.exe");
    p.is_file().then(|| p.to_string_lossy().into_owned())
}

#[tokio::test]
async fn create_and_open_project_natively() {
    if !cfg!(windows) {
        return;
    }
    let data = tempfile::tempdir().unwrap();
    let ctx = AppContext::init(data.path().to_path_buf()).await.expect("ctx");
    let mut settings = ctx.settings().await;
    settings.git_bin = git_bin();
    ctx.update_settings(settings).await.expect("settings");

    let parent = tempfile::tempdir().unwrap();
    let req = CreateProjectRequest {

        accounts: Default::default(),
        name: "demo-proj".into(),
        dir_name: None,
        parent_dir: parent.path().to_string_lossy().to_string(),
        target_os: TargetOs::Windows,
        project_type: ProjectType::Script,
        stack_id: Some("powershell".into()),
        description: "테스트용 프로젝트".into(),
        git_init: true,
        create_github_repo: false,
        github_private: true,
        generate_agent_docs: true,
        install_missing_tools: true,
        default_provider: Some(Provider::Claude),
        default_model: None,
        default_effort: Some(Effort::High),
        default_permission: Some(PermissionPreset::AutoEdit),
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ScaffoldEvent>();
    let project = create_project(ctx.clone(), req, tx).await.expect("create_project");

    let mut events = vec![];
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    fn logs_contain(events: &[ScaffoldEvent], needle: &str) -> bool {
        events.iter().any(|e| matches!(e, ScaffoldEvent::Log { line, .. } if line.contains(needle)))
    }
    let steps: Vec<String> = events.iter().filter_map(|e| if let ScaffoldEvent::Step { name } = e { Some(name.clone()) } else { None }).collect();
    assert_eq!(steps, vec!["검증", "필요한 도구 확인", "스캐폴딩", "에이전트 문서 생성", "git 초기화", "완료"]);
    assert!(logs_contain(&events, "필요한 도구가 모두 준비되어 있습니다"), "install check should find nothing to install for the powershell stack");
    assert!(matches!(events.last(), Some(ScaffoldEvent::Done { .. })));
    let logs: Vec<String> = events.iter().filter_map(|e| if let ScaffoldEvent::Log { line, .. } = e { Some(line.clone()) } else { None }).collect();
    assert!(logs.iter().any(|l| l.contains("git init")), "logs: {logs:?}");

    let dir = std::path::PathBuf::from(&project.path);
    assert!(dir.join("README.md").exists());
    assert!(dir.join("AGENTS.md").exists());
    assert!(dir.join("CLAUDE.md").exists());
    assert!(dir.join(".gitignore").exists());
    assert!(dir.join(".git").is_dir());
    assert_eq!(project.stack_id.as_deref(), Some("powershell"));
    assert_eq!(project.default_effort, Some(Effort::High));

    // Persisted and re-openable by path.
    assert_eq!(ctx.db.list_projects().unwrap().len(), 1);
    let reopened = open_existing(ctx.clone(), &project.path).await.expect("open_existing");
    assert_eq!(reopened.id, project.id);
    assert_eq!(ctx.db.list_projects().unwrap().len(), 1);

    // Duplicate name is rejected.
    let (tx2, _rx2) = tokio::sync::mpsc::unbounded_channel::<ScaffoldEvent>();
    let dup = CreateProjectRequest {

        accounts: Default::default(),
        name: "demo-proj".into(),
        dir_name: None,
        parent_dir: parent.path().to_string_lossy().to_string(),
        target_os: TargetOs::Windows,
        project_type: ProjectType::Script,
        stack_id: None,
        description: String::new(),
        git_init: false,
        create_github_repo: false,
        github_private: false,
        generate_agent_docs: false,
        install_missing_tools: false,
        default_provider: None,
        default_model: None,
        default_effort: None,
        default_permission: None,
    };
    assert!(create_project(ctx.clone(), dup, tx2).await.is_err());

    // Opening a foreign directory detects the stack.
    let other = tempfile::tempdir().unwrap();
    std::fs::write(other.path().join("package.json"), r#"{"dependencies":{"@sveltejs/kit":"2"}}"#).unwrap();
    let opened = open_existing(ctx.clone(), &other.path().to_string_lossy()).await.expect("open foreign");
    assert_eq!(opened.stack_id.as_deref(), Some("sveltekit"));
    assert_eq!(opened.project_type, Some(ProjectType::WebApp));
}
