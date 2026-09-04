//! Owns the single `codex app-server` process and routes its messages to sessions.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;

use super::mapping::{self, MapState};
use super::rpc::{Incoming, RpcClient};
use super::session::{CodexSession, SessionInner, TurnConfig};
use crate::agents::{AgentSession, StartArgs};
use crate::backend::{process, CommandSpec, ExecBackend};
use crate::error::{CoreError, Result};
use crate::types::{ModelInfo, Provider, SessionEvent};

type Registry = Arc<RwLock<HashMap<String, Arc<SessionInner>>>>;

struct HostInner {
    rpc: Arc<RpcClient>,
    /// None when attached to raw streams (tests).
    child: Option<Child>,
    key: String,
    dispatcher: JoinHandle<()>,
    stderr_task: Option<JoinHandle<()>>,
}

impl Drop for HostInner {
    fn drop(&mut self) {
        self.dispatcher.abort();
        if let Some(t) = &self.stderr_task {
            t.abort();
        }
        if let Some(c) = &mut self.child {
            let _ = c.start_kill();
        }
    }
}

/// Identifies the environment a running app-server belongs to.
pub fn host_key(backend: &dyn ExecBackend, bin: Option<&str>) -> String {
    format!("{}|{}", backend.label(), bin.unwrap_or("codex"))
}

/// Lazily started, shared app-server client. Created once per `AppContext`.
#[derive(Default)]
pub struct CodexHost {
    inner: tokio::sync::Mutex<Option<HostInner>>,
    sessions: Registry,
}

