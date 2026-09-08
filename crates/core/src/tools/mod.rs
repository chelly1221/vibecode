//! CLI detection, install helpers, auth status and model listing on the Windows host.

pub mod claude;
pub mod codex;
pub mod login;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use serde_json::Value;

use crate::backend::{process, CommandSpec, ExecBackend};
use crate::error::{CoreError, Result};
use crate::types::{AuthStatus, ModelInfo, Provider, ToolStatus};

/// Tools the onboarding wizard and stack prerequisites care about. `msvc` = Visual Studio Build
/// Tools (C++ linker for Rust/Tauri stacks), detected with vswhere instead of PATH.
pub const KNOWN_TOOLS: &[&str] = &[
    "claude", "codex", "git", "gh", "node", "npm", "cargo", "rustup", "msvc", "python", "uv", "dotnet", "flutter", "go", "java",
];

/// Version command arguments and whether the version is printed on stderr.
fn version_args(name: &str) -> (Vec<&'static str>, bool) {
    match name {
        "java" => (vec!["-version"], true),
        "go" => (vec!["version"], false),
        _ => (vec!["--version"], false),
    }
}

/// Human label for a tool name (UI lists, install progress).
pub fn label(name: &str) -> String {
    match name {
        "claude" => "Claude Code",
        "codex" => "Codex CLI",
        "git" => "Git",
        "gh" => "GitHub CLI",
        "node" => "Node.js",
        "npm" => "npm",
        "cargo" => "Rust (cargo)",
        "rustup" => "rustup",
        "msvc" => "Visual Studio Build Tools (C++ 링커)",
        "python" => "Python 3",
        "uv" => "uv (Python 패키지 관리자)",
        "dotnet" => ".NET SDK",
        "flutter" => "Flutter SDK",
        "go" => "Go",
        "java" => "JDK",
        other => other,
    }
    .to_string()
}

/// PowerShell one-liner that installs the tool (winget where a package exists).
pub fn install_hint(name: &str) -> Option<String> {
    let s = match name {
        "claude" => "irm https://claude.ai/install.ps1 | iex",
        "codex" => "npm install -g @openai/codex",
        "git" => "winget install Git.Git",
        "gh" => "winget install GitHub.cli",
        "node" | "npm" => "winget install OpenJS.NodeJS.LTS",
        "cargo" | "rustup" => "winget install Rustlang.Rustup",
        "msvc" => "winget install Microsoft.VisualStudio.2022.BuildTools --override \"--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended\"",
        "python" => "winget install Python.Python.3.12",
        "uv" => "irm https://astral.sh/uv/install.ps1 | iex",
        "dotnet" => "winget install Microsoft.DotNet.SDK.8",
        "flutter" => "https://docs.flutter.dev/get-started/install 참고 (SDK 압축 해제 후 PATH 추가)",
        "go" => "winget install GoLang.Go",
        "java" => "winget install EclipseAdoptium.Temurin.21.JDK",
        _ => return None,
    };
    Some(s.to_string())
}

/// Install hints that are commands rather than "see this page" notes (flutter).
pub fn runnable_hint(hint: &str) -> bool {
    let h = hint.trim();
    !h.is_empty() && !h.starts_with("http://") && !h.starts_with("https://")
}

/// Install hint rewritten so it never waits for input: winget accepts agreements and disables its
/// prompts (it may still show a UAC dialog for machine-wide installers).
pub fn noninteractive_script(hint: &str) -> String {
    let h = hint.trim();
    if h.starts_with("winget install") {
        format!("{h} -e --accept-source-agreements --accept-package-agreements --disable-interactivity")
    } else {
        h.to_string()
    }
}

/// Run an install hint in PowerShell, streaming output lines. Resolves with the exit code.
pub async fn install(backend: &Arc<ExecBackend>, hint: &str, on_line: impl FnMut(String, bool)) -> Result<Option<i32>> {
    let script = format!("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8\n{}", noninteractive_script(hint));
    let spec = backend.shell(&script, None);
    let mut cmd = backend.command(&spec);
    cmd.env("CI", "1").env("NO_COLOR", "1");
    let status = process::stream_lines(&mut cmd, on_line).await?;
    Ok(status.code())
}

fn first_line(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string()
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

fn vswhere() -> Option<PathBuf> {
    let p = env_dir("ProgramFiles(x86)").or_else(|| env_dir("ProgramFiles"))?.join("Microsoft Visual Studio").join("Installer").join("vswhere.exe");
    p.is_file().then_some(p)
}

/// Visual Studio (Build Tools or full) with the C++ x64 toolset, via vswhere.
async fn detect_msvc() -> ToolStatus {
    let mut st = ToolStatus { name: "msvc".into(), found: false, path: None, version: None, install_hint: install_hint("msvc") };
    let Some(vsw) = vswhere() else { return st };
    let spec = CommandSpec::new(vsw.to_string_lossy().into_owned()).args(["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-format", "json", "-utf8"]);
    let backend = ExecBackend::new();
    if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(15), backend.run(&spec)).await {
        if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&out.stdout) {
            if let Some(first) = items.first() {
                st.found = true;
                st.path = first.get("installationPath").and_then(Value::as_str).map(String::from);
                st.version = first.get("installationVersion").and_then(Value::as_str).map(String::from);
            }
        }
    }
    st
}

