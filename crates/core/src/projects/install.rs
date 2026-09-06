//! Automatic installation of what a new project needs, run before scaffolding: Windows toolchains
//! with winget on the host (agent in WSL, output a Windows program) and backend-side prerequisites
//! with their install hints (apt / `curl | sh` in WSL, winget natively). Progress is streamed as
//! `ScaffoldEvent::Install` so the wizard can draw a progress bar. Nothing here aborts the creation:
//! a failed or skipped install is reported and the project is still created.

use std::sync::Arc;

use futures::future::join_all;
use tokio::sync::mpsc::UnboundedSender;

use crate::backend::ExecBackend;
use crate::toolchain;
use crate::tools;
use crate::types::{InstallKind, InstallStatus, ScaffoldEvent, StackInfo, TargetOs, ToolStatus, WindowsToolStatus};

/// One thing to install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallItem {
    pub name: String,
    pub label: String,
    pub kind: InstallKind,
    /// Command that installs it (winget line or backend hint). None = manual download only.
    pub command: Option<String>,
}

/// Outcome of the whole pass (tool names per bucket).
#[derive(Debug, Default, Clone)]
pub struct InstallSummary {
    pub total: usize,
    pub done: Vec<String>,
    pub failed: Vec<String>,
    pub skipped: Vec<String>,
}

/// Human label for a backend tool name.
pub fn tool_label(name: &str) -> String {
    match name {
        "node" => "Node.js",
        "npm" => "npm",
        "cargo" => "Rust (cargo)",
        "rustup" => "rustup",
        "python" => "Python 3",
        "uv" => "uv (Python 패키지 관리자)",
        "dotnet" => ".NET SDK",
        "flutter" => "Flutter SDK",
        "go" => "Go",
        "java" => "JDK",
        "git" => "Git",
        "gh" => "GitHub CLI",
        "claude" => "Claude Code",
        "codex" => "Codex CLI",
        other => other,
    }
    .to_string()
}

/// What is missing for `stack`: Windows toolchains first (in the stack's order), then the backend
/// prerequisites they do not cover. Two tools sharing one install command (node/npm, cargo/rustup)
/// yield a single item. Pure: works on detection results.
pub fn plan(stack: Option<&StackInfo>, applies: bool, windows: &[WindowsToolStatus], backend_tools: &[ToolStatus]) -> Vec<InstallItem> {
    let Some(stack) = stack else { return vec![] };
    let mut items: Vec<InstallItem> = Vec::new();
    if applies {
        for name in &stack.windows_toolchain {
            if let Some(w) = windows.iter().find(|w| &w.name == name && !w.found) {
                items.push(InstallItem {
                    name: w.name.clone(),
                    label: w.label.clone(),
                    kind: InstallKind::WindowsToolchain,
                    command: toolchain::get(name).map(toolchain::winget_command),
                });
            }
        }
    }
    let required: Vec<&str> = if applies { toolchain::uncovered_prerequisites(stack) } else { stack.prerequisites.iter().map(String::as_str).collect() };
    for name in required {
        let Some(t) = backend_tools.iter().find(|t| t.name == name && !t.found) else { continue };
        if t.install_hint.is_some() && items.iter().any(|i| i.kind == InstallKind::BackendTool && i.command == t.install_hint) {
            continue;
        }
        items.push(InstallItem { name: t.name.clone(), label: tool_label(&t.name), kind: InstallKind::BackendTool, command: t.install_hint.clone() });
    }
    items
}

struct Events<'a>(&'a UnboundedSender<ScaffoldEvent>);

impl Events<'_> {
    fn log(&self, line: impl Into<String>, is_err: bool) {
        let _ = self.0.send(ScaffoldEvent::Log { line: line.into(), is_err });
    }
    fn install(&self, item: &InstallItem, index: usize, total: usize, status: InstallStatus, message: Option<String>) {
        let _ = self.0.send(ScaffoldEvent::Install {
            name: item.name.clone(),
            label: item.label.clone(),
            kind: item.kind,
            index: index as u32,
            total: total as u32,
            status,
            message,
            command: item.command.clone(),
        });
    }
}

/// Detect what `stack` needs on this backend, install what is missing and report each step.
pub async fn install_missing(backend: Arc<dyn ExecBackend>, stack: Option<&StackInfo>, target: TargetOs, events: &UnboundedSender<ScaffoldEvent>) -> InstallSummary {
    let Some(stack_ref) = stack else { return InstallSummary::default() };
    let applies = toolchain::applies(backend.kind(), Some(target), stack);
    let win_names: Vec<String> = if applies { stack_ref.windows_toolchain.clone() } else { vec![] };
    let required: Vec<String> = if applies { toolchain::uncovered_prerequisites(stack_ref).into_iter().map(String::from).collect() } else { stack_ref.prerequisites.clone() };
    let (windows, backend_tools) = tokio::join!(
        async { if win_names.is_empty() { vec![] } else { toolchain::detect(&win_names).await } },
        join_all(required.iter().map(|n| tools::detect(backend.clone(), n, None))),
    );
    let items = plan(stack, applies, &windows, &backend_tools);
    let total = items.len();
    let mut summary = InstallSummary { total, ..Default::default() };
    if total == 0 {
        return summary;
    }
    let ev = Events(events);
    ev.log(format!("설치할 도구 {}개: {}", total, items.iter().map(|i| i.label.as_str()).collect::<Vec<_>>().join(", ")), false);
    if items.iter().any(|i| i.kind == InstallKind::WindowsToolchain) {
        ev.log("Windows 설치 프로그램이 관리자 권한을 요청하는 창을 띄우면 허용하세요.", false);
    }
    let needs_sudo = items.iter().any(|i| i.kind == InstallKind::BackendTool && i.command.as_deref().is_some_and(|c| c.contains("sudo")));
    let sudo_ok = if needs_sudo { tools::sudo_available(&backend).await } else { true };

    for (i, item) in items.iter().enumerate() {
        let index = i + 1;
        ev.install(item, index, total, InstallStatus::Running, None);
        let (status, message) = match item.kind {
            InstallKind::WindowsToolchain => install_windows(item, &ev).await,
            InstallKind::BackendTool => install_backend(&backend, item, sudo_ok, &ev).await,
        };
        match status {
            InstallStatus::Done => summary.done.push(item.label.clone()),
            InstallStatus::Failed => summary.failed.push(item.label.clone()),
            InstallStatus::Skipped => summary.skipped.push(item.label.clone()),
            InstallStatus::Running => {}
        }
        ev.install(item, index, total, status, message);
    }
    summary
}

