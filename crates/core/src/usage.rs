//! Subscription usage ("남은 사용량"): the rate-limit windows the CLIs report, stored per
//! account in `usage_samples` and served to the usage graph.
//!
//! Sources: Claude Code emits `rate_limit_event` on every API response of a running session;
//! Codex app-server sends `account/rateLimits/updated` and answers `account/rateLimits/read`.
//! Neither CLI offers a headless usage query for Claude, so Claude values refresh while a
//! session is working.

use std::sync::Arc;

use crate::context::AppContext;
use crate::error::{CoreError, Result};
use crate::types::{Provider, RateLimitWindow, UsageSample};

/// Samples of one account from the last `hours` hours, oldest first.
pub fn history(ctx: &AppContext, provider: Provider, account_id: Option<&str>, hours: i64) -> Result<Vec<UsageSample>> {
    let since = chrono::Utc::now().timestamp() - hours.clamp(1, 24 * 30) * 3600;
    ctx.db.list_usage_samples(provider, account_id, since)
}

/// Newest sample of every known window of every account.
pub fn latest(ctx: &AppContext) -> Result<Vec<UsageSample>> {
    ctx.db.latest_usage_samples()
}

/// Ask the CLI for the current windows and store them. Codex only: Claude Code has no
/// usage query outside a session (its values arrive with `rate_limit_event`).
pub async fn refresh(ctx: Arc<AppContext>, provider: Provider, account_id: Option<&str>) -> Result<Vec<RateLimitWindow>> {
    if provider != Provider::Codex {
        return Err(CoreError::msg("Claude 사용량은 AI가 작업하는 동안 자동으로 갱신됩니다"));
    }
    let Some(id) = account_id else { return Err(CoreError::msg("사용량을 확인할 Codex 계정을 선택하세요")) };
    let host = match ctx.running_account_host(id).await {
        Some(h) => h,
        None => {
            let backend = crate::accounts::agent_backend(&ctx, Provider::Codex, Some(id))?;
            let bin = ctx.bin_override(Provider::Codex).await;
            let host = ctx.account_host(backend.account_key()).await;
            host.ensure_started(backend, bin).await?;
            host
        }
    };
    let windows = host.read_rate_limits().await?;
    if !windows.is_empty() {
        ctx.db.insert_usage_samples(Provider::Codex, Some(id), &windows, chrono::Utc::now().timestamp())?;
    }
    Ok(windows)
}
