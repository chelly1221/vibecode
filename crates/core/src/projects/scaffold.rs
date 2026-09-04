//! Creates a project directory: scaffold command, agent docs, git init, first commit,
//! optional GitHub repo. Progress is streamed as `ScaffoldEvent`s.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use chrono::Utc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc::UnboundedSender;

use super::{agent_docs, catalog};
use crate::backend::{process::spawn_tracked, ExecBackend};
use crate::context::AppContext;
use crate::error::{CoreError, Result};
use crate::git::Git;
use crate::github::GitHubClient;
use crate::types::{BackendKind, CreateProjectRequest, ProjectRecord, ScaffoldEvent, StackInfo};

struct Reporter(UnboundedSender<ScaffoldEvent>);

impl Reporter {
    fn step(&self, name: &str) {
        let _ = self.0.send(ScaffoldEvent::Step { name: name.to_string() });
    }
    fn log(&self, line: impl Into<String>) {
        let _ = self.0.send(ScaffoldEvent::Log { line: line.into(), is_err: false });
    }
    fn warn(&self, line: impl Into<String>) {
        let _ = self.0.send(ScaffoldEvent::Log { line: line.into(), is_err: true });
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Host-path join that keeps Windows separators when the parent looks like a Windows path.
fn join_host(parent: &str, name: &str) -> String {
    let trimmed = parent.trim_end_matches(['\\', '/']);
    if trimmed.contains('\\') || trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' {
        format!("{trimmed}\\{name}")
    } else {
        format!("{trimmed}/{name}")
    }
}

/// Run a scaffold command in `parent`, streaming output lines. Fails on non-zero exit.
async fn run_streaming(backend: &Arc<dyn ExecBackend>, script: &str, parent: &Path, rep: &Reporter) -> Result<()> {
    let spec = backend.shell(script, Some(parent));
    let mut cmd = backend.command(&spec);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Non-interactive hints for common scaffolders.
    cmd.env("CI", "1").env("npm_config_yes", "true").env("NO_COLOR", "1").env("FORCE_COLOR", "0");
    let mut child = spawn_tracked(&mut cmd)?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let tx_out = rep.0.clone();
    let tx_err = rep.0.clone();
    let out_task = tokio::spawn(async move {
        if let Some(s) = stdout {
            let mut lines = BufReader::new(s).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = tx_out.send(ScaffoldEvent::Log { line: l, is_err: false });
            }
        }
    });
    let err_task = tokio::spawn(async move {
        if let Some(s) = stderr {
            let mut lines = BufReader::new(s).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = tx_err.send(ScaffoldEvent::Log { line: l, is_err: true });
            }
        }
    });
    let status = child.wait().await?;
    let _ = out_task.await;
    let _ = err_task.await;
    if status.success() {
        Ok(())
    } else {
        Err(CoreError::Process { code: status.code(), stderr: format!("스캐폴딩 명령이 실패했습니다 (exit {:?}): {script}", status.code()) })
    }
}

fn gitignore_for(stack: Option<&StackInfo>) -> String {
    let langs: Vec<String> = stack.map(|s| s.languages.iter().map(|l| l.to_ascii_lowercase()).collect()).unwrap_or_default();
    let has = |l: &str| langs.iter().any(|x| x == l);
    let mut g = String::from("# OS\n.DS_Store\nThumbs.db\n\n# secrets\n.env\n.env.*\n!.env.example\n\n# editors\n.idea/\n.vscode/*\n!.vscode/extensions.json\n*.swp\n\n# logs\n*.log\n");
    if has("typescript") || has("javascript") || has("svelte") || has("astro") {
        g.push_str("\n# node\nnode_modules/\ndist/\n.next/\n.svelte-kit/\n.astro/\ncoverage/\n");
    }
    if has("rust") {
        g.push_str("\n# rust\ntarget/\n");
    }
    if has("python") {
        g.push_str("\n# python\n__pycache__/\n*.pyc\n.venv/\n.pytest_cache/\n.ruff_cache/\n");
    }
    if has("c#") || has("xaml") {
        g.push_str("\n# dotnet\nbin/\nobj/\n*.user\n");
    }
    if has("dart") {
        g.push_str("\n# flutter\nbuild/\n.dart_tool/\n.flutter-plugins*\n");
    }
    if has("kotlin") || has("java") {
        g.push_str("\n# jvm\nbuild/\n.gradle/\n*.class\nlocal.properties\n");
    }
    if has("go") {
        g.push_str("\n# go\nbin/\n");
    }
    if has("gdscript") {
        g.push_str("\n# godot\n.godot/\n");
    }
    if has("c#") && stack.map(|s| s.id == "unity").unwrap_or(false) {
        g.push_str("\n# unity\n[Ll]ibrary/\n[Tt]emp/\n[Ll]ogs/\n[Uu]ser[Ss]ettings/\n");
    }
    g
}

