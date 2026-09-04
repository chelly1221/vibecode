//! Builds the `claude` command line for a session. Pure and unit-tested.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::backend::CommandSpec;
use crate::types::{McpServerConfig, McpTransport, PermissionPreset, Provider, SessionConfig};

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
    /// User-configured MCP servers (settings); only enabled ones targeting Claude are passed.
    pub mcp_servers: &'a [McpServerConfig],
}

/// `mcpServers` entries for `--mcp-config` in the shape Claude Code expects:
/// stdio `{command, args, env}` and http `{type:"http", url}`.
pub fn mcp_servers_json(servers: &[McpServerConfig]) -> Map<String, Value> {
    let mut map = Map::new();
    for s in servers.iter().filter(|s| s.enabled && (s.providers.is_empty() || s.providers.contains(&Provider::Claude))) {
        let name = s.name.trim();
        if name.is_empty() {
            continue;
        }
        let entry = match s.transport {
            McpTransport::Stdio => {
                let Some(cmd) = s.command.as_deref().map(str::trim).filter(|c| !c.is_empty()) else { continue };
                let env: Map<String, Value> = s.env.iter().filter(|e| !e.key.trim().is_empty()).map(|e| (e.key.trim().to_string(), Value::String(e.value.clone()))).collect();
                let mut v = json!({ "command": cmd, "args": s.args });
                if !env.is_empty() {
                    v["env"] = Value::Object(env);
                }
                v
            }
            McpTransport::Http => {
                let Some(url) = s.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) else { continue };
                json!({ "type": "http", "url": url })
            }
        };
        map.insert(name.to_string(), entry);
    }
    map
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
            "--forward-subagent-text",
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
    let mut mcp_servers = mcp_servers_json(plan.mcp_servers);
    match plan.transport {
        PermissionTransport::Stdio => {
            spec = spec.args(["--permission-prompt-tool", "stdio"]);
        }
        PermissionTransport::McpHttp => {
            let url = plan.mcp_url.expect("mcp_url required for McpHttp transport");
            mcp_servers.insert(crate::permission::SERVER_NAME.to_string(), json!({ "type": "http", "url": url }));
            spec = spec.args(["--permission-prompt-tool", &crate::permission::PermissionBroker::tool_ref()]);
        }
    }
    if !mcp_servers.is_empty() {
        let mcp = json!({ "mcpServers": Value::Object(mcp_servers) });
        spec = spec.args(["--mcp-config", &mcp.to_string()]);
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
        let spec = build_spec(&SpawnPlan { bin: "claude", config: &c, cwd: Path::new("C:\\p"), transport: PermissionTransport::Stdio, mcp_url: None, resume_ref: None, fork: false, mcp_servers: &[] });
        let a = spec.args.join(" ");
        assert!(a.starts_with("-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --forward-subagent-text"));
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
        let spec = build_spec(&SpawnPlan { bin: "claude", config: &c, cwd: Path::new("C:\\p"), transport: PermissionTransport::McpHttp, mcp_url: Some("http://127.0.0.1:1234/mcp/s1"), resume_ref: None, fork: true, mcp_servers: &[] });
        let a = spec.args.join(" ");
        assert!(a.contains("--permission-mode bypassPermissions --allow-dangerously-skip-permissions"));
        assert!(a.contains("--permission-prompt-tool mcp__vibecode__approve"));
        let mcp_idx = spec.args.iter().position(|x| x == "--mcp-config").unwrap();
        let v: serde_json::Value = serde_json::from_str(&spec.args[mcp_idx + 1]).unwrap();
        assert_eq!(v["mcpServers"]["vibecode"]["url"], "http://127.0.0.1:1234/mcp/s1");
        assert!(a.ends_with("--resume abc --fork-session"));
    }

    #[test]
    fn user_mcp_servers_are_passed_and_filtered() {
        use crate::types::{EnvVar, McpTransport};
        let servers = vec![
            McpServerConfig { id: "1".into(), name: "fs".into(), transport: McpTransport::Stdio, command: Some("npx".into()), args: vec!["-y".into(), "@modelcontextprotocol/server-filesystem".into()], env: vec![EnvVar { key: "ROOT".into(), value: "C:\\x".into() }], url: None, enabled: true, providers: vec![] },
            McpServerConfig { id: "2".into(), name: "remote".into(), transport: McpTransport::Http, command: None, args: vec![], env: vec![], url: Some("https://mcp.example.com/mcp".into()), enabled: true, providers: vec![Provider::Claude] },
            McpServerConfig { id: "3".into(), name: "codex-only".into(), transport: McpTransport::Http, command: None, args: vec![], env: vec![], url: Some("https://x".into()), enabled: true, providers: vec![Provider::Codex] },
            McpServerConfig { id: "4".into(), name: "off".into(), transport: McpTransport::Http, command: None, args: vec![], env: vec![], url: Some("https://y".into()), enabled: false, providers: vec![] },
        ];
        let c = cfg();
        let spec = build_spec(&SpawnPlan { bin: "claude", config: &c, cwd: Path::new("C:\\p"), transport: PermissionTransport::Stdio, mcp_url: None, resume_ref: None, fork: false, mcp_servers: &servers });
        let idx = spec.args.iter().position(|x| x == "--mcp-config").expect("mcp-config present");
        let v: Value = serde_json::from_str(&spec.args[idx + 1]).unwrap();
        let m = v["mcpServers"].as_object().unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m["fs"]["command"], "npx");
        assert_eq!(m["fs"]["args"][1], "@modelcontextprotocol/server-filesystem");
        assert_eq!(m["fs"]["env"]["ROOT"], "C:\\x");
        assert_eq!(m["remote"]["type"], "http");
        assert!(m.get("codex-only").is_none());
        assert!(m.get("off").is_none());
        // no servers → no --mcp-config in stdio mode
        let spec2 = build_spec(&SpawnPlan { bin: "claude", config: &c, cwd: Path::new("C:\\p"), transport: PermissionTransport::Stdio, mcp_url: None, resume_ref: None, fork: false, mcp_servers: &[] });
        assert!(!spec2.args.iter().any(|x| x == "--mcp-config"));
    }

    #[test]
    fn preset_modes() {
        assert_eq!(permission_mode(PermissionPreset::ReadOnly), "plan");
        assert_eq!(permission_mode(PermissionPreset::AutoEdit), "acceptEdits");
    }
}
