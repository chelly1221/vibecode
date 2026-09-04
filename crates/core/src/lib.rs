//! vibecode core library. Tauri-independent: agent adapters, execution backends,
//! git/GitHub, project scaffolding, persistence, secrets and PTY sessions.
//!
//! Module ownership (see CLAUDE.md):
//! - `types`      shared serializable types exported to TypeScript via ts-rs
//! - `backend`    command execution on Windows natively or inside WSL (path mapping)
//! - `agents`     `AgentSession` trait + Claude Code / Codex adapters
//! - `permission` in-app MCP HTTP server used as Claude's `--permission-prompt-tool`
//! - `git`        git operations through the backend
//! - `github`     GitHub REST (create repo, whoami)
//! - `managed`    app-owned WSL distribution: WSL detection/installation, rootfs provisioning
//! - `projects`   stack catalog, scaffolding, CLAUDE.md/AGENTS.md generation
//! - `db`         SQLite persistence (projects, sessions, messages, settings)
//! - `secrets`    OS keyring wrapper
//! - `pty`        interactive terminal sessions (login flows)
//! - `tools`      CLI detection and auth status

pub mod agents;
pub mod backend;
pub mod context;
pub mod db;
pub mod error;
pub mod git;
pub mod github;
pub mod managed;
pub mod permission;
pub mod projects;
pub mod pty;
pub mod secrets;
pub mod tools;
pub mod types;

pub use context::AppContext;
pub use error::{CoreError, Result};
