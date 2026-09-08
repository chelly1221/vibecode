//! Codex-specific tool helpers: `codex login status`.
//!
//! Observed output (codex-cli 0.153.2): exit 1 + "Not logged in" when logged out;
//! exit 0 + "Logged in using ChatGPT" / "Logged in using an API key" otherwise.

use std::sync::Arc;

use crate::backend::{CommandSpec, ExecBackend};
use crate::error::Result;
use crate::types::{AuthStatus, Provider};

pub async fn auth_status(backend: Arc<ExecBackend>, bin: Option<&str>) -> Result<AuthStatus> {
    let spec = CommandSpec::new(bin.unwrap_or("codex")).args(["login", "status"]);
    let out = match tokio::time::timeout(std::time::Duration::from_secs(30), backend.run(&spec)).await {
        Ok(Ok(o)) => o,
        Err(_) => return Ok(AuthStatus { provider: Provider::Codex, logged_in: false, method: None, account: None, detail: Some("Codex 로그인 상태 확인 시간이 초과됐습니다".into()) }),
        Ok(Err(e)) => {
            return Ok(AuthStatus { provider: Provider::Codex, logged_in: false, method: None, account: None, detail: Some(format!("codex not available: {e}")) });
        }
    };
    let text = format!("{}\n{}", out.stdout.trim(), out.stderr.trim()).trim().to_string();
    Ok(parse_login_status(out.success(), &text))
}

pub fn parse_login_status(success: bool, text: &str) -> AuthStatus {
    let lower = text.to_ascii_lowercase();
    let logged_in = success && !lower.contains("not logged in") && lower.contains("logged in");
    let method = if !logged_in {
        None
    } else if lower.contains("chatgpt") {
        Some("chatgpt".to_string())
    } else if lower.contains("api key") {
        Some("apikey".to_string())
    } else {
        Some("unknown".to_string())
    };
    AuthStatus { provider: Provider::Codex, logged_in, method, account: None, detail: if text.is_empty() { None } else { Some(text.to_string()) } }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_text() {
        let a = parse_login_status(false, "Not logged in");
        assert!(!a.logged_in);
        let b = parse_login_status(true, "Logged in using ChatGPT");
        assert!(b.logged_in);
        assert_eq!(b.method.as_deref(), Some("chatgpt"));
        let c = parse_login_status(true, "Logged in using an API key - sk-...");
        assert_eq!(c.method.as_deref(), Some("apikey"));
        let d = parse_login_status(false, "bash: codex: command not found");
        assert!(!d.logged_in);
    }
}
