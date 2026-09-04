//! Transcript export (Markdown) built from persisted messages.

use crate::context::AppContext;
use crate::error::{CoreError, Result};

pub async fn session_markdown(ctx: &AppContext, session_id: &str) -> Result<String> {
    let _ = (ctx, session_id);
    Err(CoreError::NotImplemented("export::session_markdown"))
}
