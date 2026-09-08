//! Real native CLIs must not inherit the existing Windows login into an empty profile.
use vibecode_core::{accounts, AppContext, types::{AccountKind, Provider}};
#[tokio::test]
#[ignore]
async fn empty_profiles_do_not_inherit_native_login() {
    assert_eq!(std::env::var("VIBECODE_E2E").ok().as_deref(),Some("1"));
    let tmp = tempfile::tempdir().unwrap();
    let ctx = AppContext::init(tmp.path().join("data")).await.unwrap();
    for (kind,provider) in [(AccountKind::Claude,Provider::Claude),(AccountKind::Codex,Provider::Codex)] {
        let profile = accounts::create(&ctx,"isolated-test".into(),kind).unwrap();
        let backend = accounts::agent_backend(&ctx,provider,Some(&profile.id)).unwrap();
        let bin = if provider == Provider::Claude { std::env::var("VIBECODE_CLAUDE_BIN").ok() } else { None };
        let status = vibecode_core::tools::auth_status(backend,provider,bin.as_deref()).await.unwrap();
        assert!(!status.logged_in,"empty profile must not share the Windows user's native login");
        assert!(status.detail.as_deref().is_none_or(|s| !s.contains("실행 실패") && !s.contains("not available") && !s.contains("시간 초과")),"native CLI must actually execute");
    }
}
