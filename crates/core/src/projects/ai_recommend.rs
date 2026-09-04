//! Ask an agent (one-shot, no session) to rank catalog stacks for a free-text project description.

use std::sync::Arc;

use crate::backend::ExecBackend;
use crate::error::{CoreError, Result};
use crate::types::{StackRecommendRequest, StackRecommendation};

pub async fn recommend(backend: Arc<dyn ExecBackend>, bin: Option<String>, req: StackRecommendRequest) -> Result<Vec<StackRecommendation>> {
    let _ = (backend, bin, req);
    Err(CoreError::NotImplemented("ai_recommend::recommend"))
}
