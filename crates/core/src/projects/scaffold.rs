//! Creates a project directory: scaffold command, agent docs, git init, first commit,
//! optional GitHub repo. Progress is streamed as `ScaffoldEvent`s.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use tokio::sync::mpsc::UnboundedSender;

use super::{agent_docs, catalog, install};
use crate::backend::{process, ExecBackend};
use crate::context::AppContext;
use crate::error::{CoreError, Result};
use crate::git::Git;
use crate::github::GitHubClient;
use crate::toolchain;
use crate::types::{BackendKind, CreateProjectRequest, ProjectRecord, ScaffoldEvent, StackInfo, WindowsToolStatus};

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
    fn line(&self, line: String, is_err: bool) {
        let _ = self.0.send(ScaffoldEvent::Log { line, is_err });
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
    // Non-interactive hints for common scaffolders.
    cmd.env("CI", "1").env("npm_config_yes", "true").env("NO_COLOR", "1").env("FORCE_COLOR", "0");
    let status = process::stream_lines(&mut cmd, |line, is_err| rep.line(line, is_err)).await?;
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
    let display_name = req.name.trim();
    if !valid_display_name(display_name) {
        return Err(CoreError::msg("프로젝트 이름이 비어 있거나 \\ / : * ? \" < > | 문자를 포함합니다"));
    }
    // Tools (npm, cargo, flutter, ...) need an ASCII identifier: the folder/package name.
    let dir_owned = match req.dir_name.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => d.to_string(),
        None => derive_dir_name(display_name).ok_or_else(|| {
            CoreError::msg("한글 등 비ASCII 이름에는 도구용 영문 폴더 이름(dir_name)이 필요합니다 (예: inventory-app)")
        })?,
    };
    let name = dir_owned.as_str();
    if !valid_name(name) {
        return Err(CoreError::msg("폴더 이름은 영문 소문자, 숫자, '-', '_', '.'만 사용할 수 있습니다"));
    }
    if display_name != name {
        rep.log(format!("표시 이름 \"{display_name}\" → 폴더/패키지 이름 \"{name}\""));
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

    // Install what the stack needs first (winget on the host for Windows toolchains, install hints on the
    // backend). Failures are reported, not fatal: the project is still created and the docs list what is missing.
    if req.install_missing_tools {
        rep.step("필요한 도구 확인");
        let summary = install::install_missing(backend.clone(), stack.as_ref(), req.target_os, &rep.0).await;
        if summary.total == 0 {
            rep.log("필요한 도구가 모두 준비되어 있습니다.");
        } else {
            if !summary.done.is_empty() {
                rep.log(format!("설치 완료: {}", summary.done.join(", ")));
            }
            if !summary.failed.is_empty() {
                rep.warn(format!("설치 실패: {} → 아래 명령으로 직접 설치하지 않으면 빌드가 실패합니다.", summary.failed.join(", ")));
            }
            if !summary.skipped.is_empty() {
                rep.warn(format!("건너뜀(수동 설치 필요): {}", summary.skipped.join(", ")));
            }
        }
    }

    // WSL + Windows-target stack: connect the Windows toolchain (cargo.exe, npm.cmd, ...) before scaffolding
    // so the scaffold command and the agent both use the Windows tools.
    let win_toolchain: Option<Vec<WindowsToolStatus>> = if toolchain::applies(backend.kind(), Some(req.target_os), stack.as_ref()) {
        rep.step("Windows 툴체인 연결");
        let names = stack.as_ref().map(|s| s.windows_toolchain.clone()).unwrap_or_default();
        let statuses = toolchain::detect(&names).await;
        for st in &statuses {
            if st.found {
                rep.log(format!("{}: {}{}", st.label, st.path.clone().unwrap_or_default(), st.version.as_deref().map(|v| format!(" ({v})")).unwrap_or_default()));
            } else {
                rep.warn(format!("{} 없음 → Windows PowerShell에서 설치: winget install -e --id {}", st.label, st.winget_id));
            }
        }
        match toolchain::write_shims(backend.clone(), &statuses).await {
            Ok(shims) if !shims.is_empty() => rep.log(format!("WSL shim 갱신: {}", shims.join(" "))),
            Ok(_) => rep.warn("연결할 Windows 툴체인이 없어 shim을 만들지 않았습니다."),
            Err(e) => rep.warn(format!("shim 작성 실패: {e}")),
        }
        Some(statuses)
    } else {
        None
    };

    rep.step("스캐폴딩");
    match stack.as_ref().and_then(|s| s.scaffold_cmd.as_deref()) {
        Some(cmd) => {
            let mut script = cmd.replace("{name}", name);
            if win_toolchain.is_some() {
                script = toolchain::rewrite_command(&script);
            }
            rep.log(format!("$ {script}"));
            run_streaming(&backend, &script, &parent, rep).await?;
            if !target.is_dir() {
                return Err(CoreError::msg(format!("스캐폴딩이 끝났지만 디렉터리가 생성되지 않았습니다: {target_str}")));
            }
        }
        None => {
            std::fs::create_dir_all(&target)?;
            let readme = format!("# {display_name}\n\n{}\n", req.description.trim());
            write_if_missing(&target.join("README.md"), &readme)?;
            rep.log("스캐폴딩 명령이 없는 스택입니다. 빈 디렉터리와 README.md를 만들었습니다.");
        }
    }

    let now = Utc::now();
    let mut project = ProjectRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name: display_name.to_string(),
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
        let docs = agent_docs::generate(&project, stack.as_ref(), &req.description, win_toolchain.as_deref());
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

/// Display names may contain any characters except path separators / Windows-reserved ones.
pub fn valid_display_name(name: &str) -> bool {
    let t = name.trim();
    !t.is_empty()
        && t.len() <= 200
        && !t.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control())
        && !t.ends_with('.')
}

