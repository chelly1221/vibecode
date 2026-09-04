//! Codex adapter: one shared `codex app-server` process (JSON-RPC 2.0 over stdio,
//! newline-delimited), one thread per vibecode session.
//!
//! Protocol facts (verified against codex-cli 0.153.2 `app-server generate-ts` output
//! and a live unauthenticated server on 2026-09-04):
//! - Client→server requests: `{"jsonrpc":"2.0","id":N,"method":..,"params":..}`.
//!   Server responses omit `jsonrpc`: `{"id":N,"result":..}` / `{"id":N,"error":{code,message,data}}`.
//! - Notifications: `{"method":..,"params":..,"emittedAtMs":..}` (no id).
//! - Server→client requests carry `id` + `method` (approvals) and expect `{"id":..,"result":{..}}`.
//! - Handshake: `initialize {clientInfo{name,title,version}, capabilities{experimentalApi,
//!   requestAttestation}}` → then notification `initialized`.
//! - `thread/start {cwd, model, approvalPolicy, sandbox, config, developerInstructions,
//!   serviceName, ephemeral}` → `{thread{id,..}, model, ..}`; `thread/resume {threadId, excludeTurns,..}`;
//!   `thread/fork {threadId, excludeTurns,..}`; `thread/unsubscribe {threadId}`.
//! - `turn/start {threadId, input:[{type:"text",text,text_elements:[]}], model, effort,
//!   approvalPolicy, sandboxPolicy}` → `{turn{id,status}}`; `turn/steer {threadId,input,expectedTurnId}`;
//!   `turn/interrupt {threadId, turnId}`.
//! - `approvalPolicy`: "untrusted" | "on-request" | "never"; `sandbox`: "read-only" |
//!   "workspace-write" | "danger-full-access"; `sandboxPolicy` (turn/start): `{type:"readOnly",
//!   networkAccess}` | `{type:"workspaceWrite", writableRoots, networkAccess, excludeTmpdirEnvVar,
//!   excludeSlashTmp}` | `{type:"dangerFullAccess"}`.
//! - `model/list {limit, includeHidden}` → `{data:[{id, model, displayName, isDefault,
//!   defaultReasoningEffort, supportedReasoningEfforts:[{reasoningEffort, description}], hidden}]}`
//!   (works without login).
//! - Notifications used: `turn/started`, `turn/completed {threadId, turn{id,status,error,durationMs}}`,
//!   `item/started` / `item/completed {threadId, turnId, item{type,id,..}}`,
//!   `item/agentMessage/delta {itemId, delta}`, `item/reasoning/summaryTextDelta`,
//!   `item/reasoning/textDelta`, `item/commandExecution/outputDelta`, `turn/plan/updated
//!   {plan:[{step,status}]}`, `thread/tokenUsage/updated {tokenUsage{last{inputTokens,
//!   cachedInputTokens, cacheWriteInputTokens, outputTokens}}}`, `error {error{message}, willRetry}`,
//!   `warning`, `configWarning`, `serverRequest/resolved {requestId}`, `thread/closed`.
//! - Server requests handled: `item/commandExecution/requestApproval {itemId, command, cwd, reason}`
//!   → `{decision: accept|acceptForSession|decline|cancel}`; `item/fileChange/requestApproval
//!   {itemId, reason, grantRoot}` → same decisions; `item/permissions/requestApproval` →
//!   `{permissions, scope}`; `item/tool/requestUserInput` → `{answers}`;
//!   `mcpServer/elicitation/request` → `{action, content, _meta}`; legacy `execCommandApproval` /
//!   `applyPatchApproval` → `{decision: "approved"|"approved_for_session"|{"denied":{rejection}}}`.

pub mod exec;
mod host;
pub mod mapping;
pub mod rpc;
mod session;

pub use host::{host_key, CodexHost};
pub use session::CodexSession;

use std::sync::Arc;

use crate::backend::ExecBackend;
use crate::error::Result;

/// One-shot commit message generation (no session). See `agents::oneshot`.
pub async fn oneshot_commit_message(backend: Arc<dyn ExecBackend>, bin: Option<String>, repo: &std::path::Path, diff: &str) -> Result<String> {
    const MAX_DIFF_CHARS: usize = 60_000;
    let mut diff = diff.to_string();
    if diff.chars().count() > MAX_DIFF_CHARS {
        diff = diff.chars().take(MAX_DIFF_CHARS).collect::<String>() + "\n... (diff truncated)";
    }
    let prompt = format!("{}\n\n```diff\n{}\n```", super::oneshot::COMMIT_PROMPT, diff);
    let text = exec::run_exec(backend, bin, repo, &prompt, None).await?;
    Ok(exec::strip_code_fence(&text))
}
