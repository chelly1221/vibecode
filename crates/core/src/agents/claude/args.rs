//! Builds the `claude` command line for a session. Pure and unit-tested.

use std::path::Path;

use serde_json::json;

use crate::backend::CommandSpec;
use crate::types::{PermissionPreset, SessionConfig};

/// How permission prompts reach the app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionTransport {
    /// `--permission-prompt-tool stdio`: the CLI sends `control_request can_use_tool` on stdout (what the official SDKs use).
    Stdio,
    /// `--permission-prompt-tool mcp__vibecode__approve` backed by the in-app HTTP MCP server.
    McpHttp,
}

impl PermissionTransport {
    pub fn from_env() -> Self {
        match std::env::var("VIBECODE_CLAUDE_PERMISSION_TRANSPORT").ok().as_deref() {
            Some("mcp-http") | Some("http") | Some("mcp") => PermissionTransport::McpHttp,
            _ => PermissionTransport::Stdio,
        }
    }
}

pub fn permission_mode(preset: PermissionPreset) -> &'static str {
    match preset {
        PermissionPreset::ReadOnly => "plan",
        PermissionPreset::AskEverything => "default",
        PermissionPreset::AutoEdit => "acceptEdits",
        PermissionPreset::FullAuto => "bypassPermissions",
    }
}

pub struct SpawnPlan<'a> {
    pub bin: &'a str,
    pub config: &'a SessionConfig,
    /// Project directory as a host path (the backend translates it).
    pub cwd: &'a Path,
    pub transport: PermissionTransport,
    /// MCP URL for the McpHttp transport.
    pub mcp_url: Option<&'a str>,
    /// Overrides `config.resume_ref` (used when restarting an already-running session).
    pub resume_ref: Option<&'a str>,
    pub fork: bool,
}

pub fn build_spec(plan: &SpawnPlan) -> CommandSpec {
    let cfg = plan.config;
    let mut spec = CommandSpec::new(plan.bin)
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--replay-user-messages",
        ])
        .cwd(plan.cwd)
        .report_pid(true);

    if let Some(model) = cfg.model.as_deref().filter(|m| !m.trim().is_empty()) {
        spec = spec.args(["--model", model.trim()]);
    }
    if let Some(effort) = cfg.effort {
        spec = spec.args(["--effort", effort.to_claude()]);
    }
    spec = spec.args(["--permission-mode", permission_mode(cfg.permission)]);
    if cfg.permission == PermissionPreset::FullAuto {
        // bypassPermissions must be explicitly enabled for -p sessions.
        spec = spec.arg("--allow-dangerously-skip-permissions");
    }
    // Prompts still happen in bypass mode for the handful of always-ask actions, so the
    // permission host is wired for every preset.
    spec = spec.args(["--permission-prompts", "host"]);
    match plan.transport {
        PermissionTransport::Stdio => {
            spec = spec.args(["--permission-prompt-tool", "stdio"]);
        }
        PermissionTransport::McpHttp => {
            let url = plan.mcp_url.expect("mcp_url required for McpHttp transport");
            let mcp = json!({ "mcpServers": { crate::permission::SERVER_NAME: { "type": "http", "url": url } } });
            spec = spec
                .args(["--mcp-config", &mcp.to_string()])
                .args(["--permission-prompt-tool", &crate::permission::PermissionBroker::tool_ref()]);
        }
    }
    if let Some(sp) = cfg.append_system_prompt.as_deref().filter(|s| !s.trim().is_empty()) {
        spec = spec.args(["--append-system-prompt", sp]);
    }
    let resume = plan.resume_ref.or(cfg.resume_ref.as_deref()).filter(|r| !r.trim().is_empty());
    if let Some(r) = resume {
        spec = spec.args(["--resume", r]);
        if plan.fork {
            spec = spec.arg("--fork-session");
        }
    }
    spec
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Effort, Provider};

    fn cfg() -> SessionConfig {
        SessionConfig {
            project_id: "p".into(),
            provider: Provider::Claude,
            model: Some("sonnet".into()),
            effort: Some(Effort::XHigh),
            permission: PermissionPreset::AskEverything,
            append_system_prompt: None,
            resume_ref: None,
            fork: false,
        }
    }

    #[test]
    fn stdio_flags() {
        let c = cfg();
        let spec = build_spec(&SpawnPlan { bin: "claude", config: &c, cwd: Path::new("C:\\p"), transport: PermissionTransport::Stdio, mcp_url: None, resume_ref: None, fork: false });
        let a = spec.args.join(" ");
        assert!(a.starts_with("-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages"));
        assert!(a.contains("--model sonnet"));
        assert!(a.contains("--effort xhigh"));
        assert!(a.contains("--permission-mode default"));
        assert!(a.contains("--permission-prompts host --permission-prompt-tool stdio"));
        assert!(!a.contains("--resume"));
        assert!(!a.contains("--bare"));
        assert!(spec.report_pid);
        assert_eq!(spec.cwd.as_deref(), Some(Path::new("C:\\p")));
    }

    #[test]
    fn mcp_http_and_resume_and_bypass() {
        let mut c = cfg();
        c.permission = PermissionPreset::FullAuto;
        c.resume_ref = Some("abc".into());
        let spec = build_spec(&SpawnPlan { bin: "claude", config: &c, cwd: Path::new("C:\\p"), transport: PermissionTransport::McpHttp, mcp_url: Some("http://127.0.0.1:1234/mcp/s1"), resume_ref: None, fork: true });
        let a = spec.args.join(" ");
        assert!(a.contains("--permission-mode bypassPermissions --allow-dangerously-skip-permissions"));
        assert!(a.contains("--permission-prompt-tool mcp__vibecode__approve"));
        let mcp_idx = spec.args.iter().position(|x| x == "--mcp-config").unwrap();
        let v: serde_json::Value = serde_json::from_str(&spec.args[mcp_idx + 1]).unwrap();
        assert_eq!(v["mcpServers"]["vibecode"]["url"], "http://127.0.0.1:1234/mcp/s1");
        assert!(a.ends_with("--resume abc --fork-session"));
    }

    #[test]
    fn preset_modes() {
        assert_eq!(permission_mode(PermissionPreset::ReadOnly), "plan");
        assert_eq!(permission_mode(PermissionPreset::AutoEdit), "acceptEdits");
    }
}
