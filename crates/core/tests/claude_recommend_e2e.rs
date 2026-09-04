//! Live AI stack recommendation through Claude in WSL.
//! VIBECODE_E2E=1 WSLENV=VIBECODE_E2E cargo.exe test -p vibecode-core --test claude_recommend_e2e -- --ignored --nocapture
use std::sync::Arc;

use vibecode_core::backend::ExecBackend;
use vibecode_core::projects::ai_recommend;
use vibecode_core::types::{ProjectType, Provider, StackRecommendRequest, TargetOs};

#[tokio::test]
#[ignore]
async fn recommend_via_claude_in_wsl() {
    if std::env::var("VIBECODE_E2E").ok().as_deref() != Some("1") {
        eprintln!("VIBECODE_E2E != 1; skipping");
        return;
    }
    let distros = vibecode_core::backend::wsl::list_distros().await;
    let distro = distros.iter().find(|d| d == &"Ubuntu").cloned().unwrap_or_else(|| distros[0].clone());
    let b: Arc<dyn ExecBackend> = Arc::new(vibecode_core::backend::wsl::WslBackend::new(distro));
    let req = StackRecommendRequest {
        description: "사내 문서를 자동으로 정리해 주는 Windows 데스크톱 도구. 가볍고 빠르면 좋고 Rust를 선호합니다.".into(),
        target_os: TargetOs::Windows,
        project_type: ProjectType::DesktopApp,
        provider: Provider::Claude,
    };
    let recs = ai_recommend::recommend(b, None, req).await.expect("recommend");
    for r in &recs {
        eprintln!("  {} score={} reason={}", r.stack_id, r.score, r.reason);
    }
    assert!(!recs.is_empty());
    assert!(recs[0].score >= recs[recs.len() - 1].score);
}