async fn install_windows(item: &InstallItem, ev: &Events<'_>) -> (InstallStatus, Option<String>) {
    let Some(tool) = toolchain::get(&item.name) else {
        return (InstallStatus::Skipped, Some("알 수 없는 툴체인입니다.".into()));
    };
    ev.log(format!("$ {}", toolchain::winget_command(tool)), false);
    let code = toolchain::install_one(tool, |l, e| ev.log(l, e)).await;
    let after = toolchain::detect_one(tool).await;
    match code {
        Ok(_) if after.found => (InstallStatus::Done, Some(after.version.clone().or_else(|| after.path.clone()).unwrap_or_else(|| "설치됨".into()))),
        Ok(c) if toolchain::install_exit_ok(c) => (InstallStatus::Done, Some("설치됨 (경로는 앱을 다시 시작하면 반영됩니다)".into())),
        Ok(c) => (InstallStatus::Failed, Some(format!("winget 종료 코드 {}. 관리자 권한 창을 취소했거나 네트워크 문제일 수 있습니다.", c.map(|c| c.to_string()).unwrap_or_else(|| "?".into())))),
        Err(e) => (InstallStatus::Failed, Some(e.to_string())),
    }
}

async fn install_backend(backend: &Arc<dyn ExecBackend>, item: &InstallItem, sudo_ok: bool, ev: &Events<'_>) -> (InstallStatus, Option<String>) {
    let Some(cmd) = item.command.as_deref().filter(|c| tools::runnable_hint(c)) else {
        let hint = item.command.as_deref().map(|h| format!(" ({h})")).unwrap_or_default();
        return (InstallStatus::Skipped, Some(format!("자동 설치 방법이 없어 직접 설치해야 합니다{hint}")));
    };
    if cmd.contains("sudo") && !sudo_ok {
        return (InstallStatus::Skipped, Some("sudo 비밀번호가 필요해 자동으로 설치할 수 없습니다. 터미널에서 설치하세요.".into()));
    }
    ev.log(format!("$ {cmd}"), false);
    let code = tools::install(backend, cmd, |l, e| ev.log(l, e)).await;
    let after = tools::detect(backend.clone(), &item.name, None).await;
    match code {
        Ok(_) if after.found => (InstallStatus::Done, Some(after.version.clone().or_else(|| after.path.clone()).unwrap_or_else(|| "설치됨".into()))),
        Ok(Some(0)) => (InstallStatus::Done, Some("설치됨 (새 셸에서 PATH가 반영됩니다)".into())),
        Ok(c) => (InstallStatus::Failed, Some(format!("종료 코드 {}", c.map(|c| c.to_string()).unwrap_or_else(|| "?".into())))),
        Err(e) => (InstallStatus::Failed, Some(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::catalog;

    fn win(name: &str, found: bool) -> WindowsToolStatus {
        let t = toolchain::get(name).unwrap();
        WindowsToolStatus { name: name.into(), label: t.label.into(), found, path: None, version: None, winget_id: t.winget_id.into(), shims: vec![] }
    }

    fn tool(name: &str, found: bool, hint: Option<&str>) -> ToolStatus {
        ToolStatus { name: name.into(), found, path: None, version: None, install_hint: hint.map(String::from) }
    }

    #[test]
    fn windows_toolchain_replaces_covered_backend_tools() {
        let tauri = catalog::get("tauri-react").unwrap().unwrap();
        let windows = vec![win("node", true), win("rust", false), win("msvc", false)];
        let backend = vec![tool("node", false, Some("apt node")), tool("cargo", false, Some("curl rustup"))];
        let items = plan(Some(&tauri), true, &windows, &backend);
        assert_eq!(items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["rust", "msvc"]);
        assert!(items.iter().all(|i| i.kind == InstallKind::WindowsToolchain));
        assert!(items[0].command.as_deref().unwrap().contains("Rustlang.Rustup"));
    }

    #[test]
    fn backend_tools_dedupe_shared_hints() {
        let vite = catalog::get("vite-react").unwrap().unwrap();
        let hint = "curl nodesource | sudo -E bash - && sudo apt install -y nodejs";
        let backend = vec![tool("node", false, Some(hint)), tool("npm", false, Some(hint))];
        let items = plan(Some(&vite), false, &[], &backend);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "node");
        assert_eq!(items[0].label, "Node.js");
        assert_eq!(items[0].kind, InstallKind::BackendTool);
        assert_eq!(items[0].command.as_deref(), Some(hint));

        let uv = catalog::get("python-uv").unwrap().unwrap();
        let backend = vec![tool("uv", false, Some("curl uv | sh")), tool("python", true, None)];
        let items = plan(Some(&uv), false, &[], &backend);
        assert_eq!(items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["uv"]);
        assert!(plan(None, false, &[], &backend).is_empty());
    }
}
