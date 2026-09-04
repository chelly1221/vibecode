//! Minimal MCP streamable-HTTP server (JSON-RPC 2.0 over POST) exposing the `approve` tool.
//! Only what Claude Code's MCP client needs: initialize, notifications, ping, tools/list, tools/call.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::Router;
use serde_json::{json, Value};

use super::{PermissionAsk, PermissionBroker, SERVER_NAME, TOOL_NAME};

pub const PROTOCOL_VERSION: &str = "2025-06-18";

pub(super) fn serve(listener: tokio::net::TcpListener, broker: Arc<PermissionBroker>) {
    let app = Router::new()
        .route("/mcp/{session_id}", post(handle_post))
        .route("/mcp/{session_id}", get(|| async { (StatusCode::METHOD_NOT_ALLOWED, "SSE stream not supported") }))
        .route("/mcp/{session_id}", delete(|| async { StatusCode::OK }))
        .with_state(broker);
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!("permission MCP server stopped: {e}");
        }
    });
}

async fn handle_post(State(broker): State<Arc<PermissionBroker>>, Path(session_id): Path<String>, body: Bytes) -> Response {
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("invalid JSON: {e}")).into_response(),
    };
    let messages: Vec<Value> = match parsed {
        Value::Array(a) => a,
        other => vec![other],
    };
    let mut responses = vec![];
    for msg in messages {
        if let Some(resp) = handle_message(&broker, &session_id, msg).await {
            responses.push(resp);
        }
    }
    match responses.len() {
        0 => StatusCode::ACCEPTED.into_response(),
        1 => axum::Json(responses.pop().unwrap()).into_response(),
        _ => axum::Json(Value::Array(responses)).into_response(),
    }
}

/// Returns None for notifications (no id).
pub async fn handle_message(broker: &PermissionBroker, session_id: &str, msg: Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    if method.starts_with("notifications/") || (id.is_none() && !method.is_empty()) {
        return None;
    }
    let id = id?;
    let result = match method.as_str() {
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSION);
            Ok(json!({
                "protocolVersion": requested,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": [tool_definition()] })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            if name != TOOL_NAME {
                Err((-32602, format!("unknown tool {name}")))
            } else {
                let args = params.get("arguments").cloned().unwrap_or(Value::Null);
                let ask = PermissionAsk::from_request(session_id, &args);
                let outcome = broker.ask(ask).await;
                Ok(json!({ "content": [{ "type": "text", "text": outcome.result.to_string() }], "isError": false }))
            }
        }
        "resources/list" => Ok(json!({ "resources": [] })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        other => Err((-32601, format!("method not found: {other}"))),
    };
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    })
}

fn tool_definition() -> Value {
    json!({
        "name": TOOL_NAME,
        "description": "Ask the vibecode user whether Claude may run a tool. Returns {behavior:'allow'|'deny',...} as JSON text.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tool_name": { "type": "string" },
                "input": { "type": "object" },
                "tool_use_id": { "type": "string" },
                "permission_suggestions": { "type": "array" },
                "blocked_path": { "type": "string" },
                "description": { "type": "string" }
            },
            "required": ["tool_name", "input"]
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{PermissionDecision, PermissionReply, SessionEvent};

    #[tokio::test]
    async fn jsonrpc_surface() {
        let broker = PermissionBroker::without_server();
        let init = handle_message(&broker, "s", json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}})).await.unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], "vibecode");
        assert!(handle_message(&broker, "s", json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await.is_none());
        let list = handle_message(&broker, "s", json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).await.unwrap();
        assert_eq!(list["result"]["tools"][0]["name"], "approve");
        let unknown = handle_message(&broker, "s", json!({"jsonrpc":"2.0","id":3,"method":"nope"})).await.unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn tools_call_roundtrip_over_http() {
        let broker = PermissionBroker::start().await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        broker.register("s9", tx);
        let url = broker.mcp_url("s9");
        let client = reqwest::Client::new();
        let call = json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"t1"}}});
        let req = tokio::spawn(async move { client.post(url).json(&call).send().await.unwrap().json::<Value>().await.unwrap() });
        let id = match rx.recv().await.unwrap() { SessionEvent::PermissionRequest { request_id, .. } => request_id, o => panic!("{o:?}") };
        broker.resolve(PermissionReply { request_id: id, decision: PermissionDecision::Allow, message: None }).unwrap();
        let resp = req.await.unwrap();
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let inner: Value = serde_json::from_str(text).unwrap();
        assert_eq!(inner["behavior"], "allow");
        assert_eq!(inner["updatedInput"]["command"], "ls");
        // GET is rejected, notifications are 202
        let c = reqwest::Client::new();
        assert_eq!(c.get(broker.mcp_url("s9")).send().await.unwrap().status(), 405);
        let r = c.post(broker.mcp_url("s9")).json(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})).send().await.unwrap();
        assert_eq!(r.status(), 202);
    }
}
