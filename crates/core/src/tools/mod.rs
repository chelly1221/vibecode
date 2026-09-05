//! CLI detection, auth status and model listing on the active backend.

pub mod claude;
pub mod codex;

use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;

use crate::backend::{CommandSpec, ExecBackend};
use crate::error::{CoreError, Result};
use crate::types::{AuthStatus, BackendKind, ModelInfo, Provider, ToolStatus};

/// Tools the onboarding wizard and stack prerequisites care about.
pub const KNOWN_TOOLS: &[&str] = &[
    "claude", "codex", "git", "gh", "node", "npm", "cargo", "rustup", "python", "uv", "dotnet", "flutter", "go", "java",
];

/// Version command arguments and whether the version is printed on stderr.
fn version_args(name: &str) -> (Vec<&'static str>, bool) {
    match name {
        "java" => (vec!["-version"], true),
        "go" => (vec!["version"], false),
        "python" => (vec!["--version"], false),
        _ => (vec!["--version"], false),
    }
}

/// Program name to look up (python is `python3` in WSL).
fn program_name(name: &str, kind: BackendKind) -> &str {
    match (name, kind) {
        ("python", BackendKind::Wsl) => "python3",
        _ => name,
    }
}

fn install_hint(name: &str, kind: BackendKind) -> Option<String> {
    let native = matches!(kind, BackendKind::Native);
    let s = match name {
        "claude" => {
            if native { "irm https://claude.ai/install.ps1 | iex" } else { "curl -fsSL https://claude.ai/install.sh | bash" }
        }
        "codex" => "npm install -g @openai/codex",
        "git" => if native { "winget install Git.Git" } else { "sudo apt install -y git" },
        "gh" => if native { "winget install GitHub.cli" } else { "sudo apt install -y gh" },
        "node" | "npm" => {
            if native { "winget install OpenJS.NodeJS.LTS" } else { "curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt install -y nodejs" }
        }
        "cargo" | "rustup" => {
            if native { "winget install Rustlang.Rustup" } else { "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y" }
        }
        "python" => if native { "winget install Python.Python.3.12" } else { "sudo apt install -y python3 python3-venv" },
        "uv" => {
            if native { "irm https://astral.sh/uv/install.ps1 | iex" } else { "curl -LsSf https://astral.sh/uv/install.sh | sh" }
        }
        "dotnet" => if native { "winget install Microsoft.DotNet.SDK.8" } else { "sudo apt install -y dotnet-sdk-8.0" },
        "flutter" => "https://docs.flutter.dev/get-started/install 참고 (SDK 압축 해제 후 PATH 추가)",
        "go" => if native { "winget install GoLang.Go" } else { "sudo apt install -y golang-go" },
        "java" => if native { "winget install EclipseAdoptium.Temurin.21.JDK" } else { "sudo apt install -y openjdk-21-jdk" },
        _ => return None,
    };
    Some(s.to_string())
}

/// In WSL the Windows PATH is usually appended, so `command -v npm` can resolve to the Windows node
/// distribution's sh script under /mnt/c. That is not a usable backend-side tool (the Windows
/// toolchain is tracked separately by `toolchain`), so treat it as missing.
pub fn is_windows_side_path(kind: BackendKind, path: &str) -> bool {
    let b = path.as_bytes();
    matches!(kind, BackendKind::Wsl) && path.starts_with("/mnt/") && b.len() > 6 && b[5].is_ascii_alphabetic() && b[6] == b'/'
}

fn first_line(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string()
}

/// Detect every known tool (path + version) on the backend, concurrently.
pub async fn detect_all(backend: Arc<dyn ExecBackend>) -> Vec<ToolStatus> {
    let futs = KNOWN_TOOLS.iter().map(|name| detect(backend.clone(), name, None));
    join_all(futs).await
}

/// Detect a single tool. `bin_override` is a path/name from settings.
pub async fn detect(backend: Arc<dyn ExecBackend>, name: &str, bin_override: Option<&str>) -> ToolStatus {
    let kind = backend.kind();
    let program = bin_override.filter(|b| !b.trim().is_empty()).map(|s| s.to_string()).unwrap_or_else(|| program_name(name, kind).to_string());
    let mut status = ToolStatus { name: name.to_string(), found: false, path: None, version: None, install_hint: install_hint(name, kind) };

    let path = match backend.which(&program).await {
        Some(p) if bin_override.is_none() && is_windows_side_path(kind, &p) => return status,
        Some(p) => p,
        None => {
            // An override may be an absolute path that `which` can't resolve; try it directly.
            if bin_override.is_some() { program.clone() } else { return status }
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
pub async fn auth_status(backend: Arc<dyn ExecBackend>, provider: Provider, bin_override: Option<&str>) -> Result<AuthStatus> {
    match provider {
        Provider::Claude => claude::auth_status(backend, bin_override).await,
        Provider::Codex => codex::auth_status(backend, bin_override).await,
    }
}

/// Models offered in the UI. Claude: static list + aliases; Codex: `model/list` via app-server.
pub async fn list_models(backend: Arc<dyn ExecBackend>, provider: Provider, bin_override: Option<&str>) -> Result<Vec<ModelInfo>> {
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
            assert!(install_hint(t, BackendKind::Native).is_some(), "{t}");
            assert!(install_hint(t, BackendKind::Wsl).is_some(), "{t}");
        }
    }

    #[test]
    fn windows_side_paths_are_not_linux_tools() {
        assert!(is_windows_side_path(BackendKind::Wsl, "/mnt/c/nvm4w/nodejs/npm"));
        assert!(!is_windows_side_path(BackendKind::Wsl, "/home/me/.local/bin/claude"));
        assert!(!is_windows_side_path(BackendKind::Wsl, "/mnt/wsl/x"));
        assert!(!is_windows_side_path(BackendKind::Native, "/mnt/c/x"));
    }

    #[test]
    fn first_line_skips_blank() {
        assert_eq!(first_line("\n\n git version 2.43.0\nmore"), "git version 2.43.0");
    }
}
