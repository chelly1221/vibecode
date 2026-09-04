//! Generates CLAUDE.md and AGENTS.md from the project's choices.

use crate::types::{ProjectRecord, StackInfo};

pub struct AgentDocs {
    pub claude_md: String,
    pub agents_md: String,
}

pub fn generate(project: &ProjectRecord, stack: Option<&StackInfo>, description: &str) -> AgentDocs {
    let _ = (project, stack, description);
    AgentDocs { claude_md: String::new(), agents_md: String::new() }
}
