//! Stack catalog loaded from `resources/stacks.toml` (embedded at compile time).

use crate::error::{CoreError, Result};
use crate::types::{ProjectType, StackInfo, TargetOs};

pub const STACKS_TOML: &str = include_str!("../../resources/stacks.toml");

pub fn load() -> Result<Vec<StackInfo>> {
    Err(CoreError::NotImplemented("catalog::load"))
}

/// Stacks matching (target, type), recommended ones first.
pub fn recommend(target: TargetOs, project_type: ProjectType) -> Result<Vec<StackInfo>> {
    let _ = (target, project_type);
    Err(CoreError::NotImplemented("catalog::recommend"))
}

pub fn get(id: &str) -> Result<Option<StackInfo>> {
    let _ = id;
    Err(CoreError::NotImplemented("catalog::get"))
}
