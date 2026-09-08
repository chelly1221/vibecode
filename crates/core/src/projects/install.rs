//! Automatic installation of what a new project needs, run before scaffolding: every stack
//! prerequisite that is missing is installed with its hint (winget, `irm … | iex`, npm) in
//! PowerShell. Progress is streamed as `ScaffoldEvent::Install` so the wizard can draw a progress
//! bar. Nothing here aborts the creation: a failed or skipped install is reported and the project
//! is still created.

use std::sync::Arc;

use futures::future::join_all;
use tokio::sync::mpsc::UnboundedSender;

use crate::backend::ExecBackend;
use crate::tools;
use crate::types::{InstallStatus, ScaffoldEvent, StackInfo, ToolStatus};

/// One thing to install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallItem {
    pub name: String,
    pub label: String,
    /// Command that installs it. None = manual download only.
    pub command: Option<String>,
}

/// Outcome of the whole pass (tool labels per bucket).
#[derive(Debug, Default, Clone)]
pub struct InstallSummary {
    pub total: usize,
    pub done: Vec<String>,
    pub failed: Vec<String>,
    pub skipped: Vec<String>,
}

/// What is missing for `stack`, in the stack's prerequisite order. Two tools sharing one install
/// command (node/npm, cargo/rustup) yield a single item. Pure: works on detection results.
pub fn plan(stack: Option<&StackInfo>, detected: &[ToolStatus]) -> Vec<InstallItem> {
    let Some(stack) = stack else { return vec![] };
    let mut items: Vec<InstallItem> = Vec::new();
    for name in &stack.prerequisites {
        let Some(t) = detected.iter().find(|t| &t.name == name && !t.found) else { continue };
        if t.install_hint.is_some() && items.iter().any(|i| i.command == t.install_hint) {
            continue;
        }
        items.push(InstallItem { name: t.name.clone(), label: tools::label(&t.name), command: t.install_hint.clone() });
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
            index: index as u32,
            total: total as u32,
            status,
            message,
            command: item.command.clone(),
        });
    }
}

/// Detect what `stack` needs, install what is missing and report each step.
pub async fn install_missing(backend: Arc<ExecBackend>, stack: Option<&StackInfo>, events: &UnboundedSender<ScaffoldEvent>) -> InstallSummary {
    let Some(stack_ref) = stack else { return InstallSummary::default() };
    let detected = join_all(stack_ref.prerequisites.iter().map(|n| tools::detect(backend.clone(), n, None))).await;
    let items = plan(stack, &detected);
    let total = items.len();
    let mut summary = InstallSummary { total, ..Default::default() };
    if total == 0 {
        return summary;
    }
    let ev = Events(events);
    ev.log(format!("설치할 도구 {}개: {}", total, items.iter().map(|i| i.label.as_str()).collect::<Vec<_>>().join(", ")), false);
    ev.log("설치 프로그램이 관리자 권한을 요청하는 창을 띄우면 허용하세요.", false);

    for (i, item) in items.iter().enumerate() {
        let index = i + 1;
        ev.install(item, index, total, InstallStatus::Running, None);
        let (status, message) = install_one(&backend, item, &ev).await;
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

async fn install_one(backend: &Arc<ExecBackend>, item: &InstallItem, ev: &Events<'_>) -> (InstallStatus, Option<String>) {
    let Some(cmd) = item.command.as_deref().filter(|c| tools::runnable_hint(c)) else {
        let hint = item.command.as_deref().map(|h| format!(" ({h})")).unwrap_or_default();
        return (InstallStatus::Skipped, Some(format!("자동 설치 방법이 없어 직접 설치해야 합니다{hint}")));
    };
    ev.log(format!("$ {cmd}"), false);
    let code = tools::install(backend, cmd, |l, e| ev.log(l, e)).await;
    let after = tools::detect(backend.clone(), &item.name, None).await;
    match code {
        Ok(_) if after.found => (InstallStatus::Done, Some(after.version.clone().or_else(|| after.path.clone()).unwrap_or_else(|| "설치됨".into()))),
        // 0 = ok, 3010 = Windows Installer "reboot required": installed, PATH not visible to this process yet.
        Ok(Some(0)) | Ok(Some(3010)) => (InstallStatus::Done, Some("설치됨 (경로는 앱을 다시 시작하면 반영됩니다)".into())),
        Ok(c) => (InstallStatus::Failed, Some(format!("종료 코드 {}. 관리자 권한 창을 취소했거나 네트워크 문제일 수 있습니다.", c.map(|c| c.to_string()).unwrap_or_else(|| "?".into())))),
        Err(e) => (InstallStatus::Failed, Some(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::catalog;

    fn tool(name: &str, found: bool, hint: Option<&str>) -> ToolStatus {
        ToolStatus { name: name.into(), found, path: None, version: None, install_hint: hint.map(String::from) }
    }

    #[test]
    fn lists_missing_prerequisites_once_per_command() {
        let vite = catalog::get("vite-react").unwrap().unwrap();
        let hint = "winget install OpenJS.NodeJS.LTS";
        let detected = vec![tool("node", false, Some(hint)), tool("npm", false, Some(hint))];
        let items = plan(Some(&vite), &detected);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "node");
        assert_eq!(items[0].label, "Node.js");
        assert_eq!(items[0].command.as_deref(), Some(hint));

        let tauri = catalog::get("tauri-react").unwrap().unwrap();
        let detected = vec![tool("node", true, None), tool("npm", true, None), tool("cargo", false, Some("winget install Rustlang.Rustup")), tool("rustup", false, Some("winget install Rustlang.Rustup")), tool("msvc", false, Some("winget install Microsoft.VisualStudio.2022.BuildTools"))];
        let items = plan(Some(&tauri), &detected);
        assert_eq!(items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["cargo", "msvc"]);
        assert!(plan(None, &detected).is_empty());
    }
}
