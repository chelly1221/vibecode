//! Claude Code adapter: one `claude -p --input-format stream-json --output-format stream-json`
//! process per session, driven over stdin/stdout. Verified against CLI 2.1.260:
//! - user turns: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":...}]}}`
//! - control protocol (both directions): `control_request` / `control_response` with
//!   `interrupt`, `set_permission_mode`, `set_model` (ours) and `can_use_tool` (theirs).
//! See `docs/PLAN.md` 3.1 and the fixtures in `tests/fixtures/`.

pub mod args;
pub mod parser;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

use super::{AgentSession, EventSender, StartArgs};
use crate::backend::{process::spawn_tracked, CommandSpec, ExecBackend};
use crate::error::{CoreError, Result};
use crate::permission::{PermissionAsk, PermissionBroker};
use crate::types::{McpServerConfig, PermissionReply, Provider, QuestionAnswer, SessionConfig, SessionConfigPatch, SessionEvent};
use args::{PermissionTransport, SpawnPlan};
use parser::{Parsed, Parser};

const CONTROL_TIMEOUT: Duration = Duration::from_secs(8);
const CLOSE_GRACE: Duration = Duration::from_secs(5);

/// Live process handles; replaced on respawn.
#[derive(Default)]
struct ProcState {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    external_ref: Option<String>,
    model: Option<String>,
    capabilities: Vec<String>,
    init_seen: bool,
    exited: bool,
    generation: u64,
    stderr_tail: VecDeque<String>,
}

struct Inner {
    session_id: String,
    cwd: PathBuf,
    backend: Arc<ExecBackend>,
    bin: String,
    events: EventSender,
    broker: Arc<PermissionBroker>,
    transport: PermissionTransport,
    mcp_servers: Vec<McpServerConfig>,
    config: Mutex<SessionConfig>,
    proc: Mutex<ProcState>,
    pending_ctl: StdMutex<HashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>,
    ctl_counter: AtomicU64,
    turn_active: AtomicBool,
    closed: AtomicBool,
}

pub struct ClaudeSession {
    inner: Arc<Inner>,
}

impl ClaudeSession {
    pub async fn start(args: StartArgs, broker: Arc<PermissionBroker>) -> Result<Arc<dyn AgentSession>> {
        let transport = PermissionTransport::from_env();
        let bin = args.bin.clone().filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "claude".to_string());
        let inner = Arc::new(Inner {
            session_id: args.session_id.clone(),
            cwd: args.cwd.clone(),
            backend: args.backend.clone(),
            bin,
            events: args.events.clone(),
            broker: broker.clone(),
            transport,
            mcp_servers: args.mcp_servers.clone(),
            config: Mutex::new(args.config.clone()),
            proc: Mutex::new(ProcState::default()),
            pending_ctl: StdMutex::new(HashMap::new()),
            ctl_counter: AtomicU64::new(0),
            turn_active: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        });
        broker.register(&args.session_id, args.events.clone());
        let resume = args.config.resume_ref.clone();
        Inner::spawn(inner.clone(), resume.as_deref(), args.config.fork).await?;
        Ok(Arc::new(ClaudeSession { inner }))
    }

    pub fn external_ref_blocking(&self) -> Option<String> {
        self.inner.proc.try_lock().ok().and_then(|p| p.external_ref.clone())
    }
}