fn write_if_missing(path: &Path, content: &str) -> Result<bool> {
    if path.exists() {
        return Ok(false);
    }
    std::fs::write(path, content)?;
    Ok(true)
}

async fn has_ssh_keys(backend: &Arc<dyn ExecBackend>) -> bool {
    let script = match backend.kind() {
        BackendKind::Wsl => "ls ~/.ssh/id_* >/dev/null 2>&1".to_string(),
        BackendKind::Native => "if (Test-Path \"$env:USERPROFILE\\.ssh\\id_*\") { exit 0 } else { exit 1 }".to_string(),
    };
    let spec = backend.shell(&script, None);
    matches!(backend.run(&spec).await, Ok(out) if out.success())
}

pub async fn create_project(ctx: Arc<AppContext>, req: CreateProjectRequest, events: UnboundedSender<ScaffoldEvent>) -> Result<ProjectRecord> {
    let rep = Reporter(events);
    let result = create_inner(ctx, req, &rep).await;
    match &result {
        Ok(p) => {
            let _ = rep.0.send(ScaffoldEvent::Done { project: p.clone() });
        }
        Err(e) => {
            let _ = rep.0.send(ScaffoldEvent::Failed { message: e.to_string() });
        }
    }
    result
}

async fn create_inner(ctx: Arc<AppContext>, req: CreateProjectRequest, rep: &Reporter) -> Result<ProjectRecord> {
    rep.step("검증");
    let name = req.name.trim();
    if !valid_name(name) {
        return Err(CoreError::msg("프로젝트 이름은 영문, 숫자, '-', '_', '.'만 사용할 수 있습니다"));
    }
    let parent = PathBuf::from(req.parent_dir.trim());
    if !parent.is_dir() {
        return Err(CoreError::msg(format!("상위 디렉터리를 찾을 수 없습니다: {}", parent.display())));
    }
    let target_str = join_host(&req.parent_dir.trim(), name);
    let target = PathBuf::from(&target_str);
    if target.exists() {
        return Err(CoreError::msg(format!("이미 존재하는 경로입니다: {target_str}")));
    }
    if target_str.contains(' ') || !target_str.is_ascii() {
        rep.warn("경고: 경로에 공백이나 비ASCII 문자가 있어 일부 도구가 실패할 수 있습니다.");
    }

    let stack = match &req.stack_id {
        Some(id) => catalog::get(id)?,
        None => None,
    };
    let backend = ctx.backend().await;
    rep.log(format!("실행 백엔드: {}", backend.label()));

    rep.step("스캐폴딩");
    match stack.as_ref().and_then(|s| s.scaffold_cmd.as_deref()) {
        Some(cmd) => {
            let script = cmd.replace("{name}", name);
            rep.log(format!("$ {script}"));
            run_streaming(&backend, &script, &parent, rep).await?;
            if !target.is_dir() {
                return Err(CoreError::msg(format!("스캐폴딩이 끝났지만 디렉터리가 생성되지 않았습니다: {target_str}")));
            }
        }
        None => {
            std::fs::create_dir_all(&target)?;
            let readme = format!("# {name}\n\n{}\n", req.description.trim());
            write_if_missing(&target.join("README.md"), &readme)?;
            rep.log("스캐폴딩 명령이 없는 스택입니다. 빈 디렉터리와 README.md를 만들었습니다.");
        }
    }

    let now = Utc::now();
    let mut project = ProjectRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        path: target_str.clone(),
        target_os: Some(req.target_os),
        project_type: Some(req.project_type),
        stack_id: stack.as_ref().map(|s| s.id.clone()),
        github_url: None,
        default_provider: req.default_provider,
        default_model: req.default_model.clone(),
        default_effort: req.default_effort,
        default_permission: req.default_permission,
        created_at: now,
        last_opened_at: now,
    };

    if req.generate_agent_docs {
        rep.step("에이전트 문서 생성");
        let docs = agent_docs::generate(&project, stack.as_ref(), &req.description);
        std::fs::write(target.join("AGENTS.md"), docs.agents_md)?;
        std::fs::write(target.join("CLAUDE.md"), docs.claude_md)?;
        rep.log("CLAUDE.md, AGENTS.md 생성");
    }

    if req.git_init {
        rep.step("git 초기화");
        if write_if_missing(&target.join(".gitignore"), &gitignore_for(stack.as_ref()))? {
            rep.log(".gitignore 생성");
        }
        let settings = ctx.settings().await;
        let git = Git::new(backend.clone(), ctx.git_bin().await).with_identity(settings.git_user_name.clone(), settings.git_user_email.clone());
        let already_repo = target.join(".git").exists();
        let init_ok = if already_repo {
            rep.log("스캐폴더가 이미 git 저장소를 만들었습니다.");
            true
        } else {
            match git.init(&target, "main").await {
                Ok(()) => {
                    rep.log("git init (main)");
                    true
                }
                Err(e) => {
                    rep.warn(format!("git init 실패: {e}"));
                    false
                }
            }
        };
        if init_ok {
            match git.stage(&target, &[]).await {
                Ok(()) => match git.commit(&target, "Initial commit").await {
                    Ok(h) => rep.log(format!("첫 커밋 {h}")),
                    Err(e) => rep.warn(format!("첫 커밋 실패 (git user.name/email 설정을 확인하세요): {e}")),
                },
                Err(e) => rep.warn(format!("git add 실패: {e}")),
            }

            if req.create_github_repo {
                rep.step("GitHub 저장소 생성");
                match GitHubClient::from_keyring() {
                    Ok(Some(client)) => match client.create_repo(name, req.github_private, req.description.trim()).await {
                        Ok(repo) => {
                            rep.log(format!("저장소 생성: {}", repo.html_url));
                            // SSH when a key exists on the backend; otherwise HTTPS, which Git::push authenticates with the stored token.
                            let url = if has_ssh_keys(&backend).await { repo.ssh_url.clone() } else { repo.clone_url.clone() };
                            match git.add_remote(&target, "origin", &url).await {
                                Ok(()) => {
                                    rep.log(format!("origin → {url}"));
                                    match git.push(&target, true).await {
                                        Ok(out) => rep.log(format!("push 완료\n{out}")),
                                        Err(e) => rep.warn(format!("push 실패 (나중에 git 패널에서 다시 시도): {e}")),
                                    }
                                }
                                Err(e) => rep.warn(format!("원격 추가 실패: {e}")),
                            }
                            project.github_url = Some(repo.html_url);
                        }
                        Err(e) => rep.warn(format!("GitHub 저장소 생성 실패: {e}")),
                    },
                    Ok(None) => rep.warn("GitHub 토큰이 설정되지 않아 저장소 생성을 건너뜁니다 (설정 → GitHub)."),
                    Err(e) => rep.warn(format!("GitHub 토큰을 읽을 수 없습니다: {e}")),
                }
            }
        }
    }

    ctx.db.upsert_project(&project)?;
    rep.step("완료");
    Ok(project)
}