/// Derive an ASCII folder/package identifier from a display name: lowercase, spaces → '-',
/// drop everything else. Returns None when nothing usable remains (e.g. a purely Korean name).
pub fn derive_dir_name(name: &str) -> Option<String> {
    let mut out = String::new();
    let mut last_dash = false;
    for c in name.trim().chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
            out.push(c);
            last_dash = false;
        } else if (c == '-' || c.is_whitespace()) && !out.is_empty() && !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let out = out.trim_matches(|c| c == '-' || c == '.').to_string();
    if out.is_empty() || !valid_name(&out) { None } else { Some(out) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_and_dir_names() {
        assert!(valid_display_name("재고 관리 앱"));
        assert!(!valid_display_name("a/b"));
        assert!(!valid_display_name(""));
        assert_eq!(derive_dir_name("My App 2"), Some("my-app-2".into()));
        assert_eq!(derive_dir_name("재고관리"), None);
        assert_eq!(derive_dir_name("재고 app"), Some("app".into()));
        assert_eq!(derive_dir_name("  --x--  "), Some("x".into()));
    }

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


/// Whether CLAUDE.md / AGENTS.md exist in the project directory.
pub fn agent_docs_status(project_dir: &std::path::Path) -> crate::types::AgentDocsStatus {
    crate::types::AgentDocsStatus {
        claude_md: project_dir.join("CLAUDE.md").is_file(),
        agents_md: project_dir.join("AGENTS.md").is_file(),
    }
}

/// Write CLAUDE.md / AGENTS.md for a registered project when missing (never overwrites). Returns the files written.
pub async fn generate_agent_docs_if_missing(ctx: Arc<AppContext>, project_id: &str, description: &str) -> Result<Vec<String>> {
    let project = ctx.db.get_project(project_id)?;
    let dir = PathBuf::from(&project.path);
    if !dir.is_dir() {
        return Err(CoreError::msg(format!("디렉터리를 찾을 수 없습니다: {}", project.path)));
    }
    let stack = match &project.stack_id {
        Some(id) => catalog::get(id)?,
        None => None,
    };
    let backend = ctx.backend().await;
    let win_toolchain = if toolchain::applies(backend.kind(), project.target_os, stack.as_ref()) {
        let names = stack.as_ref().map(|s| s.windows_toolchain.clone()).unwrap_or_default();
        let statuses = toolchain::detect(&names).await;
        let _ = toolchain::write_shims(backend.clone(), &statuses).await;
        Some(statuses)
    } else {
        None
    };
    let docs = agent_docs::generate(&project, stack.as_ref(), description, win_toolchain.as_deref());
    let mut written = Vec::new();
    let claude = dir.join("CLAUDE.md");
    if !claude.exists() {
        std::fs::write(&claude, docs.claude_md)?;
        written.push("CLAUDE.md".to_string());
    }
    let agents = dir.join("AGENTS.md");
    if !agents.exists() {
        std::fs::write(&agents, docs.agents_md)?;
        written.push("AGENTS.md".to_string());
    }
    Ok(written)
}
