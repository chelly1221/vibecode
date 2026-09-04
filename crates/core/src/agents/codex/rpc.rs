//! Minimal JSON-RPC 2.0 client over newline-delimited JSON, generic over the
//! byte streams so it can be tested in-process with `tokio::io::duplex`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::error::{CoreError, Result};

/// Anything the server sends that is not a response to one of our requests.
#[derive(Debug, Clone)]
pub enum Incoming {
    Notification { method: String, params: Value },
    /// Server-initiated request; must be answered with `respond`/`respond_error`.
    Request { id: Value, method: String, params: Value },
    /// The connection ended (EOF or read error).
    Closed,
}

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "codex rpc error {}: {}", self.code, self.message)
    }
}

impl From<RpcError> for CoreError {
    fn from(e: RpcError) -> Self {
        CoreError::Agent(e.to_string())
    }
}

type Pending = oneshot::Sender<std::result::Result<Value, RpcError>>;

pub struct RpcClient {
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, Pending>>,
    writer: tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    alive: AtomicBool,
    pub request_timeout: Duration,
}

impl RpcClient {
    /// Start reading `reader`; responses resolve pending requests, everything else
    /// is forwarded to `incoming`. `Incoming::Closed` is sent exactly once at EOF.
    pub fn spawn<R, W>(reader: R, writer: W, incoming: mpsc::UnboundedSender<Incoming>) -> Arc<RpcClient>
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let client = Arc::new(RpcClient {
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            writer: tokio::sync::Mutex::new(Box::new(writer)),
            alive: AtomicBool::new(true),
            request_timeout: Duration::from_secs(120),
        });
        let c = client.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        c.handle_line(&line, &incoming);
                    }
                    Ok(None) => break,
                    Err(e) => {
                        tracing::warn!("codex app-server read error: {e}");
                        break;
                    }
                }
            }
            c.alive.store(false, Ordering::SeqCst);
            c.fail_all("codex app-server connection closed");
            let _ = incoming.send(Incoming::Closed);
        });
        client
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn handle_line(&self, line: &str, incoming: &mpsc::UnboundedSender<Incoming>) {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!("codex: non-JSON line ignored ({e}): {}", line.chars().take(200).collect::<String>());
                return;
            }
        };
        let method = v.get("method").and_then(|m| m.as_str()).map(|s| s.to_string());
        let id = v.get("id").cloned().filter(|i| !i.is_null());
        match (method, id) {
            (Some(method), Some(id)) => {
                let params = v.get("params").cloned().unwrap_or(Value::Null);
                let _ = incoming.send(Incoming::Request { id, method, params });
            }
            (Some(method), None) => {
                let params = v.get("params").cloned().unwrap_or(Value::Null);
                let _ = incoming.send(Incoming::Notification { method, params });
            }
            (None, Some(id)) => {
                let Some(id) = id.as_i64() else {
                    tracing::debug!("codex: response with non-numeric id ignored: {id}");
                    return;
                };
                let tx = self.pending.lock().ok().and_then(|mut p| p.remove(&id));
                let Some(tx) = tx else {
                    tracing::debug!("codex: response for unknown request id {id}");
                    return;
                };
                if let Some(err) = v.get("error") {
                    let _ = tx.send(Err(RpcError {
                        code: err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1),
                        message: err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error").to_string(),
                        data: err.get("data").cloned(),
                    }));
                } else {
                    let _ = tx.send(Ok(v.get("result").cloned().unwrap_or(Value::Null)));
                }
            }
            (None, None) => tracing::debug!("codex: unrecognised message: {line}"),
        }
    }

    fn fail_all(&self, reason: &str) {
        if let Ok(mut p) = self.pending.lock() {
            for (_, tx) in p.drain() {
                let _ = tx.send(Err(RpcError { code: -32000, message: reason.to_string(), data: None }));
            }
        }
    }

    async fn write_line(&self, v: &Value) -> Result<()> {
        let mut line = serde_json::to_string(v)?;
        line.push('\n');
        let mut w = self.writer.lock().await;
        w.write_all(line.as_bytes()).await.map_err(|e| CoreError::Agent(format!("codex app-server write failed: {e}")))?;
        w.flush().await.map_err(|e| CoreError::Agent(format!("codex app-server flush failed: {e}")))?;
        Ok(())
    }

    /// Send a request and await its result.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        if !self.is_alive() {
            return Err(CoreError::Agent("codex app-server is not running".into()));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().map_err(|_| CoreError::msg("rpc pending mutex poisoned"))?.insert(id, tx);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.write_line(&msg).await {
            if let Ok(mut p) = self.pending.lock() {
                p.remove(&id);
            }
            return Err(e);
        }
        match tokio::time::timeout(self.request_timeout, rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(e.into()),
            Ok(Err(_)) => Err(CoreError::Agent(format!("codex app-server dropped request {method}"))),
            Err(_) => {
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                Err(CoreError::Agent(format!("codex app-server request {method} timed out")))
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.write_line(&json!({ "jsonrpc": "2.0", "method": method, "params": params })).await
    }

    /// Answer a server-initiated request.
    pub async fn respond(&self, id: Value, result: Value) -> Result<()> {
        self.write_line(&json!({ "jsonrpc": "2.0", "id": id, "result": result })).await
    }

    pub async fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<()> {
        self.write_line(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })).await
    }
}

/// Stable string form of a JSON-RPC id (numbers unquoted, strings bare).
pub fn id_key(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}