/// Best-effort stack detection for an existing directory.
pub fn detect_stack(dir: &Path) -> Option<String> {
    let exists = |p: &str| dir.join(p).exists();
    let read = |p: &str| std::fs::read_to_string(dir.join(p)).unwrap_or_default();
    if exists("src-tauri/tauri.conf.json") || exists("tauri.conf.json") {
        return Some("tauri-react".into());
    }
    if exists("pubspec.yaml") {
        return Some("flutter-mobile".into());
    }
    if exists("project.godot") {
        return Some("godot".into());
    }
    if exists("Assets") && exists("ProjectSettings") {
        return Some("unity".into());
    }
    if exists("package.json") {
        let pkg = read("package.json");
        let dep = |name: &str| pkg.contains(&format!("\"{name}\""));
        return Some(
            if dep("next") { "nextjs" }
            else if dep("@sveltejs/kit") { "sveltekit" }
            else if dep("astro") { "astro" }
            else if dep("electron") { "electron-vite" }
            else if dep("expo") { "expo" }
            else if dep("@nestjs/core") { "nestjs" }
            else if dep("hono") { "hono" }
            else { "vite-react" }
            .into(),
        );
    }
    if exists("Cargo.toml") {
        let c = read("Cargo.toml");
        return Some(if c.contains("bevy") { "bevy" } else if c.contains("axum") { "axum" } else { "rust-cli" }.into());
    }
    if exists("pyproject.toml") {
        let p = read("pyproject.toml");
        return Some(if p.contains("fastapi") { "fastapi" } else if p.contains("typer") { "python-typer" } else { "python-uv" }.into());
    }
    if exists("go.mod") {
        return Some("go-cli".into());
    }
    if exists("build.gradle.kts") || exists("build.gradle") {
        let g = read("build.gradle.kts") + &read("build.gradle");
        return Some(if g.contains("com.android") { "kotlin-android" } else { "spring-boot" }.into());
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.ends_with(".csproj") {
                let c = std::fs::read_to_string(e.path()).unwrap_or_default();
                return Some(if c.contains("UseWPF") { "dotnet-wpf" } else { "aspnet-webapi" }.into());
            }
            if n.ends_with(".ps1") {
                return Some("powershell".into());
            }
        }
    }
    None
}

