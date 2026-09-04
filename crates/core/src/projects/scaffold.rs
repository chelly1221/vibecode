//! Creates a project directory: scaffold command, agent docs, git init, first commit,
//! optional GitHub repo. Progress is streamed as `ScaffoldEvent`s.

use std::sync::Arc;

use tokio::sync::mpsc::UnboundedSender;

use crate::context::AppContext;
use crate::error::{CoreError, Result};
use crate::types::{CreateProjectRequest, ProjectRecord, ScaffoldEvent};

pub async fn create_project(ctx: Arc<AppContext>, req: CreateProjectRequest, events: UnboundedSender<ScaffoldEvent>) -> Result<ProjectRecord> {
    let _ = (ctx, req, events);
    Err(CoreError::NotImplemented("scaffold::create_project"))
}

/// Register an existing directory as a project (no scaffolding).
pub async fn open_existing(ctx: Arc<AppContext>, path: &str) -> Result<ProjectRecord> {
    let _ = (ctx, path);
    Err(CoreError::NotImplemented("scaffold::open_existing"))
}
