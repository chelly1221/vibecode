//! Working-tree checkpoints: a snapshot commit is created before every agent turn so the user
//! can roll the project back from the chat. Projects that are git repositories keep snapshots
//! under `refs/vibecoder/checkpoints/*`; other projects use a hidden repository in the app data
//! dir (`GIT_DIR` outside the project) with a default exclude list (node_modules, target, ...).
//! All git calls go through the backend (paths translated).

use std::sync::Arc;

use crate::context::AppContext;
use crate::error::{CoreError, Result};
use crate::types::CheckpointRecord;

/// Snapshot the project's working tree. Returns None when nothing changed since the last checkpoint.
pub async fn create(ctx: Arc<AppContext>, project_id: &str, session_id: Option<&str>, label: &str) -> Result<Option<CheckpointRecord>> {
    let _ = (ctx, project_id, session_id, label);
    Err(CoreError::NotImplemented("checkpoint::create"))
}

/// Restore the working tree to a checkpoint (overwrites tracked/snapshotted files, removes files
/// that did not exist in the snapshot, leaves ignored files alone). A safety checkpoint of the
/// current state is created first and returned.
pub async fn restore(ctx: Arc<AppContext>, checkpoint_id: &str) -> Result<CheckpointRecord> {
    let _ = (ctx, checkpoint_id);
    Err(CoreError::NotImplemented("checkpoint::restore"))
}

pub async fn list(ctx: Arc<AppContext>, project_id: &str, session_id: Option<&str>) -> Result<Vec<CheckpointRecord>> {
    ctx.db.list_checkpoints(project_id, session_id)
}

/// Unified diff between the checkpoint and the current working tree (for a preview before restoring).
pub async fn diff(ctx: Arc<AppContext>, checkpoint_id: &str) -> Result<String> {
    let _ = (ctx, checkpoint_id);
    Err(CoreError::NotImplemented("checkpoint::diff"))
}