impl Inner {
    /// Spawn (or respawn) the CLI. On respawn the previous process must already be gone.
    async fn spawn(self: Arc<Self>, resume_ref: Option<&str>, fork: bool) -> Result<()> {
        let config = self.config.lock().await.clone();
        let mcp_url = self.broker.mcp_url(&self.session_id);
        let spec: CommandSpec = args::build_spec(&SpawnPlan {
            bin: &self.bin,
            config: &config,
            cwd: &self.cwd,
            transport: self.transport,
            mcp_url: Some(&mcp_url),
            resume_ref,
            fork,
            mcp_servers: &self.mcp_servers,
        });
        tracing::info!(session = %self.session_id, "spawning claude: {} {}", spec.program, spec.args.join(" "));
        let mut cmd = self.backend.command(&spec);
        cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        let mut child = spawn_tracked(&mut cmd)?;
        let stdout = child.stdout.take().ok_or_else(|| CoreError::Agent("no stdout".into()))?;
        let stderr = child.stderr.take().ok_or_else(|| CoreError::Agent("no stderr".into()))?;
        let stdin = child.stdin.take().ok_or_else(|| CoreError::Agent("no stdin".into()))?;
        let generation = {
            let mut p = self.proc.lock().await;
            p.generation += 1;
            p.child = Some(child);
            p.stdin = Some(stdin);
            p.exited = false;
            p.capabilities.clear();
            p.generation
        };
        // stderr: diagnostics
        let me = self.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                tracing::debug!(session = %me.session_id, "claude stderr: {line}");
                let mut p = me.proc.lock().await;
                if p.stderr_tail.len() >= 20 {
                    p.stderr_tail.pop_front();
                }
                p.stderr_tail.push_back(line);
            }
        });
        // stdout: NDJSON → events
        let me = self.clone();
        tokio::spawn(async move {
            let mut parser = Parser::new();
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        for parsed in parser.parse_line(&line) {
                            me.clone().handle_parsed(parsed).await;
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        tracing::warn!(session = %me.session_id, "stdout read error: {e}");
                        break;
                    }
                }
            }
            me.on_process_end(generation).await;
        });
        Ok(())
    }

    async fn handle_parsed(self: Arc<Self>, parsed: Parsed) {
        match parsed {
            Parsed::Event(ev) => {
                if matches!(ev, SessionEvent::TurnEnd { .. }) {
                    self.turn_active.store(false, Ordering::SeqCst);
                }
                let _ = self.events.send(ev);
            }
            Parsed::Init { session_id, model, tools, capabilities, .. } => {
                let mut p = self.proc.lock().await;
                let first = !p.init_seen;
                let model_changed = p.model.as_deref().map(|m| m != model).unwrap_or(false);
                p.init_seen = true;
                p.external_ref = Some(session_id.clone());
                p.model = Some(model.clone());
                p.capabilities = capabilities;
                drop(p);
                if first {
                    let _ = self.events.send(SessionEvent::Init { provider: Provider::Claude, model, external_ref: session_id, tools });
                } else if model_changed {
                    let _ = self.events.send(SessionEvent::Status { message: format!("모델: {model}") });
                }
            }
            Parsed::ControlRequest { request_id, request } => {
                let subtype = request.get("subtype").and_then(Value::as_str).unwrap_or("").to_string();
                match subtype.as_str() {
                    "can_use_tool" => {
                        let me = self.clone();
                        tokio::spawn(async move {
                            let ask = PermissionAsk::from_request(&me.session_id, &request);
                            let outcome = me.broker.ask(ask).await;
                            let resp = json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": outcome.result } });
                            if let Err(e) = me.write_line(&resp.to_string()).await {
                                tracing::warn!("failed to answer permission request: {e}");
                            }
                        });
                    }
                    other => {
                        // hook_callback / mcp_message are SDK-only features we don't register for.
                        let resp = json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": format!("unsupported control request: {other}") } });
                        let _ = self.write_line(&resp.to_string()).await;
                    }
                }
            }
            Parsed::ControlResponse { request_id, success, response, error } => {
                let tx = self.pending_ctl.lock().unwrap().remove(&request_id);
                if let Some(tx) = tx {
                    let _ = tx.send(if success { Ok(response) } else { Err(error.unwrap_or_else(|| "control request failed".into())) });
                }
            }
            Parsed::NotJson(line) => tracing::debug!(session = %self.session_id, "claude stdout (non-JSON): {line}"),
            Parsed::Ignore => {}
        }
    }

    async fn on_process_end(self: Arc<Self>, generation: u64) {
        let mut p = self.proc.lock().await;
        if p.generation != generation {
            return; // a respawn already replaced this process
        }
        let code = match p.child.as_mut() {
            Some(child) => tokio::time::timeout(CLOSE_GRACE, child.wait()).await.ok().and_then(|r| r.ok()).and_then(|s| s.code()),
            None => None,
        };
        p.child = None;
        p.stdin = None;
        p.exited = true;
        let init_seen = p.init_seen;
        let tail: Vec<String> = p.stderr_tail.iter().cloned().collect();
        drop(p);
        self.turn_active.store(false, Ordering::SeqCst);
        // Fail any pending control requests.
        for (_, tx) in self.pending_ctl.lock().unwrap().drain() {
            let _ = tx.send(Err("process exited".into()));
        }
        if !self.closed.load(Ordering::SeqCst) {
            if !init_seen || code.map(|c| c != 0).unwrap_or(false) {
                let detail = tail.iter().rev().take(5).cloned().collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
                let msg = if detail.trim().is_empty() {
                    format!("Claude 프로세스가 종료되었습니다 (code {code:?})")
                } else {
                    format!("Claude 프로세스가 종료되었습니다 (code {code:?}):\n{detail}")
                };
                let _ = self.events.send(SessionEvent::Error { message: msg, fatal: true });
            }
        }
        self.broker.unregister(&self.session_id);
        let _ = self.events.send(SessionEvent::Exited { code });
    }

    async fn write_line(&self, line: &str) -> Result<()> {
        let mut p = self.proc.lock().await;
        let stdin = p.stdin.as_mut().ok_or_else(|| CoreError::Agent("Claude 프로세스가 실행 중이 아닙니다".into()))?;
        stdin.write_all(line.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    async fn send_control(&self, request: Value) -> Result<Value> {
        let n = self.ctl_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let request_id = format!("req_{n}_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let (tx, rx) = oneshot::channel();
        self.pending_ctl.lock().unwrap().insert(request_id.clone(), tx);
        let msg = json!({ "type": "control_request", "request_id": request_id, "request": request });
        if let Err(e) = self.write_line(&msg.to_string()).await {
            self.pending_ctl.lock().unwrap().remove(&request_id);
            return Err(e);
        }
        match tokio::time::timeout(CONTROL_TIMEOUT, rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(CoreError::Agent(e)),
            Ok(Err(_)) => Err(CoreError::Agent("control channel closed".into())),
            Err(_) => {
                self.pending_ctl.lock().unwrap().remove(&request_id);
                Err(CoreError::Agent("control request timed out".into()))
            }
        }
    }

    /// Gracefully stop the current process (EOF → wait → kill) without emitting Exited
    /// for the caller's generation; used by respawn and close.
    async fn stop_process(&self) -> Option<i32> {
        let (child, generation) = {
            let mut p = self.proc.lock().await;
            p.stdin = None; // EOF
            p.generation += 1; // detach the reader's on_process_end
            (p.child.take(), p.generation)
        };
        let _ = generation;
        let Some(mut child) = child else { return None };
        match tokio::time::timeout(CLOSE_GRACE, child.wait()).await {
            Ok(Ok(status)) => status.code(),
            _ => {
                let _ = child.kill().await;
                child.wait().await.ok().and_then(|s| s.code())
            }
        }
    }

    async fn respawn(self: Arc<Self>) -> Result<()> {
        let resume = self.proc.lock().await.external_ref.clone();
        let _ = self.stop_process().await;
        {
            let mut p = self.proc.lock().await;
            p.exited = false;
        }
        self.turn_active.store(false, Ordering::SeqCst);
        let _ = self.events.send(SessionEvent::Status { message: "세션을 다시 시작합니다".into() });
        self.spawn(resume.as_deref(), false).await
    }
}

#[async_trait]
impl AgentSession for ClaudeSession {
    fn provider(&self) -> Provider {
        Provider::Claude
    }

    fn external_ref(&self) -> Option<String> {
        self.external_ref_blocking()
    }

    async fn send(&self, text: String) -> Result<()> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(CoreError::Agent("세션이 종료되었습니다".into()));
        }
        if self.inner.proc.lock().await.exited {
            self.inner.clone().respawn().await?;
        }
        let msg = json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } });
        self.inner.write_line(&msg.to_string()).await?;
        self.inner.turn_active.store(true, Ordering::SeqCst);
        let _ = self.inner.events.send(SessionEvent::UserMessage { text });
        Ok(())
    }

    async fn interrupt(&self) -> Result<()> {
        if !self.inner.turn_active.load(Ordering::SeqCst) {
            return Ok(());
        }
        match self.inner.send_control(json!({ "subtype": "interrupt" })).await {
            Ok(_) => return Ok(()),
            Err(e) => tracing::warn!(session = %self.inner.session_id, "interrupt control request failed ({e}); restarting the process"),
        }
        // Last resort: kill; `send` will respawn with --resume.
        let _ = self.inner.stop_process().await;
        {
            let mut p = self.inner.proc.lock().await;
            p.exited = true;
        }
        self.inner.turn_active.store(false, Ordering::SeqCst);
        let _ = self.inner.events.send(SessionEvent::Status { message: "중단됨 (프로세스 재시작 필요)".into() });
        let _ = self.inner.events.send(SessionEvent::TurnEnd { cost_usd: None, usage: Default::default(), duration_ms: 0, stop_reason: Some("interrupted".into()) });
        Ok(())
    }

    async fn reply_permission(&self, reply: PermissionReply) -> Result<()> {
        self.inner.broker.resolve(reply)
    }

    async fn answer_question(&self, request_id: String, answers: Vec<QuestionAnswer>) -> Result<()> {
        self.inner.broker.resolve_question(&request_id, answers)
    }

    async fn update_config(&self, patch: SessionConfigPatch) -> Result<()> {
        let mut needs_respawn = false;
        {
            let mut cfg = self.inner.config.lock().await;
            if let Some(model) = patch.model.clone() {
                cfg.model = Some(model);
            }
            if let Some(effort) = patch.effort {
                if cfg.effort != Some(effort) {
                    cfg.effort = Some(effort);
                    needs_respawn = true; // --effort is a spawn-time flag
                }
            }
            if let Some(p) = patch.permission {
                cfg.permission = p;
            }
        }
        let running = !self.inner.proc.lock().await.exited;
        if running && !needs_respawn {
            if let Some(model) = &patch.model {
                if let Err(e) = self.inner.send_control(json!({ "subtype": "set_model", "model": model })).await {
                    tracing::warn!("set_model failed ({e}); will respawn");
                    needs_respawn = true;
                }
            }
            if let Some(p) = patch.permission {
                if let Err(e) = self.inner.send_control(json!({ "subtype": "set_permission_mode", "mode": args::permission_mode(p) })).await {
                    tracing::warn!("set_permission_mode failed ({e}); will respawn");
                    needs_respawn = true;
                }
            }
        }
        if needs_respawn && running {
            if self.inner.turn_active.load(Ordering::SeqCst) {
                // Apply at the next natural boundary instead of cutting the turn.
                let _ = self.inner.events.send(SessionEvent::Status { message: "설정은 현재 턴이 끝난 뒤 적용됩니다".into() });
                let me = self.inner.clone();
                tokio::spawn(async move {
                    while me.turn_active.load(Ordering::SeqCst) && !me.closed.load(Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                    if !me.closed.load(Ordering::SeqCst) {
                        let _ = me.respawn().await;
                    }
                });
            } else {
                self.inner.clone().respawn().await?;
            }
        }
        Ok(())
    }

    async fn close(&self) -> Result<()> {
        self.inner.closed.store(true, Ordering::SeqCst);
        let was_running = !self.inner.proc.lock().await.exited;
        let code = self.inner.stop_process().await;
        {
            let mut p = self.inner.proc.lock().await;
            p.exited = true;
        }
        self.inner.broker.unregister(&self.inner.session_id);
        if was_running {
            let _ = self.inner.events.send(SessionEvent::Exited { code });
        }
        Ok(())
    }
}

