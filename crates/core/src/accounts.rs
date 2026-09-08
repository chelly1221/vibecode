//! Local account profiles. AI credentials remain owned by the native CLIs.
use std::sync::Arc;
use rusqlite::{params, OptionalExtension};
use base64::Engine;
use crate::{backend::ExecBackend, context::AppContext, db::Db, error::{CoreError, Result}, types::{AccountKind, AccountProfile, ProjectAccounts, Provider}};

pub fn migrate(db: &Db) -> Result<()> {
    db.with_conn(|c| { c.execute_batch("CREATE TABLE IF NOT EXISTS account_profiles (id TEXT PRIMARY KEY, value_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS project_accounts (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, value_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session_accounts (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, value_json TEXT NOT NULL);")?; Ok(()) })
}
pub fn list(db: &Db) -> Result<Vec<AccountProfile>> {
    db.with_conn(|c| {
        let mut q = c.prepare("SELECT value_json FROM account_profiles ORDER BY rowid")?;
        let rows = q.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows.iter().map(|s| Ok(serde_json::from_str(s)?)).collect()
    })
}
pub fn get(db: &Db, id: &str, kind: AccountKind) -> Result<AccountProfile> {
    if uuid::Uuid::parse_str(id).is_err() { return Err(CoreError::msg("올바르지 않은 계정입니다")); }
    let profile = list(db)?.into_iter().find(|p| p.id == id).ok_or_else(|| CoreError::msg("등록된 계정을 찾을 수 없습니다. 프로젝트 계정을 다시 선택하세요"))?;
    if profile.kind != kind { return Err(CoreError::msg("이 서비스에 사용할 수 없는 계정입니다")); }
    Ok(profile)
}
pub fn create(ctx: &AppContext, name: String, kind: AccountKind) -> Result<AccountProfile> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 50 { return Err(CoreError::msg("계정 이름을 1~50자로 입력하세요")); }
    let profile = AccountProfile { id: uuid::Uuid::new_v4().to_string(), name: name.into(), kind };
    let json = serde_json::to_string(&profile)?;
    ctx.db.with_conn(|c| { c.execute("INSERT INTO account_profiles VALUES(?1,?2)", params![profile.id, json])?; Ok(()) })?;
    Ok(profile)
}
pub fn project(db: &Db, id: &str) -> Result<ProjectAccounts> {
    db.get_project(id)?;
    db.with_conn(|c| {
        let s: Option<String> = c.query_row("SELECT value_json FROM project_accounts WHERE project_id=?1", [id], |r| r.get(0)).optional()?;
        Ok(s.map(|s| serde_json::from_str(&s)).transpose()?.unwrap_or_default())
    })
}
pub fn validate(db: &Db, selected: &ProjectAccounts) -> Result<()> {
    for (id, kind) in [(&selected.claude, AccountKind::Claude), (&selected.codex, AccountKind::Codex), (&selected.github, AccountKind::Github)] {
        if let Some(id) = id { get(db, id, kind)?; }
    }
    let name = selected.git_user_name.as_deref().unwrap_or("").trim();
    let email = selected.git_user_email.as_deref().unwrap_or("").trim();
    if name.is_empty() != email.is_empty() || name.chars().count() > 100 || email.len() > 254 || name.contains(['\r','\n','\0']) || email.contains(['\r','\n','\0']) {
        return Err(CoreError::msg("커밋 작성자 이름과 이메일을 함께 입력하세요 (이름 최대 100자, 이메일 최대 254자)"));
    }
    Ok(())
}
pub fn set_project(db: &Db, id: &str, selected: &ProjectAccounts) -> Result<ProjectAccounts> {
    db.get_project(id)?;
    validate(db, selected)?;
    db.with_conn(|c| { c.execute("INSERT INTO project_accounts VALUES(?1,?2) ON CONFLICT(project_id) DO UPDATE SET value_json=excluded.value_json", params![id, serde_json::to_string(selected)?])?; Ok(()) })?;
    Ok(selected.clone())
}
pub fn save_session(db: &Db, id: &str, selected: &ProjectAccounts) -> Result<()> {
    db.with_conn(|c| { c.execute("INSERT OR IGNORE INTO session_accounts VALUES(?1,?2)", params![id, serde_json::to_string(selected)?])?; Ok(()) })
}
pub fn session(db: &Db, id: &str) -> Result<ProjectAccounts> {
    db.get_session(id)?;
    db.with_conn(|c| {
        let s: Option<String> = c.query_row("SELECT value_json FROM session_accounts WHERE session_id=?1", [id], |r| r.get(0)).optional()?;
        Ok(s.map(|s| serde_json::from_str(&s)).transpose()?.unwrap_or_default())
    })
}
pub fn token_key(id: Option<&str>) -> String {
    id.map(|id| format!("github_token:{id}")).unwrap_or_else(|| "github_token:unselected".into())
}
pub async fn github_client(id: Option<&str>) -> Result<Option<crate::github::GitHubClient>> {
    if id.is_none() { return Ok(None); }
    let key = token_key(id);
    let token = tokio::task::spawn_blocking(move || crate::secrets::get(&key)).await.map_err(|e| CoreError::msg(e.to_string()))??;
    Ok(token.map(|token| crate::github::GitHubClient { token }))
}
pub async fn ensure_not_live(ctx: &AppContext, id: &str) -> Result<()> {
    for sid in ctx.sessions.live_ids().await {
        let a = session(&ctx.db, &sid)?;
        if [a.claude.as_deref(), a.codex.as_deref(), a.github.as_deref()].contains(&Some(id)) {
            return Err(CoreError::msg("이 계정을 사용하는 대화가 연결되어 있습니다. 대화 상단의 연결 종료를 누른 후 다시 시도하세요"));
        }
    }
    Ok(())
}
pub async fn remove(ctx: &AppContext, id: &str) -> Result<()> {
    let _changes = ctx.account_changes.lock().await;
    let _login = ctx.login_gate.try_lock().map_err(|_| CoreError::msg("로그인 중에는 계정을 삭제할 수 없습니다"))?;
    ensure_not_live(ctx,id).await?;
    let profile = list(&ctx.db)?.into_iter().find(|p| p.id == id).ok_or_else(|| CoreError::msg("계정을 찾을 수 없습니다"))?;
    let used = ctx.db.with_conn(|c| {
        let mut q = c.prepare("SELECT value_json FROM project_accounts UNION ALL SELECT value_json FROM session_accounts")?;
        let rows = q.query_map([], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for row in rows {
            let a: ProjectAccounts = serde_json::from_str(&row)?;
            if [a.claude.as_deref(),a.codex.as_deref(),a.github.as_deref()].contains(&Some(id)) { return Ok(true); }
        }
        Ok(false)
    })?;
    if used { return Err(CoreError::msg("프로젝트 또는 대화에서 사용 중인 계정입니다. 연결과 해당 대화를 정리한 후 삭제하세요")); }
    if profile.kind == AccountKind::Github {
        let key = token_key(Some(id));
        tokio::task::spawn_blocking(move || crate::secrets::delete(&key)).await.map_err(|e| CoreError::msg(e.to_string()))??;
    }
    ctx.stop_account_hosts(id).await;
    let dir = ctx.data_dir.join("accounts").join(&profile.id);
    if dir.exists() { std::fs::remove_dir_all(dir)?; }
    ctx.db.with_conn(|c| { c.execute("DELETE FROM account_profiles WHERE id=?1", [id])?; Ok(()) })
}
fn scope_agent(ctx: &AppContext, b: &mut ExecBackend, provider: Provider, id: Option<&str>) -> Result<()> {
    let Some(id) = id else { return Ok(()) };
    let kind = match provider { Provider::Claude => AccountKind::Claude, Provider::Codex => AccountKind::Codex };
    let p = get(&ctx.db, id, kind)?;
    let dir = ctx.data_dir.join("accounts").join(&p.id);
    std::fs::create_dir_all(&dir)?;
    let (key, removed): (&str, &[&str]) = match provider {
        Provider::Claude => ("CLAUDE_CONFIG_DIR", &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE"]),
        Provider::Codex => ("CODEX_HOME", &["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "CODEX_SQLITE_HOME"]),
    };
    b.environment.push((key.into(), dir.to_string_lossy().into_owned()));
    b.remove_environment.extend(removed.iter().map(|s| s.to_string()));
    b.account_key.push_str(&format!("{provider:?}:{id};"));
    if provider == Provider::Codex {
        // File storage makes the credential namespace unambiguously CODEX_HOME-specific.
        // Native CLI owns token persistence and refresh; no API-key login is exposed.
        let file = dir.join("config.toml");
        if !file.exists() { std::fs::write(file, "cli_auth_credentials_store = \"file\"\n")?; }
    }
    Ok(())
}
pub fn agent_backend(ctx: &AppContext, provider: Provider, id: Option<&str>) -> Result<Arc<ExecBackend>> {
    let mut b = ExecBackend::new();
    scope_agent(ctx, &mut b, provider, id)?;
    Ok(Arc::new(b))
}
pub async fn selected_backend(ctx: &AppContext, selected: &ProjectAccounts) -> Result<Arc<ExecBackend>> {
    validate(&ctx.db, selected)?;
    let mut b = ExecBackend::new();
    scope_agent(ctx, &mut b, Provider::Claude, selected.claude.as_deref())?;
    scope_agent(ctx, &mut b, Provider::Codex, selected.codex.as_deref())?;
    for (key, missing, folder) in [("CLAUDE_CONFIG_DIR",selected.claude.is_none(),"claude"),("CODEX_HOME",selected.codex.is_none(),"codex")] {
        if missing {
            let dir = ctx.data_dir.join("unselected-accounts").join(folder);
            std::fs::create_dir_all(&dir)?;
            b.environment.push((key.into(),dir.to_string_lossy().into_owned()));
        }
    }
    b.remove_environment.extend(["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","OPENAI_API_KEY","CODEX_API_KEY","GH_TOKEN","GITHUB_TOKEN"].map(String::from));
    if selected.github.is_none() { b.environment.extend(github_environment(None)); }
    if let Some(id) = &selected.github {
        b.account_key.push_str(&format!("github:{id};"));
        b.remove_environment.extend(["GH_TOKEN","GITHUB_TOKEN","GH_ENTERPRISE_TOKEN","GITHUB_ENTERPRISE_TOKEN"].map(String::from));
        let gh_dir = ctx.data_dir.join("accounts").join(id).join("gh");
        std::fs::create_dir_all(&gh_dir)?;
        b.environment.push(("GH_CONFIG_DIR".into(), gh_dir.to_string_lossy().into_owned()));
        let token = github_client(Some(id)).await?.map(|c| c.token);
        b.environment.extend(github_environment(token.as_deref()));
    }
    if let (Some(name),Some(email)) = (&selected.git_user_name,&selected.git_user_email) {
        b.environment.extend([("GIT_AUTHOR_NAME".into(),name.clone()),("GIT_COMMITTER_NAME".into(),name.clone()),("GIT_AUTHOR_EMAIL".into(),email.clone()),("GIT_COMMITTER_EMAIL".into(),email.clone())]);
        b.account_key.push_str(&format!("identity:{name}:{email};"));
    }
    Ok(Arc::new(b))
}
/// Scope HTTPS credentials to github.com, including SSH-form remotes, without changing repository config.
/// Tokens go in child environment, never command arguments or repository files.
pub fn github_environment(token: Option<&str>) -> Vec<(String,String)> {
    let mut env = vec![("GIT_TERMINAL_PROMPT".into(),"0".into()),("GIT_CONFIG_COUNT".into(),"6".into())];
    let header = token.map(|t| format!("AUTHORIZATION: basic {}", base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{t}")))).unwrap_or_default();
    for (i,(key,value)) in [("http.https://github.com/.extraheader",String::new()),("http.https://github.com/.extraheader",header),("credential.https://github.com.helper",String::new()),("url.https://github.com/.insteadOf","git@github.com:".into()),("url.https://github.com/.insteadOf","ssh://git@github.com/".into()),("http.https://github.com/.followRedirects","false".into())].into_iter().enumerate() {
        env.push((format!("GIT_CONFIG_KEY_{i}"),key.into()));env.push((format!("GIT_CONFIG_VALUE_{i}"),value));
    }
    if let Some(token) = token { env.extend([("GH_TOKEN".into(),token.into()),("GITHUB_TOKEN".into(),token.into())]); }
    env
}
pub async fn project_backend(ctx: &AppContext, id: &str) -> Result<Arc<ExecBackend>> { selected_backend(ctx, &project(&ctx.db,id)?).await }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{SessionRecord, PermissionPreset};
    async fn fixture() -> (tempfile::TempDir, Arc<AppContext>, String, String) {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = AppContext::init(tmp.path().join("data")).await.unwrap();
        let a = tmp.path().join("project-a"); let b = tmp.path().join("project-b");
        std::fs::create_dir(&a).unwrap(); std::fs::create_dir(&b).unwrap();
        let a = crate::projects::scaffold::open_existing(ctx.clone(), a.to_str().unwrap()).await.unwrap();
        let b = crate::projects::scaffold::open_existing(ctx.clone(), b.to_str().unwrap()).await.unwrap();
        (tmp, ctx, a.id, b.id)
    }
    #[tokio::test]
    async fn selections_are_local_persistent_and_type_checked() {
        let (_tmp,ctx,a,b) = fixture().await;
        let claude = create(&ctx,"Alice".into(),AccountKind::Claude).unwrap();
        let codex = create(&ctx,"Bob".into(),AccountKind::Codex).unwrap();
        let selected = ProjectAccounts { claude: Some(claude.id.clone()), codex: Some(codex.id.clone()), ..Default::default() };
        set_project(&ctx.db,&a,&selected).unwrap();
        assert_eq!(project(&ctx.db,&a).unwrap(), selected);
        assert_eq!(project(&ctx.db,&b).unwrap(), ProjectAccounts::default());
        assert!(set_project(&ctx.db,&b,&ProjectAccounts { claude:Some(codex.id), ..Default::default() }).is_err());
        assert!(get(&ctx.db,"../../outside",AccountKind::Claude).is_err());
        assert!(remove(&ctx,&claude.id).await.is_err());
        let again = AppContext::init(ctx.data_dir.clone()).await.unwrap();
        assert_eq!(project(&again.db,&a).unwrap(),selected);
    }
    #[tokio::test]
    async fn native_cli_environments_and_codex_hosts_are_separate() {
        let (_tmp,ctx,_,_) = fixture().await;
        let a = create(&ctx,"Alice".into(),AccountKind::Codex).unwrap();
        let b = create(&ctx,"Bob".into(),AccountKind::Codex).unwrap();
        let ba = agent_backend(&ctx,Provider::Codex,Some(&a.id)).unwrap();
        let bb = agent_backend(&ctx,Provider::Codex,Some(&b.id)).unwrap();
        assert_ne!(ba.account_key(),bb.account_key());
        assert_ne!(ba.environment,bb.environment);
        assert!(ba.remove_environment.contains(&"OPENAI_API_KEY".to_string()));
        let host_a = ctx.account_host(ba.account_key()).await;
        let host_b = ctx.account_host(bb.account_key()).await;
        assert!(!Arc::ptr_eq(&host_a,&host_b));
        assert!(Arc::ptr_eq(&host_a,&ctx.account_host(ba.account_key()).await));
        let c = create(&ctx,"Claude".into(),AccountKind::Claude).unwrap();
        let bc = agent_backend(&ctx,Provider::Claude,Some(&c.id)).unwrap();
        assert!(bc.environment.iter().any(|(k,v)| k == "CLAUDE_CONFIG_DIR" && v.contains(&c.id)));
        assert!(bc.remove_environment.contains(&"CLAUDE_CODE_OAUTH_TOKEN".into()));
        assert!(!ctx.data_dir.join("accounts").join(&a.id).join("auth.json").exists());
    }
    #[tokio::test]
    async fn old_conversation_keeps_its_account_when_project_changes() {
        let (_tmp,ctx,project_id,_) = fixture().await;
        let a = create(&ctx,"Alice".into(),AccountKind::Claude).unwrap();
        let b = create(&ctx,"Bob".into(),AccountKind::Claude).unwrap();
        let selected = ProjectAccounts { claude:Some(a.id.clone()), ..Default::default() };
        set_project(&ctx.db,&project_id,&selected).unwrap();
        let now = chrono::Utc::now();
        let record = SessionRecord { id:"test-session".into(), project_id:project_id.clone(), provider:Provider::Claude, external_ref:None, title:"test".into(), model:None, effort:None, permission:PermissionPreset::AskEverything, total_cost_usd:0.0, archived:false, created_at:now,last_used_at:now };
        ctx.db.upsert_session(&record).unwrap();save_session(&ctx.db,&record.id,&selected).unwrap();
        set_project(&ctx.db,&project_id,&ProjectAccounts { claude:Some(b.id), ..Default::default() }).unwrap();
        assert_eq!(session(&ctx.db,&record.id).unwrap().claude,Some(a.id.clone()));
        assert!(remove(&ctx,&a.id).await.is_err());
    }
    #[test]
    fn github_credentials_are_host_scoped_and_not_command_arguments() {
        let env = github_environment(Some("synthetic-test-token"));
        assert!(env.contains(&("GIT_CONFIG_KEY_0".into(),"http.https://github.com/.extraheader".into())));
        assert!(env.contains(&("GIT_CONFIG_KEY_2".into(),"credential.https://github.com.helper".into())));
        assert!(env.contains(&("GIT_CONFIG_VALUE_2".into(),String::new())));
        assert_ne!(token_key(Some("alice")),token_key(Some("bob")));
        assert!(github_environment(None).contains(&("GIT_CONFIG_VALUE_0".into(),String::new())));
    }
}
