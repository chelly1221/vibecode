//! Claude-specific tool helpers: `claude auth status` and the model list.

use std::sync::Arc;

use serde_json::Value;

use crate::backend::{CommandSpec, ExecBackend};
use crate::error::Result;
use crate::types::{AuthStatus, Effort, ModelInfo, Provider};

const ALL_EFFORTS: [Effort; 5] = [Effort::Low, Effort::Medium, Effort::High, Effort::XHigh, Effort::Max];

/// `claude auth status` prints JSON: {loggedIn, authMethod, apiProvider, email, subscriptionType, ...}.
pub async fn auth_status(backend: Arc<dyn ExecBackend>, bin: Option<&str>) -> Result<AuthStatus> {
    let bin = bin.filter(|b| !b.trim().is_empty()).unwrap_or("claude");
    let spec = CommandSpec::new(bin).args(["auth", "status"]);
    let out = match tokio::time::timeout(std::time::Duration::from_secs(30), backend.run(&spec)).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Ok(AuthStatus { provider: Provider::Claude, logged_in: false, method: None, account: None, detail: Some(format!("claude 실행 실패: {e}")) }),
        Err(_) => return Ok(AuthStatus { provider: Provider::Claude, logged_in: false, method: None, account: None, detail: Some("claude auth status 응답 시간 초과".into()) }),
    };
    Ok(parse_auth_status(&out.stdout, &out.stderr, out.code))
}

pub fn parse_auth_status(stdout: &str, stderr: &str, code: Option<i32>) -> AuthStatus {
    // The JSON object may be preceded by warnings; find the first '{'.
    let json_start = stdout.find('{');
    let parsed: Option<Value> = json_start.and_then(|i| serde_json::from_str(&stdout[i..]).ok());
    match parsed {
        Some(v) => {
            let logged_in = v.get("loggedIn").and_then(Value::as_bool).unwrap_or(false);
            let method = v.get("authMethod").and_then(Value::as_str).map(String::from);
            let account = v.get("email").and_then(Value::as_str).map(String::from);
            let mut detail_parts = vec![];
            if let Some(s) = v.get("subscriptionType").and_then(Value::as_str) {
                detail_parts.push(format!("plan: {s}"));
            }
            if let Some(o) = v.get("orgName").and_then(Value::as_str) {
                detail_parts.push(format!("org: {o}"));
            }
            if let Some(p) = v.get("apiProvider").and_then(Value::as_str) {
                if p != "firstParty" {
                    detail_parts.push(format!("provider: {p}"));
                }
            }
            AuthStatus { provider: Provider::Claude, logged_in, method, account, detail: if detail_parts.is_empty() { None } else { Some(detail_parts.join(", ")) } }
        }
        None => {
            let msg = if !stderr.trim().is_empty() { stderr.trim().to_string() } else { stdout.trim().to_string() };
            AuthStatus { provider: Provider::Claude, logged_in: false, method: None, account: None, detail: Some(if msg.is_empty() { format!("로그인 상태를 확인할 수 없습니다 (exit {code:?})") } else { msg }) }
        }
    }
}

/// Static list — Claude Code has no model-listing command. Aliases resolve to the newest
/// model of each family; explicit ids pin a version.
pub fn list_models() -> Vec<ModelInfo> {
    let m = |id: &str, label: &str, efforts: &[Effort], is_default: bool| ModelInfo { provider: Provider::Claude, id: id.into(), label: label.into(), efforts: efforts.to_vec(), is_default };
    vec![
        m("opus", "Opus (최신)", &ALL_EFFORTS, true),
        m("sonnet", "Sonnet (최신)", &ALL_EFFORTS, false),
        m("fable", "Fable (최신, 최고 성능)", &ALL_EFFORTS, false),
        m("claude-opus-5", "Claude Opus 5", &ALL_EFFORTS, false),
        m("claude-sonnet-5", "Claude Sonnet 5", &ALL_EFFORTS, false),
        m("claude-fable-5-1", "Claude Fable 5.1", &ALL_EFFORTS, false),
        m("claude-opus-4-8", "Claude Opus 4.8", &ALL_EFFORTS, false),
        m("claude-haiku-4-5", "Claude Haiku 4.5 (빠름)", &[], false),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_auth_json() {
        let out = r#"{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "me@example.com",
  "orgName": "My Org",
  "subscriptionType": "max"
}"#;
        let s = parse_auth_status(out, "", Some(0));
        assert!(s.logged_in);
        assert_eq!(s.method.as_deref(), Some("claude.ai"));
        assert_eq!(s.account.as_deref(), Some("me@example.com"));
        assert!(s.detail.as_deref().unwrap().contains("plan: max"));
    }

    #[test]
    fn handles_failure() {
        let s = parse_auth_status("", "command not found", Some(127));
        assert!(!s.logged_in);
        assert_eq!(s.detail.as_deref(), Some("command not found"));
        let s2 = parse_auth_status("Warning: x\n{\"loggedIn\": false}", "", Some(0));
        assert!(!s2.logged_in);
    }

    #[test]
    fn model_list_has_default_and_ids() {
        let models = list_models();
        assert_eq!(models.iter().filter(|m| m.is_default).count(), 1);
        assert!(models.iter().any(|m| m.id == "claude-fable-5-1"));
        assert!(models.iter().find(|m| m.id == "claude-haiku-4-5").unwrap().efforts.is_empty());
    }
}
