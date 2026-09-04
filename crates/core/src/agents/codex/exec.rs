//! `codex exec --json` one-shot runner (no app-server). Used for sessionless tasks
//! such as commit message generation.
//!
//! JSONL events (codex-rs/exec/src/exec_events.rs): `thread.started {thread_id}`,
//! `turn.started`, `item.started|item.updated|item.completed {item{id,type,..}}`,
//! `turn.completed {usage}`, `turn.failed {error{message}}`, `error {message}`.
//! Item `type` values are snake_case: agent_message {text}, reasoning, command_execution,
//! file_change, mcp_tool_call, web_search, todo_list, error {message}.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;

use crate::backend::{process, CommandSpec, ExecBackend};
use crate::error::{CoreError, Result};

/// Run `codex exec --json` in `repo` with `prompt` on stdin and return the final agent message.
pub async fn run_exec(backend: Arc<dyn ExecBackend>, bin: Option<String>, repo: &Path, prompt: &str, model: Option<&str>) -> Result<String> {
    let mut spec = CommandSpec::new(bin.unwrap_or_else(|| "codex".into()))
        .args(["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--color", "never"])
        .arg("-C")
        .arg(backend.to_backend_path(repo));
    if let Some(m) = model {
        spec = spec.arg("-m").arg(m);
    }
    // `-` = read the prompt from stdin (avoids command-line length limits through wsl.exe).
    spec = spec.arg("-");
    let mut cmd = backend.command(&spec);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = process::spawn_tracked(&mut cmd)?;
    if let Some(mut stdin) = child.stdin.take() {
        let data = prompt.as_bytes().to_vec();
        tokio::spawn(async move {
            let _ = stdin.write_all(&data).await;
            let _ = stdin.shutdown().await;
        });
    }
    let out = tokio::time::timeout(Duration::from_secs(240), child.wait_with_output())
        .await
        .map_err(|_| CoreError::Agent("codex exec timed out".into()))??;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    parse_exec_output(&stdout, &stderr, out.status.code())
}

/// Extract the last `agent_message` from the JSONL stream, or a meaningful error.
pub fn parse_exec_output(stdout: &str, stderr: &str, code: Option<i32>) -> Result<String> {
    let mut last_text: Option<String> = None;
    let mut failure: Option<String> = None;
    let mut saw_json = false;
    for line in stdout.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        saw_json = true;
        match v.get("type").and_then(|t| t.as_str()) {
            Some("item.completed") | Some("item.updated") => {
                if let Some(item) = v.get("item") {
                    if item.get("type").and_then(|t| t.as_str()) == Some("agent_message") {
                        if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                            last_text = Some(t.to_string());
                        }
                    }
                }
            }
            Some("turn.failed") => {
                failure = v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()).map(|s| s.to_string()).or(Some("turn failed".into()));
            }
            Some("error") => {
                if failure.is_none() {
                    failure = v.get("message").and_then(|m| m.as_str()).map(|s| s.to_string());
                }
            }
            _ => {}
        }
    }
    if let Some(t) = last_text {
        return Ok(t.trim().to_string());
    }
    if let Some(msg) = failure {
        return Err(auth_hint(CoreError::Agent(format!("codex exec failed: {msg}")), &msg));
    }
    if !saw_json && !stdout.trim().is_empty() && code == Some(0) {
        return Ok(stdout.trim().to_string());
    }
    let detail = if stderr.trim().is_empty() { stdout.trim().to_string() } else { stderr.trim().to_string() };
    let detail: String = detail.chars().take(800).collect();
    Err(auth_hint(CoreError::Agent(format!("codex exec produced no result (exit {code:?}): {detail}")), &detail))
}

fn auth_hint(err: CoreError, text: &str) -> CoreError {
    if text.contains("401") || text.to_ascii_lowercase().contains("unauthorized") {
        CoreError::Agent(format!("Codex is not logged in (run `codex login` in the backend). {err}"))
    } else {
        err
    }
}

/// Remove a wrapping ``` fence if the model added one anyway.
pub fn strip_code_fence(text: &str) -> String {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("```") {
        if let Some(end) = rest.rfind("```") {
            let inner = &rest[..end];
            let inner = inner.split_once('\n').map(|(_, b)| b).unwrap_or(inner);
            return inner.trim().to_string();
        }
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_last_agent_message() {
        let out = r#"{"type":"thread.started","thread_id":"t"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking"}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"feat(core): add codex adapter\n"}}
{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}
"#;
        assert_eq!(parse_exec_output(out, "", Some(0)).unwrap(), "feat(core): add codex adapter");
    }

    #[test]
    fn reports_auth_failure() {
        let out = r#"{"type":"thread.started","thread_id":"t"}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized)"}
{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer"}}
"#;
        let err = parse_exec_output(out, "", Some(1)).unwrap_err().to_string();
        assert!(err.contains("codex login"), "{err}");
    }

    #[test]
    fn plain_text_fallback_and_fence_strip() {
        assert_eq!(parse_exec_output("just text\n", "", Some(0)).unwrap(), "just text");
        assert_eq!(strip_code_fence("```\nfix: x\n```"), "fix: x");
        assert_eq!(strip_code_fence("```text\nfix: y\n\nbody\n```"), "fix: y\n\nbody");
        assert_eq!(strip_code_fence("fix: z"), "fix: z");
    }
}