/// Detect every known tool (path + version), concurrently.
pub async fn detect_all(backend: Arc<ExecBackend>) -> Vec<ToolStatus> {
    detect_all_with(backend, &[]).await
}

/// Like `detect_all`, honouring explicit binaries from settings (`("claude", Some(path))`) so a tool
/// that is not on PATH but configured by path shows up as found.
pub async fn detect_all_with(backend: Arc<ExecBackend>, overrides: &[(&str, Option<String>)]) -> Vec<ToolStatus> {
    let futs = KNOWN_TOOLS.iter().map(|name| {
        let bin = overrides.iter().find(|(n, _)| n == name).and_then(|(_, b)| b.clone());
        let backend = backend.clone();
        async move { detect(backend, name, bin.as_deref()).await }
    });
    join_all(futs).await
}

/// Detect a single tool. `bin_override` is a path/name from settings.
pub async fn detect(backend: Arc<ExecBackend>, name: &str, bin_override: Option<&str>) -> ToolStatus {
    if name == "msvc" {
        return detect_msvc().await;
    }
    let program = bin_override.filter(|b| !b.trim().is_empty()).map(|s| s.to_string()).unwrap_or_else(|| name.to_string());
    let mut status = ToolStatus { name: name.to_string(), found: false, path: None, version: None, install_hint: install_hint(name) };

    let path = match backend.which(&program).await {
        Some(p) => p,
        None => {
            // An override may be an absolute path that `which` can't resolve; try it directly.
            if bin_override.is_some() && Path::new(&program).is_file() { program.clone() } else { return status }
        }
    };

    let (args, on_stderr) = version_args(name);
    let spec = CommandSpec::new(&program).args(args);
    let timeout = if name == "flutter" { Duration::from_secs(8) } else { Duration::from_secs(6) };
    match tokio::time::timeout(timeout, backend.run(&spec)).await {
        Ok(Ok(out)) if out.code.is_some() => {
            status.found = true;
            status.path = Some(path);
            let text = if on_stderr || out.stdout.trim().is_empty() { &out.stderr } else { &out.stdout };
            let v = first_line(text);
            status.version = if v.is_empty() { None } else { Some(v) };
        }
        Ok(Ok(_)) | Ok(Err(_)) => {
            if bin_override.is_none() {
                // which() found it but it failed to run; still report the path.
                status.found = true;
                status.path = Some(path);
            }
        }
        Err(_) => {
            status.found = true;
            status.path = Some(path);
            status.version = Some("(버전 확인 시간 초과)".into());
        }
    }
    status
}

/// `claude auth status` (JSON) / `codex login status`.
pub async fn auth_status(backend: Arc<ExecBackend>, provider: Provider, bin_override: Option<&str>) -> Result<AuthStatus> {
    match provider {
        Provider::Claude => claude::auth_status(backend, bin_override).await,
        Provider::Codex => codex::auth_status(backend, bin_override).await,
    }
}

/// Models offered in the UI. Claude: static list + aliases; Codex: `model/list` via app-server.
pub async fn list_models(backend: Arc<ExecBackend>, provider: Provider, bin_override: Option<&str>) -> Result<Vec<ModelInfo>> {
    let _ = (backend, bin_override);
    match provider {
        Provider::Claude => Ok(claude::list_models()),
        Provider::Codex => Err(CoreError::msg("codex models are listed through CodexHost::list_models")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hints_cover_known_tools() {
        for t in KNOWN_TOOLS {
            assert!(install_hint(t).is_some(), "{t}");
            assert_ne!(label(t), "", "{t}");
        }
    }

    #[test]
    fn install_hints_run_without_prompts() {
        assert!(runnable_hint("winget install Git.Git"));
        assert!(!runnable_hint("https://docs.flutter.dev/get-started/install 참고 (SDK 압축 해제 후 PATH 추가)"));
        assert!(!runnable_hint("  "));
        let s = noninteractive_script("winget install OpenJS.NodeJS.LTS");
        assert_eq!(s, "winget install OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --disable-interactivity");
        assert_eq!(noninteractive_script("irm https://claude.ai/install.ps1 | iex"), "irm https://claude.ai/install.ps1 | iex");
    }

    #[test]
    fn first_line_skips_blank() {
        assert_eq!(first_line("\n\n git version 2.43.0\nmore"), "git version 2.43.0");
    }
}