/// Register an existing directory as a project (no scaffolding).
pub async fn open_existing(ctx: Arc<AppContext>, path: &str) -> Result<ProjectRecord> {
    let trimmed = path.trim().trim_end_matches(['\\', '/']);
    let dir = PathBuf::from(trimmed);
    if !dir.is_dir() {
        return Err(CoreError::msg(format!("디렉터리를 찾을 수 없습니다: {trimmed}")));
    }
    if let Some(existing) = ctx.db.find_project_by_path(trimmed)? {
        ctx.db.touch_project(&existing.id)?;
        return ctx.db.get_project(&existing.id);
    }
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| trimmed.to_string());
    let now = Utc::now();
    let stack_id = detect_stack(&dir);
    let stack = match &stack_id {
        Some(id) => catalog::get(id)?,
        None => None,
    };
    let project = ProjectRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path: trimmed.to_string(),
        target_os: stack.as_ref().and_then(|s| s.targets.first().copied()),
        project_type: stack.as_ref().and_then(|s| s.types.first().copied()),
        stack_id,
        github_url: None,
        default_provider: None,
        default_model: None,
        default_effort: None,
        default_permission: None,
        created_at: now,
        last_opened_at: now,
    };
    ctx.db.upsert_project(&project)?;
    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_validation() {
        assert!(valid_name("my-app_1.0"));
        assert!(!valid_name(""));
        assert!(!valid_name("a/b"));
        assert!(!valid_name("a\\b"));
        assert!(!valid_name(".hidden"));
        assert!(!valid_name("한글"));
    }

    #[test]
    fn host_join() {
        assert_eq!(join_host("C:\\code\\", "x"), "C:\\code\\x");
        assert_eq!(join_host("C:\\code", "x"), "C:\\code\\x");
        assert_eq!(join_host("/home/me/", "x"), "/home/me/x");
    }

    #[test]
    fn gitignore_by_language() {
        let tauri = catalog::get("tauri-react").unwrap().unwrap();
        let g = gitignore_for(Some(&tauri));
        assert!(g.contains("node_modules/") && g.contains("target/"));
        let py = catalog::get("fastapi").unwrap().unwrap();
        assert!(gitignore_for(Some(&py)).contains(".venv/"));
        assert!(gitignore_for(None).contains(".env"));
    }

    #[test]
    fn detects_stacks() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(detect_stack(d.path()), None);
        std::fs::write(d.path().join("package.json"), r#"{"dependencies":{"next":"15"}}"#).unwrap();
        assert_eq!(detect_stack(d.path()).as_deref(), Some("nextjs"));
        std::fs::create_dir_all(d.path().join("src-tauri")).unwrap();
        std::fs::write(d.path().join("src-tauri/tauri.conf.json"), "{}").unwrap();
        assert_eq!(detect_stack(d.path()).as_deref(), Some("tauri-react"));
    }
}