/// One-shot commit message generation (no session). See `agents::oneshot`.
pub async fn oneshot_commit_message(backend: Arc<ExecBackend>, bin: Option<String>, repo: &Path, diff: &str) -> Result<String> {
    let bin = bin.filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "claude".into());
    let mut prompt = String::from(super::oneshot::COMMIT_PROMPT);
    prompt.push_str("\n\n```diff\n");
    let max = 60_000;
    if diff.len() > max {
        let mut cut = max;
        while !diff.is_char_boundary(cut) {
            cut -= 1;
        }
        prompt.push_str(&diff[..cut]);
        prompt.push_str("\n... (diff truncated)\n");
    } else {
        prompt.push_str(diff);
    }
    prompt.push_str("\n```\n");
    let spec = CommandSpec::new(bin)
        .args(["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--disallowedTools", "*"])
        .cwd(repo);
    let mut cmd = backend.command(&spec);
    cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = spawn_tracked(&mut cmd)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await?;
    }
    let out = tokio::time::timeout(Duration::from_secs(180), child.wait_with_output()).await.map_err(|_| CoreError::Agent("commit message generation timed out".into()))??;
    if !out.status.success() {
        return Err(CoreError::Process { code: out.status.code(), stderr: String::from_utf8_lossy(&out.stderr).into_owned() });
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    // --output-format json prints one JSON object (possibly preceded by non-JSON warnings).
    let text = stdout
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v.get("type").and_then(Value::as_str) == Some("result"))
        .and_then(|v| v.get("result").and_then(Value::as_str).map(String::from))
        .ok_or_else(|| CoreError::Agent(format!("unexpected claude output: {}", stdout.chars().take(400).collect::<String>())))?;
    Ok(strip_fences(&text))
}

fn strip_fences(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let rest = rest.split_once('\n').map(|(_, r)| r).unwrap_or(rest);
        return rest.trim_end_matches("```").trim().to_string();
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn strip_fences_works() {
        assert_eq!(super::strip_fences("```\nfeat: x\n```"), "feat: x");
        assert_eq!(super::strip_fences("```text\nfix: y\n\nbody\n```"), "fix: y\n\nbody");
        assert_eq!(super::strip_fences("chore: z"), "chore: z");
    }
}