impl CodexHost {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ensure the app-server is running for `backend`/`bin`; (re)spawn when the
    /// environment changed or the previous process died.
    pub async fn ensure_started(&self, backend: Arc<dyn ExecBackend>, bin: Option<String>) -> Result<()> {
        let key = host_key(backend.as_ref(), bin.as_deref());
        let mut guard = self.inner.lock().await;
        if let Some(h) = guard.as_ref() {
            if h.rpc.is_alive() && h.key == key {
                return Ok(());
            }
        }
        if let Some(old) = guard.take() {
            drop(old);
            self.expire_sessions().await;
        }
        let spec = CommandSpec::new(bin.clone().unwrap_or_else(|| "codex".into())).arg("app-server");
        let mut cmd = backend.command(&spec);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = process::spawn_tracked(&mut cmd).map_err(|e| CoreError::Agent(format!("failed to start `codex app-server` on {}: {e}", backend.label())))?;
        let stdout = child.stdout.take().ok_or_else(|| CoreError::Agent("codex app-server: no stdout".into()))?;
        let stdin = child.stdin.take().ok_or_else(|| CoreError::Agent("codex app-server: no stdin".into()))?;
        let stderr_task = child.stderr.take().map(|stderr| {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    tracing::debug!(target: "codex_app_server", "{l}");
                }
            })
        });
        let inner = self.attach_inner(stdout, stdin, Some(child), key, stderr_task);
        let rpc = inner.rpc.clone();
        *guard = Some(inner);
        drop(guard);
        if let Err(e) = Self::handshake(&rpc).await {
            // Leave the dead handle in place; the next call re-spawns.
            return Err(CoreError::Agent(format!("codex app-server handshake failed: {e}")));
        }
        Ok(())
    }

    /// Attach to an already-connected transport (used by tests with `tokio::io::duplex`).
    /// Performs the initialize handshake.
    pub async fn connect<R, W>(&self, reader: R, writer: W, key: String) -> Result<()>
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let inner = self.attach_inner(reader, writer, None, key, None);
        let rpc = inner.rpc.clone();
        *self.inner.lock().await = Some(inner);
        Self::handshake(&rpc).await
    }

    fn attach_inner<R, W>(&self, reader: R, writer: W, child: Option<Child>, key: String, stderr_task: Option<JoinHandle<()>>) -> HostInner
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let (tx, mut rx) = mpsc::unbounded_channel::<Incoming>();
        let rpc = RpcClient::spawn(reader, writer, tx);
        let sessions = self.sessions.clone();
        let rpc_for_dispatch = rpc.clone();
        let dispatcher = tokio::spawn(async move {
            while let Some(inc) = rx.recv().await {
                match &inc {
                    Incoming::Closed => {
                        let all: Vec<_> = sessions.write().await.drain().map(|(_, s)| s).collect();
                        for s in all {
                            s.handle(Incoming::Closed).await;
                        }
                        break;
                    }
                    Incoming::Notification { params, .. } | Incoming::Request { params, .. } => {
                        let tid = params.get("threadId").or_else(|| params.get("conversationId")).and_then(|t| t.as_str()).map(|s| s.to_string());
                        let session = match tid {
                            Some(t) => sessions.read().await.get(&t).cloned(),
                            None => None,
                        };
                        match (session, &inc) {
                            (Some(s), _) => s.handle(inc).await,
                            (None, Incoming::Request { id, method, .. }) => {
                                tracing::debug!("codex: unrouted server request {method}");
                                let _ = rpc_for_dispatch.respond_error(id.clone(), -32601, "no session for this request").await;
                            }
                            (None, Incoming::Notification { method, params }) => {
                                if !matches!(method.as_str(), "thread/started" | "thread/status/changed" | "account/rateLimits/updated" | "remoteControl/status/changed") {
                                    tracing::trace!("codex: unrouted notification {method}: {params}");
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        });
        HostInner { rpc, child, key, dispatcher, stderr_task }
    }

    async fn handshake(rpc: &RpcClient) -> Result<()> {
        rpc.request(
            "initialize",
            json!({
                "clientInfo": { "name": "vibecode", "title": "vibecode", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true, "requestAttestation": false }
            }),
        )
        .await?;
        rpc.notify("initialized", json!({})).await
    }

    async fn expire_sessions(&self) {
        let all: Vec<_> = self.sessions.write().await.drain().map(|(_, s)| s).collect();
        for s in all {
            s.handle(Incoming::Closed).await;
        }
    }

    /// The live RPC client (after `ensure_started`/`connect`).
    pub async fn rpc(&self) -> Result<Arc<RpcClient>> {
        self.inner
            .lock()
            .await
            .as_ref()
            .filter(|h| h.rpc.is_alive())
            .map(|h| h.rpc.clone())
            .ok_or_else(|| CoreError::Agent("codex app-server is not running".into()))
    }

    pub async fn is_running(&self) -> bool {
        self.rpc().await.is_ok()
    }

    /// `model/list` → UI models. Works without login (static catalog).
    pub async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let rpc = self.rpc().await?;
        let v = rpc.request("model/list", json!({ "limit": 100, "includeHidden": false })).await.map_err(auth_aware)?;
        Ok(mapping::models_from_list(&v))
    }

    /// `account/read` → whether Codex has credentials.
    pub async fn account_logged_in(&self) -> Result<bool> {
        let rpc = self.rpc().await?;
        let v = rpc.request("account/read", json!({ "refreshToken": false })).await?;
        Ok(v.get("account").map(|a| !a.is_null()).unwrap_or(false))
    }

    /// Start (or resume/fork) a thread for `args`.
    pub async fn start_session(&self, args: StartArgs) -> Result<Arc<dyn AgentSession>> {
        self.ensure_started(args.backend.clone(), args.bin.clone()).await?;
        let rpc = self.rpc().await?;
        let cwd_backend = args.backend.to_backend_path(&args.cwd);
        let cfg = args.config;
        let pol = mapping::policies_for(cfg.permission, &cwd_backend);

        let mut params = json!({
            "cwd": cwd_backend,
            "approvalPolicy": pol.approval_policy,
            "sandbox": pol.sandbox_mode,
        });
        if let Some(m) = &cfg.model {
            params["model"] = json!(m);
        }
        if let Some(sp) = &cfg.append_system_prompt {
            params["developerInstructions"] = json!(sp);
        }
        // Config overrides (same key paths as `codex -c key=value`): reasoning effort + MCP servers.
        let mut overrides = mapping::mcp_config_overrides(&args.mcp_servers);
        if let Some(e) = cfg.effort {
            overrides.insert("model_reasoning_effort".into(), json!(e.to_codex()));
        }
        let method = match (&cfg.resume_ref, cfg.fork) {
            (Some(r), true) => {
                params["threadId"] = json!(r);
                params["excludeTurns"] = json!(true);
                "thread/fork"
            }
            (Some(r), false) => {
                params["threadId"] = json!(r);
                params["excludeTurns"] = json!(true);
                "thread/resume"
            }
            (None, _) => {
                params["serviceName"] = json!("vibecode");
                params["ephemeral"] = json!(false);
                "thread/start"
            }
        };
        if !overrides.is_empty() {
            params["config"] = serde_json::Value::Object(overrides);
        }
        let v = rpc.request(method, params).await.map_err(auth_aware)?;
        let thread_id = v
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(|i| i.as_str())
            .ok_or_else(|| CoreError::Agent(format!("codex {method}: response without thread id")))?
            .to_string();
        let model = v.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()).or_else(|| cfg.model.clone()).unwrap_or_default();

        let inner = Arc::new(SessionInner {
            thread_id: thread_id.clone(),
            rpc,
            events: args.events,
            cwd_backend,
            cfg: Mutex::new(TurnConfig { model: Some(model.clone()), effort: cfg.effort, permission: cfg.permission }),
            map: Mutex::new(MapState::default()),
            closed: AtomicBool::new(false),
        });
        self.sessions.write().await.insert(thread_id.clone(), inner.clone());
        inner.emit(SessionEvent::Init { provider: Provider::Codex, model, external_ref: thread_id, tools: vec![] });
        Ok(Arc::new(CodexSession { inner, registry: self.sessions.clone() }))
    }

    /// Kill the app-server. Live sessions receive `Exited`.
    pub async fn shutdown(&self) {
        let old = self.inner.lock().await.take();
        drop(old);
        self.expire_sessions().await;
    }
}

fn auth_aware(e: CoreError) -> CoreError {
    let s = e.to_string();
    if s.contains("401") || s.to_ascii_lowercase().contains("unauthorized") || s.to_ascii_lowercase().contains("not logged in") {
        CoreError::Agent(format!("Codex is not logged in — run `codex login` (or `codex login --device-auth`) in the backend. {s}"))
    } else {
        e
    }
}
