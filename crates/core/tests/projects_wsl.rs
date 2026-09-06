//! End-to-end project creation through a real AppContext on the WSL backend
//! (git lives in WSL on the dev machine). Uses a stack without a scaffold command so
//! the test needs no network or toolchains. Skips when wsl.exe is unavailable.

use vibecode_core::backend::wsl::list_distros;
use vibecode_core::projects::scaffold::{create_project, open_existing};
use vibecode_core::types::{BackendConfig, BackendKind, CreateProjectRequest, Effort, PermissionPreset, ProjectType, Provider, ScaffoldEvent, TargetOs};
use vibecode_core::AppContext;

#[tokio::test]
async fn create_and_open_project_via_wsl() {
    if !cfg!(windows) {
        return;
    }
    let distros = list_distros().await;
    let Some(distro) = distros.iter().find(|d| d.as_str() == "Ubuntu").cloned().or_else(|| distros.first().cloned()) else {
        eprintln!("skipping: no WSL distro");
        return;
    };

    let data = tempfile::tempdir().unwrap();
    let ctx = AppContext::init(data.path().to_path_buf()).await.expect("ctx");
    let mut settings = ctx.settings().await;
    settings.backend = BackendConfig { kind: BackendKind::Wsl, wsl_distro: Some(distro) };
    ctx.update_settings(settings).await.expect("switch backend");

    let parent = tempfile::tempdir().unwrap();
    let req = CreateProjectRequest {
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
